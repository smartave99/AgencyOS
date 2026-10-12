# Changelog

Every change in every version of AgencyOS, by NextGen OS, newest first. This file is generated from `libraries/helpers/src/changelog/releases.json`: edit that file, then run `node installer/build/changelog.mjs`.

## 1.1.0 — 2026-10-12 · One platform, one place for AI

A new look and layout that put every part of AgencyOS in one window, a Guide and feature explainer inside the app, and a single place to choose which AI answers: the local model, Claude Code, Codex CLI, Antigravity CLI or an API.

### Added

- **Interface:** A real top bar: where you are, a search that reaches every page, a light/dark switch, notifications and an account menu.
- **Interface:** One sidebar for everything, grouped by the work: Workspace, Delivery, Grow, Social scheduler and Admin, with Guide and Settings pinned at the bottom. It folds to icons, and slides over the page on a small window.
- **Interface:** Theme: light, dark or follow the computer. The last choice is applied before the page appears, so there is no flash of the wrong theme.
- **Interface:** Search (Ctrl+K or ⌘K) works on every page, including the social scheduler, and also finds settings, guide pages and campaigns.
- **AI:** Settings → AI and Copilot: choose the provider (local model, Claude Code, Codex CLI, Antigravity CLI, Anthropic, OpenAI, Google Gemini or any OpenAI-compatible service), the model, and the thinking level. A Test button says exactly what is wrong when something is not set up.
- **AI:** Copilot panel (Ctrl+J or ⌘J): ask how to do something in AgencyOS, or ask for a draft. It uses the provider you chose and never changes your data on its own.
- **AI:** Model lists are read live from the provider (installed local models, your API account) so they do not go out of date.
- **Help:** A Guide for the main aim (create ads, get them approved, deliver to authorized Telegram chats, report), including how to set up a local model.
- **Help:** A feature explainer: every part of AgencyOS with what it is for, how to use it step by step, and what it needs.
- **Help:** What's new: the full change history of every version, inside the app and in CHANGELOG.md.

### Improved

- **Ad copy:** Ad copy, text improvement and the Copilot all use the provider you chose. When AgencyOS has to fall back to templates it now says why, and which model wrote the copy otherwise.
- **Interface:** The search box no longer shows a second coloured outline around the field.
- **Interface:** Notifications, the account menu and the search use the same icons, spacing and colours as the rest of AgencyOS.

### Changed

- **AI:** The AI provider is chosen in Settings. An OPENAI_API_KEY in the environment is still read as the OpenAI key.
- **Interface:** The old icon rail and the promotional links of the original scheduler are gone.

### Security

- **AI:** API keys are sealed with AES-256-GCM before they are stored, are never sent back to the browser, and are kept out of the audit trail. Only owners and admins can change AI settings.
- **AI:** Command-line AI tools run only inside the desktop app, in an empty scratch folder with their tools switched off and without AgencyOS's database or session secrets.

### Good to know

- Antigravity CLI support is experimental: it follows the programme's documented options, and some versions hang when another program starts them. Use the Test button before relying on it.
- Answers in the Copilot appear when complete; they are not streamed word by word yet.
- The installer is still not code-signed, so Windows SmartScreen warns on first run.

## 1.0.0 — 2026-10-12 · AgencyOS for Windows

The first release: AgencyOS by NextGen OS as a desktop app that runs entirely on your own computer.

### Added

- **Installer:** Windows installer that sets up the desktop app, PostgreSQL, Redis, Temporal and Node.js. Nothing needs to be installed first, and Windows Firewall is never asked.
- **Installer:** Choose where your files live: a data folder and, optionally, a separate folder for AI models. Settings → Storage moves them later, copying and checking before anything is removed.
- **AI:** Local AI picked for your computer's memory, processor and graphics card, with a speed check that steps down to a lighter model if needed. It works offline once downloaded.
- **Workspace:** Clients, campaigns with a Telegram preview, four-eyes approval, optional client sign-off and a tamper-checked approved version.
- **Delivery:** Telegram delivery to chats whose administrators authorized the bot, with retries, backoff, a dead-letter list and a truthful status when something is not working.
- **Grow:** Reports with CSV and print-to-PDF, tracked links, a sales pipeline, a knowledge base and invoices.

### Changed

- **Product:** No sign-in: AgencyOS opens straight into your workspace on your own computer.
- **Product:** Rebranded as AgencyOS by NextGen OS, and released under a proprietary licence.

### Good to know

- Not code-signed: Windows SmartScreen warns on first run. The SHA-256 on the release page lets you check the file.
- No automatic updates yet: install a newer setup file over the old one and your data is kept.
