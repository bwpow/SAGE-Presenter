const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'work', 'daemon-test');
const configPath = path.join(directory, 'daemon test.json');
const executable = path.join(root, 'output', 'SAGE Presenter-win32-x64', 'SAGE Presenter.exe');
const port = 49783;
let daemonPid;
function command(line) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1'); let data = '';
    socket.setTimeout(1000); socket.on('error', reject);
    socket.on('timeout', () => { socket.destroy(); reject(new Error('Socket timeout')); });
    socket.on('connect', () => socket.write(`${line}\n`));
    socket.on('data', chunk => { data += chunk; if (data.includes('\n')) { socket.destroy(); resolve(JSON.parse(data.split('\n')[0])); } });
  });
}
async function wait(check, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { try { if (await check()) return; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${label}`);
}
async function batch() {
  const start = Date.now();
  await new Promise((resolve, reject) => {
    const environment = { ...global.process.env }; delete environment.ELECTRON_RUN_AS_NODE;
    const process = spawn('cmd.exe', ['/d', '/c', path.join(directory, 'run.cmd')], { cwd: directory, windowsHide: true, stdio: 'ignore', env: environment });
    const timeout = setTimeout(() => reject(new Error('Batch file did not return promptly')), 10000);
    process.on('error', reject);
    process.on('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`Launcher exited ${code}`)); });
  });
  return Date.now() - start;
}
(async () => {
  await fs.mkdir(directory, { recursive: true });
  await require('./fixtures.cjs').fixtures(path.join(directory,'fixtures'), false);
  const config = JSON.parse(await fs.readFile(path.join(root, 'config.example.json'), 'utf8'));
  await fs.writeFile(configPath, JSON.stringify({ ...config, instanceName: 'SAGE daemon test', monitor: 1, listenPort: port,
    emptyImage: path.join(directory, 'fixtures', 'empty.png'), mediaRoot: path.join(directory,'fixtures'), dataFolder: './data', alwaysOnTop: false, mute: true }));
  await fs.writeFile(path.join(directory, 'run.cmd'), `@echo off\r\n"${executable}" --config "${configPath}" --daemon --test-window\r\nexit /b %errorlevel%\r\n`);
  const launchMilliseconds = await batch();
  await wait(async () => { const status = await command('Status'); assert.equal(status.configPath, configPath); daemonPid = status.processId; return status.daemonized; }, 'detached child');
  assert.ok(Number.isInteger(daemonPid) && daemonPid > 0);
  assert.equal((await command('Status')).mode, 'empty');
  await command('Folder "sequence"');
  assert.equal((await command('Status')).file, '01.png');
  await batch();
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal((await command('Status')).processId, daemonPid);
  assert.equal((await command('Status')).file, '01.png');
  console.log(`PASS batch returned in ${launchMilliseconds} ms; detached child survived, accepted TCP, and repeated launch reused PID ${daemonPid}`);
  await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify({ passed: true, launchMilliseconds, processId: daemonPid, executable }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (!daemonPid) { try { const status = await command('Status'); if (status.configPath === configPath) daemonPid = status.processId; } catch {} }
  if (Number.isInteger(daemonPid) && daemonPid > 0) {
    // Remove only this test-owned process tree. Tray Close is covered by the desktop suite.
    spawnSync('taskkill.exe', ['/PID', String(daemonPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await wait(async () => { try { await command('Status'); return false; } catch { return true; } }, 'daemon test shutdown');
  }
});
