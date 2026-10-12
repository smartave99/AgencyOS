import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runToEnd } from '../lib/services.mjs';

describe('runToEnd', () => {
  it('returns the exit code and output of a normal command', async () => {
    const r = await runToEnd(process.execPath, ['-e', 'console.log("hello"); process.exit(3)']);
    assert.equal(r.code, 3);
    assert.match(r.output, /hello/);
  });

  it('does not wait for a background process that keeps the output pipes open (what pg_ctl does)', async () => {
    const parent = `
      const { spawn } = require('child_process');
      spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], { stdio: 'inherit', detached: true }).unref();
      console.log('started the server');
    `;
    const t0 = Date.now();
    const r = await runToEnd(process.execPath, ['-e', parent]);
    assert.equal(r.code, 0);
    assert.match(r.output, /started the server/);
    assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms: it waited for the background process`);
  });

  it('reports a command that cannot be started', async () => {
    const r = await runToEnd('definitely-not-a-real-program-xyz', []);
    assert.equal(r.code, -1);
  });
});
