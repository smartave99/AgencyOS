import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AgencyRole, WhatsappTaskStatus } from '@prisma/client';
import { agencyValidationPipe } from '@gitroom/nestjs-libraries/dtos/agency/agency.pipe';
import {
  CommitWhatsappImportDto,
  CreateWhatsappContactDto,
  PreviewWhatsappImportDto,
  SetWhatsappTaskStatusDto,
  UpdateWhatsappContactDto,
  WHATSAPP_LIMITS,
  WHATSAPP_TASK_STATUSES,
} from '@gitroom/nestjs-libraries/dtos/agency/whatsapp.dto';
import {
  DisabledWhatsappBusinessProvider,
  WhatsappBusinessNotEnabledError,
} from '@gitroom/nestjs-libraries/integrations/whatsapp/whatsapp.business.provider';
import { AGENCY_PERMISSIONS } from './agency.access.service';
import { AiProviderError } from './agency.ai.gateway.service';
import { AgencyWhatsappRepository } from './agency.whatsapp.repository';
import {
  AgencyWhatsappService,
  chatLink,
  maskPhone,
  normalisePhone,
  parseConsentDate,
  parseCsv,
  WHATSAPP_IMPORT_ATTESTATION,
} from './agency.whatsapp.service';
import {
  cleanSuggestion,
  renderMessage,
  TASK_TRANSITIONS,
  templateProblems,
} from './agency.whatsapp.outreach.service';
import {
  buildHarness,
  describeDb,
  Harness,
  seedTenant,
  Tenant,
} from './agency.test.support';

const pipe = (body: object, metatype: any) =>
  agencyValidationPipe.transform(body, { type: 'body', metatype });

describe('WhatsApp workspace: rules that need no database', () => {
  it('turns what people type into E.164, and refuses what it would have to guess', () => {
    for (const typed of [
      '+49 151 1234 5678',
      '0049 (151) 1234-5678',
      '+49-151-1234.5678',
      '+49 (0) 151 1234 5678',
      'tel:+4915112345678',
      '＋４９１５１１２３４５６７８'.replace('＋', '+'),
    ]) {
      expect(normalisePhone(typed)).toEqual({ phone: '+4915112345678' });
    }
    for (const bad of [
      '',
      '0151 12345678', // a national number: which country?
      '+0151123456',
      '+49 151 abc',
      '+1234567', // too short
      '+1234567890123456', // too long
    ]) {
      expect(normalisePhone(bad)).toHaveProperty('error');
    }
  });

  it('masks a number as +49•••••5678 and puts the full one only in the chat link, encoded', () => {
    expect(maskPhone('+4915112345678')).toBe('+49•••••5678');
    expect(maskPhone('+4915112345678')).not.toContain('151');
    expect(chatLink('+4915112345678')).toBe('https://wa.me/4915112345678');
    const text = 'Hi Zoë & co: 50% off?\nSee https://x.test/a?b=1&c=2';
    const url = chatLink('+4915112345678', text);
    expect(url.startsWith('https://wa.me/4915112345678?text=')).toBe(true);
    expect(new URL(url).searchParams.get('text')).toBe(text);
    expect(url).not.toMatch(/[ \n&]/);
  });

  it('reads consent dates strictly: real, not in the future, not before WhatsApp existed', () => {
    expect(parseConsentDate('2026-03-14')).toHaveProperty('date');
    expect(parseConsentDate('2026-03-14T10:00:00Z')).toHaveProperty('date');
    for (const bad of [
      '',
      '14.03.2026',
      '2026-02-31',
      '2999-01-01',
      '2001-01-01',
    ]) {
      expect(parseConsentDate(bad)).toHaveProperty('error');
    }
  });

  it('parses CSV with quotes, semicolons, tabs, a byte-order mark and Windows line endings', () => {
    const quoted = parseCsv(
      '﻿name,phone,notes\r\n"Costa, Ana",+4915112345678,"said ""yes"""\r\n\r\nB,+4915100000002,\r\n'
    );
    expect(quoted.map((r) => r.cells)).toEqual([
      ['name', 'phone', 'notes'],
      ['Costa, Ana', '+4915112345678', 'said "yes"'],
      ['B', '+4915100000002', ''],
    ]);
    expect(quoted.map((r) => r.line)).toEqual([1, 2, 4]);
    expect(parseCsv('name;phone\nA;+4915100000001')[1].cells).toEqual([
      'A',
      '+4915100000001',
    ]);
    expect(parseCsv('name\tphone\nA\t+4915100000001')[1].cells[1]).toBe(
      '+4915100000001'
    );
    expect(() => parseCsv('name,phone\n"A,+49')).toThrow(BadRequestException);
  });

  it('allows only the listed placeholders and fills them in without guessing', () => {
    expect(
      templateProblems('Hi {{name}} at {{company}} from {{agency}}')
    ).toEqual([]);
    expect(templateProblems('Hi {{first_name}}')).toEqual([]);
    expect(templateProblems('Hi {{phone}}')[0]).toMatch(/\{\{phone\}\}/);
    expect(templateProblems('Hi {{name')[0]).toMatch(/not closed/);
    expect(templateProblems('  ')).toEqual(['Write the message.']);

    const done = renderMessage(
      {
        body: 'Hi {{first_name}} ({{Company}}), {{agency}} here.',
        link: 'https://x.test/offer',
        optOutLine: 'Reply STOP to opt out.',
      },
      { name: 'Ana Costa', company: 'Acme' },
      'Bright Ads'
    );
    expect(done.message).toBe(
      'Hi Ana (Acme), Bright Ads here.\n\nhttps://x.test/offer\n\nReply STOP to opt out.'
    );
    expect(done.missing).toEqual([]);
    const gap = renderMessage(
      { body: 'Hi {{company}}', link: null, optOutLine: '' },
      { name: 'Ana', company: null },
      'Bright Ads'
    );
    expect(gap.missing).toEqual(['company']);
    expect(gap.message).toBe('Hi');
  });

  it('cleans a suggestion down to plain text with known placeholders only', () => {
    expect(
      cleanSuggestion('```\n<b>Hi</b> {{Name}} {{phone}}, see you!\n```')
    ).toBe('Hi {{name}} , see you!');
  });

  it('has no way to say a message was delivered or read: not as a status, not as a step', () => {
    const statuses = Object.values(WhatsappTaskStatus);
    expect(statuses.sort()).toEqual(
      ['PENDING', 'REPLIED', 'SENT_BY_USER', 'SKIPPED'].sort()
    );
    expect([...WHATSAPP_TASK_STATUSES].sort()).toEqual(statuses.sort());
    const everything = JSON.stringify([statuses, TASK_TRANSITIONS]);
    expect(everything).not.toMatch(/deliver|read|received|confirmed/i);
    // every status is reachable only from a status a person could have been in
    for (const [from, to] of Object.entries(TASK_TRANSITIONS)) {
      expect(to).not.toContain(from);
    }
  });

  it('the Business API is only a contract: the default never sends and says why', async () => {
    const provider = new DisabledWhatsappBusinessProvider();
    expect(provider.isEnabled()).toBe(false);
    for (const call of [
      () =>
        provider.sendTemplate('o', {
          to: '+4915112345678',
          templateName: 't',
          languageCode: 'en',
          parameters: [],
        } as any),
      () => provider.sendText('o', { to: '+4915112345678', body: 'x' } as any),
      () => provider.listApprovedTemplates('o'),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(
        WhatsappBusinessNotEnabledError
      );
    }
    await expect(provider.sendText()).rejects.toThrow(/not enabled/i);
  });

  it('keys the ledger hash to the install and the agency, and never contains the number', () => {
    process.env.JWT_SECRET ||= 'test-secret-for-whatsapp-hash';
    const service = new AgencyWhatsappService(
      null as any,
      null as any,
      new DisabledWhatsappBusinessProvider()
    );
    const a = service.hashPhone('org-a', '+4915112345678');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(service.hashPhone('org-a', '+4915112345678'));
    expect(a).not.toBe(service.hashPhone('org-b', '+4915112345678'));
    expect(a).not.toBe(service.hashPhone('org-a', '+4915112345679'));
    expect(a).not.toContain('15112345678');
    const saved = process.env.AGENCY_WHATSAPP_HASH_KEY;
    process.env.AGENCY_WHATSAPP_HASH_KEY = 'a-different-key';
    expect(service.hashPhone('org-a', '+4915112345678')).not.toBe(a);
    if (saved === undefined) delete process.env.AGENCY_WHATSAPP_HASH_KEY;
    else process.env.AGENCY_WHATSAPP_HASH_KEY = saved;
  });

  it('permission matrix: clients get nothing, analysts only read, erasing and settings are narrower than working', () => {
    const roles = (p: keyof typeof AGENCY_PERMISSIONS) => AGENCY_PERMISSIONS[p];
    for (const p of [
      'whatsapp:read',
      'whatsapp:write',
      'whatsapp:delete',
      'whatsapp:manage',
    ] as const) {
      expect(roles(p)).not.toContain(AgencyRole.CLIENT);
      expect(roles(p)).toContain(AgencyRole.AGENCY_OWNER);
    }
    expect(roles('whatsapp:read')).toContain(AgencyRole.ANALYST);
    for (const p of [
      'whatsapp:write',
      'whatsapp:delete',
      'whatsapp:manage',
    ] as const) {
      expect(roles(p)).not.toContain(AgencyRole.ANALYST);
    }
    expect(roles('whatsapp:write')).toEqual(
      expect.arrayContaining([
        AgencyRole.SALES_EXECUTIVE,
        AgencyRole.SALES_MANAGER,
        AgencyRole.CAMPAIGN_MANAGER,
        AgencyRole.CONTENT_EDITOR,
      ])
    );
    expect(roles('whatsapp:delete')).not.toContain(AgencyRole.SALES_EXECUTIVE);
    expect(roles('whatsapp:manage')).toEqual([
      AgencyRole.AGENCY_OWNER,
      AgencyRole.AGENCY_ADMIN,
    ]);
  });

  it('validates input: consent is not optional, the attestation must be true, strangers’ fields are dropped, a file stays inside the body limit', async () => {
    const person = {
      name: 'Ana',
      phone: '+4915112345678',
      consentSource: 'Web form',
      consentedAt: '2026-03-14',
    };
    await expect(pipe(person, CreateWhatsappContactDto)).resolves.toBeDefined();
    for (const missing of ['name', 'phone', 'consentSource', 'consentedAt']) {
      await expect(
        pipe({ ...person, [missing]: undefined }, CreateWhatsappContactDto)
      ).rejects.toBeDefined();
    }
    const clean = await pipe(
      { ...person, orgId: 'someone-else', consentStatus: 'OPTED_OUT' },
      CreateWhatsappContactDto
    );
    expect(clean).not.toHaveProperty('orgId');
    expect(clean).not.toHaveProperty('consentStatus');

    await expect(
      pipe({ csv: 'a,b\n1,2', attested: false }, CommitWhatsappImportDto)
    ).rejects.toBeDefined();
    await expect(
      pipe({ csv: 'a,b\n1,2' }, CommitWhatsappImportDto)
    ).rejects.toBeDefined();
    await expect(
      pipe({ csv: 'a,b\n1,2', attested: true }, CommitWhatsappImportDto)
    ).resolves.toBeDefined();
    await expect(
      pipe(
        { csv: 'x'.repeat(WHATSAPP_LIMITS.maxImportChars + 1) },
        PreviewWhatsappImportDto
      )
    ).rejects.toBeDefined();
    await expect(
      pipe({ status: 'DELIVERED' }, SetWhatsappTaskStatusDto)
    ).rejects.toBeDefined();
    await expect(
      pipe({ status: 'SENT_BY_USER' }, SetWhatsappTaskStatusDto)
    ).resolves.toBeDefined();
  });
});

describeDb('WhatsApp workspace (real database)', () => {
  let h: Harness;
  let t: Tenant;
  let other: Tenant;
  let seq = 0;

  beforeAll(async () => {
    h = await buildHarness();
  });
  afterAll(async () => {
    await h.prisma.$disconnect();
  });
  beforeEach(async () => {
    t = await seedTenant(h, 'whatsapp');
    other = await seedTenant(h, 'whatsapp-other');
    jest.restoreAllMocks();
  });

  /** A distinct, valid number per call. */
  const phone = () => `+4915100${String(++seq).padStart(6, '0')}`;
  const person = (over: Record<string, any> = {}) => ({
    name: 'Ana Costa',
    phone: phone(),
    consentSource: 'Web form',
    consentEvidence: 'Ticked the box on the spring-offer page',
    consentedAt: '2026-03-14',
    ...over,
  });
  const add = (actor = t.sales, over: Record<string, any> = {}) =>
    h.whatsapp.create(actor, person(over));
  const template = (
    actor = t.sales,
    over: Record<string, any> = {}
  ): Promise<any> =>
    h.whatsappOutreach.createTemplate(actor, {
      name: `Spring ${++seq}`,
      body: 'Hi {{first_name}}, a spring offer from {{agency}}.',
      ...over,
    });
  const segment = (actor = t.sales, over: Record<string, any> = {}) =>
    h.whatsappOutreach.createSegment(actor, { name: `Seg ${++seq}`, ...over });
  const csv = (
    rows: string[][],
    head = 'name,phone,consent_source,consent_date'
  ) => [head, ...rows.map((r) => r.join(','))].join('\n');
  const digitsOf = (e164: string) => e164.replace(/\D/g, '');
  const auditText = async (orgId: string) =>
    JSON.stringify(await h.prisma.auditEvent.findMany({ where: { orgId } }));

  // ------------------------------------------------------------------------------ consent
  it('will not add anyone without how and when they agreed', async () => {
    for (const missing of ['consentSource', 'consentedAt']) {
      await expect(
        h.whatsapp.create(t.sales, person({ [missing]: '' }))
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(
      h.whatsapp.create(t.sales, person({ consentedAt: '2999-01-01' }))
    ).rejects.toThrow(/future/);
    await expect(
      h.whatsapp.create(t.sales, person({ phone: '0151 1234567' }))
    ).rejects.toThrow(/country code/);
    expect(
      await h.prisma.whatsappContact.count({ where: { orgId: t.orgId } })
    ).toBe(0);

    const ana = await add(t.sales, { consentSource: ' In person ' });
    expect(ana).toMatchObject({
      name: 'Ana Costa',
      consentStatus: 'OPTED_IN',
      consentSource: 'In person',
      consentEvidence: 'Ticked the box on the spring-offer page',
    });
    expect(ana.consentedAt).toEqual(new Date('2026-03-14T00:00:00.000Z'));
    const stored = await h.prisma.whatsappContact.findUniqueOrThrow({
      where: { id: ana.id },
    });
    expect(stored.consentRecordedById).toBe(t.userIds.sales);
    expect(
      await h.prisma.auditEvent.count({
        where: {
          entityId: ana.id,
          action: 'whatsapp_contact.consent_recorded',
        },
      })
    ).toBe(1);
  });

  it('normalises the number, refuses a second contact with it, and lets another agency have the same number', async () => {
    const first = await add(t.sales, { phone: '+49 (0) 151 1234 5678' });
    expect(first.phone).toBe('+4915112345678');
    await expect(
      add(t.manager, { phone: '0049 151-1234-5678' })
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      add(t.manager, { phone: '+4915112345678', name: 'Someone else' })
    ).rejects.toThrow(/already exists/);
    expect(
      await h.prisma.whatsappContact.count({ where: { orgId: t.orgId } })
    ).toBe(1);
    await expect(
      add(other.sales, { phone: '+4915112345678' })
    ).resolves.toBeDefined();
  });

  it('shows numbers masked in lists and logs, whole only to staff who work the contacts, and never in the audit trail', async () => {
    const full = '+4915112345678';
    const ana = await add(t.sales, { phone: full });
    const list = await h.whatsapp.list(t.sales);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: ana.id, maskedPhone: '+49•••••5678' });
    expect(JSON.stringify(list)).not.toContain(digitsOf(full));
    expect(list[0]).not.toHaveProperty('phone');

    expect((await h.whatsapp.get(t.sales, ana.id)).phone).toBe(full);
    // an analyst can read but is not given the number
    const seen = await h.whatsapp.get(t.analyst, ana.id);
    expect(seen.phone).toBeNull();
    expect(seen.maskedPhone).toBe('+49•••••5678');
    expect(JSON.stringify(seen)).not.toContain(digitsOf(full));

    await h.whatsapp.update(t.sales, ana.id, { notes: 'likes mornings' });
    await h.whatsapp.withdraw(t.sales, ana.id, { method: 'EMAIL' });
    await h.whatsapp.erase(t.owner, ana.id);
    const trail = await auditText(t.orgId);
    expect(trail).not.toContain(digitsOf(full).slice(-7));
    expect(trail).not.toContain('Ana Costa');
  });

  it('edits a person’s details but never their number or their consent', async () => {
    const ana = await add(t.sales);
    const changed = await h.whatsapp.update(t.sales, ana.id, {
      name: ' Ana C. ',
      company: 'Acme',
      language: 'PT-br',
      tags: ['VIP', 'vip', ' Berlin '],
      notes: ' call after 5 ',
    });
    expect(changed).toMatchObject({
      name: 'Ana C.',
      company: 'Acme',
      language: 'pt-br',
      tags: ['vip', 'berlin'],
      notes: 'call after 5',
      consentSource: 'Web form',
    });
    await expect(
      h.whatsapp.update(t.sales, ana.id, { language: 'not a language' })
    ).rejects.toBeInstanceOf(BadRequestException);
    const smuggled = await pipe(
      {
        phone: '+4900000000000',
        consentStatus: 'OPTED_IN',
        consentSource: 'x',
      },
      UpdateWhatsappContactDto
    );
    expect(smuggled).toEqual({});
  });

  // ---------------------------------------------------------------------------- withdrawal
  it('records a withdrawal in the ledger, keeps that person out of every segment, task and link, and closes what was waiting', async () => {
    const ana = await add(t.sales, { tags: ['berlin'] });
    const ben = await add(t.sales, { name: 'Ben Ode', tags: ['berlin'] });
    const seg = await segment(t.sales, { tags: ['berlin'] });
    const tpl = await template();
    expect(seg.memberCount).toBe(2);
    const drafted = await h.whatsappOutreach.draft(t.sales, {
      templateId: tpl.id,
      segmentId: seg.id,
    });
    expect(drafted.created).toBe(2);
    const [anaTask] = await h.whatsappOutreach.listTasks(t.sales, {
      contactId: ana.id,
    });
    await h.whatsappOutreach.updateTask(t.sales, anaTask.id, {
      followUpAt: new Date(Date.now() - 1000).toISOString(),
    });

    const out = await h.whatsapp.withdraw(t.sales, ana.id, {
      method: 'REPLIED_STOP',
      reason: 'wrote STOP',
    });
    expect(out).toMatchObject({
      consentStatus: 'OPTED_OUT',
      optOutMethod: 'REPLIED_STOP',
      optOutReason: 'wrote STOP',
    });
    expect(out.optedOutAt).toBeInstanceOf(Date);
    await expect(
      h.whatsapp.withdraw(t.sales, ana.id, { method: 'EMAIL' })
    ).rejects.toBeInstanceOf(ConflictException);

    // segments count them out, live
    expect(
      (await h.whatsappOutreach.listSegments(t.sales))[0].memberCount
    ).toBe(1);
    // the task they had is closed, its reminder gone, and there is no chat link
    const closed = await h.prisma.whatsappTask.findUniqueOrThrow({
      where: { id: anaTask.id },
    });
    expect(closed).toMatchObject({
      status: 'SKIPPED',
      skipReason: 'The contact withdrew consent',
      followUpAt: null,
    });
    await expect(
      h.whatsappOutreach.openChat(t.sales, anaTask.id)
    ).rejects.toThrow(/withdrew consent/);
    await expect(
      h.whatsappOutreach.setStatus(t.sales, anaTask.id, { status: 'PENDING' })
    ).rejects.toThrow(/withdrew consent/);
    expect(await h.whatsappOutreach.listDue(t.sales)).toEqual([]);
    // no new task for them, by segment or by name
    await expect(
      h.whatsappOutreach.draft(t.sales, {
        templateId: tpl.id,
        contactId: ana.id,
      })
    ).rejects.toThrow(/withdrew consent/);
    const again = await h.whatsappOutreach.draft(t.sales, {
      templateId: tpl.id,
      segmentId: seg.id,
    });
    expect(again).toMatchObject({ created: 0, skipped: { alreadyWaiting: 1 } });
    await expect(
      h.whatsappOutreach.previewTemplate(t.sales, {
        body: 'Hi {{name}}',
        contactId: ana.id,
      })
    ).rejects.toThrow(/withdrew consent/);
    // Ben is untouched
    expect(
      (await h.whatsappOutreach.listTasks(t.sales, { contactId: ben.id }))[0]
        .status
    ).toBe('PENDING');

    const ledger = await h.whatsapp.listUnsubscribes(t.sales);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      method: 'REPLIED_STOP',
      recordedBy: expect.any(String),
      contact: { id: ana.id, maskedPhone: expect.stringContaining('•') },
    });
    expect(
      await h.prisma.auditEvent.count({
        where: {
          entityId: ana.id,
          action: 'whatsapp_contact.consent_withdrawn',
        },
      })
    ).toBe(1);
  });

  it('refuses to bring a withdrawn person back by form or by import, even after their details were erased', async () => {
    const full = '+4915112345678';
    const ana = await add(t.sales, { phone: full });
    await h.whatsapp.withdraw(t.sales, ana.id, {
      method: 'PHONE_CALL',
      receivedAt: '2026-04-01',
    });
    await expect(add(t.sales, { phone: '+49 151 12345678' })).rejects.toThrow(
      /withdrew consent on 2026-04-01/
    );

    const file = csv([['Ana Costa', full, 'Web form', '2026-05-01']]);
    let preview = await h.whatsapp.previewImport(t.sales, file);
    expect(preview.rows[0].status).toBe('WITHDRAWN');

    // erasing the person deletes their details and leaves only the hash
    await h.whatsapp.erase(t.owner, ana.id);
    expect(
      await h.prisma.whatsappContact.count({ where: { orgId: t.orgId } })
    ).toBe(0);
    const ledgerRows = await h.prisma.whatsappUnsubscribe.findMany({
      where: { orgId: t.orgId },
    });
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0].phoneHash).toBe(h.whatsapp.hashPhone(t.orgId, full));
    expect(JSON.stringify(ledgerRows)).not.toContain(digitsOf(full).slice(-7));
    expect(Object.keys(ledgerRows[0]).sort()).toEqual(
      [
        'createdAt',
        'id',
        'method',
        'orgId',
        'phoneHash',
        'receivedAt',
        'recordedById',
      ].sort()
    );
    expect(await h.whatsapp.listUnsubscribes(t.sales)).toEqual([
      expect.objectContaining({ contact: null, method: 'PHONE_CALL' }),
    ]);

    await expect(add(t.sales, { phone: full })).rejects.toBeInstanceOf(
      ConflictException
    );
    preview = await h.whatsapp.previewImport(t.sales, file);
    expect(preview.rows[0].status).toBe('WITHDRAWN');
    await expect(
      h.whatsapp.commitImport(t.sales, { csv: file, attested: true })
    ).rejects.toThrow(/Nothing in this file/);
    expect(
      await h.prisma.whatsappContact.count({ where: { orgId: t.orgId } })
    ).toBe(0);

    // the ledger is the agency's own: another agency may still ask this person
    await expect(add(other.sales, { phone: full })).resolves.toBeDefined();
  });

  it('keeps the ledger append-only: nothing can change or remove a row, and the only writer is a withdrawal', () => {
    const names = (proto: object) => Object.getOwnPropertyNames(proto);
    const surface = [
      ...names(AgencyWhatsappService.prototype),
      ...names(Object.getPrototypeOf(h.whatsappOutreach)),
      ...names(AgencyWhatsappRepository.prototype),
    ];
    // the ledger is reachable through a read, and through withdrawing a contact, and nothing else
    expect(surface.filter((n) => /unsubscribe|ledger/i.test(n)).sort()).toEqual(
      ['listUnsubscribes', 'listUnsubscribes']
    );
    expect(names(AgencyWhatsappRepository.prototype)).toContain(
      'withdrawContact'
    );
  });

  it('erase deletes the person, their tasks and nothing else, and needs the right to delete', async () => {
    const ana = await add(t.sales);
    const ben = await add(t.sales, { name: 'Ben' });
    const tpl = await template();
    await h.whatsappOutreach.draft(t.sales, {
      templateId: tpl.id,
      contactId: ana.id,
    });
    await h.whatsappOutreach.draft(t.sales, {
      templateId: tpl.id,
      contactId: ben.id,
    });
    await expect(h.whatsapp.erase(t.sales, ana.id)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    await expect(h.whatsapp.erase(t.analyst, ana.id)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    await expect(h.whatsapp.erase(t.salesManager, ana.id)).resolves.toEqual({
      deleted: true,
    });
    expect(
      await h.prisma.whatsappTask.count({ where: { contactId: ana.id } })
    ).toBe(0);
    expect(
      await h.prisma.whatsappTask.count({ where: { contactId: ben.id } })
    ).toBe(1);
    await expect(h.whatsapp.get(t.sales, ana.id)).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(
      await h.prisma.auditEvent.count({
        where: { entityId: ana.id, action: 'whatsapp_contact.erased' },
      })
    ).toBe(1);
    // someone who never withdrew leaves no ledger row: erasing is not a refusal
    expect(
      await h.prisma.whatsappUnsubscribe.count({ where: { orgId: t.orgId } })
    ).toBe(0);
  });

  // ------------------------------------------------------------------------------- imports
  it('checks a file row by row without storing anything, then imports only rows that carry their consent', async () => {
    await add(t.sales, { phone: '+4915100999001' });
    const file = csv([
      ['Ana Costa', '+49 151 00999 100', 'Web form', '2026-03-14'], // good
      ['Ben Ode', '+4915100999002', 'In person', '2026-03-15'], // good
      ['Cleo', '+4915100999002', 'In person', '2026-03-15'], // repeated in the file
      ['Dan', '+4915100999001', 'Web form', '2026-03-14'], // already a contact
      ['Eve', '+4915100999003', '', '2026-03-14'], // no source
      ['Fay', '+4915100999004', 'Web form', ''], // no date
      ['Gus', '0151 999', 'Web form', '2026-03-14'], // not a number
      ['Hal', '+4915100999005', 'Web form', '2999-01-01'], // date in the future
      ['', '+4915100999006', 'Web form', '2026-03-14'], // no name
    ]);
    const before = await h.prisma.whatsappContact.count({
      where: { orgId: t.orgId },
    });
    const preview = await h.whatsapp.previewImport(t.sales, file);
    expect(
      await h.prisma.whatsappContact.count({ where: { orgId: t.orgId } })
    ).toBe(before);
    expect(
      await h.prisma.whatsappImport.count({ where: { orgId: t.orgId } })
    ).toBe(0);
    expect(preview.counts).toEqual({
      total: 9,
      valid: 2,
      duplicate: 2,
      invalid: 3,
      missingConsent: 2,
      withdrawn: 0,
    });
    expect(preview.rows.map((r) => [r.line, r.status])).toEqual([
      [2, 'VALID'],
      [3, 'VALID'],
      [4, 'DUPLICATE'],
      [5, 'DUPLICATE'],
      [6, 'MISSING_CONSENT'],
      [7, 'MISSING_CONSENT'],
      [8, 'INVALID'],
      [9, 'INVALID'],
      [10, 'INVALID'],
    ]);
    expect(preview.rows[3].reasons[0]).toMatch(/already one of your contacts/);
    expect(preview.rows[2].reasons[0]).toMatch(/line 3/);
    expect(preview.canImport).toBe(true);
    // the check shows masked numbers only, and not a number it could not read
    expect(JSON.stringify(preview)).not.toContain('15100999100');
    expect(preview.rows[6].phone).toBeNull();

    const done = await h.whatsapp.commitImport(t.sales, {
      csv: file,
      attested: true,
      fileName: 'spring.csv',
    });
    expect(done).toMatchObject({
      fileName: 'spring.csv',
      totalRows: 9,
      importedRows: 2,
      duplicateRows: 2,
      invalidRows: 3,
      missingConsentRows: 2,
      withdrawnRows: 0,
      attestation: WHATSAPP_IMPORT_ATTESTATION,
    });
    const contacts = await h.prisma.whatsappContact.findMany({
      where: { orgId: t.orgId, importId: done.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(contacts.map((c) => c.name).sort()).toEqual([
      'Ana Costa',
      'Ben Ode',
    ]);
    for (const c of contacts) {
      expect(c).toMatchObject({
        consentStatus: 'OPTED_IN',
        consentRecordedById: t.userIds.sales,
      });
      expect(c.consentSource).toBeTruthy();
      expect(c.consentedAt).toBeInstanceOf(Date);
      expect(c.phone).toMatch(/^\+\d{8,15}$/);
    }
    const batch = await h.prisma.whatsappImport.findUniqueOrThrow({
      where: { id: done.id },
    });
    expect(batch.attestedById).toBe(t.userIds.sales);
    expect(batch.attestation).toBe(WHATSAPP_IMPORT_ATTESTATION);
    expect((await h.whatsapp.listImports(t.owner))[0]).toMatchObject({
      id: done.id,
      attestedBy: expect.any(String),
    });
    const event = await h.prisma.auditEvent.findFirstOrThrow({
      where: { entityId: done.id, action: 'whatsapp_import.committed' },
    });
    expect(event.metadata).toMatchObject({
      total: 9,
      imported: 2,
      missingConsent: 2,
    });
    expect(await auditText(t.orgId)).not.toContain('15100999');

    // running the same file again adds nobody
    expect((await h.whatsapp.previewImport(t.sales, file)).counts.valid).toBe(
      0
    );
  });

  it('will not import without the operator’s attestation, without consent columns, or past the limits', async () => {
    const file = csv([['Ana', '+4915100888001', 'Web form', '2026-03-14']]);
    await expect(
      h.whatsapp.commitImport(t.sales, { csv: file, attested: false } as any)
    ).rejects.toThrow(/Confirm that the people/);

    const noConsent = csv([['Ana', '+4915100888001']], 'name,phone');
    const preview = await h.whatsapp.previewImport(t.sales, noConsent);
    expect(preview.canImport).toBe(false);
    expect(preview.columnProblems.join(' ')).toMatch(/consent_source/);
    expect(preview.columnProblems.join(' ')).toMatch(/consent_date/);
    expect(preview.counts.missingConsent).toBe(1);
    await expect(
      h.whatsapp.commitImport(t.sales, { csv: noConsent, attested: true })
    ).rejects.toThrow(/Nothing in this file/);

    await expect(
      h.whatsapp.previewImport(
        t.sales,
        'name,phone,consent_source,consent_date'
      )
    ).rejects.toThrow(/header row and at least one person/);

    const many = csv(
      Array.from({ length: WHATSAPP_LIMITS.maxImportRows + 1 }, (_, i) => [
        `P${i}`,
        `+4915300${String(i).padStart(6, '0')}`,
        'Web form',
        '2026-03-14',
      ])
    );
    await expect(h.whatsapp.previewImport(t.sales, many)).rejects.toThrow(
      /at most 2000/
    );
    // exactly the limit is fine
    const exactly = csv(
      Array.from({ length: WHATSAPP_LIMITS.maxImportRows }, (_, i) => [
        `P${i}`,
        `+4915300${String(i).padStart(6, '0')}`,
        'Web form',
        '2026-03-14',
      ])
    );
    const result = await h.whatsapp.commitImport(t.sales, {
      csv: exactly,
      attested: true,
    });
    expect(result.importedRows).toBe(WHATSAPP_LIMITS.maxImportRows);
  });

  it('reads a spreadsheet export: semicolons, quotes, other column names, tags and a language', async () => {
    const file = [
      'Full Name;Mobile;Lang;Labels;Company;Source;Consent date;Evidence',
      '"Costa, Ana";+49 151 00777 001;DE;vip|berlin;Acme;Customer list with consent;2026-03-14;List v3, row 12',
    ].join('\r\n');
    const preview = await h.whatsapp.previewImport(t.sales, file);
    expect(preview.counts.valid).toBe(1);
    await h.whatsapp.commitImport(t.sales, { csv: file, attested: true });
    const [saved] = await h.prisma.whatsappContact.findMany({
      where: { orgId: t.orgId },
    });
    expect(saved).toMatchObject({
      name: 'Costa, Ana',
      phone: '+4915100777001',
      language: 'de',
      tags: ['vip', 'berlin'],
      company: 'Acme',
      consentSource: 'Customer list with consent',
      consentEvidence: 'List v3, row 12',
    });
  });

  it('counts a number that arrived while the import ran as a duplicate instead of failing', async () => {
    const file = csv([
      ['Ana', '+4915100666001', 'Web form', '2026-03-14'],
      ['Ben', '+4915100666002', 'Web form', '2026-03-14'],
    ]);
    const original = h.whatsapp['repo'].findExistingPhones.bind(
      h.whatsapp['repo']
    );
    jest
      .spyOn(h.whatsapp['repo'], 'findExistingPhones')
      .mockImplementation(async (orgId, phones) => {
        const found = await original(orgId, phones);
        // somebody adds Ben between the check and the save
        await h.prisma.whatsappContact.create({
          data: {
            orgId,
            name: 'Ben (typed in)',
            phone: '+4915100666002',
            phoneHash: h.whatsapp.hashPhone(orgId, '+4915100666002'),
            consentSource: 'In person',
            consentedAt: new Date('2026-03-01'),
            consentRecordedById: t.userIds.sales,
            createdById: t.userIds.sales,
          },
        });
        return found;
      });
    const done = await h.whatsapp.commitImport(t.sales, {
      csv: file,
      attested: true,
    });
    expect(done).toMatchObject({ importedRows: 1, duplicateRows: 1 });
  });

  // ------------------------------------------------------------------------------ segments
  it('keeps segments as saved filters whose members are counted live and are never opted out', async () => {
    const a = await add(t.sales, { tags: ['vip', 'berlin'], language: 'de' });
    await add(t.sales, {
      tags: ['vip'],
      language: 'en',
      consentSource: 'In person',
    });
    await add(t.sales, { tags: ['berlin'], language: 'de' });
    await add(t.sales, { tags: [] });

    const vip = await segment(t.sales, { name: 'VIPs', tags: ['VIP'] });
    const german = await segment(t.sales, {
      name: 'German',
      languages: ['DE'],
    });
    const both = await segment(t.sales, {
      name: 'German VIPs',
      tags: ['vip'],
      languages: ['de'],
    });
    const web = await segment(t.sales, {
      name: 'Web',
      consentSources: ['Web form'],
    });
    const everyone = await segment(t.sales, { name: 'Everyone' });
    expect(
      [vip, german, both, web, everyone].map((s) => s.memberCount)
    ).toEqual([2, 2, 1, 3, 4]);
    expect(
      (await h.whatsappOutreach.previewSegment(t.sales, { tags: ['berlin'] }))
        .memberCount
    ).toBe(2);

    await h.whatsapp.withdraw(t.sales, a.id, { method: 'EMAIL' });
    const counts = Object.fromEntries(
      (await h.whatsappOutreach.listSegments(t.sales)).map((s) => [
        s.name,
        s.memberCount,
      ])
    );
    expect(counts).toEqual({
      VIPs: 1,
      German: 1,
      'German VIPs': 0,
      Web: 2,
      Everyone: 3,
    });
    // the same filter, asked for again, still leaves them out
    expect(
      (
        await h.whatsappOutreach.previewSegment(t.sales, {
          tags: ['berlin', 'vip'],
        })
      ).memberCount
    ).toBe(2);
    expect(await h.whatsapp.facets(t.sales)).toEqual({
      tags: ['berlin', 'vip'],
      languages: ['de', 'en'],
      consentSources: ['In person', 'Web form'],
    });

    await expect(
      h.whatsappOutreach.createSegment(t.sales, { name: 'VIPs' })
    ).rejects.toBeInstanceOf(ConflictException);
    const renamed = await h.whatsappOutreach.updateSegment(t.sales, vip.id, {
      name: 'Gold',
      tags: ['berlin'],
    });
    expect(renamed).toMatchObject({ name: 'Gold', memberCount: 1 });
    await expect(
      h.whatsappOutreach.deleteSegment(t.sales, vip.id)
    ).resolves.toEqual({
      deleted: true,
    });
  });

  // ------------------------------------------------------------------------------ templates
  it('checks the wording, adds the opt-out line to every message, and warns when it is removed', async () => {
    await expect(
      h.whatsappOutreach.createTemplate(t.sales, {
        name: 'Bad',
        body: 'Hi {{phone}}',
      })
    ).rejects.toThrow(/\{\{phone\}\}/);
    await expect(
      h.whatsappOutreach.createTemplate(t.sales, {
        name: 'Bad',
        body: 'Hi {{name',
      })
    ).rejects.toThrow(/not closed/);

    const plain = await template(t.sales, {
      name: 'Plain',
      body: 'Hello {{name}} from {{agency}}',
      link: 'https://example.com/offer',
    });
    expect(plain).toMatchObject({
      optOutLine: 'Reply STOP to opt out.',
      optOutMissing: false,
    });
    const mine = await h.whatsappOutreach.updateTemplate(t.sales, plain.id, {
      name: 'Plain',
      body: 'Hello {{name}}',
      optOutLine: 'Send NO to stop.',
    });
    expect(mine.optOutLine).toBe('Send NO to stop.');
    expect(mine.link).toBeNull();

    const ana = await add(t.sales, { name: 'Ana Costa', company: 'Acme' });
    const withLine = await h.whatsappOutreach.previewTemplate(t.sales, {
      body: 'Hi {{first_name}} at {{company}}',
      link: 'https://example.com/x',
      contactId: ana.id,
    });
    expect(withLine).toMatchObject({
      message:
        'Hi Ana at Acme\n\nhttps://example.com/x\n\nReply STOP to opt out.',
      problems: [],
      warnings: [],
      usedSample: false,
    });
    const sample = await h.whatsappOutreach.previewTemplate(t.sales, {
      body: 'Hi {{name}}',
    });
    expect(sample).toMatchObject({ usedSample: true });
    expect(sample.message).toContain('Alex Example');
    expect(sample.message.endsWith('Reply STOP to opt out.')).toBe(true);

    const removed = await h.whatsappOutreach.previewTemplate(t.sales, {
      body: 'Hi {{name}}',
      optOutLine: '',
    });
    expect(removed.message).toBe('Hi Alex Example');
    expect(removed.warnings[0]).toMatch(/no way to opt out/);
    const stripped = await template(t.sales, { optOutLine: '' });
    expect(stripped.optOutMissing).toBe(true);

    const broken = await h.whatsappOutreach.previewTemplate(t.sales, {
      body: 'Hi {{nope}}',
    });
    expect(broken.problems[0]).toMatch(/\{\{nope\}\}/);
    expect(broken.message).toBe('');

    await expect(
      h.whatsappOutreach.createTemplate(t.sales, { name: 'Plain', body: 'x' })
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('uses the agency’s default opt-out line, which only an admin can change', async () => {
    await expect(
      h.whatsapp.updateSettings(t.sales, { defaultOptOutLine: 'Text END' })
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      h.whatsapp.updateSettings(t.owner, { defaultOptOutLine: '  ' })
    ).rejects.toBeInstanceOf(BadRequestException);
    const saved = await h.whatsapp.updateSettings(t.owner, {
      defaultOptOutLine: 'Text END to stop.',
    });
    expect(saved.defaultOptOutLine).toBe('Text END to stop.');
    expect((await template()).optOutLine).toBe('Text END to stop.');
    expect(
      (await h.whatsappOutreach.previewTemplate(t.sales, { body: 'Hi' }))
        .message
    ).toBe('Hi\n\nText END to stop.');
    expect((await h.whatsapp.getSettings(other.owner)).defaultOptOutLine).toBe(
      'Reply STOP to opt out.'
    );
  });

  it('keeps the Business API a stub that cannot be switched on', async () => {
    const settings = await h.whatsapp.getSettings(t.sales);
    expect(settings.businessApi).toEqual({
      enabled: false,
      available: false,
      message: 'Not available in this version',
    });
    expect(settings.placeholders).toEqual([
      'name',
      'first_name',
      'company',
      'agency',
    ]);
    await expect(
      h.whatsapp.updateSettings(t.owner, { businessApiEnabled: true })
    ).rejects.toThrow(/not available in this version/i);
    const stored = await h.prisma.whatsappSettings.findUnique({
      where: { orgId: t.orgId },
    });
    expect(stored?.businessApiEnabled ?? false).toBe(false);
    expect(Object.keys(settings)).not.toEqual(
      expect.arrayContaining([
        'token',
        'accessToken',
        'apiKey',
        'phoneNumberId',
      ])
    );
  });

  // ---------------------------------------------------------------------------------- tasks
  it('prepares one task per person who is opted in, skipping repeats and anyone the wording cannot be filled in for', async () => {
    const ana = await add(t.sales, { company: 'Acme', tags: ['spring'] });
    const ben = await add(t.sales, { name: 'Ben Ode', tags: ['spring'] }); // no company
    const seg = await segment(t.sales, { tags: ['spring'] });
    const withCompany = await template(t.sales, {
      body: 'Hi {{name}} at {{company}}',
    });

    const first = await h.whatsappOutreach.draft(t.sales, {
      templateId: withCompany.id,
      segmentId: seg.id,
    });
    expect(first).toMatchObject({
      created: 1,
      skipped: { alreadyWaiting: 0, missingDetails: 1 },
    });
    const tasks = await h.whatsappOutreach.listTasks(t.sales, {
      status: 'PENDING',
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      status: 'PENDING',
      contact: { id: ana.id, maskedPhone: expect.stringContaining('•') },
      message: 'Hi Ana Costa at Acme\n\nReply STOP to opt out.',
      template: { id: withCompany.id },
    });
    expect(JSON.stringify(tasks)).not.toMatch(/\+49151/);

    expect(
      await h.whatsappOutreach.draft(t.sales, {
        templateId: withCompany.id,
        segmentId: seg.id,
      })
    ).toMatchObject({
      created: 0,
      skipped: { alreadyWaiting: 1, missingDetails: 1 },
    });
    expect(
      await h.prisma.whatsappTask.count({ where: { orgId: t.orgId } })
    ).toBe(1);

    const greeting = await template(t.sales, { body: 'Hello {{first_name}}' });
    const single = await h.whatsappOutreach.draft(t.sales, {
      templateId: greeting.id,
      contactId: ben.id,
    });
    expect(single.created).toBe(1);

    await expect(
      h.whatsappOutreach.draft(t.sales, { templateId: greeting.id })
    ).rejects.toThrow(/segment, or one contact/);
    await expect(
      h.whatsappOutreach.draft(t.sales, {
        templateId: greeting.id,
        segmentId: seg.id,
        contactId: ana.id,
      })
    ).rejects.toThrow(/segment, or one contact/);
    const empty = await segment(t.sales, { tags: ['nobody'] });
    await expect(
      h.whatsappOutreach.draft(t.sales, {
        templateId: greeting.id,
        segmentId: empty.id,
      })
    ).rejects.toThrow(/Nobody in this segment/);
    expect(
      await h.prisma.auditEvent.count({
        where: { orgId: t.orgId, action: 'whatsapp_tasks.drafted' },
      })
    ).toBe(3);
  });

  it('refuses to prepare more tasks than a person can work through by hand', async () => {
    const limit = WHATSAPP_LIMITS.maxTasksPerDraft;
    await h.prisma.whatsappContact.createMany({
      data: Array.from({ length: limit + 1 }, (_, i) => {
        const p = `+4915400${String(i).padStart(6, '0')}`;
        return {
          orgId: t.orgId,
          name: `P${i}`,
          phone: p,
          phoneHash: h.whatsapp.hashPhone(t.orgId, p),
          tags: ['big'],
          consentSource: 'Web form',
          consentedAt: new Date('2026-03-14'),
          consentRecordedById: t.userIds.sales,
          createdById: t.userIds.sales,
        };
      }),
    });
    const seg = await segment(t.sales, { tags: ['big'] });
    expect(seg.memberCount).toBe(limit + 1);
    await expect(
      h.whatsappOutreach.draft(t.sales, {
        templateId: (await template()).id,
        segmentId: seg.id,
      })
    ).rejects.toThrow(/Narrow the segment/);
    expect(
      await h.prisma.whatsappTask.count({ where: { orgId: t.orgId } })
    ).toBe(0);
  });

  it('moves a task only when a person says so, in steps that never claim delivery', async () => {
    const ana = await add(t.sales);
    const tpl = await template();
    await h.whatsappOutreach.draft(t.sales, {
      templateId: tpl.id,
      contactId: ana.id,
    });
    const [task] = await h.whatsappOutreach.listTasks(t.sales);
    expect(task.status).toBe('PENDING');
    const setTo = (status: any, extra: object = {}) =>
      h.whatsappOutreach.setStatus(t.sales, task.id, { status, ...extra });

    // an unknown or invented status cannot even reach the service
    await expect(
      pipe({ status: 'DELIVERED' }, SetWhatsappTaskStatusDto)
    ).rejects.toBeDefined();
    await expect(
      pipe({ status: 'READ' }, SetWhatsappTaskStatusDto)
    ).rejects.toBeDefined();
    // a pending task cannot be "replied" to: nothing was sent
    await expect(setTo('REPLIED')).rejects.toThrow(/waiting.*replied/);

    const sent = await setTo('SENT_BY_USER');
    expect(sent.status).toBe('SENT_BY_USER');
    expect(sent.sentAt).toBeInstanceOf(Date);
    expect((await setTo('SENT_BY_USER')).status).toBe('SENT_BY_USER'); // repeating is harmless
    const replied = await setTo('REPLIED');
    expect(replied.repliedAt).toBeInstanceOf(Date);
    await expect(setTo('SKIPPED')).rejects.toBeInstanceOf(BadRequestException);
    expect((await setTo('SENT_BY_USER')).repliedAt).toBeNull(); // undo
    expect((await setTo('PENDING')).sentAt).toBeNull(); // undo
    const skipped = await setTo('SKIPPED', { skipReason: ' wrong number ' });
    expect(skipped).toMatchObject({
      status: 'SKIPPED',
      skipReason: 'wrong number',
    });
    expect((await setTo('PENDING')).skipReason).toBeNull();

    // someone else moved it first: the stale change is refused, not applied over theirs
    const real = h.whatsappOutreach['repo'].transitionTask.bind(
      h.whatsappOutreach['repo']
    );
    jest
      .spyOn(h.whatsappOutreach['repo'], 'transitionTask')
      .mockImplementation(async (orgId, id, from, data) => {
        await h.prisma.whatsappTask.update({
          where: { id },
          data: { status: 'SKIPPED' },
        });
        return real(orgId, id, from, data);
      });
    await expect(setTo('SENT_BY_USER')).rejects.toBeInstanceOf(
      ConflictException
    );
    jest.restoreAllMocks();

    const trail = await h.prisma.auditEvent.findMany({
      where: { entityId: task.id, action: 'whatsapp_task.status_changed' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(trail.map((e) => e.summary)).toEqual([
      'PENDING → SENT_BY_USER',
      'SENT_BY_USER → REPLIED',
      'REPLIED → SENT_BY_USER',
      'SENT_BY_USER → PENDING',
      'PENDING → SKIPPED',
      'SKIPPED → PENDING',
    ]);
    expect(trail.every((e) => e.actorUserId === t.userIds.sales)).toBe(true);
    // the words shown to people never say "delivered"
    expect(JSON.stringify(trail)).not.toMatch(/deliver/i);
  });

  it('makes the click-to-chat link only on request, for one task, never for an opted-out person, and does not prefill twice', async () => {
    const full = '+4915112345678';
    const ana = await add(t.sales, { phone: full, name: 'Zoë Ünal' });
    const tpl = await template(t.sales, {
      body: 'Hi {{first_name}}, 50% off & more?\nSee you!',
    });
    await h.whatsappOutreach.draft(t.sales, {
      templateId: tpl.id,
      contactId: ana.id,
    });
    const [task] = await h.whatsappOutreach.listTasks(t.sales);

    expect(
      await h.prisma.whatsappTask.findUniqueOrThrow({ where: { id: task.id } })
    ).toMatchObject({
      openedAt: null,
    });
    const opened = await h.whatsappOutreach.openChat(t.sales, task.id);
    expect(opened.prefilled).toBe(true);
    expect(opened.url.startsWith('https://wa.me/4915112345678?text=')).toBe(
      true
    );
    expect(new URL(opened.url).searchParams.get('text')).toBe(task.message);
    expect(opened.url).not.toMatch(/[ \n]/);
    expect(opened.url).toContain('%C3%AB'); // ë, encoded as UTF-8
    expect(
      (
        await h.prisma.whatsappTask.findUniqueOrThrow({
          where: { id: task.id },
        })
      ).openedAt
    ).toBeInstanceOf(Date);
    // opening a chat does not mark anything as sent: only the person does that
    expect(
      (
        await h.prisma.whatsappTask.findUniqueOrThrow({
          where: { id: task.id },
        })
      ).status
    ).toBe('PENDING');

    await h.whatsappOutreach.setStatus(t.sales, task.id, {
      status: 'SENT_BY_USER',
    });
    const again = await h.whatsappOutreach.openChat(t.sales, task.id);
    expect(again).toMatchObject({
      prefilled: false,
      url: 'https://wa.me/4915112345678',
    });

    await h.whatsappOutreach.setStatus(t.sales, task.id, { status: 'PENDING' });
    await h.whatsappOutreach.setStatus(t.sales, task.id, { status: 'SKIPPED' });
    await expect(h.whatsappOutreach.openChat(t.sales, task.id)).rejects.toThrow(
      /skipped/
    );

    // reading is not enough to get a link, and nothing offers more than one at a time
    await expect(
      h.whatsappOutreach.openChat(t.analyst, task.id)
    ).rejects.toBeInstanceOf(ForbiddenException);
    const methods = Object.getOwnPropertyNames(
      Object.getPrototypeOf(h.whatsappOutreach)
    );
    expect(methods.filter((m) => /open|send|bulk/i.test(m))).toEqual([
      'openChat',
    ]);
    expect(
      JSON.stringify(await h.whatsappOutreach.listTasks(t.sales))
    ).not.toContain('wa.me');
    expect(JSON.stringify(await h.whatsapp.get(t.sales, ana.id))).not.toContain(
      'wa.me'
    );
  });

  it('keeps reminders in the app: due today, done when cleared, gone for people who left', async () => {
    const ana = await add(t.sales);
    const ben = await add(t.sales, { name: 'Ben' });
    const cy = await add(t.sales, { name: 'Cy' });
    const tpl = await template();
    for (const c of [ana, ben, cy]) {
      await h.whatsappOutreach.draft(t.sales, {
        templateId: tpl.id,
        contactId: c.id,
      });
    }
    const by = async (c: { id: string }) =>
      (await h.whatsappOutreach.listTasks(t.sales, { contactId: c.id }))[0];
    const [a, b, c] = [await by(ana), await by(ben), await by(cy)];
    const day = 24 * 3600 * 1000;
    const endOfToday = new Date(Date.now() + day / 2).toISOString();

    await h.whatsappOutreach.updateTask(t.sales, a.id, {
      followUpAt: new Date(Date.now() - day).toISOString(), // overdue
      note: ' ask about the quote ',
    });
    await h.whatsappOutreach.setStatus(t.sales, b.id, {
      status: 'SENT_BY_USER',
    });
    await h.whatsappOutreach.updateTask(t.sales, b.id, {
      followUpAt: new Date(Date.now() + day / 4).toISOString(), // later today
    });
    await h.whatsappOutreach.updateTask(t.sales, c.id, {
      followUpAt: new Date(Date.now() + 3 * day).toISOString(), // not yet
    });

    const due = await h.whatsappOutreach.listDue(t.sales, endOfToday);
    expect(due.map((x) => x.id)).toEqual([a.id, b.id]);
    expect(due[0].note).toBe('ask about the quote');
    expect(
      (
        await h.whatsappOutreach.listDue(
          t.sales,
          new Date(Date.now() + 4 * day).toISOString()
        )
      ).map((x) => x.id)
    ).toEqual([a.id, b.id, c.id]);
    // a made-up "until" falls back to now rather than failing
    expect(
      (await h.whatsappOutreach.listDue(t.sales, 'nonsense')).map((x) => x.id)
    ).toEqual([a.id]);

    // clearing it is "done"; replying ends the need for one
    expect(
      (await h.whatsappOutreach.updateTask(t.sales, a.id, { followUpAt: null }))
        .followUpAt
    ).toBeNull();
    await h.whatsappOutreach.setStatus(t.sales, b.id, { status: 'REPLIED' });
    expect(await h.whatsappOutreach.listDue(t.sales, endOfToday)).toEqual([]);
    await expect(
      h.whatsappOutreach.updateTask(t.sales, b.id, {
        followUpAt: new Date().toISOString(),
      })
    ).rejects.toThrow(/still open/);
    await expect(
      h.whatsappOutreach.updateTask(t.sales, c.id, {
        followUpAt: 'tomorrow-ish' as any,
      })
    ).rejects.toThrow(/real date/);

    // a person who withdrew has no reminder left
    await h.whatsapp.withdraw(t.sales, cy.id, { method: 'EMAIL' });
    expect(
      (await h.prisma.whatsappTask.findUniqueOrThrow({ where: { id: c.id } }))
        .followUpAt
    ).toBeNull();
    expect(
      await h.whatsappOutreach.listDue(
        t.sales,
        new Date(Date.now() + 9 * day).toISOString()
      )
    ).toEqual([]);
    await expect(
      h.whatsappOutreach.updateTask(t.sales, c.id, {
        followUpAt: new Date().toISOString(),
      })
    ).rejects.toThrow(/still open|withdrew/);
  });

  // ------------------------------------------------------------------------------- AI
  it('suggests wording when the AI answers, and says plainly when it cannot, without breaking anything else', async () => {
    const complete = jest.spyOn(h.aiGateway, 'complete');
    complete.mockResolvedValue({
      text: '```\n<b>Hi {{first_name}}</b>, {{agency}} has a spring offer {{ssn}}\n```',
      provider: 'local',
      model: 'tiny',
      ms: 5,
      notes: [],
    });
    const ok = await h.whatsappOutreach.suggestWording(t.sales, {
      brief: 'Spring offer for returning customers',
      tone: 'CASUAL' as any,
    });
    expect(ok).toEqual({
      available: true,
      text: 'Hi {{first_name}}, {{agency}} has a spring offer',
      provider: 'local',
      model: 'tiny',
    });
    const asked = complete.mock.calls[0];
    expect(asked[0]).toBe(t.orgId);
    expect(asked[1].task).toBe('copy');
    expect(asked[1].system).toMatch(/only contacts people who already agreed/);
    expect(JSON.stringify(asked[1].messages)).toContain('Spring offer');
    expect(JSON.stringify(asked[1].messages)).not.toMatch(/\+49|Ana/);

    await h.whatsappOutreach.suggestWording(t.sales, { body: 'Hello there' });
    expect(complete.mock.calls[1][1].task).toBe('improve');

    complete.mockRejectedValue(
      new AiProviderError(
        'unreachable',
        'Ollama is not running. Start it or pick another AI in Settings.'
      )
    );
    expect(
      await h.whatsappOutreach.suggestWording(t.sales, { brief: 'x' })
    ).toEqual({
      available: false,
      reason: 'Ollama is not running. Start it or pick another AI in Settings.',
    });
    complete.mockRejectedValue(new Error('socket hang up'));
    expect(
      await h.whatsappOutreach.suggestWording(t.sales, { brief: 'x' })
    ).toMatchObject({
      available: false,
      reason: expect.stringMatching(/could not be reached/),
    });
    complete.mockResolvedValue({
      text: '   ',
      provider: 'local',
      model: null,
      ms: 1,
      notes: [],
    });
    expect(
      await h.whatsappOutreach.suggestWording(t.sales, { brief: 'x' })
    ).toMatchObject({ available: false });

    await expect(
      h.whatsappOutreach.suggestWording(t.sales, {})
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      h.whatsappOutreach.suggestWording(t.analyst, { brief: 'x' })
    ).rejects.toBeInstanceOf(ForbiddenException);

    // everything else still works with the AI down
    complete.mockRejectedValue(new Error('down'));
    const ana = await add(t.sales);
    const tpl = await template();
    expect(
      (
        await h.whatsappOutreach.draft(t.sales, {
          templateId: tpl.id,
          contactId: ana.id,
        })
      ).created
    ).toBe(1);
    // and the suggestion changed nothing: it is text for the editor, not a template
    expect(
      await h.prisma.whatsappTemplate.count({ where: { orgId: t.orgId } })
    ).toBe(1);
  });

  // ---------------------------------------------------------------------------------- roles
  it('lets staff who work contacts work them, lets analysts read masked lists, and keeps clients out', async () => {
    const ana = await add(t.sales);
    const tpl = await template(t.manager); // a campaign manager works too
    await h.whatsappOutreach.draft(t.salesManager, {
      templateId: tpl.id,
      contactId: ana.id,
    });

    // analysts read
    expect(await h.whatsapp.list(t.analyst)).toHaveLength(1);
    expect(await h.whatsappOutreach.listTemplates(t.analyst)).toHaveLength(1);
    expect(await h.whatsappOutreach.listTasks(t.analyst)).toHaveLength(1);
    expect(await h.whatsapp.listUnsubscribes(t.analyst)).toEqual([]);
    expect(await h.whatsapp.listImports(t.analyst)).toEqual([]);
    expect((await h.whatsapp.getSettings(t.analyst)).businessApi.enabled).toBe(
      false
    );

    const [task] = await h.whatsappOutreach.listTasks(t.analyst);
    const writes: Array<() => Promise<unknown>> = [
      () => h.whatsapp.create(t.analyst, person()),
      () => h.whatsapp.update(t.analyst, ana.id, { notes: 'x' }),
      () => h.whatsapp.withdraw(t.analyst, ana.id, { method: 'EMAIL' }),
      () => h.whatsapp.previewImport(t.analyst, csv([])),
      () => h.whatsapp.commitImport(t.analyst, { csv: '', attested: true }),
      () => segment(t.analyst),
      () => template(t.analyst),
      () =>
        h.whatsappOutreach.draft(t.analyst, {
          templateId: tpl.id,
          contactId: ana.id,
        }),
      () =>
        h.whatsappOutreach.setStatus(t.analyst, task.id, { status: 'SKIPPED' }),
      () => h.whatsappOutreach.updateTask(t.analyst, task.id, { note: 'x' }),
    ];
    for (const write of writes) {
      await expect(write()).rejects.toBeInstanceOf(ForbiddenException);
    }

    // clients get nothing at all
    const reads: Array<() => Promise<unknown>> = [
      () => h.whatsapp.list(t.client),
      () => h.whatsapp.get(t.client, ana.id),
      () => h.whatsapp.listUnsubscribes(t.client),
      () => h.whatsapp.listImports(t.client),
      () => h.whatsapp.getSettings(t.client),
      () => h.whatsapp.facets(t.client),
      () => h.whatsappOutreach.listSegments(t.client),
      () => h.whatsappOutreach.listTemplates(t.client),
      () => h.whatsappOutreach.listTasks(t.client),
      () => h.whatsappOutreach.listDue(t.client),
      () => h.whatsappOutreach.openChat(t.client, task.id),
      () => h.whatsapp.create(t.client, person()),
    ];
    for (const read of reads) {
      await expect(read()).rejects.toBeInstanceOf(ForbiddenException);
    }

    // sales executives are not scoped to their own contacts: a withdrawal must be seen by everyone
    await h.whatsapp.withdraw(t.manager, ana.id, { method: 'IN_PERSON' });
    expect((await h.whatsapp.get(t.sales, ana.id)).consentStatus).toBe(
      'OPTED_OUT'
    );
  });

  // -------------------------------------------------------------------------------- tenancy
  it('keeps agencies apart: nothing of another agency can be read, changed, opened or erased', async () => {
    const ana = await add(t.sales, { tags: ['vip'] });
    const seg = await segment(t.sales, { tags: ['vip'] });
    const tpl = await template();
    await h.whatsappOutreach.draft(t.sales, {
      templateId: tpl.id,
      segmentId: seg.id,
    });
    const [task] = await h.whatsappOutreach.listTasks(t.sales);
    await h.whatsapp.withdraw(t.sales, (await add(t.sales)).id, {
      method: 'EMAIL',
    });

    // lists are empty for the other agency
    expect(await h.whatsapp.list(other.owner)).toEqual([]);
    expect(await h.whatsappOutreach.listSegments(other.owner)).toEqual([]);
    expect(await h.whatsappOutreach.listTemplates(other.owner)).toEqual([]);
    expect(await h.whatsappOutreach.listTasks(other.owner)).toEqual([]);
    expect(
      await h.whatsappOutreach.listDue(
        other.owner,
        new Date(Date.now() + 9e9).toISOString()
      )
    ).toEqual([]);
    expect(await h.whatsapp.listUnsubscribes(other.owner)).toEqual([]);
    expect(await h.whatsapp.listImports(other.owner)).toEqual([]);
    expect(await h.whatsapp.facets(other.owner)).toEqual({
      tags: [],
      languages: [],
      consentSources: [],
    });

    // every id from the first agency is simply not found
    const nf = NotFoundException;
    await expect(h.whatsapp.get(other.owner, ana.id)).rejects.toBeInstanceOf(
      nf
    );
    await expect(
      h.whatsapp.update(other.owner, ana.id, { notes: 'x' })
    ).rejects.toBeInstanceOf(nf);
    await expect(
      h.whatsapp.withdraw(other.owner, ana.id, { method: 'EMAIL' })
    ).rejects.toBeInstanceOf(nf);
    await expect(h.whatsapp.erase(other.owner, ana.id)).rejects.toBeInstanceOf(
      nf
    );
    await expect(
      h.whatsappOutreach.updateSegment(other.owner, seg.id, {
        name: 'mine now',
      })
    ).rejects.toBeInstanceOf(nf);
    await expect(
      h.whatsappOutreach.deleteSegment(other.owner, seg.id)
    ).rejects.toBeInstanceOf(nf);
    await expect(
      h.whatsappOutreach.updateTemplate(other.owner, tpl.id, {
        name: 'x',
        body: 'y',
      })
    ).rejects.toBeInstanceOf(nf);
    await expect(
      h.whatsappOutreach.deleteTemplate(other.owner, tpl.id)
    ).rejects.toBeInstanceOf(nf);
    await expect(
      h.whatsappOutreach.openChat(other.owner, task.id)
    ).rejects.toBeInstanceOf(nf);
    await expect(
      h.whatsappOutreach.setStatus(other.owner, task.id, { status: 'SKIPPED' })
    ).rejects.toBeInstanceOf(nf);
    await expect(
      h.whatsappOutreach.updateTask(other.owner, task.id, { note: 'x' })
    ).rejects.toBeInstanceOf(nf);
    // ...and cannot be used as ingredients for the other agency's own work
    const mine = await template(other.owner);
    await expect(
      h.whatsappOutreach.draft(other.owner, {
        templateId: tpl.id,
        contactId: ana.id,
      })
    ).rejects.toBeInstanceOf(nf);
    await expect(
      h.whatsappOutreach.draft(other.owner, {
        templateId: mine.id,
        contactId: ana.id,
      })
    ).rejects.toBeInstanceOf(nf);
    await expect(
      h.whatsappOutreach.draft(other.owner, {
        templateId: mine.id,
        segmentId: seg.id,
      })
    ).rejects.toBeInstanceOf(nf);
    await expect(
      h.whatsappOutreach.previewTemplate(other.owner, {
        body: 'Hi',
        contactId: ana.id,
      })
    ).rejects.toBeInstanceOf(nf);

    // the repository's writes carry the organization too, whatever the service checked
    const repo = h.whatsapp['repo'];
    expect(
      await repo.updateContact(other.orgId, ana.id, { notes: 'hijacked' })
    ).toBeNull();
    expect((await repo.eraseContact(other.orgId, ana.id)).count).toBe(0);
    expect((await repo.deleteSegment(other.orgId, seg.id)).count).toBe(0);
    expect((await repo.deleteTemplate(other.orgId, tpl.id)).count).toBe(0);
    expect(
      await repo.withdrawContact(other.orgId, ana.id, {
        receivedAt: new Date(),
        method: 'EMAIL',
        reason: null,
        phoneHash: 'x',
        recordedById: 'u',
      })
    ).toBeNull();
    expect(
      await repo.transitionTask(other.orgId, task.id, 'PENDING', {
        status: 'SKIPPED',
      })
    ).toBe(false);
    const untouched = await h.prisma.whatsappContact.findUniqueOrThrow({
      where: { id: ana.id },
    });
    expect(untouched).toMatchObject({ notes: null, consentStatus: 'OPTED_IN' });
    expect(
      await h.prisma.whatsappUnsubscribe.count({
        where: { orgId: other.orgId },
      })
    ).toBe(0);
    // the other agency's withdrawal does not leak into this one either
    const stranger = await add(other.sales);
    await h.whatsapp.withdraw(other.sales, stranger.id, { method: 'EMAIL' });
    expect((await h.whatsapp.listUnsubscribes(t.owner)).length).toBe(1);
  });
});
