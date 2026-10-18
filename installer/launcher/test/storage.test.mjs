import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { resolvePaths, readLocations, writeLocations } from '../lib/paths.mjs';
import {
  planMove,
  dirSize,
  moveStorage,
  copyTree,
  verifyTree,
  removeTree,
  cleanupLeftovers,
  listLeftovers,
  assertLocationsAvailable,
  targetFor,
  StorageError,
} from '../lib/storage.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agencyos-storage-'));
const write = (file, text = 'x') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

/** A fake install whose default folder is inside the temp dir, so the pointer file is hermetic. */
function world() {
  const dir = tmp();
  const env = { XDG_DATA_HOME: path.join(dir, 'share'), LOCALAPPDATA: path.join(dir, 'share') };
  const make = () => resolvePaths({ launcherDir: path.join(dir, 'install', 'launcher'), env, platform: process.platform, home: dir });
  const paths = make();
  write(path.join(paths.data.pg, 'PG_VERSION'), '16');
  write(path.join(paths.data.pg, 'base', 'data'), 'rows');
  write(path.join(paths.data.uploads, '2026', '10', 'a.png'), 'png');
  write(path.join(paths.data.config, 'secrets.json'), '{"dbPassword":"p"}');
  write(path.join(paths.data.run, 'supervisor.json'), '{}');
  write(path.join(paths.data.ollamaModels, 'blob'), 'model-bytes');
  return { dir, env, paths, make };
}

const bigStatfs = () => ({ bavail: 1e9, bsize: 4096 });
const stops = () => {
  const calls = { stop: 0, restore: 0 };
  return { calls, stopServices: async () => void (calls.stop += 1), restoreServices: async () => void (calls.restore += 1) };
};

describe('locations pointer', () => {
  it('uses the default folder until a choice is saved, then follows the choice', () => {
    const { paths, make, dir } = world();
    assert.equal(paths.data.root, path.join(dir, 'share', process.platform === 'win32' ? 'AgencyOS' : 'agencyos'));
    assert.equal(paths.data.ollamaModels, path.join(paths.data.root, 'ollama', 'models'));
    assert.equal(paths.locations.customAi, false);

    writeLocations(paths.locations.file, { dataRoot: path.join(dir, 'D', 'data'), aiRoot: path.join(dir, 'E', 'ai') }, { defaultRoot: paths.locations.defaultRoot, platform: process.platform });
    const next = make();
    assert.equal(next.data.root, path.join(dir, 'D', 'data'));
    assert.equal(next.data.uploads, path.join(dir, 'D', 'data', 'uploads'));
    assert.equal(next.data.ollamaApp, path.join(dir, 'E', 'ai', 'app'));
    assert.equal(next.data.ollamaModels, path.join(dir, 'E', 'ai', 'models'));
    assert.equal(next.locations.customAi, true);
  });

  it('stores only what differs from the defaults', () => {
    const { paths, dir } = world();
    const stored = writeLocations(paths.locations.file, { dataRoot: paths.locations.defaultRoot, aiRoot: path.join(paths.locations.defaultRoot, 'ollama') }, { defaultRoot: paths.locations.defaultRoot, platform: process.platform });
    assert.deepEqual(stored, { version: 1 });
    const moved = writeLocations(paths.locations.file, { dataRoot: path.join(dir, 'D'), aiRoot: path.join(dir, 'D', 'ollama') }, { defaultRoot: paths.locations.defaultRoot, platform: process.platform });
    assert.deepEqual(moved, { version: 1, dataRoot: path.join(dir, 'D') });
  });

  it('ignores a damaged or relative pointer instead of trusting it', () => {
    const { paths, make } = world();
    write(paths.locations.file, '{not json');
    assert.deepEqual(readLocations(paths.locations.file, 'linux'), {});
    write(paths.locations.file, JSON.stringify({ dataRoot: 'relative/dir', aiRoot: 5 }));
    assert.deepEqual(readLocations(paths.locations.file, 'linux'), {});
    assert.equal(make().data.root, paths.locations.defaultRoot);
  });

  it('reads the file exactly as the installer writes it (CRLF, escaped backslashes, with or without a byte-order mark)', () => {
    const { paths } = world();
    const written = '{\r\n  "version": 1,\r\n  "dataRoot": "/mnt/d/AgencyOS",\r\n  "aiRoot": "/mnt/e/AI"\r\n}\r\n';
    write(paths.locations.file, written);
    assert.deepEqual(readLocations(paths.locations.file, 'linux'), { dataRoot: '/mnt/d/AgencyOS', aiRoot: '/mnt/e/AI' });
    write(paths.locations.file, `\uFEFF${written}`);
    assert.deepEqual(readLocations(paths.locations.file, 'linux'), { dataRoot: '/mnt/d/AgencyOS', aiRoot: '/mnt/e/AI' });
    write(paths.locations.file, '{\r\n  "version": 1,\r\n  "dataRoot": "D:\\\\AgencyOS"\r\n}\r\n');
    assert.deepEqual(readLocations(paths.locations.file, 'win32'), { dataRoot: 'D:\\AgencyOS' });
  });

  it('AGENCYOS_DATA wins, freezes the choice and never reads the pointer', () => {
    const { paths, dir } = world();
    writeLocations(paths.locations.file, { dataRoot: path.join(dir, 'D') }, { defaultRoot: paths.locations.defaultRoot, platform: process.platform });
    const locked = resolvePaths({ launcherDir: path.join(dir, 'x', 'launcher'), env: { XDG_DATA_HOME: path.join(dir, 'share'), AGENCYOS_DATA: path.join(dir, 'fixed') }, platform: process.platform, home: dir });
    assert.equal(locked.data.root, path.join(dir, 'fixed'));
    assert.equal(locked.locations.locked, true);
  });

  it('understands Windows paths', () => {
    const p = resolvePaths({ launcherDir: 'C:\\Users\\Ana\\AppData\\Local\\Programs\\AgencyOS\\launcher', env: { LOCALAPPDATA: 'C:\\Users\\Ana\\AppData\\Local' }, platform: 'win32' });
    assert.equal(p.locations.file, 'C:\\Users\\Ana\\AppData\\Local\\AgencyOS\\locations.json');
    assert.equal(p.data.ollamaModels, 'C:\\Users\\Ana\\AppData\\Local\\AgencyOS\\ollama\\models');
  });
});

describe('checking a request', () => {
  it('accepts a new empty folder and reports the work', async () => {
    const { paths, dir } = world();
    const plan = await planMove(paths, { dataRoot: path.join(dir, 'D', 'AgencyOS') }, { statfs: bigStatfs });
    assert.equal(plan.ok, true);
    assert.equal(plan.changes, true);
    const data = plan.jobs.find((j) => j.name === 'data');
    const ai = plan.jobs.find((j) => j.name === 'ai');
    assert.ok(data.bytes > 0);
    assert.ok(data.skip.includes('run') && data.skip.includes('ollama'), 'the run folder and the AI folder are handled separately');
    assert.equal(ai.to, path.join(dir, 'D', 'AgencyOS', 'ollama'));
  });

  it('says nothing changes when asked for the folders already in use', async () => {
    const { paths } = world();
    const plan = await planMove(paths, { dataRoot: paths.data.root }, { statfs: bigStatfs });
    assert.equal(plan.changes, false);
  });

  it('refuses a drive root, the program folder, a file, a non-empty folder and nesting', async () => {
    const { paths, dir } = world();
    const busy = path.join(dir, 'busy');
    write(path.join(busy, 'file.txt'));
    const asFile = path.join(dir, 'afile');
    write(asFile);
    const cases = [
      [{ dataRoot: '/' }, /not a whole drive/],
      [{ dataRoot: path.join(paths.installRoot, 'data') }, /program folder/],
      [{ dataRoot: asFile }, /is a file/],
      [{ dataRoot: busy }, /already has files/],
      [{ dataRoot: path.join(paths.data.root, 'inner') }, /inside the folder AgencyOS uses now/],
      [{ dataRoot: dir }, /contains the one AgencyOS uses now/],
    ];
    for (const [request, message] of cases) {
      const plan = await planMove(paths, request, { statfs: bigStatfs });
      assert.equal(plan.ok, false, JSON.stringify(request));
      assert.match(plan.errors.dataRoot, message);
    }
  });

  it('refuses when the drive is too small, naming how much is needed', async () => {
    const { paths, dir } = world();
    const plan = await planMove(paths, { dataRoot: path.join(dir, 'D') }, { statfs: () => ({ bavail: 10, bsize: 1 }) });
    assert.equal(plan.ok, false);
    assert.match(plan.errors.dataRoot, /Not enough free space.*needed.*free/);
  });

  it('keeps the AI files outside the data folder unless asked to keep them with the data', async () => {
    const { paths, dir } = world();
    const inside = await planMove(paths, { aiRoot: path.join(paths.data.root, 'models-here') }, { statfs: bigStatfs });
    assert.match(inside.errors.aiRoot, /outside your data folder/);
    const ok = await planMove(paths, { aiRoot: path.join(dir, 'E', 'ai') }, { statfs: bigStatfs });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.jobs.map((j) => j.name), ['ai']);
    assert.equal(targetFor(paths, { aiRoot: null }).aiRoot, path.join(paths.data.root, 'ollama'));
  });

  it('cannot move when AGENCYOS_DATA fixes the location', async () => {
    const dir = tmp();
    const paths = resolvePaths({ launcherDir: path.join(dir, 'i', 'launcher'), env: { AGENCYOS_DATA: path.join(dir, 'd') }, platform: process.platform, home: dir });
    const plan = await planMove(paths, { dataRoot: path.join(dir, 'other') }, { statfs: bigStatfs });
    assert.equal(plan.ok, false);
    assert.match(plan.errors.dataRoot, /AGENCYOS_DATA/);
  });
});

describe('copying and verifying', () => {
  it('copies everything but the skipped paths, keeps modes, and reports progress', async () => {
    const { dir } = world();
    const from = path.join(dir, 'src');
    write(path.join(from, 'a', 'one.txt'), 'one');
    write(path.join(from, 'run', 'pid'), '1');
    write(path.join(from, 'pg', 'postmaster.pid'), '9');
    write(path.join(from, 'pg', 'PG_VERSION'), '16');
    fs.chmodSync(path.join(from, 'a', 'one.txt'), 0o600);
    const seen = [];
    const to = path.join(dir, 'dst');
    await copyTree(from, to, { skip: ['run', 'pg/postmaster.pid'], total: 10, onProgress: (p) => seen.push(p.copiedBytes) });
    assert.equal(fs.readFileSync(path.join(to, 'a', 'one.txt'), 'utf8'), 'one');
    // Windows has no permission bits to keep.
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(to, 'a', 'one.txt')).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(to, 'run')), false);
    assert.equal(fs.existsSync(path.join(to, 'pg', 'postmaster.pid')), false);
    assert.ok(seen.length > 0);
    assert.equal((await verifyTree(from, to, { skip: ['run', 'pg/postmaster.pid'] })).ok, true);
  });

  it('copies a large file in chunks and does not overwrite an existing one', async () => {
    const { dir } = world();
    const from = path.join(dir, 'src');
    fs.mkdirSync(from, { recursive: true });
    fs.writeFileSync(path.join(from, 'big.bin'), Buffer.alloc(33 * 1024 * 1024, 7));
    const to = path.join(dir, 'dst');
    await copyTree(from, to);
    assert.equal(fs.statSync(path.join(to, 'big.bin')).size, 33 * 1024 * 1024);
    await assert.rejects(copyTree(from, to), /EEXIST/);
  });

  it('notices a missing, resized or altered file', async () => {
    const { dir } = world();
    const from = path.join(dir, 'src');
    write(path.join(from, 'a.txt'), 'aaaa');
    write(path.join(from, 'b.txt'), 'bbbb');
    write(path.join(from, 'c.txt'), 'cccc');
    const to = path.join(dir, 'dst');
    await copyTree(from, to);
    fs.rmSync(path.join(to, 'a.txt'));
    fs.writeFileSync(path.join(to, 'b.txt'), 'bb');
    fs.writeFileSync(path.join(to, 'c.txt'), 'xxxx');
    const check = await verifyTree(from, to);
    assert.equal(check.ok, false);
    assert.equal(check.problems.length, 3);
  });

  it('removeTree keeps the named entries', async () => {
    const { dir } = world();
    write(path.join(dir, 'gone', 'locations.json'), '{}');
    write(path.join(dir, 'gone', 'other', 'x'));
    await removeTree(path.join(dir, 'gone'), { keep: ['locations.json'] });
    assert.deepEqual(fs.readdirSync(path.join(dir, 'gone')), ['locations.json']);
  });
});

describe('moving', () => {
  it('copies, verifies, switches the pointer and leaves the old copy alone', async () => {
    const { paths, make, dir } = world();
    const states = [];
    const { calls, stopServices, restoreServices } = stops();
    const target = path.join(dir, 'D', 'AgencyOS');
    const plan = await moveStorage({ paths, request: { dataRoot: target }, stopServices, restoreServices, onState: (s) => states.push(s.phase), statfs: bigStatfs });

    assert.deepEqual([...new Set(states)], ['stopping', 'copying', 'verifying', 'switching']);
    assert.equal(calls.stop, 1);
    assert.equal(calls.restore, 0);
    assert.equal(plan.target.dataRoot, target);

    const next = make();
    assert.equal(next.data.root, target);
    assert.equal(fs.readFileSync(path.join(next.data.uploads, '2026', '10', 'a.png'), 'utf8'), 'png');
    assert.equal(fs.readFileSync(next.data.secrets, 'utf8'), '{"dbPassword":"p"}');
    assert.equal(fs.readFileSync(path.join(next.data.ollamaModels, 'blob'), 'utf8'), 'model-bytes');
    assert.equal(fs.existsSync(next.data.run), false, 'the run folder is not copied');
    assert.ok(fs.existsSync(path.join(paths.data.uploads, '2026', '10', 'a.png')), 'the old copy is still there');

    assert.deepEqual(listLeftovers(next).map((e) => e.path), [paths.data.root], 'the AI folder is inside the data folder, so one entry covers both');
  });

  it('does not fail a good copy because a log line was added while it was being checked', async () => {
    const { paths, make, dir } = world();
    write(path.join(paths.data.logs, 'supervisor.log'), 'start\n');
    const { stopServices, restoreServices } = stops();
    let grew = false;
    await moveStorage({
      paths,
      request: { dataRoot: path.join(dir, 'D', 'AgencyOS') },
      stopServices,
      restoreServices,
      statfs: bigStatfs,
      onState: (s) => {
        // The supervisor logs one more line after the copy and before the comparison.
        if (s.phase === 'verifying' && !grew) {
          grew = true;
          fs.appendFileSync(path.join(paths.data.logs, 'supervisor.log'), 'one more line\n');
        }
      },
    });
    assert.ok(grew);
    assert.equal(make().data.root, path.join(dir, 'D', 'AgencyOS'));
    assert.ok(fs.existsSync(path.join(dir, 'D', 'AgencyOS', 'logs', 'supervisor.log')), 'the log is still copied');
  });

  it('moves only the AI files when only they are changed', async () => {
    const { paths, make, dir } = world();
    const { stopServices, restoreServices } = stops();
    await moveStorage({ paths, request: { aiRoot: path.join(dir, 'E', 'ai') }, stopServices, restoreServices, statfs: bigStatfs });
    const next = make();
    assert.equal(next.data.root, paths.data.root);
    assert.equal(fs.readFileSync(path.join(dir, 'E', 'ai', 'models', 'blob'), 'utf8'), 'model-bytes');
  });

  it('puts everything back and restarts the services when the copy fails', async () => {
    const { paths, make, dir } = world();
    const { calls, stopServices, restoreServices } = stops();
    const target = path.join(dir, 'D', 'AgencyOS');
    // A second job into a target that appears mid-way makes the copy fail with EEXIST.
    const sabotage = async () => {
      await stopServices();
      write(path.join(target, 'uploads', '2026', '10', 'a.png'), 'in the way');
    };
    // planMove rejects a non-empty target, so create the clash only after planning, inside stopServices.
    await assert.rejects(moveStorage({ paths, request: { dataRoot: target }, stopServices: sabotage, restoreServices, statfs: bigStatfs }), /EEXIST/);
    assert.equal(calls.restore, 1);
    assert.equal(make().data.root, paths.data.root, 'the pointer was not switched');
    assert.equal(fs.readFileSync(path.join(paths.data.uploads, '2026', '10', 'a.png'), 'utf8'), 'png');
    assert.equal(fs.existsSync(path.join(target, 'pg')), false, 'partial copy removed');
  });

  it('refuses to copy a database that is still running', async () => {
    const { paths, dir } = world();
    write(path.join(paths.data.pg, 'postmaster.pid'), '123');
    const { calls, stopServices, restoreServices } = stops();
    await assert.rejects(
      moveStorage({ paths, request: { dataRoot: path.join(dir, 'D') }, stopServices, restoreServices, statfs: bigStatfs }),
      (e) => e instanceof StorageError && /did not stop cleanly/.test(e.message)
    );
    assert.equal(calls.restore, 1);
    assert.equal(fs.existsSync(path.join(dir, 'D')), false);
  });

  it('reports a bad request as a StorageError before stopping anything', async () => {
    const { paths } = world();
    const { calls, stopServices, restoreServices } = stops();
    await assert.rejects(moveStorage({ paths, request: { dataRoot: '/' }, stopServices, restoreServices, statfs: bigStatfs }), StorageError);
    assert.equal(calls.stop, 0);
  });
});

describe('removing the old copy', () => {
  it('deletes the old folders only when asked, and keeps the pointer in the default folder', async () => {
    const { paths, make, dir } = world();
    const { stopServices, restoreServices } = stops();
    await moveStorage({ paths, request: { dataRoot: path.join(dir, 'D', 'AgencyOS') }, stopServices, restoreServices, statfs: bigStatfs });
    const next = make();
    assert.ok(fs.existsSync(path.join(paths.data.uploads, '2026', '10', 'a.png')));
    assert.ok(fs.existsSync(next.locations.file), 'the pointer sits in the default folder');

    const result = await cleanupLeftovers(next);
    assert.equal(result.removed, 1);
    assert.equal(fs.existsSync(paths.data.uploads), false);
    assert.equal(fs.existsSync(paths.data.pg), false);
    assert.ok(fs.existsSync(next.locations.file), 'the pointer survives the cleanup');
    assert.equal(make().data.root, path.join(dir, 'D', 'AgencyOS'));
    assert.deepEqual(listLeftovers(make()), []);
    assert.ok(fs.existsSync(next.data.secrets), 'the new copy is untouched');
  });

  it('never removes a folder that is in use', async () => {
    const { paths } = world();
    write(path.join(paths.data.config, 'storage-leftovers.json'), JSON.stringify([{ path: paths.data.root }, { path: path.dirname(paths.data.root) }]));
    const result = await cleanupLeftovers(paths);
    assert.equal(result.removed, 0);
    assert.ok(fs.existsSync(paths.data.secrets));
  });
});

describe('a missing drive', () => {
  it('stops the start instead of beginning an empty database somewhere else', () => {
    const { paths, make, dir } = world();
    writeLocations(paths.locations.file, { dataRoot: path.join(dir, 'unplugged', 'AgencyOS') }, { defaultRoot: paths.locations.defaultRoot, platform: process.platform });
    assert.throws(() => assertLocationsAvailable(make()), /not available.*connect the drive/s);
  });

  it('is fine when the chosen folder exists or only its last part is new', () => {
    const { paths, make, dir } = world();
    fs.mkdirSync(path.join(dir, 'D'));
    writeLocations(paths.locations.file, { dataRoot: path.join(dir, 'D', 'AgencyOS') }, { defaultRoot: paths.locations.defaultRoot, platform: process.platform });
    assert.doesNotThrow(() => assertLocationsAvailable(make()));
  });
});

describe('sizing a folder that is in use', () => {
  it('leaves out a file that vanishes while it is being read, and one that cannot be read', async (t) => {
    const { paths } = world();
    write(path.join(paths.data.pg, 'pg_wal', 'segment-1'), 'abcd');
    write(path.join(paths.data.pg, 'pg_wal', 'segment-2'), 'efgh');
    write(path.join(paths.data.pg, 'pg_wal', 'locked'), 'ijkl');
    const before = await dirSize(paths.data.root, ['run', 'ollama']);
    const real = fsp.stat;
    t.after(() => mock.restoreAll());
    mock.method(fsp, 'stat', async (file, ...rest) => {
      if (String(file).endsWith('segment-1')) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      if (String(file).endsWith('locked')) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return real.call(fsp, file, ...rest);
    });
    assert.equal(await dirSize(paths.data.root, ['run', 'ollama']), before - 4 - 4);
  });

  it('a check of a whole drive is answered with the reason, even while the database is running', async () => {
    const { paths } = world();
    const plan = await planMove(paths, { dataRoot: path.parse(paths.data.root).root }, { statfs: bigStatfs });
    assert.equal(plan.ok, false);
    assert.match(plan.errors.dataRoot, /not a whole drive/);
  });
});
