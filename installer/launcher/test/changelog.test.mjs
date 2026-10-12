import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHANGELOG_FILE,
  CHANGE_TYPES,
  normalizeEol,
  loadReleases,
  renderBody,
  renderChangelog,
} from '../../build/changelog.mjs';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..'
);
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const semver = (v) => v.split('.').map(Number);
const newer = (a, b) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

describe('changelog (what changed in every version)', () => {
  const releases = loadReleases();

  it('has well-formed entries, newest first, one per version', () => {
    assert.ok(releases.length >= 2);
    const seen = new Set();
    releases.forEach((r, i) => {
      assert.match(r.version, /^\d+\.\d+\.\d+$/, 'version');
      assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/, `${r.version} date`);
      assert.ok(
        r.title && r.summary,
        `${r.version} needs a title and a summary`
      );
      assert.ok(r.changes.length > 0, `${r.version} lists no changes`);
      assert.ok(!seen.has(r.version), `${r.version} appears twice`);
      seen.add(r.version);
      if (i > 0)
        assert.ok(
          newer(releases[i - 1].version, r.version),
          `${r.version} must come after ${releases[i - 1].version}`
        );
      for (const c of r.changes) {
        assert.ok(
          CHANGE_TYPES.some(([t]) => t === c.type),
          `${r.version}: unknown type "${c.type}"`
        );
        assert.ok(
          c.area && c.text,
          `${r.version}: a change needs an area and text`
        );
      }
    });
  });

  it('the newest entry is the version being built, so a release cannot ship without notes', () => {
    assert.equal(releases[0].version, read('installer', 'VERSION').trim());
  });

  it('CHANGELOG.md is generated from releases.json and is up to date', () => {
    assert.equal(
      normalizeEol(fs.readFileSync(CHANGELOG_FILE, 'utf8')),
      renderChangelog(releases),
      'run: node installer/build/changelog.mjs'
    );
    for (const r of releases)
      assert.ok(read('CHANGELOG.md').includes(`## ${r.version} — ${r.date}`));
  });

  it('a version’s section lists every change under its type', () => {
    const body = renderBody(releases[0]);
    for (const c of releases[0].changes) assert.ok(body.includes(c.text));
    assert.match(body, /### Added/);
  });

  it('release notes carry what changed', () => {
    assert.match(read('installer', 'RELEASE_NOTES.md'), /\{\{CHANGES\}\}/);
  });
});

describe('feature explainer (how to use what)', () => {
  const data = JSON.parse(
    read('libraries', 'helpers', 'src', 'changelog', 'features.json')
  );
  const nav = read(
    'apps',
    'frontend',
    'src',
    'components',
    'new-layout',
    'nav.config.tsx'
  );
  const hrefs = [...nav.matchAll(/href: '([^']+)'/g)].map((m) => m[1]);

  it('explains every page in the sidebar except Guide and Settings', () => {
    const explained = new Set(
      data.features.map((f) => f.href.split(/[?#]/)[0])
    );
    for (const href of hrefs) {
      if (href === '/guide' || href === '/settings') continue;
      assert.ok(
        explained.has(href),
        `the sidebar links to ${href} but the feature explainer has no entry for it`
      );
    }
  });

  it('every entry says what it is for and how to use it', () => {
    const groups = new Set(data.groups.map((g) => g.id));
    const ids = new Set();
    for (const f of data.features) {
      assert.ok(groups.has(f.group), `${f.id}: unknown group ${f.group}`);
      assert.ok(!ids.has(f.id), `${f.id} appears twice`);
      ids.add(f.id);
      assert.ok(f.title && f.summary, `${f.id}: title and summary`);
      assert.ok(f.steps.length >= 1, `${f.id}: how-to steps`);
      assert.ok(
        ['ready', 'needs-setup', 'partial', 'experimental'].includes(f.status),
        `${f.id}: status`
      );
    }
  });
});
