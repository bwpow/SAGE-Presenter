const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { parseCommand, LineBuffer, navigate, initialState, wrap, validateConfig, readFolder, daemonArguments } = require('../dist/core');
test('daemon launch strips recursion flag and forwards literal config/app paths', () => {
  assert.deepEqual(daemonArguments(['--config', 'relative config.json', '--daemon', '--test-window'], 'C:\\a b\\config.json'),
    ['--test-window', '--config', 'C:\\a b\\config.json', '--daemon-child']);
  assert.deepEqual(daemonArguments(['C:\\dev app', '--daemon', '--daemon-child'], 'C:\\cfg.json'),
    ['C:\\dev app', '--config', 'C:\\cfg.json', '--daemon-child']);
});
test('Windows paths, spaces and optional file retain literal backslashes', () => {
  assert.deepEqual(parseCommand('Folder "C:\\media\\a b" "hello world.jpg"'), { type: 'folder', folder: 'C:\\media\\a b', file: 'hello world.jpg' });
  assert.equal(parseCommand('uRL "http://example.test/?x=a&y=b"').url, 'http://example.test/?x=a&y=b');
  for (const line of ['Next junk', 'Folder "unterminated', 'URL file:///C:/secret', 'Folder "x"y']) assert.throws(() => parseCommand(line));
});
test('TCP handles split UTF-8, CRLF, multiple commands and final command at EOF', () => {
  const text = 'Folder "C:/media/žluťoučký"\r\nNext\nPrevious';
  const bytes = Buffer.from(text); const buffer = new LineBuffer(); const result = [];
  for (const byte of bytes) result.push(...buffer.push(Buffer.from([byte])));
  result.push(...buffer.end());
  assert.deepEqual(result, ['Folder "C:/media/žluťoučký"', 'Next', 'Previous']);
  assert.throws(() => new LineBuffer().push(Buffer.alloc(65537, 65)));
});
test('navigation wraps, thumbnail enter preserves auto, and web ignores navigation', () => {
  const items = [0,1,2].map(x => ({ name: `${x}.jpg`, path: `${x}.jpg`, url: '', kind: 'image' }));
  let state = { ...initialState(), mode: 'media', items, auto: true };
  state = navigate(state, { type: 'previous' }); assert.equal(state.index, 2);
  state = navigate(state, { type: 'next' }); assert.equal(state.index, 0);
  state = navigate(state, { type: 'enter' }); assert.equal(state.mode, 'thumbs'); assert.equal(state.auto, true);
  state = navigate(state, { type: 'select', index: 2 }); assert.equal(state.mode, 'media'); assert.equal(state.index, 2);
  state = navigate(state, { type: 'url', url: 'http://example.test/' });
  assert.equal(state.auto, false); assert.equal(navigate(state, { type: 'next' }), state);
  assert.equal(navigate(state, { type: 'enter' }), state);
  assert.equal(wrap(-1, 0), 0);
});
test('configuration rejects unsafe host and invalid timing', () => {
  for (const value of [{ listenHost: '0.0.0.0' }, { listenPort: 1 }, { imageDurationSeconds: NaN }, { monitor: 1.2 }, { alwaysOnTop: 'true' }, { fit: 'cover' }])
    assert.throws(() => validateConfig(value, process.cwd()));
  assert.equal(validateConfig({ mediaRoot: '.' }, process.cwd()).mediaRoot, process.cwd());
});
test('portable data folder resolves beside config and accepts absolute custom paths', () => {
  const directory = path.resolve('work/config');
  assert.equal(validateConfig({}, directory).dataFolder, path.join(directory, 'data'));
  assert.equal(validateConfig({ dataFolder: '../shared-data' }, directory).dataFolder, path.resolve(directory, '../shared-data'));
  assert.equal(validateConfig({ dataFolder: directory }, process.cwd()).dataFolder, directory);
  for (const dataFolder of ['', ' ', null, 42]) assert.throws(() => validateConfig({ dataFolder }, directory));
});
test('Empty is the initial mode, cancels automatic media and ignores navigation', () => {
  assert.equal(initialState().mode, 'empty');
  assert.deepEqual(parseCommand('eMpTy'), { type: 'empty' });
  assert.throws(() => parseCommand('Empty something'));
  const state = navigate({ ...initialState(), mode: 'media', auto: true, revision: 9 }, { type: 'empty' });
  assert.equal(state.mode, 'empty'); assert.equal(state.auto, false); assert.equal(state.revision, 10);
  for (const type of ['next', 'previous', 'enter']) assert.equal(navigate(state, { type }), state);
  const directory = path.resolve('work/config');
  assert.equal(validateConfig({ emptyImage: '../logo.png' }, directory).emptyImage, path.resolve(directory, '../logo.png'));
  assert.throws(() => validateConfig({ emptyImage: 123 }, directory));
});
test('folder scan sorts deterministically, excludes directories, and validates start file and root', async () => {
  const root = path.resolve('work/core-tests'); await fs.mkdir(root, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(root, 'scan-'));
  await fs.mkdir(path.join(fixture, 'fake.jpg'));
  for (const filename of ['b.mp4', 'A.jpg', 'a10.png', 'a2.jpg', 'notes.txt']) await fs.writeFile(path.join(fixture, filename), 'test');
  const listing = await readFolder(fixture, '.', 'b.mp4');
  assert.deepEqual(listing.items.map(x => x.name), ['A.jpg', 'a10.png', 'a2.jpg', 'b.mp4']);
  assert.equal(listing.index, 3);
  await assert.rejects(readFolder(fixture, '.', 'missing.mov'));
  await assert.rejects(readFolder(fixture, '..'));
});
