import { createRequire } from 'node:module';
const require = createRequire('/home/user/AgencyOS/package.json');
const { chromium } = require('playwright');
const { PrismaClient } = require('@prisma/client');
const out = process.argv[2];
const prisma = new PrismaClient({ datasources: { db: { url: 'postgresql://postgres@127.0.0.1:54333/agencyos_e2e?schema=public' } } });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addCookies([{ name: 'mode', value: 'light', url: 'http://localhost:4200' }]);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message.slice(0, 200)));
const go = async (p) => { await page.goto('http://localhost:4200' + p, { waitUntil: 'networkidle', timeout: 90000 }); await page.waitForTimeout(1200); };
const shot = (n) => page.screenshot({ path: `${out}/${n}.png` });
const tok = (n) => `${n}:${'x'.repeat(10)}${String(n).padEnd(25, 'q')}`;
const n0 = 500000 + Math.floor(Math.random() * 400000);

await go('/settings?tab=telegram');
for (const [label, n] of [['Acme Ads', n0], ['Acme Backup', n0 + 1]]) {
  await page.getByPlaceholder('e.g. Acme Ads').fill(label);
  await page.getByPlaceholder('123456789:AAH…').fill(tok(n));
  await page.getByRole('button', { name: 'Connect bot' }).click();
  await page.waitForTimeout(1300);
}
await go('/agency/telegram');
await page.getByLabel('Posts through').selectOption({ label: `Acme Ads (@bot_${n0})` });
await page.getByLabel('Chat ID or public @username').fill('-1002468013579');
await page.getByRole('button', { name: 'Get authorization code' }).click();
await page.waitForTimeout(1300);
await page.getByRole('button', { name: /sent it/i }).click();
await page.waitForTimeout(500);
// the chat's administrator authorized it (the dev harness has no listener): make it active
await prisma.telegramDestination.updateMany({ where: { chatId: '-1002468013579' }, data: { authorizationStatus: 'ACTIVE', isAuthorized: true, consentGrantedAt: new Date(), consentExpiresAt: new Date(Date.now() + 365 * 864e5), canPostMessages: true } });
await go('/agency/telegram');
await shot('01-active-chat');
await page.getByRole('button', { name: 'More actions' }).first().click();
await page.getByRole('menuitem', { name: 'Backup bots…' }).click();
await page.waitForTimeout(600);
await shot('02-backup-dialog');
await page.getByLabel(/Acme Backup/).check();
await page.getByLabel('How they share the work').selectOption('ROUND_ROBIN');
await page.waitForTimeout(300);
await shot('03-backup-chosen');
await page.getByRole('button', { name: 'Save' }).click();
await page.waitForTimeout(1500);
await shot('04-after-save');
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await prisma.$disconnect();
await browser.close();
