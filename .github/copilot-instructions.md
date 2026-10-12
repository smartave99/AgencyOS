# Instructions for coding agents working on AgencyOS

AgencyOS is created by NextGen OS. Before writing code or answering questions, read `RULES.md` in full, then
`CLAUDE.md`. `RULES.md` is the source of truth; where the two differ, `RULES.md` wins.

* pnpm monorepo: `apps/backend` (NestJS), `apps/frontend` (Next.js), `apps/orchestrator` (Temporal workers),
  `libraries/*` (shared code), `installer/*` (the Windows desktop app and its installer).
* Use only `pnpm`. Prisma only; every schema change needs a migration.
* Code must look like the code around it. No `eslint-disable` comments.
