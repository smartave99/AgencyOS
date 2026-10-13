import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { agencyValidationPipe } from '@gitroom/nestjs-libraries/dtos/agency/agency.pipe';
import {
  CreateAdTemplateDto,
  UpdateAdTemplateDto,
} from '@gitroom/nestjs-libraries/dtos/agency/template.dto';
import {
  buildHarness,
  describeDb,
  Harness,
  seedTenant,
  Tenant,
} from './agency.test.support';

describeDb('Ad templates (real database)', () => {
  let h: Harness;
  let t: Tenant;
  let other: Tenant;

  beforeAll(async () => {
    h = await buildHarness();
  });
  afterAll(async () => {
    await h.prisma.$disconnect();
  });
  beforeEach(async () => {
    t = await seedTenant(h, 'templates');
    other = await seedTenant(h, 'templates-other');
  });

  const make = (actor: Tenant['sales'], over: Record<string, unknown> = {}) =>
    h.agency.createTemplate(actor, {
      name: 'Spring offer',
      contentTitle: 'Fresh bread, every morning',
      contentBody: 'Come in before 9am and the first loaf is on us.',
      ctaLink: 'https://bakery.test/spring',
      ctaText: 'See the menu',
      ...over,
    });

  it('saves content only, trims it, and audits who made it', async () => {
    const template = await make(t.sales, { name: '  Spring offer  ' });
    expect(template).toMatchObject({
      orgId: t.orgId,
      name: 'Spring offer',
      createdById: t.userIds.sales,
      ctaLink: 'https://bakery.test/spring',
    });
    expect(Object.keys(template)).not.toEqual(
      expect.arrayContaining(['customerId', 'destinations', 'status'])
    );
    expect(
      await h.prisma.auditEvent.count({
        where: { entityId: template.id, action: 'template.created' },
      })
    ).toBe(1);
  });

  it('refuses a second template with the same name, whatever the capitals', async () => {
    await make(t.sales);
    await expect(make(t.sales, { name: 'SPRING offer' })).rejects.toThrow(
      /already exists/
    );
    // another agency may use the same name
    await expect(make(other.sales)).resolves.toBeDefined();
  });

  it('refuses a blank name, blank text and a link that is not http(s)', async () => {
    await expect(make(t.sales, { name: '   ' })).rejects.toThrow(/name/);
    await expect(make(t.sales, { contentBody: '  ' })).rejects.toThrow(/text/);
    await expect(
      make(t.sales, { ctaLink: 'javascript:alert(1)' })
    ).rejects.toThrow(/http/);
  });

  it('validates the request body the way the API does', async () => {
    const pipe = (body: object, metatype: any = CreateAdTemplateDto) =>
      agencyValidationPipe.transform(body, { type: 'body', metatype });
    await expect(pipe({})).rejects.toBeDefined();
    await expect(pipe({ name: 'A' })).rejects.toBeDefined();
    await expect(
      pipe({ name: 'A', contentBody: 'x', ctaLink: 'ftp://x' })
    ).rejects.toBeDefined();
    await expect(
      pipe({ name: 'A', contentBody: 'x', ctaLink: '' })
    ).resolves.toBeDefined(); // a cleared field means none
    await expect(
      pipe({
        name: 'A',
        contentBody: 'x',
        orgId: 'smuggled',
        status: 'APPROVED',
      })
    ).resolves.toEqual({ name: 'A', contentBody: 'x' });
    await expect(pipe({ name: '' }, UpdateAdTemplateDto)).rejects.toBeDefined();
  });

  it('lists a workspace its own templates only, and edits and deletes them', async () => {
    const mine = await make(t.sales);
    await make(other.sales, { name: 'Theirs' });
    expect((await h.agency.getTemplates(t.analyst)).map((x) => x.name)).toEqual(
      ['Spring offer']
    );

    const renamed = await h.agency.updateTemplate(t.sales, mine.id, {
      name: 'Summer offer',
      ctaLink: '',
    });
    expect(renamed).toMatchObject({ name: 'Summer offer', ctaLink: null });
    // keeping its own name is not a clash
    await expect(
      h.agency.updateTemplate(t.sales, mine.id, { name: 'Summer offer' })
    ).resolves.toBeDefined();

    await expect(h.agency.deleteTemplate(t.sales, mine.id)).resolves.toEqual({
      deleted: true,
    });
    expect(await h.agency.getTemplates(t.sales)).toEqual([]);
  });

  it("never lets one agency read, change or delete another agency's template", async () => {
    const theirs = await make(other.sales);
    await expect(
      h.agency.updateTemplate(t.owner, theirs.id, { name: 'Mine now' })
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      h.agency.deleteTemplate(t.owner, theirs.id)
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await h.prisma.adTemplate.count({ where: { id: theirs.id } })).toBe(
      1
    );
  });

  it('is for staff who write campaigns: analysts read, clients are shut out', async () => {
    await expect(make(t.analyst)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(h.agency.getTemplates(t.analyst)).resolves.toEqual([]);
    await expect(h.agency.getTemplates(t.client)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    await expect(make(t.client)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
