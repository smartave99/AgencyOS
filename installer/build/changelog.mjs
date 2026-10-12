#!/usr/bin/env node
// The change history of every AgencyOS version lives in one file,
// libraries/helpers/src/changelog/releases.json. This script turns it into CHANGELOG.md and
// into the "what's new" part of a release's notes, so the repository, the release page and
// the in-app What's new page can never disagree.
//
//   node installer/build/changelog.mjs                  write CHANGELOG.md
//   node installer/build/changelog.mjs --check          fail if CHANGELOG.md is out of date
//   node installer/build/changelog.mjs --notes 1.1.0    print one version's section (fails if missing)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
);
export const RELEASES_FILE = path.join(
  root,
  'libraries',
  'helpers',
  'src',
  'changelog',
  'releases.json'
);
export const CHANGELOG_FILE = path.join(root, 'CHANGELOG.md');

export const CHANGE_TYPES = [
  ['added', 'Added'],
  ['improved', 'Improved'],
  ['changed', 'Changed'],
  ['fixed', 'Fixed'],
  ['security', 'Security'],
];

// A Windows checkout may turn line endings into CRLF; the words are what must match.
export const normalizeEol = (text) => text.replace(/\r\n/g, '\n');

export const loadReleases = () =>
  JSON.parse(fs.readFileSync(RELEASES_FILE, 'utf8')).releases;

/** One version's body: the summary, the changes by type, then the notes. */
export const renderBody = (release) => {
  const lines = [release.summary, ''];
  for (const [type, heading] of CHANGE_TYPES) {
    const changes = release.changes.filter((c) => c.type === type);
    if (!changes.length) continue;
    lines.push(`### ${heading}`, '');
    for (const c of changes) lines.push(`- **${c.area}:** ${c.text}`);
    lines.push('');
  }
  if (release.notes?.length) {
    lines.push('### Good to know', '');
    for (const note of release.notes) lines.push(`- ${note}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
};

export const renderChangelog = (releases) =>
  [
    '# Changelog',
    '',
    'Every change in every version of AgencyOS, by NextGen OS, newest first. This file is generated from `libraries/helpers/src/changelog/releases.json`: edit that file, then run `node installer/build/changelog.mjs`.',
    '',
    ...releases.flatMap((r) => [
      `## ${r.version} — ${r.date} · ${r.title}`,
      '',
      renderBody(r),
      '',
    ]),
  ]
    .join('\n')
    .trimEnd() + '\n';

const main = () => {
  const args = process.argv.slice(2);
  const releases = loadReleases();
  if (args[0] === '--notes') {
    const release = releases.find((r) => r.version === args[1]);
    if (!release) {
      console.error(
        `CHANGELOG: there is no entry for version ${args[1]} in releases.json. Add one before releasing.`
      );
      process.exit(1);
    }
    process.stdout.write(renderBody(release) + '\n');
    return;
  }
  const text = renderChangelog(releases);
  if (args[0] === '--check') {
    const current = fs.existsSync(CHANGELOG_FILE)
      ? fs.readFileSync(CHANGELOG_FILE, 'utf8')
      : '';
    if (normalizeEol(current) !== text) {
      console.error(
        'CHANGELOG.md is out of date. Run: node installer/build/changelog.mjs'
      );
      process.exit(1);
    }
    console.log('CHANGELOG.md is up to date.');
    return;
  }
  fs.writeFileSync(CHANGELOG_FILE, text);
  console.log(`Wrote CHANGELOG.md (${releases.length} versions).`);
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
