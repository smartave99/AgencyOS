#!/bin/bash
# Proves the migrations apply, in Prisma's own (alphabetical) order, to an EMPTY database, and that
# the result has no drift from schema.prisma. This tree still carries "10_agency_variants_schedule",
# which main has already renamed to a1_; the copy used here renames it the same way (the real tree is
# not touched) so the check is the one that will apply after the merge.
set -e
WT=/home/user/AgencyOS/.claude/worktrees/agent-af6237e3f6b886d5a
SRC=$WT/libraries/nestjs-libraries/src/database/prisma
TMP=/tmp/claude-0/-home-user-AgencyOS/becc8a9d-87ff-5e3d-ba68-4cadff714271/scratchpad/fresh-prisma
rm -rf "$TMP"
mkdir -p "$TMP"
cp "$SRC/schema.prisma" "$TMP/schema.prisma"
cp -r "$SRC/migrations" "$TMP/migrations"
if [ -d "$TMP/migrations/10_agency_variants_schedule" ]; then
  mv "$TMP/migrations/10_agency_variants_schedule" "$TMP/migrations/a1_agency_variants_schedule"
fi
echo "folders in the order Prisma applies them:"
ls "$TMP/migrations"
URL=postgresql://postgres@127.0.0.1:54444/wa_fresh
psql -h 127.0.0.1 -p 54444 -U postgres -q -c "drop database if exists wa_fresh" -c "create database wa_fresh"
cd "$WT"
DATABASE_URL=$URL node_modules/.bin/prisma migrate deploy --schema "$TMP/schema.prisma"
echo "---- drift check (database vs schema.prisma)"
set +e
DATABASE_URL=$URL node_modules/.bin/prisma migrate diff --from-schema-datasource "$TMP/schema.prisma" --to-schema-datamodel "$TMP/schema.prisma" --exit-code
echo "drift exit code: $?"
