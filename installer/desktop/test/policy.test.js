'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const p = require('../policy');

const origins = p.trustedOrigins({ statusPort: 4999, frontendPort: 4200, backendPort: 3000 });

describe('desktop shell policy', () => {
  it('parses launch arguments', () => {
    assert.deepEqual(p.parseArgs(['AgencyOS.exe', '--hidden'], {}), { hidden: true, debug: false });
    assert.deepEqual(p.parseArgs([], { AGENCYOS_DEBUG: '1' }), { hidden: false, debug: true });
  });

  it('trusts AgencyOS pages on this computer under both loopback names, and nothing else', () => {
    assert.equal(origins.size, 6);
    for (const url of ['http://127.0.0.1:4999/', 'http://localhost:4200/agency/dashboard', 'http://localhost:3000/user/self']) {
      assert.equal(p.classifyNavigation(url, origins), 'allow', url);
    }
  });

  it('sends every other web address to the default browser instead of showing it in the app', () => {
    for (const url of ['https://accounts.google.com/o/oauth2/auth', 'https://t.me/mybot', 'http://localhost:9999/', 'http://127.0.0.1:4201/', 'https://localhost:4200/']) {
      assert.equal(p.classifyNavigation(url, origins), 'external', url);
    }
  });

  it('refuses file, javascript, data, blob and unknown schemes', () => {
    for (const url of ['file:///C:/Windows/System32/cmd.exe', 'javascript:alert(1)', 'data:text/html,<script>1</script>', 'blob:http://localhost:4200/x', 'ms-msdt:/id', 'not a url', '']) {
      assert.equal(p.classifyNavigation(url, origins), 'deny', url);
    }
  });

  it('allows mail links through the system and the in-app retry link', () => {
    assert.equal(p.classifyNavigation('mailto:team@example.com', origins), 'external');
    assert.equal(p.classifyNavigation(p.RETRY_URL, origins), 'allow');
  });

  it('only ever opens web and mail addresses outside the app', () => {
    assert.equal(p.safeToOpenExternally('https://example.com'), true);
    assert.equal(p.safeToOpenExternally('mailto:a@b.c'), true);
    for (const url of ['file:///x', 'ms-settings:privacy', 'javascript:1', 'cmd:/c calc', 'smb://host/share']) {
      assert.equal(p.safeToOpenExternally(url), false, url);
    }
  });

  it('reads the status port from the launcher output', () => {
    assert.equal(p.parseStatusPort('AgencyOS is running. Status: http://127.0.0.1:4999/\n'), 4999);
    assert.equal(p.parseStatusPort('AgencyOS is running. Status: http://127.0.0.1:5003/'), 5003);
    assert.equal(p.parseStatusPort('nothing here'), null);
    assert.equal(p.parseStatusPort('Status: http://evil.example:4999/'), null);
  });

  it('summarises state for the window and the tray', () => {
    assert.equal(p.windowPhase(null), 'starting');
    assert.equal(p.windowPhase({ ready: false, attention: false }), 'starting');
    assert.equal(p.windowPhase({ ready: true }), 'ready');
    assert.equal(p.windowPhase({ ready: false, attention: true }), 'attention');
    assert.equal(p.windowPhase({ ready: false, storage: { move: { active: true } } }), 'moving');
    assert.equal(p.windowPhase({ ready: true, storage: { move: { active: false, phase: 'failed' } } }), 'ready');
    assert.match(p.trayTooltip({ storage: { move: { active: true } } }), /moving your data/);
    assert.match(p.trayTooltip({ ready: true }, '1.0.0'), /AgencyOS 1\.0\.0 — running/);
    assert.match(p.trayTooltip({ attention: true }), /needs attention/);
    assert.match(p.trayTooltip(null), /starting/);
  });

  it('lets only the launcher status page open the folder picker', () => {
    assert.equal(p.isStatusPage('http://127.0.0.1:4999/', 4999), true);
    assert.equal(p.isStatusPage('http://localhost:4999/', 4999), true);
    for (const url of ['http://127.0.0.1:4200/', 'http://127.0.0.1:4999/other', 'https://127.0.0.1:4999/', 'http://evil.example:4999/', 'http://127.0.0.1:4999.evil.com/', 'nonsense', undefined]) {
      assert.equal(p.isStatusPage(url, 4999), false, String(url));
    }
    assert.equal(p.isStatusPage('http://127.0.0.1:4999/', null), false);
  });

  it('lets the app’s Settings page, and no other page of the app, open the folder picker', () => {
    assert.equal(p.isAppSettingsPage('http://localhost:4200/settings', 4200), true);
    assert.equal(p.isAppSettingsPage('http://127.0.0.1:4200/settings?tab=system', 4200), true);
    for (const url of ['http://localhost:4200/', 'http://localhost:4200/settings/x', 'http://localhost:4200/agency/dashboard', 'https://localhost:4200/settings', 'http://localhost:4201/settings', 'http://evil.example:4200/settings', 'http://localhost:4200.evil.com/settings', 'nonsense', undefined]) {
      assert.equal(p.isAppSettingsPage(url, 4200), false, String(url));
    }
    assert.equal(p.isAppSettingsPage('http://localhost:4200/settings', null), false);
  });

  it('warns, before closing, that closing shuts AgencyOS down and stops every scheduled send', () => {
    const n = p.CLOSE_NOTICE;
    assert.deepEqual(n.buttons, ['Close AgencyOS', 'Keep running']); // the safe answer is the second one
    assert.match(n.detail, /No scheduled campaign will be sent/);
    assert.match(n.detail, /minimize the window instead/);
  });

  it('says on the start-up screen what is being started', () => {
    assert.equal(p.startupLine(undefined), 'Starting on this computer…');
    assert.equal(p.startupLine({ ready: false, services: [{ label: 'Database', state: 'starting' }, { label: 'Cache', state: 'pending' }] }), 'Starting database…');
    assert.equal(p.startupLine({ ready: false, services: [{ label: 'Cache', state: 'ready' }] }), 'Almost ready…');
    assert.equal(p.startupLine({ ready: true, services: [] }), 'Opening AgencyOS…');
  });

  it('draws the window buttons in the app theme, at the height of the top bar', () => {
    assert.deepEqual(p.titleBarOverlay(true), { color: '#1a1919', symbolColor: '#ffffff', height: 56 });
    assert.deepEqual(p.titleBarOverlay(false), { color: '#ffffff', symbolColor: '#0e0e0e', height: 56 });
  });

  it('only AgencyOS’s own pages may change the title bar theme', () => {
    assert.equal(p.isOwnPage('http://localhost:4200/agency/dashboard', origins), true);
    assert.equal(p.isOwnPage('http://127.0.0.1:4999/', origins), true);
    assert.equal(p.isOwnPage('https://example.com/', origins), false);
    assert.equal(p.isOwnPage('http://localhost:9999/', origins), false);
    assert.equal(p.isOwnPage(undefined, origins), false);
  });
});
