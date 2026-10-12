'use strict';
// What pages inside the AgencyOS window may ask the desktop shell for: a native folder picker (the
// status page's Storage settings) and, for the app itself, the colours of the window buttons, which
// are drawn over the app's top bar. The shell answers each only for its own pages.

const { contextBridge, ipcRenderer } = require('electron');

// The main window has no title bar of its own; its pages mark themselves so they can make room for
// the window buttons and let the top bar drag the window.
const frameless = process.argv.includes('--agencyos-frameless');

contextBridge.exposeInMainWorld('agencyos', {
  frameless,
  pickFolder: (current) => ipcRenderer.invoke('agencyos:pick-folder', typeof current === 'string' ? current : ''),
  setTitleBarTheme: (dark) => ipcRenderer.invoke('agencyos:title-bar-theme', dark === true),
});

if (frameless) {
  window.addEventListener('DOMContentLoaded', () => document.documentElement.setAttribute('data-frameless', ''));
}
