// Packaged Electron ignores development -r hooks. Attach to its main-process inspector
// before startup instead; no test hooks or debug switches are added to the product.
const { spawn } = require('node:child_process');
module.exports = async function launchPortable(executable, args) {
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, ['--inspect-brk=0', ...args], { windowsHide: true, env: environment });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Inspector startup timeout')), 15000);
    child.once('error', reject);
    child.stderr.on('data', data => {
      output += data;
      const match = /Debugger listening on (ws:\/\/[^\s]+)/.exec(output);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  const requests = new Map();
  const events = new (require('node:events').EventEmitter)();
  const scripts = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data); const request = requests.get(message.id);
    if (request) { requests.delete(message.id); clearTimeout(request.timeout); message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result); }
    if (message.method === 'Debugger.scriptParsed') scripts.set(message.params.scriptId, message.params.url);
    if (message.method) events.emit(message.method, message.params);
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => { requests.delete(id); reject(new Error(`Inspector timeout: ${method}`)); }, 20000);
      requests.set(id, { resolve, reject, timeout }); socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function expression(value) {
    const result = await send('Runtime.evaluate', { expression: value, includeCommandLineAPI: true, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  await send('Runtime.enable');
  await send('Debugger.enable');
  const breakpoint = await send('Debugger.setBreakpointByUrl', { urlRegex: 'dist[/\\\\]main\\.js$', lineNumber: 0 });
  let pause = require('node:events').once(events, 'Debugger.paused');
  await send('Runtime.runIfWaitingForDebugger');
  for (;;) {
    const [event] = await pause;
    const frame = event.callFrames[0];
    if (/dist[\\/]main\.js$/.test(scripts.get(frame.location.scriptId) || '')) {
      const result = await send('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId,
        expression: `(() => { const { Tray } = require('electron'); const original = Tray.prototype.setContextMenu;
          Tray.prototype.setContextMenu = function(menu) { globalThis.presenterTestMenu = menu; globalThis.presenterTestTray = this; return original.call(this, menu); }; })()` });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      await send('Debugger.removeBreakpoint', { breakpointId: breakpoint.breakpointId });
      await send('Debugger.resume'); break;
    }
    pause = require('node:events').once(events, 'Debugger.paused');
    await send('Debugger.resume');
  }
  child.stderr.on('data', data => { if (String(data).includes('Waiting for the debugger to disconnect')) socket.close(); });
  return {
    evaluate: (fn, argument) => expression(`(${fn.toString()})(require('electron'),${JSON.stringify(argument) ?? 'undefined'})`),
    process: () => child,
    waitForEvent: () => exited,
    close: async () => { await expression('require("electron").app.quit()').catch(() => {}); socket.close(); await exited; }
  };
};
