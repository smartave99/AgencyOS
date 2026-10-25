# Development tooling kept from the long build session

Small scripts used to run the real compiled backend and the Next.js frontend on a Linux machine with no Telegram,
and to walk the screens in a headless Chromium. **They are not part of the product or of any build or test run.**
They were written for one sandbox and have its paths baked in (`/tmp/claude-0/...`, `/opt/pw-browsers/chromium-1194/...`,
PostgreSQL on port 54333, Redis on 6391). Read each one and change the paths before using it.

| File                                                                     | What it does                                                                                                                                                                                                      |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev-backend.mjs`                                                        | Starts the compiled backend (`apps/backend/dist`) on :3000 with Temporal stubbed. With `DEV_FAKE_TELEGRAM=1` it answers for Telegram per bot, so the bot screens work. Needs the environment in `dev.env.example` |
| `dev.env.example`                                                        | The environment it expects. The secrets in it are placeholders for a throwaway local database                                                                                                                     |
| `reset-local.sh`, `clean-local-org.mjs`                                  | Empty the local workspace, so each walkthrough starts clean (the local-mode end-to-end test fails if one is left behind)                                                                                          |
| `pg-start.sh`, `fresh-deploy.sh`                                         | Start the scratch PostgreSQL; prove the migrations apply to an empty database and have no drift                                                                                                                   |
| `fake-launcher.mjs`, `fake-launcher-cli.mjs`, `restart-fake-launcher.sh` | A stand-in launcher status server, so Settings → System and the local AI and tools screens can be used in a browser                                                                                               |
| `bots.mjs`, `backup.mjs`                                                 | Playwright walkthroughs: connect bots, register chats, backup bots                                                                                                                                                |
| `tgaccounts.mjs`                                                         | Telegram accounts and communities against the real worker's in-memory backend (`python -m agencyos_telegram --backend memory`)                                                                                    |
| `assign.mjs`                                                             | The "Which bot posts where" card, a slowed bot, the filter, the dialog, mobile width                                                                                                                              |
| `versions.mjs`                                                           | Ad versions and schedules in the campaign composer                                                                                                                                                                |
| `agent-ui.mjs`, `agent-live.mjs`                                         | The Agent integrations page; a live agent run                                                                                                                                                                     |

How the dev stack was started:

```bash
# PostgreSQL and Redis (see pg-start.sh), then
prisma migrate deploy --schema libraries/nestjs-libraries/src/database/prisma/schema.prisma
(set -a; . dev.env; set +a; DEV_FAKE_TELEGRAM=1 node dev-backend.mjs)          # :3000
cd apps/frontend && NEXT_PUBLIC_BACKEND_URL=http://localhost:3000 BACKEND_INTERNAL_URL=http://localhost:3000 \
  AGENCYOS_LOCAL=true AGENCYOS_LOCAL_KEY=… JWT_SECRET=… NOT_SECURED=true STORAGE_PROVIDER=local \
  FRONTEND_URL=http://localhost:4200 ../../node_modules/.bin/next dev --webpack -p 4200
```

Notes learned the hard way: the first visit to each route compiles for minutes (warm it with `curl` before a walkthrough);
the backend build needs `NODE_OPTIONS=--max-old-space-size=6144` here; run `prisma migrate deploy` on the dev database
after pulling a new migration or every API that selects the new columns answers 500; if `/edit` routes 404 under
`next dev`, delete `apps/frontend/.next/dev` and restart it.
