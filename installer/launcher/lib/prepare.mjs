// Getting a brand-new computer ready, done by the installer while AgencyOS is being set up so nothing has
// to be downloaded later: the local AI engine (the same checked download the app would make on first use,
// with the GPU files this computer cannot use left out) and Antigravity, which is installed by Google's own
// installer. Neither step is allowed to fail the installation: each says what happened, and AgencyOS
// tries again by itself or from Settings.

import fs from 'node:fs';
import path from 'node:path';
import { OllamaRuntime } from './ollama.mjs';
import { detectHardware } from './hardware.mjs';
import { CliTools } from './cli-tools.mjs';

const mb = (bytes) => Math.round(bytes / 1048576);

/**
 * @param opts.manifest  the runtime manifest the installer shipped (its "ollama" section pins the download)
 * @param opts.say       one plain line at a time, for the installer's progress text
 */
export async function prepareComputer({
  paths,
  manifest = {},
  log = () => {},
  say = () => {},
  tools,
  detect = detectHardware,
  makeRuntime = (opts) => new OllamaRuntime(opts),
  skip = [],
}) {
  const result = { at: new Date().toISOString(), ollama: null, antigravity: null };
  const note = (line) => {
    log(line);
    say(line);
  };

  // ---- the local AI engine ----------------------------------------------------------------
  if (skip.includes('ollama')) {
    result.ollama = { ok: true, skipped: true };
  } else {
    try {
      const runtime = makeRuntime({ dir: paths.data.ollamaApp, manifest: manifest.ollama || null, log });
      if (runtime.installed) {
        result.ollama = { ok: true, already: true, version: runtime.version };
        note(`The local AI engine is already installed (${runtime.version || 'unknown version'}).`);
      } else {
        note('Downloading the local AI engine…');
        const hw = await detect({ dataDir: paths.data.ollamaModels });
        let lastStep = -1;
        await runtime.install(hw, {
          onProgress: ({ received, total }) => {
            const step = total ? Math.floor((received / total) * 20) : -1; // every 5 %
            if (step !== lastStep && step >= 0) {
              lastStep = step;
              say(`Local AI engine: ${step * 5}% (${mb(received)} of ${mb(total)} MB)`);
            }
          },
        });
        result.ollama = { ok: true, version: runtime.version };
        note(`The local AI engine is installed (${runtime.version || 'unknown version'}).`);
      }
    } catch (error) {
      result.ollama = { ok: false, error: error.message };
      note(`The local AI engine could not be downloaded now (${error.message}). AgencyOS will offer it again in Settings.`);
    }
  }

  // ---- Antigravity ------------------------------------------------------------------------
  if (skip.includes('antigravity')) {
    result.antigravity = { ok: true, skipped: true };
  } else {
    try {
      const cli = tools || new CliTools({ log });
      const existing = await cli.locate('antigravity');
      if (existing) {
        result.antigravity = { ok: true, already: true, path: existing };
        note('Antigravity is already installed.');
      } else {
        note('Installing Antigravity…');
        cli.startInstall('antigravity');
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          const { task } = await cli.snapshot();
          if (task?.state === 'working') continue;
          if (task?.state === 'done') {
            result.antigravity = { ok: true, path: await cli.locate('antigravity'), message: task.message };
            note(task.message);
          } else {
            result.antigravity = { ok: false, error: task?.error || 'The installer did not finish.' };
            note(`Antigravity could not be installed now (${result.antigravity.error}). It can be downloaded again in Settings, AI and Copilot.`);
          }
          break;
        }
      }
    } catch (error) {
      result.antigravity = { ok: false, error: error.message };
      note(`Antigravity could not be installed now (${error.message}).`);
    }
  }

  try {
    fs.mkdirSync(paths.data.config, { recursive: true });
    fs.writeFileSync(path.join(paths.data.config, 'prepare.json'), JSON.stringify(result, null, 2));
  } catch (error) {
    log(`Could not save the preparation result: ${error.message}`);
  }
  return result;
}
