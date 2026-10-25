#!/bin/bash
# Starts a private PostgreSQL 16 on port 54444 for the WhatsApp module tests.
set -e
PGDIR=/var/tmp/wa-pg-54444
mkdir -p "$PGDIR"
chown postgres:postgres "$PGDIR"
if [ ! -d "$PGDIR/data" ]; then
  su postgres -s /bin/bash -c "/usr/lib/postgresql/16/bin/initdb -D $PGDIR/data -A trust -U postgres > /dev/null"
fi
su postgres -s /bin/bash -c "/usr/lib/postgresql/16/bin/pg_ctl -D $PGDIR/data -o '-p 54444 -k $PGDIR -c listen_addresses=127.0.0.1' -l $PGDIR/log -w start" | tail -2
psql -h 127.0.0.1 -p 54444 -U postgres -tc "select 1" > /dev/null
for db in wa_test wa_scratch; do
  psql -h 127.0.0.1 -p 54444 -U postgres -tc "select 1 from pg_database where datname='$db'" | grep -q 1 || psql -h 127.0.0.1 -p 54444 -U postgres -c "create database $db"
done
echo ready
