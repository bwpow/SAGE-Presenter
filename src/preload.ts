import { contextBridge, ipcRenderer } from 'electron';
import type { PresenterAPI } from './shared';
const api: PresenterAPI = {
  onRender: callback => { ipcRenderer.on('render', (_event, value) => callback(value)); },
  onRevealWeb: callback => { ipcRenderer.on('reveal-web', (_event, value) => callback(value)); },
  onNotice: callback => { ipcRenderer.on('notice', (_event, value) => callback(value)); },
  onClear: callback => { ipcRenderer.on('clear-media-cache', () => callback()); },
  onPause: callback => { ipcRenderer.on('pause-media', () => callback()); },
  command: line => ipcRenderer.invoke('command', line),
  select: index => ipcRenderer.send('select', index),
  ready: revision => ipcRenderer.send('ready', revision),
  ended: revision => ipcRenderer.send('ended', revision),
  failed: (revision, message) => ipcRenderer.send('failed', revision, message),
  revealed: revision => ipcRenderer.send('revealed', revision),
  initialized: () => ipcRenderer.send('initialized')
};
contextBridge.exposeInMainWorld('presenter', api);
