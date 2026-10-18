// Where things live. The install folder (read-mostly, replaced on upgrade) is kept apart from
// the data folder (database, uploads, logs, secrets) so an upgrade or reinstall never touches the
// user's work. The person chooses the data folder, and optionally a separate folder for the local
// AI engine and models, in the installer or later in the status page. The choice is remembered in
// locations.json, which always sits in the default folder so every part of AgencyOS (launcher,
// desktop shell, uninstaller) can find it before it knows where the rest is.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LOCATIONS_FILE = 'locations.json';

export function defaultDataRoot(env = process.env, platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') {
    return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'AgencyOS');
  }
  return path.posix.join(env.XDG_DATA_HOME || path.posix.join(home, '.local', 'share'), 'agencyos');
}

const pathModule = (platform) => (platform === 'win32' ? path.win32 : path.posix);

/**
 * Reads the remembered choice. Anything that is not an absolute path is ignored so a damaged or
 * hand-edited file falls back to the defaults instead of pointing the database somewhere odd.
 */
export function readLocations(file, platform = process.platform) {
  const p = pathModule(platform);
  let raw;
  try {
    // The installer writes this file too; tolerate a byte-order mark.
    raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
  const out = {};
  for (const key of ['dataRoot', 'aiRoot']) {
    if (typeof raw?.[key] === 'string' && p.isAbsolute(raw[key])) out[key] = p.resolve(raw[key]);
  }
  return out;
}

/** Writes the choice atomically; only values that differ from the defaults are stored. */
export function writeLocations(file, { dataRoot, aiRoot }, { defaultRoot, platform = process.platform } = {}) {
  const p = pathModule(platform);
  const stored = { version: 1 };
  if (dataRoot && (!defaultRoot || p.resolve(dataRoot) !== p.resolve(defaultRoot))) stored.dataRoot = p.resolve(dataRoot);
  if (aiRoot && p.resolve(aiRoot) !== p.join(p.resolve(dataRoot || defaultRoot || '.'), 'ollama')) stored.aiRoot = p.resolve(aiRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(stored, null, 2));
  fs.renameSync(temp, file);
  return stored;
}

/**
 * @param launcherDir folder that holds agencyos.mjs (<install>/launcher)
 *
 * Precedence for the data folder: AGENCYOS_DATA (development and tests; also freezes the choice),
 * then locations.json, then the default. The AI folder follows the data folder unless
 * AGENCYOS_AI_DIR or locations.json names one.
 */
export function resolvePaths({
  launcherDir,
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
} = {}) {
  const p = pathModule(platform);
  const installRoot = env.AGENCYOS_HOME ? p.resolve(env.AGENCYOS_HOME) : p.resolve(launcherDir, '..');
  const defaultRoot = defaultDataRoot(env, platform, home);
  const locked = !!env.AGENCYOS_DATA;
  const locationsFile = p.join(defaultRoot, LOCATIONS_FILE);
  const saved = locked ? {} : readLocations(locationsFile, platform);
  const dataRoot = locked ? p.resolve(env.AGENCYOS_DATA) : saved.dataRoot || defaultRoot;
  const aiRoot = env.AGENCYOS_AI_DIR ? p.resolve(env.AGENCYOS_AI_DIR) : saved.aiRoot || p.join(dataRoot, 'ollama');
  const exe = platform === 'win32' ? '.exe' : '';
  const runtime = p.join(installRoot, 'runtime');
  const app = p.join(installRoot, 'app');

  return {
    platform,
    exe,
    installRoot,
    dataRoot,
    launcherDir,
    locations: {
      file: locationsFile,
      defaultRoot,
      dataRoot,
      aiRoot,
      customAi: aiRoot !== p.join(dataRoot, 'ollama'),
      // AGENCYOS_DATA fixes the location, so the person cannot move it from the status page.
      locked,
    },
    runtime: {
      root: runtime,
      postgresBin: p.join(runtime, 'postgres', 'bin'),
      redis: p.join(runtime, 'redis', `redis-server${exe}`),
      temporal: p.join(runtime, 'temporal', `temporal${exe}`),
      python: p.join(runtime, 'python', `python${exe}`),
      manifest: p.join(installRoot, 'runtime-manifest.json'),
    },
    app: {
      root: app,
      nodeModules: p.join(app, 'node_modules'),
      backendMain: p.join(app, 'backend', 'dist', 'apps', 'backend', 'src', 'main.js'),
      orchestratorMain: p.join(app, 'orchestrator', 'dist', 'apps', 'orchestrator', 'src', 'main.js'),
      frontendServer: p.join(app, 'frontend', 'apps', 'frontend', 'server.js'),
      telegramWorker: p.join(app, 'telegram-worker'),
      prismaSchema: p.join(app, 'prisma', 'schema.prisma'),
      prismaCli: p.join(app, 'node_modules', 'prisma', 'build', 'index.js'),
      publicDir: p.join(app, 'frontend', 'apps', 'frontend', 'public'),
    },
    data: {
      root: dataRoot,
      pg: p.join(dataRoot, 'pg'),
      temporal: p.join(dataRoot, 'temporal'),
      temporalDb: p.join(dataRoot, 'temporal', 'temporal.db'),
      uploads: p.join(dataRoot, 'uploads'),
      redis: p.join(dataRoot, 'redis'),
      ollamaRoot: aiRoot,
      ollamaApp: p.join(aiRoot, 'app'),
      ollamaModels: p.join(aiRoot, 'models'),
      run: p.join(dataRoot, 'run'),
      logs: p.join(dataRoot, 'logs'),
      config: p.join(dataRoot, 'config'),
      secrets: p.join(dataRoot, 'config', 'secrets.json'),
      userEnv: p.join(dataRoot, 'config', 'user.env'),
      aiState: p.join(dataRoot, 'config', 'ai-state.json'),
      supervisorInfo: p.join(dataRoot, 'run', 'supervisor.json'),
    },
  };
}
