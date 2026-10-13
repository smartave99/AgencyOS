import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { agencyValidationPipe } from '@gitroom/nestjs-libraries/dtos/agency/agency.pipe';
import {
  CreateLeadLinkDto,
  UpdateLeadDto,
} from '@gitroom/nestjs-libraries/dtos/agency/lead.dto';
import {
  buildHarness,
  describeDb,
  draftCampaign,
  Harness,
  seedTenant,
  Tenant,
} from './agency.test.support';

const privateChat = (id: number) => ({ id, type: 'private' });
const say = (user: object, text: string, chat?: object) => ({
  update_id: Math.floor(Math.random() * 1e9),
  message: {
    message_id: 1,
    date: 0,
    chat: chat ?? privateChat((user as { id: number }).id),
    from: user,
    text,
  },
});

describeDb('Lead links: people who start the bot (real database)', () => {
  let h: Harness;
  let t: Tenant;
  let other: Tenant;
  const tenants: Tenant[] = [];
  let seed = 3_000_000 + Math.floor(Math.random() * 5_000_000);
  const person = (over: object = {}) => ({
    id: ++seed,
    is_bot: false,
    first_name: 'Priya',
    last_name: 'Nair',
    username: `priya${seed}`,
    ...over,
  });

  beforeAll(async () => {
    h = await buildHarness();
  });
  afterAll(async () => {
    await h.prisma.$disconnect();
  });
  beforeEach(async () => {
    t = await seedTenant(h, 'leads');
    other = await seedTenant(h, 'leads-other');
    tenants.push(t, other);
    h.gateway.notices = [];
    h.gateway.bots.clear();
  });
  afterEach(async () => {
    await h.prisma.telegramBot.updateMany({
      where: { orgId: { in: tenants.map((x) => x.orgId) }, deletedAt: null },
      data: {
        deletedAt: new Date(),
        status: 'DISABLED',
        tokenSealed: '',
        tokenHash: '',
      },
    });
  });

  const connect = async (tenant: Tenant = t) => {
    const tok = `${++seed}:AAH${Math.random()
      .toString(36)
      .slice(2)}${Math.random().toString(36).slice(2)}`;
    const bot = await h.bots.add(tenant.owner, {
      label: 'Leads bot',
      token: tok,
    });
    return {
      bot,
      handle: await h.bots.handleFor(tenant.orgId, bot.id),
      fake: h.gateway.bots.get(tok)!,
    };
  };
  const hear = async (
    update: ReturnType<typeof say>,
    handle: Awaited<ReturnType<typeof connect>>['handle']
  ) => h.telegram.handleUpdate(update, handle);
  const codeOf = (url: string) => url.split('start=')[1];

  it('makes a link that opens the chosen bot, and lists it with the bot’s name', async () => {
    const { bot } = await connect();
    const link = await h.leads.createLink(t.sales, {
      label: 'Spring offer',
      botId: bot.id,
    });
    expect(link.url).toBe(`https://t.me/${bot.username}?start=${link.code}`);
    expect(link.code).toMatch(/^[A-Za-z0-9_-]{11}$/);
    const listed = await h.leads.listLinks(t.sales);
    expect(listed).toEqual([
      expect.objectContaining({
        id: link.id,
        url: link.url,
        people: 0,
        stopped: 0,
      }),
    ]);
    expect(
      await h.prisma.auditEvent.count({
        where: { entityId: link.id, action: 'lead_link.created' },
      })
    ).toBe(1);
  });

  it('records a person who taps Start, tells them what is kept and how to stop, and keeps one row each', async () => {
    const { bot, handle, fake } = await connect();
    const campaign = await draftCampaign(h, t, []);
    const link = await h.leads.createLink(t.sales, {
      label: 'Spring offer',
      botId: bot.id,
      campaignId: campaign.id,
      welcomeMessage: 'Welcome to the bakery club!',
    });
    const priya = person();
    await hear(say(priya, `/start ${link.code}`), handle);
    await hear(say(priya, `/start ${link.code}`), handle); // tapping twice adds nobody

    const rows = await h.leads.list(t.sales);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'Priya Nair',
      telegramHandle: `@${priya.username}`,
      status: 'NEW',
      campaignId: campaign.id,
      source: 'telegram-bot',
    });
    expect(rows[0].consentedAt).toBeInstanceOf(Date);
    expect(fake.notices[0]).toMatchObject({ chatId: String(priya.id) });
    expect(fake.notices[0].text).toContain('Welcome to the bakery club!');
    expect(fake.notices[0].text).toContain('/stop');
    expect(fake.notices[0].text).toContain('Spring offer');
  });

  it('records nobody who did not tap Start: group chats, bots, a missing code, a made-up code', async () => {
    const { bot, handle, fake } = await connect();
    const link = await h.leads.createLink(t.sales, {
      label: 'L',
      botId: bot.id,
    });
    const p = person();
    await hear(
      say(p, `/start ${link.code}`, { id: -1001, type: 'supergroup' }),
      handle
    );
    await hear(say(person({ is_bot: true }), `/start ${link.code}`), handle);
    await hear(say(p, '/start'), handle);
    await hear(say(p, '/start NotARealCode1'), handle);
    expect(await h.leads.list(t.sales)).toEqual([]);
    expect(fake.notices.map((n) => n.text)).toEqual([
      'This link is not active any more.',
    ]);
  });

  it('works only through the bot it was made for', async () => {
    const first = await connect();
    const second = await connect();
    const link = await h.leads.createLink(t.sales, {
      label: 'L',
      botId: first.bot.id,
    });
    await hear(say(person(), `/start ${link.code}`), second.handle);
    expect(await h.leads.list(t.sales)).toEqual([]);

    const foreign = await connect(other);
    await hear(say(person(), `/start ${link.code}`), foreign.handle);
    expect(await h.leads.list(t.sales)).toEqual([]);
    expect(await h.leads.list(other.sales)).toEqual([]);
  });

  it('/stop deletes the details, keeps the person out of every list and export, and Start again is a new request', async () => {
    const { bot, handle, fake } = await connect();
    const link = await h.leads.createLink(t.sales, {
      label: 'L',
      botId: bot.id,
    });
    const priya = person();
    await hear(say(priya, `/start ${link.code}`), handle);
    const [lead] = await h.leads.list(t.sales);
    await h.leads.update(t.sales, lead.id, {
      status: 'QUALIFIED',
      notes: 'wants a quote',
    });

    fake.notices = [];
    await hear(say(priya, '/stop'), handle);
    expect(fake.notices[0].text).toMatch(/deleted your details/);

    const stored = await h.prisma.leadCapture.findUniqueOrThrow({
      where: { id: lead.id },
    });
    expect(stored).toMatchObject({
      status: 'OPTED_OUT',
      name: null,
      telegramHandle: null,
      notes: null,
    });
    expect(stored.optedOutAt).toBeInstanceOf(Date);
    expect(await h.leads.list(t.sales)).toEqual([]);
    expect(await h.leads.exportRows(t.owner)).toEqual([]);
    expect((await h.leads.listLinks(t.sales))[0]).toMatchObject({
      people: 0,
      stopped: 1,
    });
    await expect(
      h.leads.update(t.sales, lead.id, { status: 'CONTACTED' })
    ).rejects.toBeInstanceOf(BadRequestException);

    fake.notices = [];
    await hear(say(priya, '/stop'), handle);
    expect(fake.notices[0].text).toMatch(/not on any list/);

    await hear(say(priya, `/start ${link.code}`), handle);
    expect(await h.leads.list(t.sales)).toEqual([
      expect.objectContaining({
        id: lead.id,
        status: 'NEW',
        name: 'Priya Nair',
      }),
    ]);
  });

  it('a removed link stops collecting, and keeps the people it already has', async () => {
    const { bot, handle, fake } = await connect();
    const link = await h.leads.createLink(t.sales, {
      label: 'L',
      botId: bot.id,
    });
    await hear(say(person(), `/start ${link.code}`), handle);
    await h.leads.removeLink(t.sales, link.id);
    fake.notices = [];
    await hear(say(person(), `/start ${link.code}`), handle);
    expect(fake.notices[0].text).toBe('This link is not active any more.');
    expect(await h.leads.list(t.sales)).toHaveLength(1);
    expect(await h.leads.listLinks(t.sales)).toEqual([]);
  });

  it('exports who is left as CSV and JSON, with spreadsheet formulas defused and no ids', async () => {
    const { bot, handle } = await connect();
    const link = await h.leads.createLink(t.sales, {
      label: 'Expo',
      botId: bot.id,
    });
    await hear(
      say(
        person({ first_name: '=HYPERLINK("x")', last_name: undefined }),
        `/start ${link.code}`
      ),
      handle
    );
    const csv = await h.leads.exportCsv(t.owner);
    const [head, row] = csv.split('\r\n');
    expect(head).toBe(
      '"Name","Telegram username","Source","Campaign","Status","Started","Notes"'
    );
    expect(row).toContain(`"'=HYPERLINK(""x"")"`);
    expect(row).toContain('"Expo"');
    const json = await h.leads.exportRows(t.owner);
    expect(json[0]['Telegram username']).not.toMatch(/^@/);
    expect(Object.keys(json[0])).not.toContain('telegramUserId');
    expect(JSON.stringify(json)).not.toMatch(/telegramUserId/);
  });

  it('shows a sales executive only the links they made, and keeps workspaces apart', async () => {
    const { bot, handle } = await connect();
    const mine = await h.leads.createLink(t.sales, {
      label: 'Mine',
      botId: bot.id,
    });
    const managers = await h.leads
      .createLink(t.manager, { label: 'Manager', botId: bot.id })
      .catch((e) => e);
    // a campaign manager cannot work leads at all
    expect(managers).toBeInstanceOf(ForbiddenException);
    const ownerLink = await h.leads.createLink(t.owner, {
      label: 'Owner',
      botId: bot.id,
    });
    await hear(say(person(), `/start ${mine.code}`), handle);
    await hear(say(person(), `/start ${ownerLink.code}`), handle);

    expect((await h.leads.list(t.sales)).map((l) => l.leadLink?.label)).toEqual(
      ['Mine']
    );
    expect((await h.leads.listLinks(t.sales)).map((l) => l.label)).toEqual([
      'Mine',
    ]);
    expect(await h.leads.list(t.owner)).toHaveLength(2);
    expect(await h.leads.list(other.owner)).toEqual([]);

    const ownersLead = (await h.leads.list(t.owner)).find(
      (l) => l.leadLink?.label === 'Owner'
    )!;
    await expect(
      h.leads.update(t.sales, ownersLead.id, { status: 'LOST' })
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      h.leads.erase(other.owner, ownersLead.id)
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      h.leads.removeLink(t.sales, ownerLink.id)
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lets staff update status and notes, and erase a person on request', async () => {
    const { bot, handle } = await connect();
    const link = await h.leads.createLink(t.sales, {
      label: 'L',
      botId: bot.id,
    });
    await hear(say(person(), `/start ${link.code}`), handle);
    const [lead] = await h.leads.list(t.sales);
    await expect(
      h.leads.update(t.sales, lead.id, {
        status: 'CONTACTED',
        notes: ' called ',
      })
    ).resolves.toMatchObject({ status: 'CONTACTED', notes: 'called' });
    await expect(h.leads.erase(t.sales, lead.id)).resolves.toEqual({
      deleted: true,
    });
    expect(await h.prisma.leadCapture.count({ where: { id: lead.id } })).toBe(
      0
    );
    // analysts and clients cannot read people's details
    await expect(h.leads.list(t.analyst)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    await expect(h.leads.list(t.client)).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it('validates input and refuses a campaign or bot that is not the workspace’s', async () => {
    const pipe = (body: object, metatype: any = CreateLeadLinkDto) =>
      agencyValidationPipe.transform(body, { type: 'body', metatype });
    await expect(pipe({})).rejects.toBeDefined();
    await expect(pipe({ label: 'x'.repeat(101) })).rejects.toBeDefined();
    await expect(
      pipe({ status: 'OPTED_OUT' }, UpdateLeadDto)
    ).rejects.toBeDefined();
    await expect(pipe({ label: 'A', orgId: 'smuggled' })).resolves.toEqual({
      label: 'A',
    });

    const { bot } = await connect();
    const theirs = await draftCampaign(h, other, []);
    await expect(
      h.leads.createLink(t.sales, {
        label: 'L',
        botId: bot.id,
        campaignId: theirs.id,
      })
    ).rejects.toBeInstanceOf(NotFoundException);
    const foreignBot = await connect(other);
    await expect(
      h.leads.createLink(t.sales, { label: 'L', botId: foreignBot.bot.id })
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      h.leads.createLink(t.sales, { label: '  ', botId: bot.id })
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
