# Security Policy

AgencyOS, created by NextGen OS, holds an agency's clients, campaigns, contacts and bot credentials, so
security reports are taken seriously.

## Reporting a vulnerability

Please do not open a public issue. Report it privately:

* use **Security → Report a vulnerability** on this repository, or
* message the repository owner privately.

Include what you found, the steps to reproduce it, and what an attacker could do with it. You will get an
answer as soon as the maintainers have looked at it, and a fix will be released before details are made public.

## Scope

* The AgencyOS backend, frontend and orchestrator in this repository
* The Windows desktop app and its installer (`installer/`)
* The container files used to deploy AgencyOS on a server

Weaknesses in third-party dependencies are in scope only when AgencyOS's own use of the dependency is
exploitable. Problems on a computer or server that someone else controls (their operating system, network
or backups) are out of scope.

## Supported versions

Only the latest release is supported. Run the latest version to have the latest fixes.

## How the desktop app protects the person using it

* Every service listens on `127.0.0.1` only. Nothing is reachable from the network, and Windows Firewall
  does not prompt.
* There is no sign-in on a person's own computer, so the way into the workspace is guarded instead: the app
  server opens the session with a per-install key that never reaches the browser, and the sign-in, sign-up
  and password-reset routes are switched off.
* Secrets (database password, session secret, control-page token) are generated per install and stored in the
  person's own profile folder. The Telegram bot token is never stored in the database.
* The control page that moves data and restarts services answers only on the loopback address and needs a
  per-install token for anything that changes state.

See [`docs/AGENCYOS_SECURITY.md`](docs/AGENCYOS_SECURITY.md) for the controls and the known gaps.
