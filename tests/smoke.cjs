/* Run with NODE_PATH pointing to a Playwright installation. Uses only Presenter test processes. */
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const work = path.join(root, 'work', 'smoke');
const fixtureRoot = path.join(work, 'fixtures');
const expand = line => line.replaceAll('@fixtures', fixtureRoot.replaceAll('\\', '/'));
const { fixtures } = require('./fixtures.cjs');
let first, second, fixture;
const results = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 15000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { last = await check(); if (last) return last; } catch (error) { last = error.message; }
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}; last=${JSON.stringify(last)}`);
}
async function command(port, line, fragmented = false) {
  line = expand(line);
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1'); let buffer = '';
    socket.setTimeout(10000); socket.on('error', reject); socket.on('timeout', () => { socket.destroy(); reject(new Error('Socket timeout')); });
    socket.on('connect', () => {
      if (fragmented) { socket.write(line.slice(0, 3)); setTimeout(() => socket.write(`${line.slice(3)}\r\n`), 20); }
      else socket.write(`${line}\n`);
    });
    socket.on('data', chunk => { buffer += chunk; if (buffer.includes('\n')) { socket.destroy(); resolve(JSON.parse(buffer.split('\n')[0])); } });
  });
}
async function evaluate(app, script, kind = 'media') {
  return app.evaluate(async ({ webContents }, { script, kind }) => {
    const contents = webContents.getAllWebContents().find(item => kind === 'media' ? item.getURL().startsWith('file:') : /^https?:/.test(item.getURL()));
    if (!contents) return null;
    return contents.executeJavaScript(script);
  }, { script, kind });
}
async function datagram(line) {
  line = expand(line);
  const socket = require('node:dgram').createSocket('udp4');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('UDP timeout')); }, 5000);
    socket.once('error', error => { clearTimeout(timer); socket.close(); reject(error); });
    socket.once('message', data => { clearTimeout(timer); socket.close(); resolve(JSON.parse(data)); });
    socket.send(Buffer.from(line), 49781, '127.0.0.1');
  });
}
async function screenshot(app, filename, kind = 'media') {
  const data = await app.evaluate(async ({ webContents }, kind) => {
    const contents = webContents.getAllWebContents().find(item => kind === 'media' ? item.getURL().startsWith('file:') : /^https?:/.test(item.getURL()));
    return (await contents.capturePage()).toPNG().toString('base64');
  }, kind);
  await fs.writeFile(path.join(work, filename), Buffer.from(data, 'base64'));
}
async function check(label, fn) { await fn(); results.push(label); console.log(`PASS ${label}`); }
async function launch(configPath, windowed = true) {
  if (process.env.PRESENTER_EXE) return require('./portable-launch.cjs')(process.env.PRESENTER_EXE,
    ['--config', configPath, ...(windowed ? ['--test-window'] : [])]);
  return electron.launch({
    executablePath: process.env.PRESENTER_EXE || path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: ['-r', path.join(path.dirname(require.resolve('playwright-core')), 'lib/server/electron/loader.js'), '-r', path.join(root, 'tests/harness.cjs'), ...(process.env.PRESENTER_EXE ? [] : [root]), '--config', configPath, ...(windowed ? ['--test-window'] : [])],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, timeout: 30000
  });
}
(async () => {
  await fs.mkdir(work, { recursive: true });
  await fixtures(fixtureRoot);
  fixture = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Presenter interaction fixture</title><style>body{height:4000px;background:#173141;color:white;font:24px sans-serif}button{padding:20px}</style><h1>Interactive webpage</h1><button id="counter" onclick="this.textContent=++window.count">0</button><script>window.count=0</script>');
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;
  const base = JSON.parse(await fs.readFile(path.join(root, 'config.example.json'), 'utf8'));
  const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  await fs.copyFile(path.join(fixtureRoot, 'empty.png'), path.join(work, 'empty.png'));
  for (const [name, port] of [['first', 49781], ['second', 49782]]) await fs.writeFile(path.join(work, `${name}.json`), JSON.stringify({ ...base,
    instanceName: `Presenter test ${name}`, monitor: 1, alwaysOnTop: false, listenPort: port, startupUrl: fixtureUrl,
    emptyImage: path.join(work, 'empty.png'), mediaRoot: name === 'second' ? path.join(fixtureRoot,'sequence') : work,
    imageDurationSeconds: .6, transitionMilliseconds: 80, mute: true }));
  first = await launch(path.join(work, 'first.json'));
  first.process().stderr.on('data', data => { fs.appendFile(path.join(work, 'electron-stderr.log'), data).catch(() => {}); });
  await waitFor(() => evaluate(first, 'Boolean(window.presenter)'), 'preload bridge');
  await check('Startup Empty page has original-size centered image, sampled background and name/version only', async () => {
    assert.equal((await command(49781, 'Status')).mode, 'empty');
    await waitFor(() => evaluate(first, 'document.querySelector("#empty-picture img")?.naturalWidth === 756'), 'startup logo');
    const info = await evaluate(first, `(()=>{const p=document.querySelector('#empty-picture img'); const r=p.getBoundingClientRect(); return {text:document.body.innerText.trim(),bg:getComputedStyle(document.getElementById('welcome')).backgroundColor,width:r.width*devicePixelRatio,height:r.height*devicePixelRatio,cx:(r.left+r.width/2-innerWidth/2)*devicePixelRatio,cy:(r.top+r.height/2-innerHeight/2)*devicePixelRatio}})()`);
    assert.equal(info.text, `SAGE Presenter ${version}`); assert.equal(info.bg, 'rgb(55, 8, 71)');
    assert.ok(Math.abs(info.width - 756) < 1); assert.ok(Math.abs(info.height - 189) < 1);
    assert.ok(Math.abs(info.cx) <= .6 && Math.abs(info.cy) <= .6);
    await first.evaluate(({ webContents }) => webContents.getAllWebContents().find(item => item.getURL().startsWith('file:')).send('notice', 'Internal connection error at 127.0.0.1:49781'));
    await sleep(200);
    assert.equal(await evaluate(first, 'document.body.innerText.trim()'), `SAGE Presenter ${version}`);
    await screenshot(first, 'empty-page.png');
  });
  await check('UDP datagrams accept commands without newline and share TCP state', async () => {
    assert.equal((await datagram('Folder "@fixtures/sequence"')).file, '01.png');
    const next = await datagram('Next');
    assert.equal(next.ok, true);
    assert.equal((await command(49781, 'Status')).file, next.file);
    assert.equal((await datagram('Empty\nNext')).ok, false);
    assert.equal((await datagram('')).ok, false);
    assert.equal((await datagram(`URL "${fixtureUrl}"`)).mode, 'web');
    assert.equal((await datagram('Empty')).mode, 'empty');
  });
  await check('Incoming image crossfades over a distinct retained outgoing image', async () => {
    const fadeFolder = path.join(work, 'fade-fixture'); await fs.mkdir(fadeFolder, { recursive:true });
    for (const [name,color] of [['01.png','#ff0000'],['02.png','#0000ff']]) {
      const data = await evaluate(first, `(() => { const c=document.createElement('canvas');c.width=800;c.height=600;const x=c.getContext('2d');x.fillStyle='${color}';x.fillRect(0,0,800,600);return c.toDataURL().split(',')[1]; })()`);
      await fs.writeFile(path.join(fadeFolder,name),Buffer.from(data,'base64'));
    }
    await command(49781, `Folder "${fadeFolder}"`);
    await waitFor(() => evaluate(first, 'document.querySelectorAll(".media-layer").length === 1 && document.querySelector(".media-layer img")?.src.includes("fade-fixture") && document.querySelector(".media-layer").getAnimations().length === 0'), 'settled old image');
    await evaluate(first, `(() => { const original = Element.prototype.animate;
      Element.prototype.animate = function(frames, options) {
        const animation = original.call(this, frames, options);
        if (this.classList.contains('media-layer')) { animation.pause(); animation.currentTime = 40; window.testFade = animation; Element.prototype.animate = original; }
        return animation;
      }; })()`);
    await command(49781, 'Next');
    await waitFor(() => evaluate(first, 'Boolean(window.testFade)'), 'incoming animation');
    const layers = await evaluate(first, `Array.from(document.querySelectorAll('.media-layer')).map(layer => ({file:layer.dataset.file,opacity:Number(getComputedStyle(layer).opacity),decoded:layer.querySelector('img').naturalWidth > 0}))`);
    assert.equal(layers.length, 2); assert.notEqual(layers[0].file, layers[1].file);
    assert.equal(layers[0].opacity, 1); assert.ok(layers[1].opacity > 0 && layers[1].opacity < 1);
    assert.ok(layers.every(layer => layer.decoded));
    const pixel = await first.evaluate(async ({webContents}) => {
      const page=webContents.getAllWebContents().find(item=>item.getURL().startsWith('file:'));
      const shot=await page.capturePage();const bitmap=shot.toBitmap();const {width,height}=shot.getSize();
      const index=(Math.floor(height/2)*width+Math.floor(width/2))*4;
      return {blue:bitmap[index],green:bitmap[index+1],red:bitmap[index+2]};
    });
    assert.ok(pixel.blue > 50 && pixel.red > 10 && pixel.red < 240 && pixel.green < 10, `Foreground must blend red and blue: ${JSON.stringify(pixel)}`);
    await screenshot(first, 'crossfade.png');
    await evaluate(first, 'window.testFade.finish()');
    await waitFor(() => evaluate(first, 'document.querySelectorAll(".media-layer").length === 1'), 'old layer released');
  });
  await check('Thumbnail pages use exactly five columns and three rows with clear selection', async () => {
    const folder = path.join(work, 'grid-fixture'); await fs.mkdir(folder, { recursive: true });
    for (let i = 0; i < 31; i++) await fs.copyFile(path.join(fixtureRoot, 'empty.png'), path.join(folder, `${String(i).padStart(2, '0')}.png`));
    await command(49781, `Thumbs "${folder}"`);
    const geometry = await evaluate(first, `(() => { const grid=document.getElementById('grid'),style=getComputedStyle(grid);return {columns:style.gridTemplateColumns.split(' ').length,rows:style.gridTemplateRows.split(' ').length,visible:grid.querySelectorAll('.tile:not([hidden])').length,border:getComputedStyle(grid.querySelector('.selected')).borderTopWidth,scroll:grid.scrollHeight > grid.clientHeight}; })()`);
    assert.ok(parseFloat(geometry.border) >= 2); delete geometry.border; assert.deepEqual(geometry, { columns:5, rows:3, visible:15, scroll:false });
    for(let i=0;i<15;i++) await command(49781, 'Next');
    assert.equal(await evaluate(first, 'document.querySelector(".tile:not([hidden])").dataset.index'), '15');
    assert.equal(await evaluate(first, 'document.querySelector(".selected").hidden'), false);
    await command(49781, 'Previous');
    assert.equal(await evaluate(first, 'document.querySelector(".tile:not([hidden])").dataset.index'), '0');
    await command(49781, `Thumbs "${folder}" "30.png"`);
    assert.equal(await evaluate(first, 'document.querySelectorAll(".tile:not([hidden])").length'), 1);
    await command(49781, 'Next');
    assert.equal((await command(49781, 'Status')).index, 0);
  });
  await check('Portable data paths use configuration instead of AppData', async () => {
    const status = await command(49781, 'Status');
    assert.equal(status.dataFolder, path.join(work, 'data'));
    const locations = await first.evaluate(({ app }) => Object.fromEntries(['userData', 'sessionData', 'logs', 'crashDumps'].map(key => [key, app.getPath(key)])));
    for (const location of Object.values(locations)) assert.ok(location.startsWith(status.instanceDataFolder), location);
    await fs.access(path.join(status.instanceDataFolder, 'logs', 'presenter.log'));
  });
  await check('TCP split command, folder selection and previous/next wrap', async () => {
    assert.equal((await command(49781, 'Folder "@fixtures/sequence"', true)).file, '01.png');
    await waitFor(() => evaluate(first, 'document.querySelector(".media-layer.active")?.dataset.file === "01.png"'), 'first image');
    assert.equal((await command(49781, 'Previous')).file, '13.png');
    assert.equal((await command(49781, 'Next')).file, '01.png');
    await waitFor(() => evaluate(first, 'document.querySelector(".media-layer.active:last-child")?.dataset.file === "01.png"'), 'wrapped image');
  });
  await check('Uncropped image and blurred background', async () => {
    await command(49781, 'Folder "@fixtures/landscape" "landscape.png"');
    await waitFor(() => evaluate(first, 'document.querySelector(".media-layer:last-child")?.dataset.file === "landscape.png"'), 'image');
    const fit = await evaluate(first, '({fit:getComputedStyle(document.querySelector(".foreground")).objectFit,blur:getComputedStyle(document.querySelector(".backdrop")).filter})');
    assert.equal(fit.fit, 'contain'); assert.match(fit.blur, /blur/);
    await sleep(200); await screenshot(first, 'image.png');
  });
  await check('Thumbnails, selection, mouse open and Enter toggle', async () => {
    await command(49781, 'Thumbs "@fixtures/gallery"');
    await waitFor(() => evaluate(first, '!document.getElementById("library").hidden && document.querySelectorAll(".tile-preview img").length >= 5'), 'thumbnails', 30000);
    await command(49781, 'Next');
    assert.equal(await evaluate(first, 'document.querySelector(".selected")?.dataset.index'), '1');
    assert.equal(await evaluate(first, `document.querySelectorAll('.tile-caption,[title],#folder-name,#folder-path,#selection-name').length`), 0);
    assert.doesNotMatch(await evaluate(first, 'document.body.innerText'), /C:\\|MEDIA LIBRARY|MANUAL|Stream Deck|Listening on/i);
    await sleep(250); await screenshot(first, 'thumbnails.png');
    await evaluate(first, 'document.querySelectorAll(".tile")[2].click()');
    await waitFor(async () => (await command(49781, 'Status')).mode === 'media', 'thumbnail click');
    await command(49781, 'Enter');
    assert.equal((await command(49781, 'Status')).mode, 'thumbs');
  });
  await check('Generated H.264 MOV and MP4 videos decode and advance frames', async () => {
    for (const file of ['portrait.mov', 'sample.mp4', 'demo.mp4']) {
      await command(49781, `Folder "@fixtures/${file === 'demo.mp4' ? 'auto' : 'video'}" "${file}"`);
      await waitFor(() => evaluate(first, `(()=>{const v=document.querySelector('.media-layer:last-child video');return v && v.currentTime>.5 && v.videoWidth>0 && !v.paused})()`), file, 30000);
      const video = await evaluate(first, `(()=>{const v=document.querySelector('.media-layer:last-child video');return {file:v.parentElement.dataset.file,time:v.currentTime,width:v.videoWidth,height:v.videoHeight,frames:v.getVideoPlaybackQuality().totalVideoFrames}})()`);
      assert.equal(video.file, file); assert.ok(video.frames > 0); console.log(JSON.stringify(video));
      if (file.endsWith('.mov')) await screenshot(first, 'mov.png');
    }
  });
  await check('Auto image timing, pause in thumbnails and resume', async () => {
    await command(49781, 'AutoFolder "@fixtures/sequence"');
    await waitFor(async () => (await command(49781, 'Status')).index >= 1, 'auto image');
    await command(49781, 'Enter'); const paused = await command(49781, 'Status');
    await sleep(900); assert.equal((await command(49781, 'Status')).index, paused.index);
    await command(49781, 'Enter');
    await waitFor(async () => (await command(49781, 'Status')).index !== paused.index, 'auto resume');
  });
  await check('Automatic video plays to end then advances', async () => {
    await command(49781, 'AutoFolder "@fixtures/auto" "demo.mp4"');
    await waitFor(() => evaluate(first, 'document.querySelector(".media-layer:last-child video")?.currentTime > .5'), 'auto video');
    await sleep(1200); assert.equal((await command(49781, 'Status')).file, 'demo.mp4');
    await waitFor(async () => (await command(49781, 'Status')).file === 'after.png', 'video ended', 15000);
  });
  await check('URL interrupts media; webpage accepts mouse and wheel; same URL preserves page state', async () => {
    await command(49781, `URL "${fixtureUrl}"`);
    await waitFor(async () => (await command(49781, 'Status')).webVisible, 'web visible');
    await sleep(200);
    await first.evaluate(async ({ webContents }) => {
      const page = webContents.getAllWebContents().find(item => /^http:/.test(item.getURL()));
      const rect = await page.executeJavaScript('document.getElementById("counter").getBoundingClientRect().toJSON()');
      const point = { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
      page.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
      page.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
      page.sendInputEvent({ type: 'mouseWheel', x: 200, y: 200, deltaY: -400, deltaX: 0 });
    });
    await sleep(300); console.log('Input:', await evaluate(first, '({count:window.count,scroll:window.scrollY})', 'web'));
    await waitFor(() => evaluate(first, 'window.count === 1 && window.scrollY > 0', 'web'), 'mouse and wheel');
    await command(49781, 'Folder "@fixtures/sequence"');
    await command(49781, `URL "${fixtureUrl}"`);
    await waitFor(async () => (await command(49781, 'Status')).webVisible, 'web return');
    assert.equal(await evaluate(first, 'window.count', 'web'), 1);
    await command(49781, 'Next'); assert.equal((await command(49781, 'Status')).mode, 'web');
  });
  await check('Clear reloads webpage and restarts video; keeps instance session cookies', async () => {
    await evaluate(first, 'document.cookie="presenterTest=keep"', 'web');
    await first.evaluate(() => globalThis.presenterTestMenu.items.find(item => item.label === 'Clear cache and reload').click());
    await waitFor(() => evaluate(first, 'window.count === 0', 'web'), 'web reload');
    assert.match(await evaluate(first, 'document.cookie', 'web'), /presenterTest=keep/);
    await command(49781, 'Folder "@fixtures/auto" "demo.mp4"');
    await waitFor(() => evaluate(first, 'document.querySelector(".media-layer:last-child video")?.currentTime > 2'), 'video before clear');
    await command(49781, 'Clear');
    await waitFor(() => evaluate(first, '(()=>{const v=document.querySelector(".media-layer:last-child video");return v && v.currentTime > .05 && v.currentTime < 1})()'), 'video restart');
  });
  await check('Rapid mixed commands cannot resurrect old videos or timers', async () => {
    for (const line of ['AutoFolder "@fixtures/auto" "demo.mp4"', 'Thumbs "@fixtures/sequence"', 'Next', 'Enter', `URL "${fixtureUrl}"`, 'Folder "@fixtures/sequence" "04.png"']) await command(49781, line);
    await sleep(1500); const final = await command(49781, 'Status');
    assert.equal(final.file, '04.png'); assert.equal(final.auto, false); assert.equal(final.mode, 'media');
    assert.equal(await evaluate(first, 'document.querySelectorAll("video").length'), 0);
  });
  await check('Invalid folder and missing file preserve the active selection', async () => {
    assert.equal((await command(49781, 'Folder "C:/Windows"')).ok, false);
    assert.equal((await command(49781, 'Folder "@fixtures/sequence" "missing.jpg"')).ok, false);
    assert.equal((await command(49781, 'Status')).file, '04.png');
  });
  await check('Empty interrupts playback and Clear reloads its configured picture', async () => {
    await command(49781, 'AutoFolder "@fixtures/auto" "demo.mp4"');
    await waitFor(() => evaluate(first, 'document.querySelector(".media-layer:last-child video")?.currentTime > .2'), 'video before Empty');
    await command(49781, 'Empty'); await sleep(900);
    assert.equal((await command(49781, 'Status')).mode, 'empty');
    assert.equal((await command(49781, 'Status')).auto, false);
    assert.equal(await evaluate(first, 'document.querySelectorAll("video").length'), 0);
    await fs.copyFile(path.join(root, 'assets', 'icon.png'), path.join(work, 'empty.png'));
    await command(49781, 'Clear');
    await waitFor(() => evaluate(first, 'document.querySelector("#empty-picture img")?.naturalWidth === 256'), 'reloaded Empty picture');
    assert.equal(await evaluate(first, 'getComputedStyle(document.getElementById("welcome")).backgroundColor'), 'rgb(12, 25, 35)');
    await fs.copyFile(path.join(fixtureRoot, 'empty.png'), path.join(work, 'empty.png'));
    await command(49781, 'Folder "@fixtures/sequence" "04.png"');
  });
  await check('Two instances use independent ports and browser sessions', async () => {
    second = await launch(path.join(work, 'second.json'), false);
    await waitFor(() => evaluate(second, 'Boolean(window.presenter)'), 'second instance');
    await waitFor(() => evaluate(second, 'document.querySelector("#empty-picture img")?.naturalWidth === 756'), 'configured logo outside mediaRoot');
    await command(49782, `URL "${fixtureUrl}"`);
    await waitFor(async () => (await command(49782, 'Status')).webVisible, 'second web');
    assert.doesNotMatch(await evaluate(second, 'document.cookie', 'web'), /presenterTest=keep/);
    await command(49782, 'Clear');
    assert.equal((await command(49781, 'Status')).file, '04.png');
    assert.ok(await second.evaluate(() => globalThis.presenterTestTray && !globalThis.presenterTestTray.isDestroyed()));
    const originalDisplays = await second.evaluate(({ screen }) => screen.getAllDisplays().map(display => display.id));
    await second.evaluate(({ screen }) => {
      globalThis.presenterOriginalDisplays = screen.getAllDisplays.bind(screen);
      screen.getAllDisplays = () => [];
      screen.emit('display-removed', {}, {});
    });
    assert.equal((await command(49782, 'Status')).displayMissing, true);
    assert.equal(await second.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].isVisible()), false);
    await second.evaluate(({ screen }) => {
      screen.getAllDisplays = globalThis.presenterOriginalDisplays;
      screen.emit('display-added', {}, screen.getAllDisplays()[0]);
    });
    assert.equal((await command(49782, 'Status')).displayMissing, false);
    assert.equal(await second.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].isVisible()), true);
    console.log('Monitor recovery simulated for display IDs:', originalDisplays);
    const closed = second.waitForEvent('close');
    await second.evaluate(() => { setTimeout(() => globalThis.presenterTestMenu.items.find(item => item.label === 'Close').click(), 0); });
    await closed; second = null;
    assert.equal((await command(49781, 'Status')).ok, true);
  });
  await check('Local webpage can be revisited after mixed commands', async () => {
    await command(49781, `URL "${fixtureUrl}"`);
    await waitFor(() => evaluate(first, 'document.title.includes("Presenter interaction fixture")', 'web'), 'real website', 30000);
    await waitFor(async () => (await command(49781, 'Status')).webVisible, 'real website visible');
    console.log('Real page:', await evaluate(first, '({title:document.title,links:document.links.length,ready:document.readyState})', 'web'));
    await screenshot(first, 'web-fixture.png', 'web');
  });
  await fs.writeFile(path.join(work, 'results.json'), JSON.stringify({ passed: results, date: new Date().toISOString(), executable: process.env.PRESENTER_EXE || 'development' }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (second) await second.close().catch(() => {});
  if (first) await first.close().catch(() => {});
  if (fixture) fixture.close();
});




