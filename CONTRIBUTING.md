# Contributing to AgencyOS

AgencyOS is created by NextGen OS. Before changing anything, read [`RULES.md`](RULES.md) (the mission, the
mandatory features and the design and engineering rules) and [`CLAUDE.md`](CLAUDE.md) (the coding
conventions). Where they differ, `RULES.md` wins.

## Working on the code

```bash
pnpm install                       # pnpm only, never npm or yarn
cp .env.agencyos.example .env
pnpm run prisma-migrate
pnpm run dev
```

* Every schema change needs a migration. Never use `prisma db push` on a database that has migrations.
* Code must look like the code around it. No `eslint-disable` comments.
* The Windows app has its own tests: `node --test installer/launcher/test/*.test.mjs installer/desktop/test/policy.test.js`.
* The backend has end-to-end tests that run the compiled server against PostgreSQL; see `AGENCYOS_GUIDE.md`.

## Pull requests

Use the pull request template. It asks for what kind of change it is, numbered QA steps a reviewer can run,
and a statement that the core flows are unaffected (or intentionally changed).
