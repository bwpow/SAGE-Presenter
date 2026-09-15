import fs from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Config, Command, MediaItem, State } from './shared';

export function daemonArguments(args: string[], configPath: string): string[] {
  const child: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === '--daemon' || argument === '--daemon-child') continue;
    if (argument === '--config') { index++; continue; }
    child.push(argument);
  }
  return [...child, '--config', configPath, '--daemon-child'];
}

// Quoted Windows paths are literal: backslashes are never escape sequences.
export function parseCommand(line: string): Command {
  const tokens: string[] = [];
  const re = /\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/gy;
  let position = 0;
  while (position < line.trimEnd().length) {
    re.lastIndex = position;
    const match = re.exec(line);
    if (!match) throw new Error('Invalid quoting; enclose paths containing spaces in double quotes.');
    tokens.push(match[1] ?? match[2] ?? match[3]!);
    position = re.lastIndex;
    if (position < line.length && !/\s/.test(line[position]!)) throw new Error('Separate arguments with spaces.');
  }
  const type = tokens.shift()?.toLowerCase();
  if (type === 'url' && tokens.length === 1) return { type, url: validUrl(tokens[0]!) };
  if (['folder', 'autofolder', 'thumbs'].includes(type ?? '') && tokens.length >= 1 && tokens.length <= 2)
    return { type: type as 'folder' | 'autofolder' | 'thumbs', folder: tokens[0]!, file: tokens[1] };
  if (['next', 'previous', 'enter', 'status', 'clear', 'empty'].includes(type ?? '') && tokens.length === 0)
    return { type: type as 'next' | 'previous' | 'enter' | 'status' | 'clear' | 'empty' };
  throw new Error('Expected URL, Folder, AutoFolder, Thumbs, Next, Previous, Enter, Empty, Status or Clear.');
}
export function validUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('URL must use http or https.');
  return url.href;
}
export function wrap(index: number, count: number): number { return count ? ((index % count) + count) % count : 0; }
export const initialState = (): State => ({ revision: 0, mode: 'empty', folder: '', items: [], index: 0, auto: false, url: '' });
export function navigate(state: State, command: Command): State {
  if (command.type === 'empty') return { ...state, mode: 'empty', auto: false, revision: state.revision + 1 };
  if (command.type === 'url') return { ...state, mode: 'web', url: command.url, auto: false, revision: state.revision + 1 };
  if (!['media', 'thumbs'].includes(state.mode) || !state.items.length) return state;
  if (command.type === 'next' || command.type === 'previous')
    return { ...state, index: wrap(state.index + (command.type === 'next' ? 1 : -1), state.items.length), revision: state.revision + 1 };
  if (command.type === 'enter') return { ...state, mode: state.mode === 'thumbs' ? 'media' : 'thumbs', revision: state.revision + 1 };
  if (command.type === 'select') {
    if (!Number.isInteger(command.index) || command.index < 0 || command.index >= state.items.length) throw new Error('Invalid selection.');
    return { ...state, index: command.index, mode: 'media', revision: state.revision + 1 };
  }
  return state;
}
export function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
const images = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif']);
const videos = new Set(['.mp4', '.mov', '.m4v', '.webm', '.ogv']);
export async function readFolder(root: string, requested: string, start?: string): Promise<{ folder: string; items: MediaItem[]; index: number }> {
  const realRoot = await fs.realpath(root);
  const folder = await fs.realpath(path.resolve(root, requested));
  if (!within(realRoot, folder)) throw new Error('Folder is outside mediaRoot.');
  const entries = await fs.readdir(folder, { withFileTypes: true });
  const items: MediaItem[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!images.has(ext) && !videos.has(ext)) continue;
    const filename = path.join(folder, entry.name);
    items.push({ name: entry.name, path: filename, kind: videos.has(ext) ? 'video' : 'image',
      url: `presenter-media://local/file?path=${encodeURIComponent(filename)}` });
  }
  // Fixed, case-insensitive lexical ordering with a deterministic case-sensitive tie break.
  items.sort((a, b) => compare(a.name.toLowerCase(), b.name.toLowerCase()) || compare(a.name, b.name));
  if (!items.length) throw new Error('Folder contains no supported images or videos.');
  const index = start ? items.findIndex(item => process.platform === 'win32'
    ? path.resolve(folder, start).toLowerCase() === item.path.toLowerCase() : path.resolve(folder, start) === item.path) : 0;
  if (index < 0) throw new Error(`File not found in folder: ${start}`);
  return { folder, items, index };
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
export function validateConfig(input: unknown, configDirectory: string): Config {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Configuration must be a JSON object.');
  const config = { instanceName: 'SAGE Presenter', monitor: 2, alwaysOnTop: true, listenHost: '127.0.0.1', listenPort: 49731,
    emptyImage: './empty.png', mediaRoot: configDirectory, dataFolder: './data', imageDurationSeconds: 7, transitionMilliseconds: 180,
    fit: 'contain', volume: 1, mute: false, missingMonitor: 'hide', ...input } as Config;
  for (const [key, min, max, integer] of [
    ['monitor', 1, 64, true], ['listenPort', 1024, 65535, true], ['imageDurationSeconds', 0.1, 86400, false],
    ['transitionMilliseconds', 0, 2000, true], ['volume', 0, 1, false]
  ] as const) {
    const value = config[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
      throw new Error(`Invalid configuration: ${key}`);
  }
  for (const key of ['alwaysOnTop', 'mute'] as const) if (typeof config[key] !== 'boolean') throw new Error(`Invalid ${key}`);
  if (config.listenHost !== '127.0.0.1') throw new Error('listenHost must be 127.0.0.1.');
  if (config.fit !== 'contain' || !['hide', 'primary'].includes(config.missingMonitor)) throw new Error('fit must be contain; missingMonitor must be hide or primary.');
  if (typeof config.instanceName !== 'string' || !config.instanceName.trim()) throw new Error('instanceName is required.');
  if (typeof config.mediaRoot !== 'string' || typeof config.emptyImage !== 'string') throw new Error('Invalid mediaRoot/emptyImage.');
  if (config.displayId !== undefined && !Number.isInteger(config.displayId)) throw new Error('displayId must be an integer.');
  config.mediaRoot = path.resolve(configDirectory, config.mediaRoot);
  if (typeof config.dataFolder !== 'string' || !config.dataFolder.trim()) throw new Error('dataFolder must be a nonempty path.');
  config.dataFolder = path.resolve(configDirectory, config.dataFolder);
  if (config.emptyImage) config.emptyImage = path.resolve(configDirectory, config.emptyImage);
  return config;
}
export class LineBuffer {
  private decoder = new StringDecoder('utf8');
  private pending = '';
  push(chunk: Buffer): string[] {
    this.pending += this.decoder.write(chunk);
    if (Buffer.byteLength(this.pending) > 65536) throw new Error('Command buffer exceeds 64 KiB.');
    const lines = this.pending.split('\n');
    this.pending = lines.pop()!;
    return lines.map(line => line.trim()).filter(Boolean);
  }
  end(): string[] {
    const final = (this.pending + this.decoder.end()).trim();
    this.pending = '';
    return final ? [final] : [];
  }
}
