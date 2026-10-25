import { createRequire } from 'node:module';
const require = createRequire('/home/user/AgencyOS/package.json');
const { chromium } = require('playwright');
const { PrismaClient } = require('@prisma/client');
const out = process.argv[2];
const prisma = new PrismaClient({ datasources: { db: { url: 'postgresql://postgres@127.0.0.1:54333/agencyos_e2e?schema=public' } } });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1 });
await ctx.addCookies([{ name: 'mode', value: 'light', url: 'http://localhost:4200' }]);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message.slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error' && !/CopilotKit|Stripe|Failed to fetch|Agent default|favicon/.test(m.text())) errors.push('console: ' + m.text().slice(0, 200)); });
const go = async (p) => { await page.goto('http://localhost:4200' + p, { waitUntil: 'networkidle', timeout: 180000 }); await page.waitForTimeout(900); };
const shot = async (n) => page.screenshot({ path: `${out}/${n}.png`, fullPage: true });
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (!ok) process.exitCode = 1; };

await go('/agency/dashboard');
const user = await prisma.user.findFirstOrThrow({ where: { email: 'owner@agencyos.local' }, include: { organizations: true } });
const orgId = user.organizations[0].organizationId;
const customer = await prisma.customer.create({ data: { orgId, name: 'Bakery', companyName: 'Sunrise Bakery' } });
const dests = [];
for (const title of ['Bread lovers', 'Cake club', 'Local deals']) {
  dests.push(await prisma.telegramDestination.create({ data: { orgId, chatId: '-100' + Math.floor(Math.random() * 1e9), title, type: 'supergroup', authorizationStatus: 'ACTIVE', isAuthorized: true, canPostMessages: true, consentGrantedAt: new Date(), consentExpiresAt: new Date(Date.now() + 365 * 864e5), consentedByName: 'Admin' } }));
}

await go('/agency/campaigns/new');
await page.getByLabel('Client').selectOption({ label: 'Sunrise Bakery' });
await page.getByLabel('Campaign name').fill('Spring bread test');
await page.getByLabel('Ad text').first().fill('Fresh <b>sourdough</b> every morning.');
await page.getByLabel('Headline').first().fill('Sourdough');
check('no preview tabs before a second version exists', (await page.getByRole('tab', { name: 'Version B' }).count()) === 0);

await page.getByRole('button', { name: 'Compare another version' }).click();
await page.getByRole('button', { name: 'Add version B' }).click();
await page.waitForTimeout(300);
const b = page.locator('div', { has: page.getByRole('heading', { name: 'Version B' }) }).last();
await page.getByRole('heading', { name: 'Version B' }).scrollIntoViewIfNeeded();
check('a new version starts as a copy of A', (await page.getByLabel('Ad text').nth(1).inputValue()).includes('sourdough'));
await page.getByLabel('Ad text').nth(1).fill('');
await page.getByLabel('Ad text').nth(1).blur();
await page.waitForTimeout(300);
check('an empty version shows an inline error', await page.getByText('Version B needs some ad text.').isVisible());
await page.getByLabel('Ad text').nth(1).fill('Warm <i>sourdough</i>, baked at dawn. Order before 9.');
await page.waitForTimeout(500);
check('preview tabs appear', (await page.getByRole('tab', { name: 'Version B' }).count()) === 1);
await page.getByRole('tab', { name: 'Version B' }).click();
await page.waitForTimeout(900);
check('the preview shows version B', await page.getByText('baked at dawn').first().isVisible());
await page.getByRole('tab', { name: 'Version A' }).click();
await page.waitForTimeout(900);
check('and A again', await page.getByText('Fresh').first().isVisible());
await shot('01-composer-versions');

// pick the chats
for (const t of ['Bread lovers', 'Cake club', 'Local deals']) await page.getByText(t, { exact: true }).click();
const start = new Date(Date.now() + 36e5); const pad = (n) => String(n).padStart(2, '0');
const local = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}T${pad(start.getHours())}:${pad(start.getMinutes())}`;
await page.getByLabel('Start').fill(local);

await page.getByLabel('How it posts').selectOption('REPEAT');
await page.getByLabel('Posts per chat').fill('1');
await page.getByLabel('Wait between posts').fill('30');
await page.getByLabel('Unit').selectOption('minutes');
await page.getByLabel('Unit').blur();
await page.getByLabel('Wait between posts').blur(); await page.waitForTimeout(300);
check('repeat needs at least an hour', await page.getByText('Repeats need at least an hour between posts').isVisible());
check('and 2 to 60 posts', await page.getByText('Choose between 2 and 60 posts per chat.').isVisible());
await page.getByLabel('Posts per chat').fill('3');
await page.getByLabel('Wait between posts').fill('6');
await page.getByLabel('Unit').selectOption('hours');
await page.waitForTimeout(400);
check('summary says what will happen', await page.getByText('Posts 3 times to each chat, 6 hours apart').isVisible());
await shot('02-composer-repeat');

await page.getByLabel('How it posts').selectOption('DRIP');
await page.getByLabel('Wait between chats').fill('15');
await page.getByLabel('Wait between chats').blur();
await page.getByLabel('Unit').selectOption('minutes');
const stop = new Date(start.getTime() + 20 * 60000);
await page.getByLabel('Stop sending after').fill(`${stop.getFullYear()}-${pad(stop.getMonth() + 1)}-${pad(stop.getDate())}T${pad(stop.getHours())}:${pad(stop.getMinutes())}`);
await page.waitForTimeout(400);
check('a drip that runs past the stop time is explained', await page.getByText('The last chat would start after the stop time').isVisible());
await page.getByLabel('Stop sending after').fill('');
await page.getByLabel('Wait between chats').fill('20');
await page.waitForTimeout(300);
check('drip summary', await page.getByText('One chat after another, 20 minutes apart').isVisible());
await shot('03-composer-drip');

// save as a repeating campaign and look at detail + edit
await page.getByLabel('How it posts').selectOption('REPEAT');
await page.getByLabel('Posts per chat').fill('3');
await page.getByLabel('Wait between posts').fill('1');
await page.getByLabel('Unit').selectOption('days');
await page.getByRole('button', { name: 'Save draft' }).click();
await page.waitForURL(/\/agency\/campaigns\/(?!new)[a-z0-9-]+$/, { timeout: 30000 });
await page.waitForTimeout(1200);
await shot('04-detail');
check('detail shows the schedule in words', await page.getByText('Posts 3 times to each chat, 1 day apart').isVisible());
check('detail lists the versions', await page.getByText('Versions being compared').isVisible());
const id = page.url().split('/').pop();
// what the jobs table looks like once repeats exist
const camp = await prisma.campaign.findUniqueOrThrow({ where: { id } });
for (const [i, label, occ] of [[0, null, 0], [1, 'B', 1], [2, null, 2]]) {
  await prisma.postingJob.create({ data: { orgId, campaignId: id, telegramDestinationId: dests[0].id, destinationType: 'TELEGRAM', idempotencyKey: `shot-${id}-${i}`, status: 'PENDING', variantLabel: label, occurrence: occ, scheduledFor: new Date(Date.now() + (i + 1) * 864e5), nextAttemptAt: new Date(Date.now() + (i + 1) * 864e5), contentHash: 'h' } });
}
await go('/agency/campaigns/' + id);
check('jobs table names version and repeat', await page.getByText('Version B · Repeat 2').isVisible());
await shot('05-detail-jobs');
await go(`/agency/campaigns/${id}/edit`);
check('edit shows the saved versions', (await page.getByRole('button', { name: 'Other versions (1)' }).count()) === 1);
check('and the saved version text', (await page.getByLabel('Ad text').nth(1).inputValue()).includes('baked at dawn'));
check('and the saved schedule', (await page.getByLabel('How it posts').inputValue()) === 'REPEAT' && (await page.getByLabel('Posts per chat').inputValue()) === '3' && (await page.getByLabel('Unit').inputValue()) === 'days');
// removing a version asks first
await page.getByRole('button', { name: 'Remove' }).click();
await page.waitForTimeout(400);
check('removing a version asks to confirm', await page.getByRole('button', { name: 'Yes, remove it' }).isVisible());
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('cancelling keeps it', (await page.getByLabel('Ad text').count()) === 2);

// 390 px
await page.setViewportSize({ width: 390, height: 844 });
for (const [n, p] of [['composer', `/agency/campaigns/${id}/edit`], ['detail', `/agency/campaigns/${id}`]]) {
  await go(p);
  check(`${n} has no horizontal scroll at 390px`, !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  await shot(`06-${n}-390`);
}
console.log(errors.length ? 'console errors:\n' + errors.join('\n') : 'no console errors');
await prisma.$disconnect();
await browser.close();
