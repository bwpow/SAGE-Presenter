import { app, BaseWindow, BrowserWindow, WebContentsView, Menu, Tray, nativeImage, screen, session, ipcMain,
  protocol, dialog, powerSaveBlocker, type Session, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import dgram from 'node:dgram';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { parseCommand, validateConfig, initialState, navigate, readFolder, within, validUrl, LineBuffer, daemonArguments } from './core';
import type { Command, Config, State } from './shared';

const argument = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const configPath = path.resolve(argument('--config') ?? path.join(app.isPackaged ? path.dirname(process.execPath) : app.getAppPath(), 'config.json'));
if (process.argv.includes('--daemon') && !process.argv.includes('--list-displays')) {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  // Spawn directly with an argument array: paths with spaces never pass through a shell.
  const child = spawn(process.execPath, daemonArguments(process.argv.slice(1), configPath), {
    cwd: process.cwd(), env: environment, detached: true, stdio: 'ignore', windowsHide: true
  });
  child.once('spawn', () => { child.unref(); app.exit(0); });
  child.once('error', error => {
    dialog.showErrorBox('SAGE Presenter daemon launch failed', error.message);
    app.exit(1);
  });
} else runPresenter();

function runPresenter() {
let config: Config;
try { config = validateConfig(JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')), path.dirname(configPath)); }
catch (error) { dialog.showErrorBox('SAGE Presenter configuration error', `${configPath}\n\n${String(error)}`); app.exit(1); throw error; }
// Stable across moving the portable folder to another drive or computer.
const instanceKey = crypto.createHash('sha256').update(`${path.basename(configPath).toLowerCase()}:${config.listenPort}`).digest('hex').slice(0, 16);
const dataPath = path.join(config.dataFolder, 'instances', instanceKey);
try {
  for (const child of ['', 'session', 'logs', 'crash-dumps']) fs.mkdirSync(path.join(dataPath, child), { recursive: true });
  fs.accessSync(dataPath, fs.constants.W_OK);
  app.setPath('userData', dataPath);
  app.setPath('sessionData', path.join(dataPath, 'session'));
  app.setPath('crashDumps', path.join(dataPath, 'crash-dumps'));
  app.setAppLogsPath(path.join(dataPath, 'logs'));
} catch (error) {
  dialog.showErrorBox('SAGE Presenter data folder error', `Cannot use the configured data folder:\n${dataPath}\n\n${String(error)}`);
  app.exit(1); throw error;
}
app.setName('SAGE Presenter');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
protocol.registerSchemesAsPrivileged([{ scheme: 'presenter-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
const testWindow = process.argv.includes('--test-window');
const listDisplays = process.argv.includes('--list-displays');
if (!listDisplays && !app.requestSingleInstanceLock()) { app.exit(0); }

let win: BaseWindow;
let media: WebContentsView;
let web: WebContentsView;
let tray: Tray | undefined;
let webSession: Session;
let mediaSession: Session;
let state = initialState();
let timer: NodeJS.Timeout | undefined;
let uiReady = false;
let closing = false;
let webVisible = false;
let webLoaded = false;
let loadToken = 0;
let failures = 0;
let displayMissing = false;
let hiddenToTray = false;
let queue = Promise.resolve();
let pendingCommands = 0;
let server: net.Server;
let udp: dgram.Socket | undefined;
let udpBound = false;
const sockets = new Set<net.Socket>();
const logPath = path.join(dataPath, 'logs', 'presenter.log');
function log(message: string) {
  try {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 1048576) fs.renameSync(logPath, `${logPath}.previous`);
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
  } catch { /* Logging must never stop presentation. */ }
}
function notice(message: string) {
  log(message);
  if (uiReady && !media.webContents.isDestroyed()) media.webContents.send('notice', message);
}
function cancelTimer() { if (timer) clearTimeout(timer); timer = undefined; }
function sendRender(snapshot?: string) {
  if (uiReady) media.webContents.send('render', { state, config, appInfo: { name: app.getName(), version: app.getVersion() }, snapshot });
}
function trusted(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return event.sender === media.webContents && event.senderFrame === media.webContents.mainFrame;
}
function status() {
  return { ok: true, instanceName: config.instanceName, processId: process.pid, daemonized: process.argv.includes('--daemon-child'), port: config.listenPort, configPath, dataFolder: config.dataFolder, instanceDataFolder: dataPath, mode: state.mode,
    revision: state.revision, url: state.mode === 'web' ? web.webContents.getURL() || state.url : state.url,
    folder: state.folder, file: state.items[state.index]?.name ?? null, index: state.index, count: state.items.length,
    auto: state.auto, displayMissing, webVisible, hidden: !win.isVisible() };
}
async function dispatch(command: Command) {
  if (command.type === 'status') return status();
  if (command.type === 'clear') { await clearAndReload(); return status(); }
  if (command.type === 'hide') { hiddenToTray = true; win.hide(); return status(); }
  if (command.type === 'resume') {
    if (hiddenToTray) { hiddenToTray = false; applyDisplay(); }
    return status();
  }
  if (command.type === 'quit') {
    const reply = status();
    setTimeout(() => app.quit(), 100);
    return reply;
  }
  let next: State;
  if (command.type === 'folder' || command.type === 'autofolder' || command.type === 'thumbs') {
    const listing = await readFolder(config.mediaRoot, command.folder, command.file);
    next = { ...state, ...listing, mode: command.type === 'thumbs' ? 'thumbs' : 'media', auto: command.type === 'autofolder', revision: state.revision + 1 };
  } else next = navigate(state, command);
  if (next !== state) {
    cancelTimer(); failures = 0; state = next;
    void present().catch(error => notice(String(error)));
  }
  return status();
}
function enqueue(command: Command): Promise<ReturnType<typeof status>> {
  if (pendingCommands >= 128) return Promise.reject(new Error('Command queue is full.'));
  pendingCommands++;
  const result = queue.then(() => dispatch(command));
  queue = result.then(() => { pendingCommands--; }, () => { pendingCommands--; });
  return result;
}

// Commands never wait for page loads, video decoding or animation. Revision checks reject stale completions.
async function present(forceReload = false) {
  const revision = state.revision;
  if (state.mode === 'web') {
    const requestedUrl = state.url;
    if (!forceReload && webLoaded && requestedUrl === web.webContents.getURL()) {
      sendRender();
      revealWeb(revision); return;
    }
    let snapshot: string | undefined;
    if (webVisible) {
      try { snapshot = (await web.webContents.capturePage()).toDataURL(); } catch { /* Retain preceding content if capture fails. */ }
    }
    if (revision !== state.revision || closing) return;
    sendRender(snapshot);
    media.setVisible(true);
    web.setVisible(false);
    web.webContents.setAudioMuted(true);
    webVisible = false;
    webLoaded = false;
    const token = ++loadToken;
    void web.webContents.loadURL(requestedUrl, forceReload ? { extraHeaders: 'Pragma: no-cache\nCache-Control: no-cache\n' } : {}).then(() => {
      if (token !== loadToken || closing) return;
      webLoaded = true;
      if (state.revision === revision && state.mode === 'web') {
        state = { ...state, url: web.webContents.getURL() };
        revealWeb(revision);
      }
    }).catch(error => {
      if (state.revision === revision) notice(`Cannot load webpage: ${error.message}`);
    });
    return;
  }
  let snapshot: string | undefined;
  if (webVisible) {
    try { snapshot = (await web.webContents.capturePage()).toDataURL(); } catch { /* Fade without a snapshot if capture fails. */ }
  }
  if (state.revision !== revision || closing) return;
  sendRender(snapshot);
  media.setVisible(true);
  web.setVisible(false);
  web.webContents.setAudioMuted(true);
  webVisible = false;
}
function revealWeb(revision: number) {
  if (state.mode !== 'web' || state.revision !== revision || closing) return;
  web.setVisible(true);
  web.webContents.setAudioMuted(config.mute);
  webVisible = true;
  // The overlay fades away, then is removed from hit testing so mouse input reaches the real webpage.
  media.webContents.send('reveal-web', revision);
}
async function clearAndReload() {
  cancelTimer();
  const currentUrl = state.mode === 'web' ? web.webContents.getURL() : '';
  // Invalidate old ready/ended callbacks before asynchronous cache operations.
  state = { ...state, revision: state.revision + 1 };
  if (uiReady) media.webContents.send('pause-media');
  await Promise.all([
    webSession.clearCache(), mediaSession.clearCache(),
    webSession.clearStorageData({ storages: ['cachestorage', 'serviceworkers'] })
  ]);
  media.webContents.send('clear-media-cache');
  if (state.mode === 'web') {
    if (currentUrl && /^https?:/.test(currentUrl)) state = { ...state, url: currentUrl };
  } else if (state.mode === 'media' || state.mode === 'thumbs') {
    const selected = state.items[state.index]?.name;
    const listing = await readFolder(config.mediaRoot, state.folder);
    const index = Math.max(0, listing.items.findIndex(item => item.name === selected));
    state = { ...state, ...listing, index };
  }
  state = { ...state, revision: state.revision + 1 };
  failures = 0;
  await present(true);
}

function orderedDisplays() {
  return screen.getAllDisplays().sort((a, b) => (a.id === screen.getPrimaryDisplay().id ? -1 : b.id === screen.getPrimaryDisplay().id ? 1 : a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y || a.id - b.id));
}
function applyDisplay() {
  if (closing || !win) return;
  if (testWindow) { if (hiddenToTray) { win.hide(); return; } win.setBounds({ x: 40, y: 40, width: 1100, height: 740 }); win.show(); layout(); return; }
  const displays = orderedDisplays();
  let target = config.displayId === undefined ? displays[config.monitor - 1] : displays.find(display => display.id === config.displayId);
  displayMissing = !target;
  if (!target && config.missingMonitor === 'primary') target = screen.getPrimaryDisplay();
  if (!target || hiddenToTray) {
    win.hide();
    tray?.setToolTip(!target ? `${config.instanceName} — waiting for monitor ${config.monitor} — TCP ${config.listenPort}` : `${config.instanceName} — hidden — TCP ${config.listenPort}`);
  } else {
    win.setBounds(target.bounds);
    win.setAlwaysOnTop(config.alwaysOnTop, 'screen-saver');
    win.showInactive();
    layout();
    tray?.setToolTip(`${config.instanceName} — monitor ${config.monitor} — TCP ${config.listenPort}`);
  }
  rebuildTray();
}
function showPresentation() {
  hiddenToTray = false;
  applyDisplay();
  if (!displayMissing && win.isVisible()) win.focus();
}
function layout() {
  if (!media || !web) return;
  const { width, height } = win.getContentBounds();
  for (const view of [web, media]) view.setBounds({ x: 0, y: 0, width, height });
}
function identifyDisplays() {
  for (const [index, display] of orderedDisplays().entries()) {
    const label = new BrowserWindow({ ...display.bounds, width: 520, height: 250, frame: false, alwaysOnTop: true, skipTaskbar: true,
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
    const html = `<body style="margin:0;background:#101923;color:#fff;font:24px system-ui;padding:28px"><b style="font-size:64px">${index + 1}</b><br>SAGE Presenter display · ID ${display.id}<br>${display.size.width} × ${display.size.height}</body>`;
    void label.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    setTimeout(() => { if (!label.isDestroyed()) label.destroy(); }, 3500);
  }
}
function rebuildTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: config.instanceName, enabled: false },
    { label: `TCP 127.0.0.1:${config.listenPort}`, enabled: false },
    { type: 'separator' },
    { label: 'Show presentation', click: showPresentation },
    { label: 'Identify displays', click: identifyDisplays },
    { label: 'Display (this run)', submenu: orderedDisplays().map((display, index) => ({
      label: `${index + 1}: ${display.label || 'Display'} (${display.size.width} × ${display.size.height}, ID ${display.id})`,
      type: 'radio' as const, checked: config.displayId === undefined ? config.monitor === index + 1 : config.displayId === display.id,
      click: () => { config.monitor = index + 1; config.displayId = display.id; showPresentation(); }
    })) },
    { label: 'Clear cache and reload', click: () => { void enqueue({ type: 'clear' }).catch(error => notice(String(error))); } },
    { type: 'separator' },
    { label: 'Close', click: () => app.quit() }
  ]));
}

async function installMediaProtocol() {
  const root = await fsp.realpath(config.mediaRoot);
  mediaSession.protocol.handle('presenter-media', async request => {
    try {
      const url = new URL(request.url);
      const isEmptyImage = url.pathname === '/empty';
      if (url.hostname !== 'local' || (!isEmptyImage && url.pathname !== '/file') || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 403 });
      const filename = await fsp.realpath(isEmptyImage ? config.emptyImage : url.searchParams.get('path') ?? '');
      if (!isEmptyImage && !within(root, filename)) return new Response(null, { status: 403 });
      const types: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
        '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif', '.mp4': 'video/mp4', '.mov': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg' };
      const mime = types[path.extname(filename).toLowerCase()];
      if (isEmptyImage && !mime?.startsWith('image/')) return new Response(null, { status: 403 });
      const stat = await fsp.stat(filename);
      if (!mime || !stat.isFile()) return new Response(null, { status: 403 });
      let start = 0, end = stat.size - 1;
      const headers: Record<string, string> = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
      const range = request.headers.get('range');
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
        if (!match[1]) start = Math.max(0, stat.size - Number(match[2]));
        else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
        if (start > end || start >= stat.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
        headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      }
      headers['Content-Length'] = String(Math.max(0, end - start + 1));
      const body = request.method === 'HEAD' || !stat.size ? null : Readable.toWeb(fs.createReadStream(filename, { start, end })) as ReadableStream;
      return new Response(body, { status: range ? 206 : 200, headers });
    } catch { return new Response('Media unavailable', { status: 404 }); }
  });
}
async function startSocket() {
  server = net.createServer({ allowHalfOpen: true }, socket => {
    if (sockets.size >= 32) { socket.destroy(); return; }
    sockets.add(socket); socket.setNoDelay(true); socket.setTimeout(60000);
    const buffer = new LineBuffer();
    let replies = Promise.resolve();
    const receive = (lines: string[]) => {
      for (const line of lines) {
        let task: Promise<unknown>;
        try { task = enqueue(parseCommand(line)); }
        catch (error) { task = Promise.reject(error); }
        // Attach rejection immediately; replies retain command order even when parsing fails.
        const reply = task.then(value => value, error => ({ ok: false, error: String(error) }));
        replies = replies.then(async () => { const value = await reply; if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`); });
      }
    };
    socket.on('data', chunk => { try { receive(buffer.push(chunk)); } catch { socket.destroy(); } });
    socket.on('end', () => { receive(buffer.end()); void replies.finally(() => socket.end()); });
    socket.on('timeout', () => socket.end());
    socket.on('error', error => log(`Socket: ${error.message}`));
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.listenPort, config.listenHost, resolve); });
  server.on('error', error => notice(`Socket error: ${error.message}`));
  udp = dgram.createSocket('udp4');
  udp.on('message', (message, remote) => {
    if (closing || remote.address !== '127.0.0.1') return;
    const reply = (value: unknown) => {
      if (!closing && udpBound) udp!.send(Buffer.from(JSON.stringify(value)), remote.port, remote.address,
        error => { if (error) log(`UDP reply: ${error.message}`); });
    };
    try {
      const line = message.toString('utf8').trim();
      if (!line || /[\r\n]/.test(line)) throw new Error('Send one command per UDP datagram.');
      void enqueue(parseCommand(line)).then(reply, error => reply({ ok: false, error: String(error) }));
    } catch (error) { reply({ ok: false, error: String(error) }); }
  });
  await new Promise<void>((resolve, reject) => {
    udp!.once('error', reject);
    udp!.bind(config.listenPort, config.listenHost, () => { udpBound = true; udp!.removeListener('error', reject); resolve(); });
  });
  udp.on('error', error => log(`UDP socket: ${error.message}`));
}

app.whenReady().then(async () => {
  if (listDisplays) { console.log(JSON.stringify(orderedDisplays().map((display, index) => ({ monitor: index + 1, ...display })), null, 2)); app.quit(); return; }
  await startSocket();
  webSession = session.fromPartition('persist:web');
  mediaSession = session.fromPartition('media');
  webSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  webSession.setPermissionCheckHandler(() => false);
  webSession.on('will-download', event => event.preventDefault());
  await installMediaProtocol();
  win = new BaseWindow({ title: config.instanceName, width: 1100, height: 740, frame: testWindow, show: false,
    backgroundColor: '#080b10', autoHideMenuBar: true, skipTaskbar: !testWindow, resizable: testWindow });
  web = new WebContentsView({ webPreferences: { session: webSession, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  media = new WebContentsView({ webPreferences: { session: mediaSession, sandbox: true, contextIsolation: true, nodeIntegration: false,
    preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  media.setBackgroundColor('#00000000');
  media.webContents.on('console-message', (_event, level, message) => { if (level >= 2) log(`Media UI: ${message}`); });
  win.contentView.addChildView(web); win.contentView.addChildView(media); web.setVisible(false);
  web.webContents.setWindowOpenHandler(({ url }) => { try { void enqueue({ type: 'url', url: validUrl(url) }); } catch { /* Non-web popup schemes are not launched. */ } return { action: 'deny' }; });
  web.webContents.on('will-navigate', (event, url) => { try { validUrl(url); } catch { event.preventDefault(); } });
  web.webContents.on('did-finish-load', () => {
    if (webVisible && state.mode === 'web') webLoaded = true;
  });
  web.webContents.on('did-navigate', (_event, url) => { if (webVisible && state.mode === 'web') state = { ...state, url }; });
  web.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame && webVisible && state.mode === 'web') state = { ...state, url }; });
  web.webContents.on('render-process-gone', (_event, details) => { webLoaded = false; notice(`Web renderer stopped (${details.reason}). Use Clear cache and reload.`); });
  media.webContents.on('render-process-gone', (_event, details) => {
    cancelTimer(); uiReady = false; log(`Media renderer stopped: ${details.reason}`);
    if (!closing) setTimeout(() => { if (!closing) void media.webContents.loadFile(path.join(__dirname, 'index.html')); }, 1000);
  });
  media.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  media.webContents.on('will-navigate', event => event.preventDefault());
  ipcMain.handle('command', (event, line: unknown) => {
    if (!trusted(event) || typeof line !== 'string' || line.length > 8192) throw new Error('Invalid command sender.');
    return enqueue(parseCommand(line));
  });
  ipcMain.on('select', (event, index: number) => { if (trusted(event)) void enqueue({ type: 'select', index }).catch(error => notice(String(error))); });
  ipcMain.on('initialized', event => { if (trusted(event)) { uiReady = true; void present(); } });
  ipcMain.on('ready', (event, revision: number) => {
    if (!trusted(event) || revision !== state.revision || state.mode !== 'media') return;
    failures = 0; cancelTimer();
    if (state.auto && state.items[state.index]?.kind === 'image') timer = setTimeout(() => {
      if (state.revision === revision) void enqueue({ type: 'next' });
    }, config.imageDurationSeconds * 1000);
  });
  ipcMain.on('ended', (event, revision: number) => {
    if (trusted(event) && revision === state.revision && state.mode === 'media' && state.auto && state.items[state.index]?.kind === 'video') void enqueue({ type: 'next' });
  });
  ipcMain.on('failed', (event, revision: number, message: string) => {
    if (!trusted(event) || revision !== state.revision) return;
    if (state.mode === 'empty') log(message); else notice(message);
    cancelTimer();
    if (state.auto && ++failures < state.items.length) timer = setTimeout(() => {
      if (state.revision !== revision) return;
      // Keep failure count across automatically skipped broken files.
      state = navigate(state, { type: 'next' }); void present();
    }, 2000);
  });
  ipcMain.on('revealed', (event, revision: number) => {
    if (trusted(event) && state.mode === 'web' && state.revision === revision) { media.setVisible(false); web.webContents.focus(); }
  });
  const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
  tray = new Tray(icon.resize({ width: 32, height: 32 }));
  tray.on('double-click', showPresentation);
  rebuildTray();
  win.on('resize', layout);
  win.on('closed', () => app.quit());
  screen.on('display-added', applyDisplay);
  screen.on('display-removed', applyDisplay);
  screen.on('display-metrics-changed', applyDisplay);
  app.on('second-instance', showPresentation);
  powerSaveBlocker.start('prevent-display-sleep');
  await media.webContents.loadFile(path.join(__dirname, 'index.html'));
  applyDisplay();
  log(`Started ${config.instanceName}, TCP/UDP ${config.listenPort}, ${configPath}`);
}).catch(error => { log(String(error)); dialog.showErrorBox('SAGE Presenter could not start', `${String(error)}\n\nConfig: ${configPath}`); app.quit(); });
app.on('before-quit', () => {
  closing = true; cancelTimer();
  if (udpBound) { udpBound = false; udp?.close(); }
  for (const socket of sockets) socket.destroy();
  server?.close(); tray?.destroy();
  if (media && !media.webContents.isDestroyed()) media.webContents.close();
  if (web && !web.webContents.isDestroyed()) web.webContents.close();
});
app.on('window-all-closed', () => { if (!closing) app.quit(); });
}
