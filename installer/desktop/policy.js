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

/** 'starting' while services come up, 'ready' when every required one runs, 'attention' if one failed. */
function windowPhase(status) {
  if (!status) return 'starting';
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
    default:
      return `${name} — starting…`;
  }
}

module.exports = { parseArgs, trustedOrigins, classifyNavigation, safeToOpenExternally, parseStatusPort, windowPhase, trayTooltip, RETRY_URL };
