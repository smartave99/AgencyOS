'use strict';
// What pages inside the AgencyOS window may ask the desktop shell for: a native folder picker (the
// app's Settings → System, and the launcher's status page) and, for the app itself, the colours of
// the window buttons, which are drawn over the app's top bar. The start-up screen is told what is
// being started. The shell answers each only for its own pages.

const { contextBridge, ipcRenderer } = require('electron');

// The main window has no title bar of its own; its pages mark themselves so they can make room for
// the window buttons and let the top bar drag the window.
const frameless = process.argv.includes('--agencyos-frameless');

contextBridge.exposeInMainWorld('agencyos', {
  frameless,
  pickFolder: (current) => ipcRenderer.invoke('agencyos:pick-folder', typeof current === 'string' ? current : ''),
  setTitleBarTheme: (dark) => ipcRenderer.invoke('agencyos:title-bar-theme', dark === true),
  // The start-up screen shows what is being started; the line is plain text from the shell.
  onStartupLine: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('agencyos:startup-line', (_event, line) => callback(typeof line === 'string' ? line.slice(0, 120) : ''));
  },
});

if (frameless) {
  window.addEventListener('DOMContentLoaded', () => document.documentElement.setAttribute('data-frameless', ''));
}
