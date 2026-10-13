import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  buildHarness,
  describeDb,
  Harness,
  seedTenant,
  Tenant,
} from './agency.test.support';

const realEnv = { ...process.env };
const onPosix = process.platform === 'win32' ? describe.skip : describe;

/**
 * The AI command-line tools are kept up to date by running each tool's own updater. The
 * tools here are stand-in programs on the PATH that record how they were called.
 */
onPosix('AI command-line tools stay up to date (real database)', () => {
  const run = describeDb;
  run('updater', () => {
    let h: Harness;
    let t: Tenant;
    let dir: string;
    let log: string;

    const install = (name: string, script: string) =>
      fs.writeFile(path.join(dir, name), `#!/bin/sh\n${script}\n`, {
        mode: 0o755,
      });
    // A tool whose version moves to 2.0.1 once it has been updated.
    const updatable = (name: string) =>
      install(
        name,
        `echo "$*" >> "${log}"
V="${dir}/${name}.version"; [ -f "$V" ] || echo 2.0.0 > "$V"
case "$1" in
  --version) cat "$V" ;;
  update) echo 2.0.1 > "$V"; echo updated ;;
  *) cat >/dev/null; echo ok ;;
esac`
      );
    const calls = async () =>
      (await fs.readFile(log, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean);

    beforeAll(async () => {
      h = await buildHarness();
    });
    afterAll(async () => {
      await h.prisma.$disconnect();
    });
    beforeEach(async () => {
      process.env.AGENCYOS_LOCAL = 'true';
      delete process.env.AGENCY_AI_TOOL_UPDATES;
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agencyos-tools-'));
      log = path.join(dir, 'calls.log');
      process.env.PATH = `${dir}${path.delimiter}${realEnv.PATH}`;
      await h.prisma.agencyAiTool.deleteMany();
      t = await seedTenant(h, 'tools');
    });
    afterEach(async () => {
      process.env = { ...realEnv };
      await fs.rm(dir, { recursive: true, force: true });
    });

    const tool = async (id: string) =>
      (await h.aiTools.list(t.owner)).tools.find((x) => x.id === id)!;

    it('runs the tool’s own updater and reports the new version', async () => {
      await updatable('claude');
      const view = await h.aiTools.updateNow(t.owner, 'claude-cli');
      const claude = view.tools.find((x) => x.id === 'claude-cli')!;
      expect(claude).toMatchObject({
        installed: true,
        status: 'updated',
        version: '2.0.1',
        message: 'Updated from 2.0.0 to 2.0.1.',
      });
      expect(claude.lastUpdatedAt).toBeTruthy();
      // version before, the updater, version after (listing the tools asks once more)
      expect((await calls()).slice(0, 3)).toEqual([
        '--version',
        'update',
        '--version',
      ]);
      expect((await calls()).filter((c) => c === 'update')).toHaveLength(1);

      await h.aiTools.updateNow(t.owner, 'claude-cli');
      expect(await tool('claude-cli')).toMatchObject({
        status: 'current',
        message: 'Up to date.',
      });
    });

    it('says plainly when an update fails, and how to do it by hand', async () => {
      await install(
        'codex',
        'case "$1" in --version) echo codex-cli 0.1.0 ;; update) echo "unknown command" >&2; exit 2 ;; esac'
      );
      await h.aiTools.updateNow(t.owner, 'codex-cli');
      const codex = await tool('codex-cli');
      expect(codex.status).toBe('failed');
      expect(codex.message).toMatch(/code 2/);
      expect(codex.message).toMatch(/codex update/);
    });

    it('updates Antigravity with its documented `agy update`', async () => {
      await updatable('agy');
      await h.aiTools.updateNow(t.owner, 'antigravity-cli');
      const agy = await tool('antigravity-cli');
      expect(agy).toMatchObject({
        status: 'updated',
        canUpdate: true,
        version: '2.0.1',
      });
      expect((await calls()).filter((c) => c === 'update')).toHaveLength(1);
    });

    it('reports a tool that is not installed instead of failing', async () => {
      const missing = jest
        .spyOn(h.aiGateway, 'findBinary')
        .mockResolvedValue(null);
      try {
        expect(await tool('claude-cli')).toMatchObject({
          installed: false,
          autoUpdate: true,
        });
        await h.aiTools.updateNow(t.owner, 'claude-cli');
        expect((await tool('claude-cli')).message).toBe('Not installed.');
      } finally {
        missing.mockRestore();
      }
    });

    it('checks once a day, across every process, and respects the switch', async () => {
      await updatable('claude');
      await h.aiTools.runDue();
      await h.aiTools.runDue();
      expect((await calls()).filter((c) => c === 'update')).toHaveLength(1);

      await h.aiTools.setAutoUpdate(t.owner, false);
      await h.prisma.agencyAiTool.updateMany({
        data: { lastCheckedAt: new Date(Date.now() - 3 * 86400000) },
      });
      await h.aiTools.runDue();
      expect((await calls()).filter((c) => c === 'update')).toHaveLength(1);
      expect((await h.aiTools.list(t.owner)).autoUpdate).toBe(false);

      await h.aiTools.setAutoUpdate(t.owner, true);
      await h.aiTools.runDue();
      expect((await calls()).filter((c) => c === 'update')).toHaveLength(2);
      const audit = await h.accessRepo.listAuditEvents(t.orgId, {
        entityType: 'AgencyAiTool',
      });
      expect(audit.map((e) => e.action)).toContain('ai.tools_auto_update');
    });

    it('never replaces a program while a request is using it', async () => {
      await install(
        'claude',
        `echo "$*" >> "${log}"; case "$1" in --version) echo 2.0.0 ;; update) echo updated ;; *) cat >/dev/null; sleep 1; echo ok ;; esac`
      );
      await h.aiGateway.updateSettings(t.owner, {
        activeProvider: 'claude-cli',
      });
      const running = h.aiGateway.complete(t.orgId, {
        messages: [{ role: 'user', content: 'hi' }],
      });
      await new Promise((r) => setTimeout(r, 200));
      await h.aiTools.update('claude-cli');
      expect((await tool('claude-cli')).status).toBe('skipped');
      expect((await calls()).includes('update')).toBe(false);
      await running;

      await h.aiTools.update('claude-cli');
      expect((await tool('claude-cli')).status).toBe('current');
    });

    it('is for owners and admins, and only on the desktop app', async () => {
      await expect(h.aiTools.setAutoUpdate(t.sales, false)).rejects.toThrow();
      await expect(h.aiTools.updateNow(t.analyst)).rejects.toThrow();
      expect(await h.aiTools.list(t.analyst)).toBeTruthy(); // anyone on staff may look

      process.env.AGENCYOS_LOCAL = 'false';
      await expect(h.aiTools.updateNow(t.owner)).rejects.toThrow(/desktop app/);
      expect((await h.aiTools.list(t.owner)).available).toBe(false);
    });
  });
});
