// The real status server and the real command-line tools manager, with stand-in programs: install takes a
// few seconds, a sign-in finishes six seconds after it starts. Lets the Settings card be used in a browser.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createStatusServer } from '/home/user/AgencyOS/installer/launcher/lib/status-server.mjs';
import { CliTools } from '/home/user/AgencyOS/installer/launcher/lib/cli-tools.mjs';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-cli-')); const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
const state = (id) => path.join(dir, `${id}.signed`);
const script = (id, label, extra = '') => `#!/bin/sh
case "$1" in
  --version) echo "${label}";;
  auth) case "$2" in
      status) [ -f "${state(id)}" ] && exit 0 || exit 1;;
      login) echo "If your browser does not open, visit https://claude.ai/oauth/authorize?client=agencyos"; sleep 6; touch "${state(id)}"; exit 0;;
      logout) rm -f "${state(id)}"; exit 0;;
    esac;;
  login) case "$2" in
      status) [ -f "${state(id)}" ] && exit 0 || exit 1;;
      "") echo "Open https://auth.openai.com/oauth/authorize?x=1"; sleep 6; touch "${state(id)}"; exit 0;;
    esac;;
  logout) rm -f "${state(id)}"; exit 0;;
  -p) [ -f "${state(id)}" ] && echo OK || { echo "authentication required" >&2; exit 1; };;
esac
${extra}
`;
const put = (name, id, label) => fs.writeFileSync(path.join(bin, name), script(id, label), { mode: 0o755 });
put('agy', 'agy', 'agy 1.4.0'); // came with the install
const tools = new CliTools({
  env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, HOME: dir }, platform: 'linux', extraDirs: [bin], pollMs: 1500,
  install: async (id) => { await new Promise((r) => setTimeout(r, 3500)); if (id === 'claude') put('claude', 'claude', '2.1.211 (Claude Code)'); if (id === 'codex') put('codex', 'codex', 'codex-cli 0.9.0'); },
  startWindow: async () => { setTimeout(() => fs.writeFileSync(state('agy'), '1'), 5000); return 4242; },
});
const status = { app: 'AgencyOS', version: '1.4.0', ready: true, attention: false, url: 'http://localhost:4200', services: [], ai: {}, telegram: {}, storage: { dataRoot: 'x', aiRoot: 'y', customAi: false, locked: false, move: null, leftovers: [] }, dataDir: 'x', logsDir: 'y' };
const server = createStatusServer({
  port: 4999, token: 'dev-launcher-token', version: '1.4.0', getStatus: () => status, tail: () => null,
  actions: {
    restart: async () => {}, shutdown: () => {}, retryAi: () => {}, setTelegramToken: async () => {},
    cliTools: () => tools.snapshot(), cliInstall: (t) => tools.startInstall(t), cliLogin: (t) => tools.startLogin(t), cliCancel: () => tools.cancel(),
    cliCheck: async (t) => ({ signedIn: await tools.check(t) }), cliSignOut: (t) => tools.signOut(t),
  },
});
await server.listen(); console.log('fake launcher with real tools manager on 4999');
