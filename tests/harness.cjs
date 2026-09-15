// Loaded only by the automated test launcher, never by normal Presenter launches.
const { Tray } = require('electron');
const setContextMenu = Tray.prototype.setContextMenu;
Tray.prototype.setContextMenu = function(menu) {
  globalThis.presenterTestMenu = menu;
  globalThis.presenterTestTray = this;
  return setContextMenu.call(this, menu);
};
