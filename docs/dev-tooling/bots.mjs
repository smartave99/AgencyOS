import { createRequire } from 'node:module';
const require = createRequire('/home/user/AgencyOS/package.json');
const { chromium } = require('playwright');
const out = process.argv[2];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
await ctx.addCookies([{ name: 'mode', value: 'light', url: 'http://localhost:4200' }]);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message.slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error' && !/CopilotKit|Stripe|Failed to fetch|Agent default/.test(m.text())) errors.push('console: ' + m.text().slice(0, 200)); });
const go = async (p) => { await page.goto('http://localhost:4200' + p, { waitUntil: 'networkidle', timeout: 90000 }); await page.waitForTimeout(900); };
const shot = async (n) => page.screenshot({ path: `${out}/${n}.png` });
const tok = (n) => `${n}:${'x'.repeat(10)}${String(n).padEnd(25, 'q')}`;

await go('/settings?tab=telegram');
await page.waitForTimeout(1500);
await shot('01-bots-empty');

// inline validation
await page.getByPlaceholder('123456789:AAH…').fill('nope');
await page.getByPlaceholder('e.g. Acme Ads').fill('');
await page.getByRole('button', { name: 'Connect bot' }).click();
await page.waitForTimeout(300);
await shot('02-bots-validation');

// connect two bots
for (const [label, n] of [['Acme Ads', 111111], ['Fruit Lovers', 222222]]) {
  await page.getByPlaceholder('e.g. Acme Ads').fill(label);
  await page.getByPlaceholder('123456789:AAH…').fill(tok(n));
  await page.getByRole('button', { name: 'Connect bot' }).click();
  await page.waitForTimeout(1200);
}
await shot('03-bots-two');

// duplicate -> plain message
await page.getByPlaceholder('e.g. Acme Ads').fill('Again');
await page.getByPlaceholder('123456789:AAH…').fill(tok(111111));
await page.getByRole('button', { name: 'Connect bot' }).click();
await page.waitForTimeout(900);
await shot('04-bots-duplicate');

// the Telegram page: choose a bot when registering
await go('/agency/telegram');
await shot('05-telegram-page');
await page.getByLabel('Posts through').selectOption({ label: 'Fruit Lovers (@bot_222222)' });
await page.getByLabel('Chat ID or public @username').fill('-1001234567890');
await page.getByRole('button', { name: 'Get authorization code' }).click();
await page.waitForTimeout(1200);
await shot('06-telegram-instructions');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await page.getByRole('button', { name: /done|close/i }).first().click().catch(() => {});
await page.waitForTimeout(400);
await shot('07-telegram-registered');

// System tab
await go('/settings?tab=system');
await shot('08-system');
await page.getByRole('button', { name: 'Change location…' }).click();
await page.getByLabel('Data folder').fill('E:\\AgencyOS');
await page.waitForTimeout(1200);
await shot('09-system-move-plan');
await page.getByRole('button', { name: 'Move…' }).click();
await page.waitForTimeout(500);
await shot('10-system-move-confirm');
console.log(errors.length ? 'ERRORS:\n' + [...new Set(errors)].join('\n') : 'no page errors');
await browser.close();
