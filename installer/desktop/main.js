'use strict';
// AgencyOS desktop shell. This is what the person starts: it owns the window, the taskbar
// icon and the tray icon, and it starts and stops the services (database, workflow engine,
// server, local AI) through the launcher that ships next to it. The app is shown inside this
// window; nothing is opened in a web browser.

const { app, BrowserWindow, Menu, Tray, shell, dialog, nativeTheme, nativeImage, session, screen, Notification, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const policy = require('./policy');

const flags = policy.parseArgs(process.argv, process.env);
const isWindows = process.platform === 'win32';
const installRoot = process.env.AGENCYOS_HOME || (app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '..', 'dist', 'stage'));
const nodeExe = process.env.AGENCYOS_NODE || path.join(installRoot, 'runtime', 'node', isWindows ? 'node.exe' : path.join('bin', 'node'));
const launcherScript = path.join(installRoot, 'launcher', 'agencyos.mjs');
const dataRoot = process.env.AGENCYOS_DATA || (isWindows ? path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'AgencyOS') : path.join(app.getPath('home'), '.local', 'share', 'agencyos'));
const preloadScript = path.join(__dirname, 'preload.js');
const assets = path.join(__dirname, 'assets');
const iconPath = path.join(assets, 'icon.png');

const APP_ID = 'com.agencyos.desktop';
const LOGIN_NAME = 'AgencyOS';

let mainWindow = null;
let statusWindow = null;
let tray = null;
let statusPort = null;
let latestStatus = null;
let appShown = false; // the main window has moved on from the status page to the app itself
let quitting = false;
let stopping = false;
let failedPolls = 0;
let lastRevive = 0;
let origins = policy.trustedOrigins({});

if (isWindows) app.setAppUserModelId(APP_ID);
app.setName('AgencyOS');

// One AgencyOS per person: a second launch brings the first one forward.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', (_event, argv) => {
  if (!argv.includes('--hidden')) showMainWindow();
});

// ---- launcher ------------------------------------------------------------------------------

// The person may keep their data on another drive, so ask the running launcher where it is.
const currentDataRoot = () => (latestStatus && latestStatus.dataDir) || dataRoot;
const currentLogsDir = () => (latestStatus && latestStatus.logsDir) || path.join(dataRoot, 'logs');

function runLauncher(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(nodeExe) || !fs.existsSync(launcherScript)) {
      reject(new Error(`AgencyOS is not installed correctly (missing ${!fs.existsSync(nodeExe) ? nodeExe : launcherScript}). Please reinstall.`));
      return;
    }
    const child = spawn(nodeExe, [launcherScript, ...args], { windowsHide: true, env: { ...process.env, AGENCYOS_HOME: installRoot } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`The launcher took longer than ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(new Error((stderr || stdout).trim().split('\n').pop() || `The launcher exited with code ${code}.`));
    });
  });
}

async function ensureServices() {
  const { stdout } = await runLauncher(['start', '--background'], 120000);
  const port = policy.parseStatusPort(stdout);
  if (!port) throw new Error('The launcher did not report where AgencyOS is running.');
  statusPort = port;
  origins = policy.trustedOrigins({ statusPort });
  return port;
}

function getJson(url, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// ---- windows -------------------------------------------------------------------------------

const stateFile = path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  const fallback = { width: 1360, height: 860 };
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const visible = screen.getAllDisplays().some((d) => {
      const b = d.workArea;
      return s.x >= b.x - 40 && s.y >= b.y - 40 && s.x < b.x + b.width - 80 && s.y < b.y + b.height - 80;
    });
    return { width: Math.max(1000, s.width), height: Math.max(640, s.height), ...(visible ? { x: s.x, y: s.y } : {}), maximized: !!s.maximized };
  } catch {
    return fallback;
  }
}

function saveWindowState(win) {
  try {
    const maximized = win.isMaximized();
    const b = maximized ? win.getNormalBounds() : win.getBounds();
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ ...b, maximized }));
  } catch {
    /* remembering the window position is a courtesy */
  }
}

// Windows only: the other platforms keep their usual window frame.
const frameless = process.platform === 'win32';

const backgroundColor = () => (nativeTheme.shouldUseDarkColors ? '#0b0b0f' : '#f5f5f7');

function createMainWindow() {
  const saved = loadWindowState();
  const win = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    x: saved.x,
    y: saved.y,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    title: 'AgencyOS',
    icon: iconPath,
    backgroundColor: backgroundColor(),
    autoHideMenuBar: true,
    // The window's own title bar is replaced by the app's top bar; Windows draws just the buttons.
    ...(frameless ? { titleBarStyle: 'hidden', titleBarOverlay: policy.titleBarOverlay(nativeTheme.shouldUseDarkColors) } : {}),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true, devTools: flags.debug, preload: preloadScript, additionalArguments: frameless ? ['--agencyos-frameless'] : [] },
  });
  if (saved.maximized) win.maximize();
  win.once('ready-to-show', () => {
    if (!flags.hidden || !tray) win.show();
  });
  win.on('close', (event) => {
    saveWindowState(win);
    if (quitting) return;
    // Closing the window keeps AgencyOS running so scheduled campaigns are still sent.
    event.preventDefault();
    win.hide();
    notifyOnce('AgencyOS is still running', 'Scheduled campaigns keep being sent. Use the AgencyOS icon near the clock to open it again or to quit.');
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted */) return;
    if (appShown && url.startsWith('http://localhost')) {
      appShown = false;
      showStatusPage(win);
    }
  });
  win.webContents.on('page-title-updated', (event) => {
    event.preventDefault();
    win.setTitle('AgencyOS');
  });
  win.loadFile(path.join(__dirname, 'splash.html'));
  return win;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    // Started hidden (at sign-in): the window is created the first time it is asked for.
    mainWindow = createMainWindow();
    if (latestStatus && policy.windowPhase(latestStatus) === 'ready') {
      appShown = true;
      mainWindow.loadURL(latestStatus.url);
    } else if (statusPort) {
      appShown = false;
      showStatusPage(mainWindow);
    }
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function showStatusPage(target = null) {
  if (!statusPort) return;
  const url = `http://127.0.0.1:${statusPort}/`;
  if (target) {
    target.loadURL(url);
    return;
  }
  if (statusWindow && !statusWindow.isDestroyed()) {
    statusWindow.show();
    statusWindow.focus();
    return;
  }
  statusWindow = new BrowserWindow({
    width: 720,
    height: 860,
    title: 'AgencyOS status',
    icon: iconPath,
    backgroundColor: backgroundColor(),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: flags.debug, preload: preloadScript },
  });
  statusWindow.on('page-title-updated', (e) => e.preventDefault());
  statusWindow.loadURL(url);
}

function errorPage(message) {
  const safe = String(message).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const html = `<!doctype html><meta charset="utf-8"><title>AgencyOS</title><style>
:root{color-scheme:light dark}body{font:15px/1.5 system-ui,"Segoe UI Variable","Segoe UI",sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:Canvas;color:CanvasText}
main{max-width:520px;padding:32px}h1{font-size:24px;margin:0 0 8px}p{opacity:.75}pre{white-space:pre-wrap;background:rgba(127,127,127,.12);padding:12px;border-radius:10px;font-size:12px}
a{display:inline-block;margin-top:16px;padding:10px 18px;border-radius:10px;background:#6d4aff;color:#fff;text-decoration:none;font-weight:600}</style>
<main><h1>AgencyOS could not start</h1><p>Nothing was lost. Try again; if it keeps happening, open the logs from the Help menu.</p><pre>${safe}</pre><a href="${policy.RETRY_URL}">Try again</a></main>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

// ---- starting, watching, stopping ----------------------------------------------------------

async function boot() {
  stopPolling();
  try {
    await ensureServices();
  } catch (error) {
    if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow();
    mainWindow.loadURL(errorPage(error.message));
    mainWindow.show();
    return;
  }
  appShown = false;
  if (mainWindow && !mainWindow.isDestroyed()) showStatusPage(mainWindow);
  startPolling();
}

let pollTimer = null;
function startPolling() {
  stopPolling();
  const tick = async () => {
    if (quitting) return;
    try {
      const status = await getJson(`http://127.0.0.1:${statusPort}/api/status`);
      failedPolls = 0;
      latestStatus = status;
      origins = policy.trustedOrigins({ statusPort, frontendPort: status.ports?.frontend, backendPort: status.ports?.backend });
      updateTray();
      const phase = policy.windowPhase(status);
      if (phase === 'ready' && !appShown && mainWindow && !mainWindow.isDestroyed()) {
        appShown = true;
        mainWindow.loadURL(status.url);
      } else if (phase === 'moving' && appShown && mainWindow && !mainWindow.isDestroyed()) {
        // The app is stopped while its files are copied: show the progress instead of a broken page.
        appShown = false;
        showStatusPage(mainWindow);
      }
    } catch {
      failedPolls += 1;
      if (failedPolls >= 6 && Date.now() - lastRevive > 60000) {
        // The supervisor is gone (crashed or killed): start it again rather than leave a dead window.
        lastRevive = Date.now();
        failedPolls = 0;
        boot();
        return;
      }
    }
    pollTimer = setTimeout(tick, 1500);
  };
  pollTimer = setTimeout(tick, 600);
}
function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

async function quitAgencyOS({ confirm }) {
  if (stopping) return;
  if (confirm) {
    const { response } = await dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? mainWindow : undefined, {
      type: 'question',
      icon: nativeImage.createFromPath(iconPath),
      buttons: ['Quit AgencyOS', 'Keep running'],
      defaultId: 1,
      cancelId: 1,
      title: 'Quit AgencyOS',
      message: 'Quit AgencyOS?',
      detail: 'Scheduled campaigns will not be sent while AgencyOS is closed. Your data is kept.',
    });
    if (response !== 0) return;
  }
  stopping = true;
  quitting = true;
  stopPolling();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><meta charset="utf-8"><style>:root{color-scheme:light dark}body{font:15px system-ui,"Segoe UI";display:grid;place-items:center;min-height:100vh;margin:0;background:Canvas;color:CanvasText}</style><p>Stopping AgencyOS safely…</p>')}`);
  }
  try {
    await runLauncher(['stop'], 120000);
  } catch {
    /* the supervisor may already be gone; anything left over is cleaned up on the next start */
  }
  app.exit(0);
}

// ---- tray, menu, notifications -------------------------------------------------------------

function loginItemEnabled() {
  if (!isWindows && process.platform !== 'darwin') return false;
  return app.getLoginItemSettings({ path: process.execPath, args: ['--hidden'] }).openAtLogin;
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(policy.trayTooltip(latestStatus, app.getVersion()));
}

function buildTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(assets, 'tray.png')));
  const menu = () =>
    Menu.buildFromTemplate([
      { label: 'Open AgencyOS', click: showMainWindow },
      { label: 'Status and settings…', click: () => showStatusPage() },
      { type: 'separator' },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: loginItemEnabled(),
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath, args: ['--hidden'], name: LOGIN_NAME }),
      },
      { label: 'Open logs folder', click: () => shell.openPath(currentLogsDir()) },
      { type: 'separator' },
      { label: 'Quit AgencyOS', click: () => quitAgencyOS({ confirm: true }) },
    ]);
  tray.on('click', showMainWindow);
  tray.setContextMenu(menu());
  updateTray();
}

function buildMenu() {
  const template = [
    {
      label: 'AgencyOS',
      submenu: [
        { label: 'Status and settings…', click: () => showStatusPage() },
        { label: 'Open logs folder', click: () => shell.openPath(currentLogsDir()) },
        { type: 'separator' },
        { label: 'Quit AgencyOS', accelerator: 'CmdOrCtrl+Q', click: () => quitAgencyOS({ confirm: true }) },
      ],
    },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(flags.debug ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : []),
      ],
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] },
    {
      label: 'Help',
      submenu: [
        { label: 'Try starting again', click: () => boot() },
        { label: 'Open logs folder', click: () => shell.openPath(currentLogsDir()) },
        { type: 'separator' },
        {
          label: 'About AgencyOS',
          click: () =>
            dialog.showMessageBox({
              type: 'info',
              icon: nativeImage.createFromPath(iconPath),
              title: 'About AgencyOS',
              message: `AgencyOS ${app.getVersion()}`,
              detail: `Created by NextGen OS.\nRuns entirely on this computer.\nYour data: ${currentDataRoot()}\n\nElectron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function notifyOnce(title, body) {
  const marker = path.join(app.getPath('userData'), 'tray-hint-shown');
  if (fs.existsSync(marker) || !Notification.isSupported()) return;
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, '1');
  } catch {
    /* ignore */
  }
  new Notification({ title, body, icon: iconPath }).show();
}

// ---- folder picker -------------------------------------------------------------------------

ipcMain.handle('agencyos:pick-folder', async (event, current) => {
  const frameUrl = event.senderFrame && event.senderFrame.url;
  if (!statusPort || !policy.isStatusPage(frameUrl, statusPort)) return null;
  const owner = BrowserWindow.fromWebContents(event.sender) || undefined;
  const defaultPath = typeof current === 'string' && current && fs.existsSync(current) ? current : undefined;
  const { canceled, filePaths } = await dialog.showOpenDialog(owner, { title: 'Choose a folder for AgencyOS', defaultPath, properties: ['openDirectory', 'createDirectory'] });
  return canceled || !filePaths.length ? null : filePaths[0];
});

// The app tells the shell which theme it is in, so the window buttons match its top bar.
ipcMain.handle('agencyos:title-bar-theme', (event, dark) => {
  const frameUrl = event.senderFrame && event.senderFrame.url;
  if (!frameless || !policy.isOwnPage(frameUrl, origins)) return false;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || typeof win.setTitleBarOverlay !== 'function') return false;
  win.setTitleBarOverlay(policy.titleBarOverlay(dark === true));
  return true;
});

// ---- hardening ----------------------------------------------------------------------------

app.on('web-contents-created', (_event, contents) => {
  const openOutside = (url) => {
    if (policy.safeToOpenExternally(url)) shell.openExternal(url);
  };
  contents.setWindowOpenHandler(({ url }) => {
    const verdict = policy.classifyNavigation(url, origins);
    if (verdict === 'external') openOutside(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (url === policy.RETRY_URL) {
      event.preventDefault();
      boot();
      return;
    }
    const verdict = policy.classifyNavigation(url, origins);
    if (verdict === 'allow') return;
    event.preventDefault();
    if (verdict === 'external') openOutside(url);
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

function hardenSession() {
  const ses = session.defaultSession;
  // A normal browser identity: some sign-in and payment pages refuse user agents that say "Electron".
  ses.setUserAgent(ses.getUserAgent().replace(/\sElectron\/\S+/, '').replace(/\sagencyos\/\S+/i, ''));
  const allowed = new Set(['notifications', 'clipboard-sanitized-write', 'fullscreen']);
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
}

// ---- lifecycle ----------------------------------------------------------------------------

app.on('window-all-closed', () => {
  /* stay in the tray */
});

app.on('before-quit', (event) => {
  if (!quitting) {
    event.preventDefault();
    quitAgencyOS({ confirm: false });
  }
});

app.whenReady().then(async () => {
  hardenSession();
  buildMenu();
  buildTray();
  if (!flags.hidden) mainWindow = createMainWindow();
  await boot();
});
