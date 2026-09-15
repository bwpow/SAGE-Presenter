import type { Config, MediaItem, PresenterAPI, RenderMessage, State } from './shared';
declare global { interface Window { presenter: PresenterAPI; } }
const api = window.presenter;
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const surface = element('surface'), stage = element('stage'), welcome = element('welcome'), library = element('library');
const grid = element('grid'), snapshot = element<HTMLImageElement>('snapshot'), loading = element('loading');
let state: State;
let config: Config;
let pending: AbortController | undefined;
let current: { layer: HTMLElement; media: HTMLImageElement | HTMLVideoElement; stop: () => void } | undefined;
let renderedFolder = '';
let gridSignature = '';
let thumbEpoch = 0;
let thumbQueue: Array<() => Promise<void>> = [];
let thumbRunning = 0;
const thumbCache = new Map<string, string>();
const thumbnailControllers = new Set<AbortController>();
let observer: IntersectionObserver | undefined;
let noticeTimer: ReturnType<typeof setTimeout>;
let cursorTimer: ReturnType<typeof setTimeout>;
let lastFrameStamp = 0;
let emptyPicture: HTMLImageElement | undefined;
function positionEmptyPicture() {
  if (!emptyPicture) return;
  const scale = window.devicePixelRatio || 1;
  emptyPicture.style.width = `${emptyPicture.naturalWidth / scale}px`;
  emptyPicture.style.height = `${emptyPicture.naturalHeight / scale}px`;
  emptyPicture.style.left = `${Math.round((innerWidth * scale - emptyPicture.naturalWidth) / 2) / scale}px`;
  emptyPicture.style.top = `${Math.round((innerHeight * scale - emptyPicture.naturalHeight) / 2) / scale}px`;
}
window.addEventListener('resize', positionEmptyPicture);
async function showEmpty(revision: number, signal: AbortSignal) {
  resetThumbnails(); hideLoading(); element('notice').hidden = true;
  let picture: HTMLImageElement | undefined;
  let background = 'rgb(0, 0, 0)', textColor = 'rgba(255,255,255,.65)';
  try {
    if (config.emptyImage) {
      picture = await loadImage(`presenter-media://local/empty?revision=${revision}`, signal);
      if (signal.aborted || state.revision !== revision) { release(picture); return; }
      // Sample precisely the top-left pixel, flattening transparency onto black.
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d', { alpha: false })!;
      context.drawImage(picture, 0, 0, 1, 1, 0, 0, 1, 1);
      const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data;
      background = `rgb(${red}, ${green}, ${blue})`;
      if (.2126 * red + .7152 * green + .0722 * blue > 150) textColor = 'rgba(0,0,0,.55)';
    }
  } catch (error) {
    if (signal.aborted || state.revision !== revision) return;
    if (picture) release(picture); picture = undefined;
    api.failed(revision, `Empty image: ${String(error)}`);
  }
  if (signal.aborted || state.revision !== revision) { if (picture) release(picture); return; }
  if (emptyPicture) release(emptyPicture);
  emptyPicture = picture;
  element('empty-picture').replaceChildren(...(picture ? [picture] : []));
  if (picture) { picture.alt = ''; picture.draggable = false; positionEmptyPicture(); }
  welcome.style.background = background;
  element('app-version').style.color = textColor;
  welcome.getAnimations().forEach(animation => animation.cancel());
  const previouslyHidden = welcome.hidden;
  library.hidden = true; welcome.hidden = false;
  if (previouslyHidden) welcome.animate([{ opacity: 0 }, { opacity: 1 }], { duration: config.transitionMilliseconds });
  const preceding = current; current = undefined;
  if (preceding) void delay(config.transitionMilliseconds + 20).then(() => { preceding.stop(); release(preceding.media); preceding.layer.remove(); });
  fadeSnapshot(revision);
}
function delay(ms: number) { return new Promise<void>(resolve => setTimeout(resolve, ms)); }
function release(media: HTMLImageElement | HTMLVideoElement) {
  if (media instanceof HTMLVideoElement) { media.pause(); media.removeAttribute('src'); media.load(); }
  else media.removeAttribute('src');
}
function pauseCurrent() { if (current?.media instanceof HTMLVideoElement) current.media.pause(); }
function destroyCurrent() { if (current) { current.stop(); release(current.media); current.layer.remove(); current = undefined; } }
function showNotice(_message: string) {
  if (state?.mode === 'empty') return;
  const box = element('notice'); box.textContent = 'This content is unavailable.'; box.hidden = false;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { box.hidden = true; }, 7000);
}
function hideLoading() { loading.hidden = true; }
function showLoading() { loading.hidden = false; }
function mediaUrl(item: MediaItem, revision: number) { return `${item.url}&revision=${revision}`; }
async function loadImage(src: string, signal: AbortSignal): Promise<HTMLImageElement> {
  const image = new Image(); image.decoding = 'async'; image.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Image loading timed out.')), 15000);
    function finish(error?: Error) { clearTimeout(timeout); image.onload = image.onerror = null; signal.removeEventListener('abort', aborted); if (error) { release(image); reject(error); } else resolve(); }
    function aborted() { finish(new DOMException('Cancelled', 'AbortError')); }
    image.onload = () => finish(); image.onerror = () => finish(new Error('Image cannot be decoded.'));
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted(); else image.src = src;
  });
  await image.decode();
  if (signal.aborted) { release(image); throw new DOMException('Cancelled', 'AbortError'); }
  return image;
}
async function loadVideo(src: string, signal: AbortSignal): Promise<HTMLVideoElement> {
  const video = document.createElement('video'); video.preload = 'auto'; video.playsInline = true; video.muted = true; video.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Video loading timed out.')), 20000);
    function finish(error?: Error) { clearTimeout(timeout); video.onloadeddata = video.onerror = null; signal.removeEventListener('abort', aborted); if (error) { release(video); reject(error); } else resolve(); }
    function aborted() { finish(new DOMException('Cancelled', 'AbortError')); }
    video.onloadeddata = () => finish();
    video.onerror = () => finish(new Error(`Video cannot be decoded (code ${video.error?.code ?? '?'}). Try MP4 with H.264 video and AAC audio.`));
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted(); else { video.src = src; video.load(); }
  });
  return video;
}
function paintCover(canvas: HTMLCanvasElement, source: HTMLImageElement | HTMLVideoElement) {
  const width = source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth;
  const height = source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight;
  if (!width || !height) return;
  canvas.width = 480; canvas.height = Math.max(1, Math.round(480 * innerHeight / innerWidth));
  const ratio = Math.max(canvas.width / width, canvas.height / height);
  canvas.getContext('2d', { alpha: false })?.drawImage(source, (canvas.width - width * ratio) / 2, (canvas.height - height * ratio) / 2, width * ratio, height * ratio);
}
function backdropFor(layer: HTMLElement, source: HTMLImageElement | HTMLVideoElement): () => void {
  const canvas = document.createElement('canvas'); canvas.className = 'backdrop'; layer.append(canvas);
  let stopped = false, frame: number | undefined;
  const draw = () => { try { paintCover(canvas, source); } catch { /* A frame may disappear during cancellation. */ } };
  draw();
  if (source instanceof HTMLVideoElement) {
    // Reuse the foreground decoder. Only the small, heavily blurred background is sampled at 12 fps.
    const update = (now: number) => {
      if (stopped) return;
      if (now - lastFrameStamp >= 83) { draw(); lastFrameStamp = now; }
      frame = source.requestVideoFrameCallback(update);
    };
    frame = source.requestVideoFrameCallback(update);
  }
  window.addEventListener('resize', draw);
  return () => { stopped = true; if (frame !== undefined && source instanceof HTMLVideoElement) source.cancelVideoFrameCallback(frame); window.removeEventListener('resize', draw); };
}
async function showMedia(revision: number, signal: AbortSignal) {
  const item = state.items[state.index]; if (!item) return;
  showLoading();
  let source: HTMLImageElement | HTMLVideoElement | undefined;
  try {
    source = item.kind === 'video' ? await loadVideo(mediaUrl(item, revision), signal) : await loadImage(mediaUrl(item, revision), signal);
    if (signal.aborted || state.revision !== revision) { release(source); return; }
    const layer = document.createElement('div'); layer.className = 'media-layer'; layer.dataset.file = item.name;
    const stop = backdropFor(layer, source);
    source.className = 'foreground'; layer.append(source); stage.append(layer);
    const old = current; current = { layer, media: source, stop };
    // Animate the decoded incoming layer explicitly. A CSS class added in the first
    // animation frame can be coalesced with insertion and skip the opacity transition.
    layer.classList.add('active');
    const fade = layer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: config.transitionMilliseconds, easing: 'ease' });
    void fade.finished.catch(() => {}).then(() => { if (old) { old.stop(); release(old.media); old.layer.remove(); } });
    for (const panel of [welcome, library]) if (!panel.hidden) {
      panel.getAnimations().forEach(animation => animation.cancel());
      panel.animate([{ opacity: 1 }, { opacity: 0 }], { duration: config.transitionMilliseconds, fill: 'forwards' });
      void delay(config.transitionMilliseconds + 20).then(() => { if (state.revision === revision && state.mode === 'media') { panel.hidden = true; panel.getAnimations().forEach(animation => animation.cancel()); } });
    }
    hideLoading();
    if (signal.aborted || state.revision !== revision) return;
    if (source instanceof HTMLVideoElement) {
      source.volume = config.volume; source.muted = config.mute;
      source.onended = () => api.ended(revision);
      source.onerror = () => { if (state.revision === revision) api.failed(revision, `${item.name}: playback failed.`); };
      try { await source.play(); } catch (error) { if (!signal.aborted) api.failed(revision, `${item.name}: ${String(error)}`); }
    }
    api.ready(revision);
    fadeSnapshot(revision);
  } catch (error) {
    if (source) release(source);
    if (!signal.aborted && state.revision === revision) { hideLoading(); api.failed(revision, `${item.name}: ${String(error)}`); }
  }
}
function fadeSnapshot(revision: number) {
  snapshot.classList.add('fading');
  void delay(config.transitionMilliseconds + 30).then(() => {
    if (state.revision === revision) { snapshot.hidden = true; snapshot.removeAttribute('src'); }
  });
}
function pumpThumbnails() {
  while (thumbRunning < 2 && thumbQueue.length) {
    const task = thumbQueue.shift()!; thumbRunning++;
    void task().finally(() => { thumbRunning--; pumpThumbnails(); });
  }
}
function resetThumbnails(clearCache = false) {
  thumbEpoch++; thumbQueue = []; observer?.disconnect();
  for (const controller of thumbnailControllers) controller.abort();
  thumbnailControllers.clear();
  if (clearCache) thumbCache.clear();
}
async function thumbnail(item: MediaItem, epoch: number, tile: HTMLElement, revision: number) {
  if (epoch !== thumbEpoch) return;
  const preview = tile.querySelector('.tile-preview')!;
  const cached = thumbCache.get(item.url);
  if (cached) { const img = new Image(); img.src = cached; preview.replaceChildren(img); return; }
  const controller = new AbortController(); thumbnailControllers.add(controller);
  let source: HTMLImageElement | HTMLVideoElement | undefined;
  try {
    source = item.kind === 'image' ? await loadImage(mediaUrl(item, revision), controller.signal) : await loadVideo(mediaUrl(item, revision), controller.signal);
    if (epoch !== thumbEpoch || controller.signal.aborted) return;
    const canvas = document.createElement('canvas');
    const width = source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth;
    const height = source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight;
    canvas.width = 640; canvas.height = Math.max(1, Math.round(640 * height / width));
    // Bound portrait thumbnails as well as landscape thumbnails.
    if (canvas.height > 640) { canvas.width = Math.max(1, Math.round(640 * width / height)); canvas.height = 640; }
    canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/jpeg', .8);
    thumbCache.set(item.url, data);
    if (thumbCache.size > 256) thumbCache.delete(thumbCache.keys().next().value!);
    const img = new Image(); img.alt = ''; img.src = data; preview.replaceChildren(img);
  } catch { if (epoch === thumbEpoch) preview.textContent = item.kind === 'video' ? '▶' : '◇'; }
  finally { if (source) release(source); thumbnailControllers.delete(controller); }
}
function showThumbnails() {
  const signature = state.items.map(item => item.path).join('\n');
  const animate = library.hidden || renderedFolder !== state.folder || signature !== gridSignature;
  if (renderedFolder !== state.folder || signature !== gridSignature) {
    resetThumbnails(); grid.replaceChildren(); renderedFolder = state.folder; gridSignature = signature;
    const epoch = thumbEpoch, revision = state.revision;
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        observer?.unobserve(entry.target);
        const tile = entry.target as HTMLElement, item = state.items[Number(tile.dataset.index)];
        if (item) thumbQueue.push(() => thumbnail(item, epoch, tile, revision));
      }
      pumpThumbnails();
    }, { root: grid, rootMargin: '200px' });
    state.items.forEach((item, index) => {
      const tile = document.createElement('button'); tile.className = 'tile'; tile.dataset.index = String(index); tile.setAttribute('role', 'option');
      tile.setAttribute('aria-label', `${item.kind === 'video' ? 'Video' : 'Image'} ${index + 1}`);
      const preview = document.createElement('div'); preview.className = 'tile-preview'; preview.textContent = item.kind === 'video' ? '▶' : '◇';
      tile.append(preview);
      if (item.kind === 'video') { const tag = document.createElement('span'); tag.className = 'video-label'; tag.textContent = '▶'; tag.setAttribute('aria-hidden', 'true'); tile.append(tag); }
      tile.addEventListener('click', () => api.select(index)); grid.append(tile); observer?.observe(tile);
    });
  }
  for (const tile of grid.children) {
    const index = Number((tile as HTMLElement).dataset.index);
    (tile as HTMLElement).hidden = Math.floor(index / 15) !== Math.floor(state.index / 15);
    const selected = index === state.index;
    tile.classList.toggle('selected', selected); tile.setAttribute('aria-selected', String(selected));
  }
  welcome.hidden = true; library.hidden = false; hideLoading();
  library.getAnimations().forEach(animation => animation.cancel());
  if (animate) library.animate([{ opacity: 0 }, { opacity: 1 }], { duration: config.transitionMilliseconds });
  const preceding = current; current = undefined;
  if (preceding) void delay(config.transitionMilliseconds + 20).then(() => { preceding.stop(); release(preceding.media); preceding.layer.remove(); });
  fadeSnapshot(state.revision);
}
async function render(message: RenderMessage) {
  pending?.abort(); pending = new AbortController();
  pauseCurrent(); state = message.state; config = message.config;
  element('app-version').textContent = `${message.appInfo.name} ${message.appInfo.version}`;
  document.documentElement.style.setProperty('--transition', `${config.transitionMilliseconds}ms`);
  surface.classList.remove('reveal');
  if (message.snapshot) { snapshot.src = message.snapshot; snapshot.classList.remove('fading'); snapshot.hidden = false; }
  if (state.mode === 'web') { showLoading(); return; }
  if (state.mode === 'empty') { await showEmpty(state.revision, pending.signal); return; }
  if (state.mode === 'thumbs') { showThumbnails(); return; }
  resetThumbnails(); renderedFolder = ''; gridSignature = '';
  await showMedia(state.revision, pending.signal);
}
api.onRender(message => { void render(message); });
api.onRevealWeb(revision => {
  if (state?.revision !== revision || state.mode !== 'web') return;
  pending?.abort(); pauseCurrent(); hideLoading(); surface.classList.add('reveal');
  void delay(config.transitionMilliseconds + 30).then(() => {
    if (state.revision !== revision || state.mode !== 'web') return;
    destroyCurrent(); snapshot.hidden = true; snapshot.removeAttribute('src');
    api.revealed(revision);
  });
});
api.onClear(() => { resetThumbnails(true); renderedFolder = ''; gridSignature = ''; });
api.onPause(() => { pending?.abort(); pauseCurrent(); resetThumbnails(); });
api.onNotice(showNotice);
document.addEventListener('keydown', event => {
  if (!state || !['media', 'thumbs'].includes(state.mode)) return;
  const command = event.key === 'ArrowRight' ? 'Next' : event.key === 'ArrowLeft' ? 'Previous' : event.key === 'Enter' ? 'Enter' : '';
  if (command) { event.preventDefault(); void api.command(command).catch(error => showNotice(String(error))); }
});
document.addEventListener('mousemove', () => {
  document.body.classList.remove('cursor-hidden'); clearTimeout(cursorTimer);
  if (state?.mode === 'media') cursorTimer = setTimeout(() => document.body.classList.add('cursor-hidden'), 2000);
});
api.initialized();
