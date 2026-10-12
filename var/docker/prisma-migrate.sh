#!/usr/bin/env bash
# Applies Prisma migrations at startup.
#
# Databases created by older installs used `prisma db push` and have no migration
# history, so the first `migrate deploy` stops with P3005 ("schema is not empty"). In
# that one case the 0_baseline migration (the schema those installs already have) is
# recorded as applied and everything after it is then applied normally.
#
# Back up the database before upgrading an existing install. Never use `db push` on a
# database that has migrations: it would bypass the data fixes they contain.
set -uo pipefail

SCHEMA="./libraries/nestjs-libraries/src/database/prisma/schema.prisma"
PRISMA="${PRISMA:-pnpm dlx prisma@6.5.0}"

out="$($PRISMA migrate deploy --schema "$SCHEMA" 2>&1)"
code=$?
echo "$out"

if [ "$code" -ne 0 ] && echo "$out" | grep -q "P3005"; then
  echo "Existing database without migration history: recording 0_baseline as applied."
  $PRISMA migrate resolve --applied 0_baseline --schema "$SCHEMA" || exit 1
  $PRISMA migrate deploy --schema "$SCHEMA"
  exit $?
fi

exit "$code"
