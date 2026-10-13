// The control surface on 127.0.0.1: a status page for people, a small JSON API for the page
// and for `agencyos stop|status`. It never listens on the network.
//
// Read-only endpoints are open to the local machine. Anything that changes state or exposes
// logs needs the per-install token, and every request must carry a Host header naming this
// loopback address, which closes DNS-rebinding attacks from web pages.

import http from 'node:http';
import crypto from 'node:crypto';
import { renderStatusPage } from './status-page.mjs';
import { validModelName } from './ollama.mjs';

const TELEGRAM_TOKEN = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;

export function tokenMatches(expected, given) {
  const a = Buffer.from(String(expected || ''));
  const b = Buffer.from(String(given || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function hostAllowed(hostHeader, port) {
  const host = String(hostHeader || '').toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

async function readJson(req, limit = 16 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

/** A model name typed by a person: checked here, and again by the manager, before it reaches the engine. */
export function modelName(value) {
  if (!validModelName(value)) {
    throw Object.assign(new Error('That is not a valid model name. Use a name like gemma3:4b.'), { status: 400 });
  }
  return value.trim();
}

/**
 * Folders arrive as plain strings. An empty or missing field means "leave as is"; for the AI folder
 * `keepWithData: true` means "store the AI files inside the data folder" (the default layout).
 */
export function storageRequest(body = {}) {
  const text = (v) => (typeof v === 'string' ? v.trim().slice(0, 1024) : '');
  const request = {};
  if (text(body.dataRoot)) request.dataRoot = text(body.dataRoot);
  if (body.keepWithData === true) request.aiRoot = null;
  else if (text(body.aiRoot)) request.aiRoot = text(body.aiRoot);
  return request;
}

/**
 * @param actions { restart(service?), shutdown(), retryAi(), setTelegramToken(token|null),
 *                  checkStorage(request), moveStorage(request), cleanupStorage(),
 *                  aiModels(), aiSetAuto(enabled), aiDownload(model), aiCancel(), aiDelete(model),
 *                  aiEngine(action), aiTry(model) }
 */
export function createStatusServer({ port, token, version, getStatus, tail, actions }) {
  const send = (res, status, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'",
    });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostAllowed(req.headers.host, port)) return send(res, 421, { error: 'Wrong host' });
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const authorized = tokenMatches(token, req.headers['x-agencyos-token']);

      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, renderStatusPage({ token, version }), 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, 'ok', 'text/plain; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, getStatus());

      if (!authorized) return send(res, 403, { error: 'Forbidden' });

      if (req.method === 'GET' && url.pathname === '/api/ai/models') return send(res, 200, await actions.aiModels());

      if (req.method === 'GET' && url.pathname.startsWith('/api/logs/')) {
        const name = decodeURIComponent(url.pathname.slice('/api/logs/'.length));
        const lines = Math.min(Number.parseInt(url.searchParams.get('lines') || '200', 10) || 200, 2000);
        const body = tail(name, lines);
        return body == null ? send(res, 404, { error: 'No such log' }) : send(res, 200, body, 'text/plain; charset=utf-8');
      }

      if (req.method === 'POST') {
        const body = await readJson(req);
        switch (url.pathname) {
          case '/api/restart':
            actions.restart(typeof body.service === 'string' ? body.service : undefined).catch(() => {});
            return send(res, 202, { ok: true });
          case '/api/shutdown':
            send(res, 202, { ok: true });
            setTimeout(() => actions.shutdown(), 50);
            return undefined;
          case '/api/ai/retry':
            actions.retryAi();
            return send(res, 202, { ok: true });
          case '/api/ai/auto':
            return send(res, 200, actions.aiSetAuto(body.enabled === true));
          case '/api/ai/pull':
            return send(res, 202, { ok: true, ...actions.aiDownload(modelName(body.model)) });
          case '/api/ai/cancel':
            return send(res, 200, actions.aiCancel());
          case '/api/ai/delete':
            return send(res, 200, { ok: true, ...(await actions.aiDelete(modelName(body.model))) });
          case '/api/ai/engine':
            return send(res, 202, { ok: true, ...actions.aiEngine(String(body.action || '')) });
          case '/api/ai/try':
            return send(res, 200, await actions.aiTry(modelName(body.model)));
          case '/api/storage/check':
            return send(res, 200, await actions.checkStorage(storageRequest(body)));
          case '/api/storage/move':
            await actions.moveStorage(storageRequest(body));
            return send(res, 202, { ok: true });
          case '/api/storage/cleanup':
            return send(res, 200, { ok: true, ...(await actions.cleanupStorage()) });
          case '/api/telegram': {
            const value = typeof body.token === 'string' ? body.token.trim() : '';
            if (value && !TELEGRAM_TOKEN.test(value)) {
              return send(res, 400, { error: 'That does not look like a bot token. It looks like 123456789:AAH… and comes from @BotFather.' });
            }
            await actions.setTelegramToken(value || null);
            return send(res, 200, { ok: true, configured: !!value });
          }
          default:
            return send(res, 404, { error: 'Not found' });
        }
      }
      return send(res, 404, { error: 'Not found' });
    } catch (error) {
      return send(res, error.status || 500, { error: error.status ? error.message : 'Something went wrong', ...(error.fields ? { fields: error.fields } : {}) });
    }
  });

  return {
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ port, host: '127.0.0.1' }, () => resolve());
      }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
