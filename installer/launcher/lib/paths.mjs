// Where things live. The install folder (read-mostly, replaced on upgrade) is kept apart from
// the data folder (database, uploads, models, logs, secrets) so an upgrade or reinstall
// never touches the user's work.

import os from 'node:os';
import path from 'node:path';

export function defaultDataRoot(env = process.env, platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') {
    return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'AgencyOS');
  }
  return path.posix.join(env.XDG_DATA_HOME || path.posix.join(home, '.local', 'share'), 'agencyos');
}

/**
 * @param launcherDir folder that holds agencyos.mjs (<install>/launcher)
 */
export function resolvePaths({
  launcherDir,
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
} = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const installRoot = env.AGENCYOS_HOME ? p.resolve(env.AGENCYOS_HOME) : p.resolve(launcherDir, '..');
  const dataRoot = env.AGENCYOS_DATA ? p.resolve(env.AGENCYOS_DATA) : defaultDataRoot(env, platform, home);
  const exe = platform === 'win32' ? '.exe' : '';
  const runtime = p.join(installRoot, 'runtime');
  const app = p.join(installRoot, 'app');

  return {
    platform,
    exe,
    installRoot,
    dataRoot,
    launcherDir,
    runtime: {
      root: runtime,
      postgresBin: p.join(runtime, 'postgres', 'bin'),
      redis: p.join(runtime, 'redis', `redis-server${exe}`),
      temporal: p.join(runtime, 'temporal', `temporal${exe}`),
      manifest: p.join(installRoot, 'runtime-manifest.json'),
    },
    app: {
      root: app,
      nodeModules: p.join(app, 'node_modules'),
      backendMain: p.join(app, 'backend', 'dist', 'apps', 'backend', 'src', 'main.js'),
      orchestratorMain: p.join(app, 'orchestrator', 'dist', 'apps', 'orchestrator', 'src', 'main.js'),
      frontendServer: p.join(app, 'frontend', 'apps', 'frontend', 'server.js'),
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
      ollamaApp: p.join(dataRoot, 'ollama', 'app'),
      ollamaModels: p.join(dataRoot, 'ollama', 'models'),
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
