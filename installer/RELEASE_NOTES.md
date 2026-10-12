## AgencyOS {{VERSION}} for Windows

*AgencyOS, created by NextGen OS. Proprietary software: see the licence shown by the installer.*

A desktop app: install it, open it from the Start menu, and everything runs on your own computer, in its own window (not in a browser). Nothing needs to be installed first.

**Download:** `AgencyOS-Setup-{{VERSION}}.exe`
**SHA-256:** `{{SHA256}}`
**Built from commit:** `{{COMMIT}}`

### What the installer sets up

- The AgencyOS desktop app (own window, taskbar and tray icon; closing the window keeps scheduled campaigns running; quit from the tray icon).
- PostgreSQL 16, Redis, the Temporal workflow engine and Node.js, bundled and started for you. They listen only on this computer, so Windows Firewall never asks about them.
- **Local AI, chosen for your computer, with no setup.** On first start AgencyOS looks at your memory, processor and graphics card and picks models that fit:
  - EmbeddingGemma (Google) for meaning-based search of your knowledge base,
  - a Gemma text model for ad-copy suggestions, from a small model on a modest laptop up to a large one on a powerful NVIDIA card,
  - it then measures real speed and steps down to a lighter model if the machine is too slow.
  The AI engine and models are downloaded in the background (a one-time download of roughly 2–6 GB depending on your computer). AgencyOS works fully meanwhile, using keyword search and template copy, and works offline afterwards.
- **You choose where your files are stored.** Setup asks for a data folder (database, uploads, logs) and, optionally, a separate folder for the AI models. The default is `%LOCALAPPDATA%\AgencyOS`. Later, **Settings → Storage** moves them safely: files are copied and checked first, and the old copy is deleted only when you say so. Your data is kept when you upgrade or uninstall (the uninstaller asks and lists the folders).
- **No sign-in.** AgencyOS runs for one person on this computer and opens straight into your workspace.

### Requirements

Windows 10 (version 1809) or Windows 11, 64-bit (Windows on ARM runs it through Windows' x64 emulation). About 4 GB of free disk space for the program, plus space for the AI models. 8 GB of memory or more recommended; below 8 GB the AI is limited to small models, below 4 GB it is switched off.

### First start

1. Run the installer. It does not ask for administrator rights.
2. Windows SmartScreen may say "Windows protected your PC" because this build is **not code-signed**: choose **More info**, then **Run anyway**.
3. Setup asks where to keep your files (you can keep the defaults).
4. AgencyOS opens and shows what it is starting. The first start takes a minute or two (it creates the database). It then opens straight into your workspace: there is no account to create and nothing to sign in to.
5. Optional: paste a Telegram bot token under the tray icon, **Status and settings**, to let AgencyOS post to chats whose administrators have authorized it.

### Honest limits

- Not code-signed (no certificate), so SmartScreen warns as above. The SHA-256 above lets you check the file.
- Social-network accounts that need a web sign-in (Google, Facebook, …) open in your default browser for the sign-in step, as the providers require; everything else stays in the AgencyOS window.
- Tested on a clean Windows Server 2025 build machine with 16 GB of memory, 4 processor threads and no GPU. Other hardware (including NVIDIA GPUs and Windows on ARM) is covered by the selection rules and their unit tests but has not been run on real devices.
- There is no automatic update yet: install a newer setup file over the old one; your data is kept.

{{VERIFICATION}}
