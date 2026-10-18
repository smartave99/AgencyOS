// Minimal .env reading and writing. user.env is the one file a person may edit by hand
// (Telegram bot token, optional overrides); everything else is generated.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function parseEnv(text = '') {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function readEnvFile(file) {
  try {
    return parseEnv(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

const needsQuotes = (v) => /[\s#"'$`\\]/.test(v) || v === '';

/** Sets (or, with null/'' removes) one key while keeping comments and other lines intact. */
export function updateEnvText(text, key, value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid variable name: ${key}`);
  if (typeof value === 'string' && /[\r\n]/.test(value)) throw new Error('Value must be a single line');
  const lines = String(text || '').split(/\r?\n/);
  const rendered = value == null || value === '' ? null : `${key}=${needsQuotes(value) ? JSON.stringify(value) : value}`;
  let replaced = false;
  const next = [];
  for (const line of lines) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && m[1] === key) {
      if (!replaced && rendered) next.push(rendered);
      replaced = true;
      continue;
    }
    next.push(line);
  }
  if (!replaced && rendered) {
    while (next.length && next[next.length - 1] === '') next.pop();
    next.push(rendered);
  }
  while (next.length && next[next.length - 1] === '') next.pop();
  return `${next.join('\n')}\n`;
}

export function setEnvKey(file, key, value) {
  let current = '';
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    /* new file */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, updateEnvText(current, key, value), { mode: 0o600 });
}

/** Random secrets are made once per install and then reused for the life of the data folder. */
export function loadOrCreateSecrets(file, random = (n) => crypto.randomBytes(n).toString('hex')) {
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* first run */
  }
  const secrets = {
    jwtSecret: existing.jwtSecret || random(48),
    dbPassword: existing.dbPassword || random(24),
    adminToken: existing.adminToken || random(24),
    // Shared by the app's server and the Telegram account worker, which listens on this computer only.
    workerToken: existing.workerToken || random(24),
  };
  if (JSON.stringify(secrets) !== JSON.stringify(existing)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  }
  return secrets;
}
