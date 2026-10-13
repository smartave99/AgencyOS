## AgencyOS {{VERSION}} for Windows

*AgencyOS, created by NextGen OS. Proprietary software: see the licence shown by the installer.*

A desktop app: install it, open it from the Start menu, and everything runs on your own computer, in its own window (not in a browser). Nothing needs to be installed first.

**Download:** `AgencyOS-Setup-{{VERSION}}.exe`
**SHA-256:** `{{SHA256}}`
**Built from commit:** `{{COMMIT}}`

{{CHANGES}}

### What the installer sets up

- The AgencyOS desktop app (own window, taskbar and tray icon; **closing the window shuts AgencyOS down** (it asks first, and nothing is sent while it is closed) and **minimizing keeps it working** in the background).
- PostgreSQL 16, Redis, the Temporal workflow engine and Node.js, bundled and started for you. They listen only on this computer, so Windows Firewall never asks about them.
- **AI with nothing to download.** AgencyOS uses Antigravity CLI by default (install and sign in to it on this computer; other tools and API keys are one choice away). A **local model is optional**: under **Settings → System → Local AI** you can let AgencyOS pick models for your computer, or download, try, start, stop and delete models yourself. Local models are a one-time download of roughly 2–6 GB, then work offline.
- **You choose where your files are stored.** Setup asks for a data folder (database, uploads, logs) and, optionally, a separate folder for the AI models. The default is `%LOCALAPPDATA%\AgencyOS`. Later, **Settings → Storage** moves them safely: files are copied and checked first, and the old copy is deleted only when you say so. Your data is kept when you upgrade or uninstall (the uninstaller asks and lists the folders).
- **No sign-in.** AgencyOS runs for one person on this computer and opens straight into your workspace.
- **One place for AI.** Settings → AI and Copilot lets you use Antigravity CLI (the default), a local model, Claude Code, Codex CLI, Antigravity CLI or an API key (Anthropic, OpenAI, Gemini, or any OpenAI-compatible service), choose the model and the thinking level, and test that it works. The **Guide** inside the app explains the main workflow and how to set up a local model if you want one.

### Requirements

Windows 10 (version 1809) or Windows 11, 64-bit (Windows on ARM runs it through Windows' x64 emulation). About 4 GB of free disk space for the program, plus space for any local AI models you choose to download. 8 GB of memory or more recommended for local models; below 8 GB they are limited to small ones, below 4 GB they are not offered.

### First start

1. Run the installer. It does not ask for administrator rights.
2. {{SIGNING_FIRST_START}}
3. Setup asks where to keep your files (you can keep the defaults).
4. AgencyOS opens and shows what it is starting. The first start takes a minute or two (it creates the database). It then opens straight into your workspace: there is no account to create and nothing to sign in to.
5. Optional: connect a Telegram bot under **Settings → Telegram bots** (paste the token from @BotFather; you can connect as many bots as you need) to let AgencyOS post to chats whose administrators have authorized it.

### Honest limits

- {{SIGNING_LIMIT}} The SHA-256 above lets you check the file.
- Social-network accounts that need a web sign-in (Google, Facebook, …) open in your default browser for the sign-in step, as the providers require; everything else stays in the AgencyOS window.
- Tested on a clean Windows Server 2025 build machine with 16 GB of memory, 4 processor threads and no GPU. Other hardware (including NVIDIA GPUs and Windows on ARM) is covered by the selection rules and their unit tests but has not been run on real devices.
- There is no automatic update yet: install a newer setup file over the old one; your data is kept.

{{VERIFICATION}}
