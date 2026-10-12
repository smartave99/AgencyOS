# AgencyOS Windows installer

Turns the monorepo into a double-click Windows program that runs fully locally. For people using
it, read [`docs/AGENCYOS_WINDOWS_INSTALL.md`](../docs/AGENCYOS_WINDOWS_INSTALL.md); this file is
for whoever builds or changes it.

## What gets installed

```
%LOCALAPPDATA%\Programs\AgencyOS\
  AgencyOS.exe              Electron desktop shell (window, tray, single instance)
  resources\app.asar        the shell's code (installer/desktop)
  launcher\                 supervisor (installer/launcher), run by the bundled Node
  runtime\node\             Node.js
  runtime\postgres\         PostgreSQL 16
  runtime\redis\            Redis for Windows
  runtime\temporal\         Temporal dev server (the platform needs one to start)
  runtime\vc\               Visual C++ runtime DLLs (so a brand-new Windows needs nothing)
  app\backend|orchestrator  compiled NestJS apps
  app\frontend              Next.js standalone server
  app\node_modules          only what the backend can reach
  app\prisma                schema + migrations
%LOCALAPPDATA%\AgencyOS\    locations.json: where the data lives (always here)
<data folder>\             pg\, uploads\, logs\, config\, redis\, temporal\ (default: %LOCALAPPDATA%\AgencyOS; never touched by upgrades)
<AI folder>\               app\ (Ollama), models\ (default: <data folder>\ollama)
```

## How it runs

```
AgencyOS.exe (Electron)
   └─ node launcher\agencyos.mjs start --background        (detached supervisor)
        ├─ PostgreSQL (pg_ctl)   Redis   Temporal           127.0.0.1 only
        ├─ prisma migrate deploy
        ├─ backend :3000   orchestrator :3002   frontend :4200
        ├─ status server :4999 (status page + control API, token-protected)
        └─ AiManager: hardware → models → download → benchmark → (step down)
```

* The supervisor outlives the window, so scheduled campaigns keep being sent; the tray icon quits
  it. If the supervisor dies the shell restarts it.
* Ports prefer the defaults and move to the next free one; the choice is remembered.
* The launcher has no npm dependencies and no build step.

## Layout of this folder

| Path | What |
| --- | --- |
| `launcher/lib/hardware.mjs` | detects RAM, CPU, NVIDIA/other GPUs (nvidia-smi, WMI, registry), free disk |
| `launcher/lib/models.mjs` | the model catalog and the hardware → tier rules |
| `launcher/lib/ai.mjs` | plans, installs Ollama, pulls models, benchmarks, steps down |
| `launcher/lib/ollama.mjs` | Ollama client, registry lookups, runtime install |
| `launcher/lib/supervisor.mjs`, `services.mjs`, `app.mjs` | process control and the service definitions |
| `launcher/lib/paths.mjs` | resolves every folder; reads and writes `locations.json` |
| `launcher/lib/storage.mjs` | checks a chosen folder, copies, verifies, switches, and removes the old copy on request |
| `launcher/lib/status-*.mjs` | the loopback status page and API |
| `desktop/` | Electron shell: `main.js`, `preload.js` (the folder picker, status page only), `policy.js` (navigation rules, tested), `splash.html`, icons |
| `build/stage-app.mjs` | assembles `app/` and `launcher/` from a finished build, verifies it |
| `build/stage-runtime.mjs` | downloads and checks Node, PostgreSQL, Redis, Temporal, VC++ DLLs |
| `build/make-icons.mjs` | draws the icon (PNG, tray, ICO) without external tools |
| `windows/agencyos.iss` | Inno Setup script |
| `windows/smoke-test.mjs` | installs the built setup file and uses the product (CI) |
| `windows/build.ps1` | one-command local build on Windows |
| `runtimes.json` | pinned versions of the bundled runtimes |

## Build it

On a Windows machine with Node 22, Git and [Inno Setup 6](https://jrsoftware.org/isdl.php):

```
powershell -ExecutionPolicy Bypass -File installer\windows\build.ps1
```

Output: `installer\dist\out\AgencyOS-Setup-<version>.exe`. Or let GitHub Actions do it: the
`windows-installer` workflow runs on every push that touches this folder or the apps, builds the
installer on a clean Windows runner, installs it, and runs the smoke test. Run it by hand with
*Publish a GitHub Release* ticked to create a release from a build that passed.

## Test it

```
node --test installer/launcher/test/*.test.mjs installer/desktop/test/policy.test.js
```

88 tests: hardware parsing, model selection for every hardware class, the AI manager's state
machine (download, step-down, offline wait, reuse an existing Ollama), the supervisor with real
child processes, the status server's auth rules, paths, ports, environment building, and the
desktop shell's navigation policy. They also run on the Windows runner.

The smoke test (`windows/smoke-test.mjs`) is the end-to-end check, and only runs on Windows: it
installs silently, starts the desktop app, waits for every service, checks that nothing listens
beyond loopback, attaches to the app window over the DevTools protocol (title, no Node access,
screenshot), confirms no web browser was opened, signs up and uses the agency API through the real
server, waits for the local AI to be set up (EmbeddingGemma 768-dim vectors, a text model,
a measured speed, ad copy produced by the local model), quits, starts again and signs in (data
kept), and uninstalls.

## Changing things

* **A bundled runtime**: edit `runtimes.json`, run the build, read the smoke test. Each version was
  fetched, unpacked and started on a clean runner before being pinned.
* **The model catalog**: `launcher/lib/models.mjs`. Sizes there are planning figures read from
  `registry.ollama.ai`; the real size is read again before downloading, and a missing tag falls
  through to the next candidate. Add a test for any rule you change.
* **The app itself** needs no change for the installer: it reads `DATABASE_URL`, `REDIS_URL`,
  `TEMPORAL_ADDRESS`, `OLLAMA_HOST`, `AI_MODEL`, `EMBEDDING_MODEL` as usual. Two opt-in switches exist
  for the desktop build: `BACKEND_BIND_HOST` / `ORCHESTRATOR_BIND_HOST` (listen on loopback only)
  and `AGENCYOS_STANDALONE=true` for the frontend build (self-contained server, no source maps).

## Not done / known limits

* Not code-signed: SmartScreen warns. Signing needs a certificate this project does not have.
* No auto-update.
* Real hardware other than the CI runner (16 GB, 4 threads, no GPU) is covered by unit tests of the
  selection rules, not by runs on real NVIDIA/ARM machines.
* The social-network sign-ins that require a system browser open in the default browser by design.
