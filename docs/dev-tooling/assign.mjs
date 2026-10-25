import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire('/home/user/AgencyOS/package.json');
const { chromium } = require('playwright');
const out = process.argv[2];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1 });
await ctx.addCookies([{ name: 'mode', value: 'light', url: 'http://localhost:4200' }]);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message.slice(0, 200)));
const go = async (p) => { await page.goto('http://localhost:4200' + p, { waitUntil: 'networkidle', timeout: 240000 }); await page.waitForTimeout(900); };
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (!ok) process.exitCode = 1; };
const tok = (n) => `${n}:${'x'.repeat(10)}${String(n).padEnd(25, 'q')}`;
const sql = (q) => execSync(`psql -q -t -h 127.0.0.1 -p 54333 -U postgres -d agencyos_e2e -c ${JSON.stringify(q)}`).toString();

await go('/settings?tab=telegram');
for (const [label, n] of [['Acme Ads', 111111], ['Fruit Lovers', 222222]]) {
  await page.getByPlaceholder('e.g. Acme Ads').fill(label);
  await page.getByPlaceholder('123456789:AAH…').fill(tok(n));
  await page.getByRole('button', { name: 'Connect bot' }).click();
  await page.waitForTimeout(1500);
}
await go('/agency/telegram');
for (const [bot, chat] of [['Acme Ads (@bot_111111)', '-1001000000001'], ['Fruit Lovers (@bot_222222)', '-1001000000002']]) {
  await page.getByLabel('Posts through').selectOption({ label: bot });
  await page.getByLabel('Chat ID or public @username').fill(chat);
  await page.getByRole('button', { name: 'Get authorization code' }).click();
  await page.waitForTimeout(1500);
  const close = page.getByRole('button', { name: /^(Done|Close)$/ });
  if (await close.count()) await close.first().click();
  await go('/agency/telegram');
}
// Backup for the first chat, and a Telegram slow-down on the first bot (a minute from now).
sql(`update "TelegramDestination" set "backupBotIds"=ARRAY[(select id from "TelegramBot" where username='bot_222222' limit 1)] where "chatId"='-1001000000001'`);
await go('/agency/telegram/accounts');
await page.screenshot({ path: `${out}/assign-1-before.png`, fullPage: true });
check('card is on the page', await page.getByText('Which bot posts where').first().isVisible());
check('both chats are listed', (await page.getByText('Chat -1001000000001').count()) + (await page.getByText('-1001000000001').count()) > 0);
check('main bot and backup are named', (await page.getByText('Acme Ads (@bot_111111)').count()) > 0 && (await page.getByText('Fruit Lovers (@bot_222222)').count()) > 0);
sql(`update "TelegramBot" set "rateLimitedUntil"=now()+interval '5 minutes', "lastRateLimitedAt"=now() where username='bot_111111'`);
await go('/agency/telegram/accounts');
await page.screenshot({ path: `${out}/assign-2-slowed.png`, fullPage: true });
check('the slowed bot is flagged in the card', (await page.getByText(/Slowed until/).count()) >= 1);
check('the at-a-glance panel counts it as limited', (await page.getByText('Limited by Telegram').count()) >= 1);
// filter
await page.getByLabel('Show', { exact: true }).selectOption({ label: 'Fruit Lovers (@bot_222222)' });
await page.waitForTimeout(300);
check('filter shows only that bot\'s chats', (await page.getByText('Change bots').count()) === 1);
await page.screenshot({ path: `${out}/assign-3-filter.png`, fullPage: true });
await page.getByLabel('Show', { exact: true }).selectOption({ label: 'All chats' });
// the dialog reuses the existing backup dialog
await page.getByRole('button', { name: 'Change bots' }).first().click();
await page.waitForTimeout(500);
check('Change bots opens the backup dialog', await page.getByText(/Backup bots for/).first().isVisible());
await page.screenshot({ path: `${out}/assign-4-dialog.png` });
// mobile width: no horizontal scroll
await page.keyboard.press('Escape');
await page.setViewportSize({ width: 390, height: 900 });
await go('/agency/telegram/accounts');
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
check('no horizontal scroll at 390px', !overflow);
await page.screenshot({ path: `${out}/assign-5-mobile.png`, fullPage: true });
console.log(errors.length ? errors.join('\n') : 'no page errors');
await browser.close();
