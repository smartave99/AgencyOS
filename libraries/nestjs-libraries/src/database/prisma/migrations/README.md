# Migrations

Prisma applies migrations in the **alphabetical order of their folder names**, not in numeric order. That is
why `10_…` would run before `1_…` and fail on a new install (it did, on the first Windows run that had one).

* `0_baseline` … `9_…` are the first series, in numeric order.
* From here on the folders are `a1_…`, `a2_…`, `a3_…`: letters sort after digits, so each new one runs after
  everything before it. Count up within the series (`a9_…` is followed by `b1_…`).
* Always check a new migration on an **empty** database (`prisma migrate deploy`), not only on one that already
  has the earlier ones: an existing database only runs what it has not yet applied, so it hides this mistake.
