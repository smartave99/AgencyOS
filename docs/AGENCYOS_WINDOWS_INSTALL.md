# AgencyOS for Windows — install and run

AgencyOS ships as a normal Windows desktop program. You install it once, open it from the Start
menu, and it runs on your own computer in its own window (like any other desktop application; it
is not a web page in a browser). Nothing needs to be installed first.

Download `AgencyOS-Setup-<version>.exe` from the repository's **Releases** page and run it.

## What you need

| | |
| --- | --- |
| Windows | 10 (1809 or newer) or 11, 64-bit. Windows on ARM works through Windows' x64 emulation. |
| Disk | About 4 GB for the program, plus space for the AI models (see below). |
| Memory | 8 GB or more is recommended. Below 8 GB the AI is limited to small models; below 4 GB it is off. |
| Internet | Needed once, for the AI engine and models. AgencyOS works without it, and offline afterwards. |
| Rights | None. It installs for your user only; there is no administrator prompt. |

## Install

1. Run the setup file. If Windows SmartScreen says *"Windows protected your PC"*, the build is not
   code-signed: choose **More info → Run anyway**. (The SHA-256 on the release page lets you
   verify the file.)
2. Keep the defaults. Two optional choices: start AgencyOS when you sign in to Windows (on by
   default, so scheduled campaigns keep being sent), and a desktop shortcut.
3. Finish. AgencyOS opens and shows what it is starting; the first start takes a minute or two
   because it creates your private database. Then create your account — it is a local account on
   this computer.

## Daily use

* **Open** it from the Start menu. The window is the app: no browser tabs or address bar.
* **Closing the window does not stop AgencyOS.** It keeps running in the background (the AgencyOS
  icon near the clock) so scheduled campaigns are still sent. Use the tray icon to open it again.
* **Quit** from the tray icon (or the *AgencyOS → Quit* menu). It asks first, because campaigns
  are not sent while AgencyOS is closed.
* **Status and settings** (tray icon): what is running, the local AI status, restart, and the
  place to paste a Telegram bot token.
* Links to other websites open in your normal browser. Only AgencyOS itself is shown in the window.

## Local AI, chosen for your computer

AI is optional in AgencyOS — search and copy suggestions work without it — but a local model makes
both better, and nothing leaves your computer. On the first start AgencyOS looks at your memory,
processor and graphics card and installs what fits, automatically:

| Your computer | Search model | Text model for copy suggestions |
| --- | --- | --- |
| Under 4 GB memory | none (AI off) | none |
| 4–7 GB | a small embedding model | none |
| 8 GB+ (any laptop) | EmbeddingGemma | Gemma 3 1B |
| 12 GB+ memory, 6+ processor threads | EmbeddingGemma | Gemma 4 E2B |
| 24 GB+ memory, 12+ threads | EmbeddingGemma | Gemma 4 E4B |
| NVIDIA GPU, 8 GB video memory | EmbeddingGemma | Gemma 4 E4B |
| NVIDIA GPU, 10–21 GB | EmbeddingGemma | Gemma 4 12B |
| NVIDIA GPU, 22–23 GB | EmbeddingGemma | Gemma 4 26B |
| NVIDIA GPU, 24 GB or more | EmbeddingGemma | Gemma 4 31B |

Details of how it decides:

* It reads memory, processor threads, free disk space and NVIDIA video memory. AMD, Intel and
  integrated graphics are not counted as acceleration, so a large model is never chosen for a
  graphics card that cannot run it.
* It leaves room for Windows, your browser and AgencyOS's own services before counting what the
  model may use, and checks the model's real download size against your free disk space.
* After downloading it **measures the real speed** of the text model. If it is too slow to feel
  responsive it steps down to a lighter model, deletes the larger one and tells you why on the
  Status page.
* The model names are checked against the public Ollama model registry before downloading; a name
  that no longer exists falls back to the next candidate.
* If you already run Ollama, AgencyOS uses yours instead of installing a second one.

The AI engine (Ollama, about 1.4 GB) and the models are downloaded in the background after the
first start. You can use AgencyOS right away; keyword search and template copy are used until
the models are ready. The status page shows progress.

Override the choice by creating `%LOCALAPPDATA%\AgencyOS\config\user.env` containing, for example:

```
AGENCYOS_AI=off
AGENCYOS_TEXT_MODEL=qwen3:8b
AGENCYOS_EMBEDDING_MODEL=nomic-embed-text
```

## Privacy and network

* Everything runs on this computer. The database, cache, workflow engine, server and AI listen on
  `127.0.0.1` only, so Windows Firewall does not prompt and nothing is reachable from the network.
* Nothing is sent to a third-party AI service unless you set both `AGENCY_ALLOW_EXTERNAL_AI=true`
  and an API key in `user.env`.
* The only connections AgencyOS itself makes: the one-time download of the AI engine and models
  (GitHub and the Ollama registry), and Telegram if you add a bot token.
* A Telegram bot token is stored in `user.env` in your own profile folder. It is never stored in
  the database or shown again.

## Where things are

| | |
| --- | --- |
| Program | `%LOCALAPPDATA%\Programs\AgencyOS` |
| Your data (database, uploads, AI models, logs) | `%LOCALAPPDATA%\AgencyOS` |
| Logs | `%LOCALAPPDATA%\AgencyOS\logs` (tray icon → Open logs folder) |
| Settings you may edit | `%LOCALAPPDATA%\AgencyOS\config\user.env` |

Upgrading: run a newer setup over the old one; your data is kept. Uninstalling asks whether to
delete your data as well (silent uninstall keeps it unless you pass `/PURGEDATA=1`).

## If something goes wrong

* The window shows an error page with **Try again**. The Help menu has **Open logs folder**.
* *Status and settings* lists every service and its state; a failed one shows the reason and
  **Restart everything** tries again.
* Another program is using a port AgencyOS wants (4200, 3000, …)? AgencyOS moves to the next free
  port by itself.
* Run `"%LOCALAPPDATA%\Programs\AgencyOS\runtime\node\node.exe" "%LOCALAPPDATA%\Programs\AgencyOS\launcher\agencyos.mjs" doctor`
  to print this computer's details and the AI models it would choose.

## Honest limits

* The build is not code-signed (see SmartScreen above).
* Sign-ins to external websites that require a browser (some social networks) happen in your
  default browser, as those providers require. AgencyOS itself never runs in a browser tab.
* No automatic updates yet.
* See [`AGENCYOS_IMPLEMENTATION_STATUS.md`](AGENCYOS_IMPLEMENTATION_STATUS.md) for exactly what was
  verified on a real Windows machine and what was not.

## Building the installer yourself

See [`installer/README.md`](../installer/README.md).
