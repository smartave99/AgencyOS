// Moving AgencyOS's data (database, uploads, logs, settings) and, separately, the local AI engine
// and models to another folder or drive. The order is always: check, stop, copy, verify, switch.
// The old copy is never deleted by a move; it is removed later, only when the person asks, so a
// failed or doubtful move can always be abandoned without losing anything.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { freeDiskBytes } from './hardware.mjs';
import { writeLocations } from './paths.mjs';

const MIB = 1024 ** 2;
const BIG_FILE = 32 * MIB;
const HEADROOM_BYTES = 512 * MIB;
const SIZE_MARGIN = 1.1;
const PROGRESS_EVERY_MS = 250;
const LEFTOVERS_FILE = 'storage-leftovers.json';

/** Left behind by a running or stopped database; copying them would make the new copy look in use. */
export const SKIP_IN_DATA = ['run', 'pg/postmaster.pid', 'pg/postmaster.opts'];

/** Copied, but not compared: the supervisor may still add a line to its log while the move is being checked. */
const LOGS_NOT_COMPARED = ['logs'];

export class StorageError extends Error {
  constructor(message, fields = {}) {
    super(message);
    this.name = 'StorageError';
    this.status = 400;
    this.fields = fields;
  }
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 MB';
  return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(n / MIB))} MB`;
}

const pathModule = (platform) => (platform === 'win32' ? path.win32 : path.posix);

function helpers(platform) {
  const p = pathModule(platform);
  const norm = (x) => (platform === 'win32' ? p.resolve(x).toLowerCase() : p.resolve(x));
  const same = (a, b) => norm(a) === norm(b);
  const isInside = (child, parent) => {
    const c = norm(child);
    const q = norm(parent);
    return c !== q && c.startsWith(q.endsWith(p.sep) ? q : q + p.sep);
  };
  return { p, same, isInside };
}

// ---- walking, sizing, copying, verifying ---------------------------------------------------

const relKey = (rel) => rel.split(path.sep).join('/');
const skipped = (rel, skip) => skip.some((s) => rel === s || rel.startsWith(`${s}/`));

/** Yields every folder and file under `root` (folders first), minus anything in `skip`. */
async function* walk(root, skip = [], rel = '') {
  let entries;
  try {
    entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (skipped(childRel, skip)) continue;
    const abs = path.join(root, childRel);
    if (entry.isDirectory()) {
      yield { rel: childRel, abs, kind: 'dir' };
      yield* walk(root, skip, childRel);
    } else if (entry.isFile()) {
      yield { rel: childRel, abs, kind: 'file', size: (await fsp.stat(abs)).size };
    } else {
      yield { rel: childRel, abs, kind: 'other' };
    }
  }
}

export async function dirSize(root, skip = []) {
  let bytes = 0;
  for await (const item of walk(root, skip)) if (item.kind === 'file') bytes += item.size;
  return bytes;
}

async function copyBigFile(src, dest, mode, onBytes) {
  const read = fs.createReadStream(src, { highWaterMark: 4 * MIB });
  read.on('data', (chunk) => onBytes(chunk.length));
  await pipeline(read, fs.createWriteStream(dest, { flags: 'wx', mode }));
}

/** Copies `from` into `to`. Never overwrites: a file that already exists is an error. */
export async function copyTree(from, to, { skip = [], total = 0, onProgress = () => {}, log = () => {} } = {}) {
  await fsp.mkdir(to, { recursive: true });
  let copied = 0;
  let files = 0;
  let last = 0;
  const report = (force = false) => {
    const now = Date.now();
    if (force || now - last >= PROGRESS_EVERY_MS) {
      last = now;
      onProgress({ copiedBytes: copied, totalBytes: total, files });
    }
  };
  for await (const item of walk(from, skip)) {
    const dest = path.join(to, item.rel);
    if (item.kind === 'dir') {
      const { mode } = await fsp.stat(item.abs);
      await fsp.mkdir(dest, { recursive: true, mode: mode & 0o777 });
    } else if (item.kind === 'file') {
      const { mode } = await fsp.stat(item.abs);
      if (item.size > BIG_FILE) {
        await copyBigFile(item.abs, dest, mode & 0o777, (n) => {
          copied += n;
          report();
        });
      } else {
        await fsp.copyFile(item.abs, dest, fs.constants.COPYFILE_EXCL);
        await fsp.chmod(dest, mode & 0o777);
        copied += item.size;
      }
      files += 1;
      report();
    } else {
      log(`Not copied (not a plain file or folder): ${item.abs}`);
    }
  }
  report(true);
  return { copiedBytes: copied, files };
}

/** Every file of the source must exist in the copy with the same size; small files are compared byte for byte. */
export async function verifyTree(from, to, { skip = [] } = {}) {
  const problems = [];
  let files = 0;
  let bytes = 0;
  for await (const item of walk(from, skip)) {
    if (item.kind === 'other') continue;
    const dest = path.join(to, item.rel);
    let stat;
    try {
      stat = await fsp.stat(dest);
    } catch {
      problems.push(`Missing in the copy: ${item.rel}`);
      continue;
    }
    if (item.kind === 'dir') {
      if (!stat.isDirectory()) problems.push(`Not a folder in the copy: ${item.rel}`);
      continue;
    }
    files += 1;
    bytes += item.size;
    if (stat.size !== item.size) {
      problems.push(`Different size in the copy: ${item.rel}`);
    } else if (item.size <= MIB && !(await fsp.readFile(item.abs)).equals(await fsp.readFile(dest))) {
      problems.push(`Different content in the copy: ${item.rel}`);
    }
  }
  return { ok: problems.length === 0, files, bytes, problems: problems.slice(0, 5) };
}

/**
 * Deletes a folder's contents. `keep` names top-level entries to leave (the pointer file); the
 * folder itself goes too unless something was kept or `removeSelf` is false.
 */
export async function removeTree(dir, { keep = [], removeSelf = true } = {}) {
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const name of entries) {
    if (keep.includes(name)) continue;
    await fsp.rm(path.join(dir, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  if (removeSelf && !entries.some((n) => keep.includes(n))) await fsp.rmdir(dir).catch(() => {});
}

// ---- planning -----------------------------------------------------------------------------

/** The folders that would be in use after the request. Fields left out keep their current value. */
export function targetFor(paths, request = {}) {
  const { p } = helpers(paths.platform);
  const cur = paths.locations;
  const dataRoot = typeof request.dataRoot === 'string' && request.dataRoot.trim() ? p.resolve(request.dataRoot.trim()) : cur.dataRoot;
  let aiRoot;
  if (request.aiRoot === null) aiRoot = p.join(dataRoot, 'ollama'); // keep the AI files with the data
  else if (typeof request.aiRoot === 'string' && request.aiRoot.trim()) aiRoot = p.resolve(request.aiRoot.trim());
  else aiRoot = cur.customAi ? cur.aiRoot : p.join(dataRoot, 'ollama');
  return { dataRoot, aiRoot };
}

async function folderState(dir) {
  try {
    const stat = await fsp.stat(dir);
    if (!stat.isDirectory()) return 'file';
    return (await fsp.readdir(dir)).length ? 'notEmpty' : 'empty';
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    throw error;
  }
}

function nearestExisting(dir) {
  let current = path.resolve(dir);
  for (let i = 0; i < 64 && !fs.existsSync(current); i += 1) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

const volumeOf = (dir) => {
  const ancestor = nearestExisting(dir);
  try {
    return String(fs.statSync(ancestor).dev);
  } catch {
    return ancestor;
  }
};

/**
 * Checks a request and describes the work. Never changes anything. `errors` are shown next to the
 * field they belong to, so the form can validate while the person types.
 */
export async function planMove(paths, request, { statfs = fs.statfsSync } = {}) {
  const { p, same, isInside } = helpers(paths.platform);
  const cur = paths.locations;
  const target = targetFor(paths, request);
  const errors = {};
  const fail = (field, message) => {
    if (!errors[field]) errors[field] = message;
  };

  const dataChanges = !same(target.dataRoot, cur.dataRoot);
  const aiChanges = !same(target.aiRoot, cur.aiRoot);

  if (cur.locked && (dataChanges || aiChanges)) {
    fail('dataRoot', 'The location is fixed by the AGENCYOS_DATA setting, so it cannot be changed here.');
  }

  const checkFolder = async (field, dir, current, { insideDataAllowed = false } = {}) => {
    if (paths.platform === 'win32' && /^\\\\/.test(dir)) return fail(field, 'Network folders are not supported. Choose a folder on this computer.');
    if (p.parse(dir).root === p.resolve(dir)) return fail(field, 'Choose a folder, not a whole drive. Create a folder such as AgencyOS first.');
    if (same(dir, paths.installRoot) || isInside(dir, paths.installRoot)) return fail(field, 'That is inside the AgencyOS program folder, which is replaced when AgencyOS is updated.');
    if (isInside(dir, current)) return fail(field, 'That is inside the folder AgencyOS uses now. Choose a different place.');
    if (isInside(current, dir)) return fail(field, 'That folder contains the one AgencyOS uses now. Choose a different place.');
    if (!insideDataAllowed) {
      const state = await folderState(dir);
      if (state === 'file') return fail(field, 'That path is a file, not a folder.');
      if (state === 'notEmpty') return fail(field, 'That folder already has files in it. Choose an empty folder or a new one.');
    }
    return undefined;
  };

  if (dataChanges) await checkFolder('dataRoot', target.dataRoot, cur.dataRoot);
  if (aiChanges) {
    const keepsWithData = same(target.aiRoot, p.join(target.dataRoot, 'ollama'));
    if (!keepsWithData && (same(target.aiRoot, target.dataRoot) || isInside(target.aiRoot, target.dataRoot))) {
      fail('aiRoot', 'Choose a folder outside your data folder, or keep the AI files with your data.');
    } else if (isInside(target.dataRoot, target.aiRoot)) {
      fail('aiRoot', 'The AI folder cannot contain your data folder.');
    } else if (!keepsWithData) {
      await checkFolder('aiRoot', target.aiRoot, cur.aiRoot);
    }
  }

  const jobs = [];
  if (dataChanges) {
    const skip = [...SKIP_IN_DATA];
    if (isInside(cur.aiRoot, cur.dataRoot)) skip.push(relKey(p.relative(cur.dataRoot, cur.aiRoot)));
    jobs.push({ name: 'data', label: 'Your data', from: cur.dataRoot, to: target.dataRoot, skip, noCompare: LOGS_NOT_COMPARED });
  }
  if (aiChanges) jobs.push({ name: 'ai', label: 'Local AI files', from: cur.aiRoot, to: target.aiRoot, skip: [] });

  for (const job of jobs) job.bytes = await dirSize(job.from, job.skip);

  // Space is checked per drive: two folders going to the same drive add up.
  const needByVolume = new Map();
  for (const job of jobs) {
    const key = volumeOf(job.to);
    const seen = needByVolume.get(key);
    // The first job on a drive owns the message, and the headroom is counted once per drive.
    needByVolume.set(key, { need: (seen ? seen.need : HEADROOM_BYTES) + Math.ceil(job.bytes * SIZE_MARGIN), job: seen ? seen.job : job });
  }
  let needBytes = 0;
  let freeBytes = null;
  for (const { need, job } of needByVolume.values()) {
    const free = freeDiskBytes(job.to, statfs);
    needBytes += need;
    freeBytes = freeBytes == null ? free : Math.min(freeBytes, free ?? freeBytes);
    if (free != null && need > free) {
      fail(job.name === 'data' ? 'dataRoot' : 'aiRoot', `Not enough free space there: ${formatBytes(need)} needed, ${formatBytes(free)} free.`);
    }
  }

  return { ok: Object.keys(errors).length === 0, errors, jobs, target, changes: jobs.length > 0, needBytes, freeBytes };
}

// ---- moving -------------------------------------------------------------------------------

const leftoversFile = (paths) => path.join(paths.data.config, LEFTOVERS_FILE);

export function readLeftovers(paths) {
  try {
    const list = JSON.parse(fs.readFileSync(leftoversFile(paths), 'utf8'));
    return Array.isArray(list) ? list.filter((e) => e && typeof e.path === 'string') : [];
  } catch {
    return [];
  }
}

function writeLeftovers(paths, list) {
  const file = leftoversFile(paths);
  if (!list.length) return fsp.rm(file, { force: true });
  return fsp.writeFile(file, JSON.stringify(list, null, 2));
}

/**
 * Moves the data and/or AI folders. `stopServices` must leave nothing running that writes to them;
 * `restoreServices` is called if the move fails before the switch so AgencyOS carries on where it was.
 * Returns once the new location is recorded; the caller then starts AgencyOS again from it.
 */
export async function moveStorage({ paths, request, stopServices, restoreServices, onState = () => {}, log = () => {}, statfs }) {
  const plan = await planMove(paths, request, { statfs });
  if (!plan.ok) throw new StorageError(Object.values(plan.errors)[0], plan.errors);
  if (!plan.changes) throw new StorageError('Those are the folders AgencyOS already uses.');

  const totalBytes = plan.jobs.reduce((n, j) => n + j.bytes, 0);
  const created = [];
  let switched = false;
  try {
    onState({ phase: 'stopping', message: 'Stopping AgencyOS safely', totalBytes, copiedBytes: 0 });
    await stopServices();
    if (fs.existsSync(path.join(paths.data.pg, 'postmaster.pid'))) {
      throw new StorageError('The database did not stop cleanly, so nothing was moved. Try again in a moment.');
    }

    let doneBytes = 0;
    for (const job of plan.jobs) {
      const wasMissing = !fs.existsSync(job.to);
      created.push({ dir: job.to, wasMissing });
      onState({ phase: 'copying', message: `Copying ${job.label.toLowerCase()}`, totalBytes, copiedBytes: doneBytes });
      const base = doneBytes;
      const result = await copyTree(job.from, job.to, {
        skip: job.skip,
        total: job.bytes,
        log,
        onProgress: ({ copiedBytes }) => onState({ phase: 'copying', message: `Copying ${job.label.toLowerCase()}`, totalBytes, copiedBytes: base + copiedBytes }),
      });
      doneBytes += result.copiedBytes;
    }

    onState({ phase: 'verifying', message: 'Checking the copy', totalBytes, copiedBytes: totalBytes });
    for (const job of plan.jobs) {
      const check = await verifyTree(job.from, job.to, { skip: [...job.skip, ...(job.noCompare || [])] });
      if (!check.ok) throw new StorageError(`The copy did not match the original, so nothing was changed. ${check.problems[0]}`);
    }

    onState({ phase: 'switching', message: 'Switching to the new location', totalBytes, copiedBytes: totalBytes });
    const leftovers = readLeftovers(paths);
    const next = [...leftovers];
    const { isInside } = helpers(paths.platform);
    for (const job of plan.jobs) {
      // The AI folder usually sits inside the data folder, so removing the data folder removes it too.
      if (plan.jobs.some((other) => other !== job && isInside(job.from, other.from))) continue;
      next.push({ path: job.from, kind: job.name, bytes: job.bytes, movedAt: new Date().toISOString() });
    }
    // The record is written into the new folder, because that is where the next start looks.
    await fsp.mkdir(path.join(plan.target.dataRoot, 'config'), { recursive: true });
    await fsp.writeFile(path.join(plan.target.dataRoot, 'config', LEFTOVERS_FILE), JSON.stringify(next, null, 2));
    writeLocations(paths.locations.file, plan.target, { defaultRoot: paths.locations.defaultRoot, platform: paths.platform });
    switched = true;
    log(`Storage moved. Data: ${plan.target.dataRoot}. AI: ${plan.target.aiRoot}`);
    return plan;
  } catch (error) {
    if (!switched) {
      // Put things back exactly as they were: remove only what this attempt created.
      for (const { dir, wasMissing } of created.reverse()) {
        await removeTree(dir, { removeSelf: wasMissing }).catch(() => {});
      }
      await restoreServices().catch((e) => log(`Could not restart after a failed move: ${e.message}`));
    }
    throw error;
  }
}

/** Old copies that a finished move left in place, with the space each one takes. */
export function listLeftovers(paths) {
  const { same, isInside } = helpers(paths.platform);
  const inUse = [paths.locations.dataRoot, paths.locations.aiRoot];
  return readLeftovers(paths).filter((e) => fs.existsSync(e.path) && !inUse.some((u) => same(e.path, u) || isInside(u, e.path) || isInside(e.path, u)));
}

/** Deletes the old copies left by moves. The pointer file in the default folder is always kept. */
export async function cleanupLeftovers(paths, { log = () => {} } = {}) {
  const { same, isInside } = helpers(paths.platform);
  const inUse = [paths.locations.dataRoot, paths.locations.aiRoot];
  const all = readLeftovers(paths);
  const remaining = [];
  let removed = 0;
  for (const entry of all) {
    // Never touch anything AgencyOS uses now, or a folder that contains one.
    if (inUse.some((u) => same(entry.path, u) || isInside(u, entry.path) || isInside(entry.path, u))) {
      remaining.push(entry);
      continue;
    }
    log(`Removing the old copy at ${entry.path}`);
    await removeTree(entry.path, { keep: same(entry.path, paths.locations.defaultRoot) ? [path.basename(paths.locations.file)] : [] });
    removed += 1;
  }
  await writeLeftovers(paths, remaining);
  return { removed };
}

/** A data folder on a drive that is not connected must stop the start, not silently begin an empty database elsewhere. */
export function assertLocationsAvailable(paths) {
  if (paths.locations.locked) return;
  const folders = [['data', paths.locations.dataRoot]];
  if (paths.locations.customAi) folders.push(['AI', paths.locations.aiRoot]);
  for (const [label, dir] of folders) {
    if (fs.existsSync(dir) || fs.existsSync(path.dirname(dir))) continue;
    throw new Error(
      `The ${label} folder chosen for AgencyOS is not available: ${dir}\nIf it is on an external drive, connect the drive and try again. To go back to the default location, delete ${paths.locations.file} (your data stays where it is).`
    );
  }
}
