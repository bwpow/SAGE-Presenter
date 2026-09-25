export interface Config {
  instanceName: string; monitor: number; displayId?: number; alwaysOnTop: boolean;
  listenHost: string; listenPort: number; emptyImage: string; mediaRoot: string; dataFolder: string;
  imageDurationSeconds: number; transitionMilliseconds: number; fit: 'contain';
  volume: number; mute: boolean; missingMonitor: 'hide' | 'primary';
}
export interface MediaItem { name: string; path: string; url: string; kind: 'image' | 'video'; }
export interface State {
  revision: number; mode: 'empty' | 'web' | 'media' | 'thumbs';
  folder: string; items: MediaItem[]; index: number; auto: boolean; url: string;
}
export type Command =
  | { type: 'url'; url: string }
  | { type: 'folder' | 'autofolder' | 'thumbs'; folder: string; file?: string }
  | { type: 'next' | 'previous' | 'enter' | 'status' | 'clear' | 'empty' | 'quit' | 'hide' | 'resume' }
  | { type: 'select'; index: number };
export interface RenderMessage { state: State; config: Config; appInfo: { name: string; version: string }; snapshot?: string; }
export interface PresenterAPI {
  onRender(callback: (message: RenderMessage) => void): void;
  onRevealWeb(callback: (revision: number) => void): void;
  onNotice(callback: (text: string) => void): void;
  onClear(callback: () => void): void;
  onPause(callback: () => void): void;
  command(line: string): Promise<unknown>;
  select(index: number): void;
  ready(revision: number): void;
  ended(revision: number): void;
  failed(revision: number, message: string): void;
  revealed(revision: number): void;
  initialized(): void;
}
