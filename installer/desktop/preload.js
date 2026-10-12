'use strict';
// The one thing pages inside the AgencyOS window may ask the desktop shell for: a native folder
// picker, used by the Storage settings on the status page. The shell only answers the status page.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agencyos', {
  pickFolder: (current) => ipcRenderer.invoke('agencyos:pick-folder', typeof current === 'string' ? current : ''),
});
