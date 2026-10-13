// Small network and timing helpers shared by the supervisor and the Ollama manager.

import net from 'node:net';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The environment for starting Windows PowerShell 5.1. When the launcher was itself started from PowerShell 7
 * (a terminal, a script, a build machine), the inherited module path points at modules 5.1 cannot load, and
 * commands such as Get-FileHash then do not exist. Without the variable it uses its own.
 */
export function windowsPowerShellEnv(env = process.env) {
  const clean = { ...env };
  delete clean.PSModulePath;
  return clean;
}

/** True when something accepts TCP connections on host:port. */
export function tcpOpen(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** True when nothing is listening on host:port (so we may bind it). */
export async function portFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/** First free port at or after `preferred`. */
export async function findFreePort(preferred, host = '127.0.0.1', attempts = 50) {
  for (let i = 0; i < attempts; i += 1) {
    if (await portFree(preferred + i, host)) return preferred + i;
  }
  throw new Error(`No free port found from ${preferred}`);
}

/** GET returning { status, body } or null when nothing answers within the timeout. */
export async function httpGet(url, { timeoutMs = 4000, headers } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'manual', headers });
    const body = await res.text().catch(() => '');
    return { status: res.status, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Polls `check()` until it returns a truthy value or the deadline passes. */
export async function waitFor(check, { timeoutMs = 60000, intervalMs = 500, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) return false;
    let result = false;
    try {
      result = await check();
    } catch {
      result = false;
    }
    if (result) return result;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}
