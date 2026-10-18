#!/usr/bin/env node
// Assembles the application part of the installer from a finished `pnpm run build`:
//
//   <out>/app/backend|orchestrator   compiled NestJS apps
//   <out>/app/frontend               Next.js standalone server (+ static files)
//   <out>/app/node_modules           only the packages the backend and orchestrator can reach
//   <out>/app/prisma                 schema and migrations
//   <out>/app/telegram-worker        the Python Telegram user-account worker (its interpreter is staged by stage-runtime)
//   <out>/app/agent-mcp              the MCP server a person can point an agent program (Antigravity) at; no dependencies
//   <out>/launcher                   the supervisor
//
// The repository keeps every dependency of every app in one package.json (about 3.4 GB installed).
// The backend only needs a fraction of that, so the packages are chosen by following what the
// compiled code actually requires, then verified by loading every compiled file.
//
//   node installer/build/stage-app.mjs --out <dir> [--verify] [--keep-dev-files]

import fs from 'node:fs';
import path from 'node:path';
import { builtinModules, createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const out = path.resolve(option('--out', path.join(root, 'installer', 'dist', 'stage')));
const target = option('--platform', process.platform); // win32 for the installer; the host platform for local dry runs
const appDir = path.join(out, 'app');
const modules = path.join(root, 'node_modules');
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

const log = (...m) => console.log('[stage-app]', ...m);
const die = (message) => {
  console.error(`[stage-app] ERROR: ${message}`);
  process.exit(1);
};

// ---------------------------------------------------------------------------------------
// 1. inputs
// ---------------------------------------------------------------------------------------
const inputs = {
  backend: path.join(root, 'apps/backend/dist'),
  orchestrator: path.join(root, 'apps/orchestrator/dist'),
  standalone: path.join(root, 'apps/frontend/.next/standalone'),
  staticDir: path.join(root, 'apps/frontend/.next/static'),
  publicDir: path.join(root, 'apps/frontend/public'),
  schema: path.join(root, 'libraries/nestjs-libraries/src/database/prisma/schema.prisma'),
  migrations: path.join(root, 'libraries/nestjs-libraries/src/database/prisma/migrations'),
  launcher: path.join(root, 'installer/launcher'),
};
const mustExist = {
  [path.join(inputs.backend, 'apps/backend/src/main.js')]: 'run `pnpm run build:backend`',
  [path.join(inputs.orchestrator, 'apps/orchestrator/src/main.js')]: 'run `pnpm run build:orchestrator`',
  [path.join(inputs.standalone, 'apps/frontend/server.js')]: 'run the frontend build with AGENCYOS_STANDALONE=true',
  [inputs.schema]: 'schema.prisma is missing',
  [path.join(modules, '.prisma/client')]: 'run `pnpm run prisma-generate`',
};
for (const [file, hint] of Object.entries(mustExist)) if (!fs.existsSync(file)) die(`${path.relative(root, file)} not found: ${hint}`);

// ---------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------
const JUNK_FILE = /\.(map|tsbuildinfo)$|\.d\.(ts|mts|cts)$|\.(md|markdown)$/i;
const KEEP_DOC = /^(license|licence|notice|copying|patents|third[-_ ]party)/i;
const JUNK_DIR = new Set(['.github', '.vscode', '__tests__', '.idea']);

function copyTree(src, dest, { prune = true } = {}) {
  fs.cpSync(src, dest, {
    recursive: true,
    dereference: true,
    filter(from) {
      if (!prune) return true;
      const base = path.basename(from);
      let stat;
      try {
        stat = fs.lstatSync(from);
      } catch {
        return false;
      }
      if (stat.isDirectory()) return !JUNK_DIR.has(base);
      if (KEEP_DOC.test(base)) return true;
      return !JUNK_FILE.test(base);
    },
  });
}

function dirSize(dir) {
  let total = 0;
  let files = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        total += fs.statSync(p).size;
        files += 1;
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return { bytes: total, files };
}
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

// ---------------------------------------------------------------------------------------
// 2. app code
// ---------------------------------------------------------------------------------------
log(`staging into ${out}`);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(appDir, { recursive: true });

copyTree(inputs.backend, path.join(appDir, 'backend/dist'));
copyTree(inputs.orchestrator, path.join(appDir, 'orchestrator/dist'));
// Anchors "commonjs" for the compiled apps so Node never reads some unrelated package.json above the install.
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'agencyos-app', private: true }, null, 2));

copyTree(inputs.standalone, path.join(appDir, 'frontend'), { prune: false });
const frontendApp = path.join(appDir, 'frontend/apps/frontend');
fs.mkdirSync(path.join(frontendApp, '.next'), { recursive: true });
copyTree(inputs.staticDir, path.join(frontendApp, '.next/static'), { prune: false });
if (fs.existsSync(inputs.publicDir)) copyTree(inputs.publicDir, path.join(frontendApp, 'public'), { prune: false });
// `.env` files must never travel with the installer.
for (const f of fs.readdirSync(path.join(appDir, 'frontend'))) if (f.startsWith('.env')) fs.rmSync(path.join(appDir, 'frontend', f));

// Next's file tracing copies only the files it saw being imported, and can leave out a package's
// entry file (it did for @swc/helpers, which crashed the server at start). Any traced package
// that Node cannot resolve is replaced by the complete package from the repository.
{
  const stagedModules = path.join(appDir, 'frontend/node_modules');
  const sourceModules = modules;
  const completed = [];
  const walkPackages = (stagedDir, sourceDir) => {
    for (const entry of fs.readdirSync(stagedDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.bin') continue;
      const stagedPkg = path.join(stagedDir, entry.name);
      if (entry.name.startsWith('@')) {
        walkPackages(stagedPkg, path.join(sourceDir, entry.name));
        continue;
      }
      if (!fs.existsSync(path.join(stagedPkg, 'package.json'))) continue;
      const sourcePkg = path.join(sourceDir, entry.name);
      let resolvable = true;
      try {
        createRequire(path.join(stagedPkg, 'noop.js')).resolve(stagedPkg);
      } catch (error) {
        // ESM-only packages have no CommonJS entry by design; only a missing file counts.
        resolvable = !/Cannot find module/.test(String(error.message));
      }
      if (!resolvable && fs.existsSync(path.join(sourcePkg, 'package.json'))) {
        copyTree(sourcePkg, stagedPkg);
        completed.push(path.relative(stagedModules, stagedPkg));
      }
      const nested = path.join(stagedPkg, 'node_modules');
      if (fs.existsSync(nested)) walkPackages(nested, path.join(sourcePkg, 'node_modules'));
    }
  };
  walkPackages(stagedModules, sourceModules);
  log(`completed ${completed.length} partially traced frontend packages${completed.length ? `: ${completed.slice(0, 12).join(', ')}` : ''}`);
}

fs.mkdirSync(path.join(appDir, 'prisma'), { recursive: true });
fs.copyFileSync(inputs.schema, path.join(appDir, 'prisma/schema.prisma'));
copyTree(inputs.migrations, path.join(appDir, 'prisma/migrations'), { prune: false });

// The MCP server for agent programs: one file with no dependencies, run with the bundled Node when a person
// connects an agent under Admin > Agent integrations. The page looks for it at app/agent-mcp/server.mjs.
{
  const server = path.join(root, 'apps/agent-mcp/server.mjs');
  if (!fs.existsSync(server)) die('apps/agent-mcp/server.mjs not found');
  const check = spawnSync(process.execPath, ['--check', server], { encoding: 'utf8' });
  if (check.status !== 0) die(`apps/agent-mcp/server.mjs does not parse: ${check.stderr}`);
  fs.mkdirSync(path.join(appDir, 'agent-mcp'), { recursive: true });
  fs.copyFileSync(server, path.join(appDir, 'agent-mcp/server.mjs'));
}

// The Telegram user-account worker: its source only (no tests, no bytecode); stage-runtime adds Python and the packages.
{
  const source = path.join(root, 'apps/telegram-worker/agencyos_telegram');
  if (!fs.existsSync(path.join(source, '__main__.py'))) die('apps/telegram-worker/agencyos_telegram/__main__.py not found');
  fs.cpSync(source, path.join(appDir, 'telegram-worker/agencyos_telegram'), {
    recursive: true,
    filter: (from) => path.basename(from) !== '__pycache__' && !from.endsWith('.pyc'),
  });
  fs.copyFileSync(path.join(root, 'apps/telegram-worker/requirements.lock.txt'), path.join(appDir, 'telegram-worker/requirements.lock.txt'));
}

// ---------------------------------------------------------------------------------------
// 3. node_modules: follow the requires
// ---------------------------------------------------------------------------------------
const REQUIRE_RE = /\brequire\(\s*["']([^"'\n]+)["']\s*\)|\bimport\(\s*["']([^"'\n]+)["']\s*\)|\bfrom\s+["']([^"'\n]+)["']/g;

function packageName(spec) {
  if (!spec || spec.startsWith('.') || spec.startsWith('/') || BUILTINS.has(spec) || /^[a-z]:\\/i.test(spec)) return null;
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function* walkJs(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkJs(p);
    else if (/\.(c|m)?js$/.test(e.name)) yield p;
  }
}

const roots = new Set();
for (const dist of [path.join(appDir, 'backend/dist'), path.join(appDir, 'orchestrator/dist')]) {
  for (const file of walkJs(dist)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(REQUIRE_RE)) {
      const name = packageName(m[1] || m[2] || m[3]);
      if (name) roots.add(name);
    }
  }
}
log(`compiled code references ${roots.size} packages directly`);

// Loaded by name at runtime by frameworks (so no literal require appears in our code), plus what the launcher itself uses.
const ALWAYS = [
  'pg', 'prisma', '@prisma/client', '@prisma/engines', 'reflect-metadata', 'rxjs', 'tslib', 'source-map-support',
  'express', 'class-transformer', 'class-validator', 'cookie-parser', 'compression', 'dotenv',
];
ALWAYS.forEach((n) => roots.add(n));
// Build-time tooling that the server never loads.
const NOT_NEEDED = new Set(['@nestjs/cli', '@nestjs/schematics', '@nestjs/testing']);
for (const n of fs.readdirSync(path.join(modules, '@nestjs'))) if (!NOT_NEEDED.has(`@nestjs/${n}`)) roots.add(`@nestjs/${n}`);

const keep = new Map(); // absolute source dir -> package name. Keyed by location: the same name can live in several places.
const missing = new Set();
const queue = [...roots].map((name) => ({ name, from: root }));

/** Node's own lookup: walk up from `fromDir`, taking the first node_modules/<name> found. */
function resolvePackage(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

while (queue.length) {
  const { name, from } = queue.pop();
  const dir = resolvePackage(name, from);
  if (!dir) {
    missing.add(name);
    continue;
  }
  if (keep.has(dir)) continue;
  keep.set(dir, name);
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    continue;
  }
  for (const group of [pkg.dependencies, pkg.optionalDependencies, pkg.peerDependencies]) {
    for (const dep of Object.keys(group || {})) queue.push({ name: dep, from: dir });
  }
}

// Packages the code names but that are not installed are normally optional; report so a real gap is visible.
const trulyMissing = [...missing].filter((m) => !m.startsWith('@types/'));
if (trulyMissing.length) log(`not installed (treated as optional): ${trulyMissing.slice(0, 40).join(', ')}${trulyMissing.length > 40 ? ' …' : ''}`);

const nm = path.join(appDir, 'node_modules');
fs.mkdirSync(nm, { recursive: true });
let copied = 0;
for (const dir of keep.keys()) {
  const rel = path.relative(modules, dir);
  // Packages nested inside another package's node_modules travel with that package.
  if (rel.startsWith('..') || rel.split(path.sep).includes('node_modules')) continue;
  copyTree(dir, path.join(nm, rel));
  copied += 1;
}
// Native binaries and build sources for platforms other than the one being installed.
{
  const bridge = path.join(nm, '@temporalio/core-bridge');
  if (fs.existsSync(bridge)) {
    const wanted = target === 'win32' ? /windows/ : target === 'darwin' ? /apple/ : /linux/;
    for (const d of ['sdk-core', 'src', 'bridge-macros', 'scripts', 'ts']) fs.rmSync(path.join(bridge, d), { recursive: true, force: true });
    const releases = path.join(bridge, 'releases');
    if (fs.existsSync(releases)) {
      for (const triple of fs.readdirSync(releases)) if (!wanted.test(triple)) fs.rmSync(path.join(releases, triple), { recursive: true, force: true });
    }
  }
}
// Generated Prisma client and its engine live in a dot-folder that is not a package.
copyTree(path.join(modules, '.prisma'), path.join(nm, '.prisma'), { prune: false });
// Executables for the few CLIs the launcher calls directly are not needed: it runs `node <file>`.
log(`copied ${copied} packages`);

// The migration engine and the query engine must travel with the app: without them Prisma would try
// to download one on the person's computer at first start (and fail offline).
{
  const engines = path.join(nm, '@prisma/engines');
  const hasMigrationEngine = () => fs.existsSync(engines) && fs.readdirSync(engines).some((f) => /^schema-engine-/.test(f) && !f.endsWith('.map'));
  if (!hasMigrationEngine()) {
    log('the Prisma migration engine is not in node_modules; asking the Prisma CLI to fetch it');
    spawnSync(process.execPath, [path.join(nm, 'prisma/build/index.js'), '-v'], { cwd: appDir, env: { ...process.env, CHECKPOINT_DISABLE: '1' }, stdio: 'inherit', timeout: 5 * 60 * 1000 });
  }
  if (!hasMigrationEngine()) die('the Prisma migration engine (schema-engine-*) is missing from the staged @prisma/engines');
  const client = path.join(nm, '.prisma/client');
  if (!fs.readdirSync(client).some((f) => /query_engine|libquery_engine/.test(f))) die('the Prisma query engine is missing from the staged .prisma/client');
  log(`prisma engines present: ${fs.readdirSync(engines).filter((f) => /^schema-engine-/.test(f)).join(', ')}; ${fs.readdirSync(client).filter((f) => /query_engine/.test(f)).join(', ')}`);
}

// ---------------------------------------------------------------------------------------
// 4. launcher
// ---------------------------------------------------------------------------------------
const launcherOut = path.join(out, 'launcher');
fs.mkdirSync(launcherOut, { recursive: true });
fs.cpSync(path.join(inputs.launcher, 'lib'), path.join(launcherOut, 'lib'), { recursive: true });
fs.copyFileSync(path.join(inputs.launcher, 'agencyos.mjs'), path.join(launcherOut, 'agencyos.mjs'));
fs.writeFileSync(path.join(launcherOut, 'package.json'), JSON.stringify({ name: 'agencyos-launcher', private: true, type: 'module' }, null, 2));

// ---------------------------------------------------------------------------------------
// 5. report
// ---------------------------------------------------------------------------------------
const sizes = {};
for (const part of ['app/backend', 'app/orchestrator', 'app/frontend', 'app/node_modules', 'app/prisma', 'launcher']) {
  sizes[part] = dirSize(path.join(out, part));
}
const total = Object.values(sizes).reduce((n, s) => n + s.bytes, 0);
log('sizes:');
for (const [part, s] of Object.entries(sizes)) log(`  ${part.padEnd(22)} ${mb(s.bytes).padStart(10)}  ${String(s.files).padStart(7)} files`);
log(`  ${'total'.padEnd(22)} ${mb(total).padStart(10)}`);

const biggest = fs
  .readdirSync(nm, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .flatMap((e) =>
    e.name.startsWith('@') ? fs.readdirSync(path.join(nm, e.name)).map((n) => `${e.name}/${n}`) : [e.name]
  )
  .map((n) => ({ n, b: dirSize(path.join(nm, n)).bytes }))
  .sort((a, b) => b.b - a.b)
  .slice(0, 15);
log('largest packages:');
biggest.forEach((p) => log(`  ${p.n.padEnd(40)} ${mb(p.b).padStart(10)}`));

// ---------------------------------------------------------------------------------------
// 6. verify: load every compiled file with only the staged node_modules
// ---------------------------------------------------------------------------------------
if (flag('--verify')) {
  log('verifying that every compiled file can load…');
  const script = `
    const fs = require('fs'); const path = require('path');
    const roots = process.argv.slice(1);
    const missing = new Map(); let loaded = 0, failed = 0;
    const skip = /[\\\\/]main\\.js$/;
    function* walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) yield* walk(p); else if (e.name.endsWith('.js')) yield p; } }
    process.on('uncaughtException', () => {});
    process.on('unhandledRejection', () => {});
    for (const r of roots) for (const f of walk(r)) {
      if (skip.test(f)) continue;
      try { require(f); loaded++; }
      catch (e) {
        failed++;
        if (e && e.code === 'MODULE_NOT_FOUND') { const m = /Cannot find module '([^']+)'/.exec(e.message); const k = m ? m[1] : e.message; if (!missing.has(k)) missing.set(k, f); }
      }
    }
    console.log(JSON.stringify({ loaded, failed, missing: [...missing].map(([k, f]) => k + '  <-  ' + path.relative(process.cwd(), f)) }));
    process.exit(0);
  `;
  const run = spawnSync(
    process.execPath,
    ['--experimental-require-module', '-e', script, path.join(appDir, 'backend/dist'), path.join(appDir, 'orchestrator/dist')],
    { cwd: appDir, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production', DATABASE_URL: 'postgresql://x:x@127.0.0.1:1/x', REDIS_URL: '', JWT_SECRET: 'verify', FRONTEND_URL: 'http://localhost:4200' }, maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 }
  );
  const lastLine = String(run.stdout).trim().split('\n').pop();
  let report;
  try {
    report = JSON.parse(lastLine);
  } catch {
    console.error(run.stdout?.slice(-2000), run.stderr?.slice(-2000));
    die('verification did not finish');
  }
  log(`loaded ${report.loaded} files; ${report.failed} threw while loading`);
  if (report.missing.length) {
    console.error('[stage-app] packages that are required but were not staged:');
    report.missing.forEach((m) => console.error('   ' + m));
    die('the staged node_modules is missing packages (add them to ALWAYS in stage-app.mjs or fix the dependency)');
  }
  log('verification passed: no missing modules');
}
log('done');
