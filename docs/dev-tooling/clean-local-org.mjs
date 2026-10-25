// The browser walkthroughs used the e2e database's local workspace; clear what they left so the
// local-mode e2e suite can remove that workspace again.
import { createRequire } from 'node:module';
const require = createRequire('/home/user/AgencyOS/package.json');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ datasources: { db: { url: 'postgresql://postgres@127.0.0.1:54333/agencyos_e2e?schema=public' } } });
const users = await prisma.user.findMany({ where: { email: 'owner@agencyos.local' }, select: { id: true } });
const orgs = await prisma.userOrganization.findMany({ where: { userId: { in: users.map((u) => u.id) } }, select: { organizationId: true } });
const stray = await prisma.$queryRawUnsafe(`select distinct "orgId" from "Campaign" where "createdById" = any($1::text[])`, users.map((u) => u.id));
const orgIds = [...new Set([...orgs.map((o) => o.organizationId), ...stray.map((r) => r.orgId)])];
console.log('local orgs', orgIds.length);
const cols = await prisma.$queryRawUnsafe(`select table_name, column_name from information_schema.columns where table_schema='public' and column_name in ('orgId','organizationId') and table_name <> 'Organization'`);
let progress = true, rounds = 0;
while (progress && rounds++ < 12) {
  progress = false;
  for (const { table_name, column_name } of cols) {
    for (const id of orgIds) {
      try {
        const n = await prisma.$executeRawUnsafe(`DELETE FROM "${table_name}" WHERE "${column_name}" = $1`, id);
        if (n > 0) progress = true;
      } catch { /* a table that still has children: next round */ }
    }
  }
}
// rows keyed through a campaign or destination go with their parents; what is left is reported
for (const { table_name, column_name } of cols) {
  for (const id of orgIds) {
    const [{ c }] = await prisma.$queryRawUnsafe(`select count(*)::int as c from "${table_name}" where "${column_name}" = $1`, id);
    if (c) console.log('left in', table_name, c);
  }
}
await prisma.$disconnect();
