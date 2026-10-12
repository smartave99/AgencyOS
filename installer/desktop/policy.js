'use strict';
// Decisions the desktop shell makes, kept free of Electron so they can be tested with plain Node.

const LOOPBACK = ['127.0.0.1', 'localhost'];

function parseArgs(argv = [], env = {}) {
  return {
    hidden: argv.includes('--hidden'),
    debug: argv.includes('--debug') || env.AGENCYOS_DEBUG === '1',
  };
}

/** Pages AgencyOS itself serves on this computer: the status page, the app and its API. */
function trustedOrigins({ statusPort, frontendPort, backendPort } = {}) {
  const origins = new Set();
  for (const port of [statusPort, frontendPort, backendPort]) {
    if (!Number.isInteger(port)) continue;
    for (const host of LOOPBACK) origins.add(`http://${host}:${port}`);
  }
  return origins;
}

function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

const RETRY_URL = 'agencyos-retry://now';

/**
 * What to do when the window is asked to go to `url`:
 *   allow    show it inside AgencyOS
 *   external hand it to the person's default browser (OAuth sign-ins, help links, ...)
 *   deny     do nothing
 */
function classifyNavigation(url, origins) {
  if (url === RETRY_URL) return 'allow';
  const u = parseUrl(url);
  if (!u) return 'deny';
  if (u.protocol === 'about:' || u.protocol === 'blob:' || u.protocol === 'data:') return u.protocol === 'about:' && u.href === 'about:blank' ? 'allow' : 'deny';
  if (u.protocol === 'mailto:') return 'external';
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'deny';
  if (u.protocol === 'http:' && origins.has(u.origin)) return 'allow';
  return 'external';
}

/** Only these ever reach shell.openExternal. */
function safeToOpenExternally(url) {
  const u = parseUrl(url);
  return !!u && (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:');
}

/** The launcher prints "Status: http://127.0.0.1:4999/" once the supervisor answers. */
function parseStatusPort(stdout = '') {
  const m = /Status:\s*http:\/\/127\.0\.0\.1:(\d+)\//.exec(String(stdout));
  return m ? Number.parseInt(m[1], 10) : null;
}

/**
 * 'moving' while the data is being copied to a new folder (the app is stopped meanwhile), 'starting'
 * while services come up, 'ready' when every required one runs, 'attention' if one failed.
 */
function windowPhase(status) {
  if (!status) return 'starting';
  if (status.storage && status.storage.move && status.storage.move.active) return 'moving';
  if (status.ready) return 'ready';
  return status.attention ? 'attention' : 'starting';
}

function trayTooltip(status, version = '') {
  const name = `AgencyOS${version ? ` ${version}` : ''}`;
  switch (windowPhase(status)) {
    case 'ready':
      return `${name} — running`;
    case 'attention':
      return `${name} — needs attention`;
    case 'moving':
      return `${name} — moving your data…`;
    default:
      return `${name} — starting…`;
  }
}

/** Only the launcher's own status page (never the app or any other site) may open the folder picker. */
function isStatusPage(url, statusPort) {
  const u = parseUrl(url);
  return !!u && u.protocol === 'http:' && LOOPBACK.includes(u.hostname) && Number.isInteger(statusPort) && u.port === String(statusPort) && u.pathname === '/';
}

/**
 * The title bar is part of the page: the window buttons are drawn over the app's own top bar, so
 * their colours follow the app's theme (the top bar's background and text colours).
 */
const TITLE_BAR_HEIGHT = 56;
function titleBarOverlay(dark) {
  return dark ? { color: '#1a1919', symbolColor: '#ffffff', height: TITLE_BAR_HEIGHT } : { color: '#ffffff', symbolColor: '#0e0e0e', height: TITLE_BAR_HEIGHT };
}

/** Any page AgencyOS itself serves on this computer (the app or the status page), by its address. */
function isOwnPage(url, origins) {
  const u = parseUrl(url);
  return !!u && u.protocol === 'http:' && origins.has(u.origin);
}

module.exports = { parseArgs, trustedOrigins, classifyNavigation, safeToOpenExternally, parseStatusPort, windowPhase, trayTooltip, isStatusPage, titleBarOverlay, isOwnPage, TITLE_BAR_HEIGHT, RETRY_URL };
