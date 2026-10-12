# AgencyOS

**AgencyOS, created by NextGen OS.** The advertising agency platform that runs on your own computer.

Clients, campaigns, a review and approval workflow, Telegram destinations whose administrators have
authorized posting, scheduled publishing with delivery receipts, a sales pipeline, invoices, a client
portal and publishing reports, all from one dashboard.

## Use it on a Windows laptop

Download `AgencyOS-Setup-<version>.exe` and run it. Nothing needs to be installed first: the database,
workflow engine and local AI models come with it, and it opens in its own window.

* **You choose where your files go.** On a first install, setup asks for a data folder (database,
  uploads, logs) and, optionally, a separate folder for the local AI models, which can take several GB.
  Later, **Settings → Storage** moves them safely: files are copied and checked first, and the old copy
  is deleted only when you say so.
* **There is no sign-in.** AgencyOS runs for one person on one computer and opens straight into your
  workspace. Nothing is reachable from the network.

Details: [`docs/AGENCYOS_WINDOWS_INSTALL.md`](docs/AGENCYOS_WINDOWS_INSTALL.md).

## Run it on a server or as a developer

See [`AGENCYOS_GUIDE.md`](AGENCYOS_GUIDE.md). Server deployments keep sign-in, roles and the client portal.

```bash
pnpm install
cp .env.agencyos.example .env
pnpm run prisma-migrate
pnpm run dev            # backend :3000, frontend :4200
```

## Documentation

* [`AGENCYOS_GUIDE.md`](AGENCYOS_GUIDE.md): operator guide, what is real today, how to run and deploy
* [`docs/AGENCYOS_WINDOWS_INSTALL.md`](docs/AGENCYOS_WINDOWS_INSTALL.md): the Windows app
* [`docs/AGENCYOS_ARCHITECTURE.md`](docs/AGENCYOS_ARCHITECTURE.md), [`docs/AGENCYOS_SECURITY.md`](docs/AGENCYOS_SECURITY.md), [`docs/AGENCYOS_UI_DESIGN_SYSTEM.md`](docs/AGENCYOS_UI_DESIGN_SYSTEM.md)
* [`RULES.md`](RULES.md) and [`CLAUDE.md`](CLAUDE.md): the project's rules and coding conventions
* [`installer/README.md`](installer/README.md): building the Windows installer

© NextGen OS
