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
    // The background process lives for 30 s unless the test ends it; waiting for it would take at least that long,
    // so a generous limit of 15 s still tells the two apart on a machine that is slow right now.
    const parent = `
      const { spawn } = require('child_process');
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit', detached: true });
      child.unref();
      console.log('started the server', child.pid);
    `;
    const t0 = Date.now();
    const r = await runToEnd(process.execPath, ['-e', parent]);
    const took = Date.now() - t0;
    const pid = Number(/started the server (\d+)/.exec(r.output)?.[1]);
    if (pid) {
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
    }
    assert.equal(r.code, 0);
    assert.match(r.output, /started the server/);
    assert.ok(took < 15000, `took ${took} ms: it waited for the background process`);
  });

  it('reports a command that cannot be started', async () => {
    const r = await runToEnd('definitely-not-a-real-program-xyz', []);
    assert.equal(r.code, -1);
  });
});
