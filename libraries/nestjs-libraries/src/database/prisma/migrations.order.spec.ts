import { readdirSync } from 'fs';
import { join } from 'path';

/**
 * Prisma runs migrations in the alphabetical order of their folder names. A two-digit name such as
 * `10_…` sorts before `1_…`, which broke the first Windows install that met one. The names after
 * `9_…` therefore start with a letter (see migrations/README.md).
 */
describe('migration folder names', () => {
  const dir = join(__dirname, 'migrations');
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  it('start with 0_baseline and never use a number of two digits or more', () => {
    expect([...names].sort()[0]).toBe('0_baseline');
    expect(names.filter((n) => /^\d{2,}/.test(n))).toEqual([]);
  });

  it('run in the order they were written: the digit series, then a1, a2, a3…', () => {
    const sorted = [...names].sort();
    const digits = sorted.filter((n) => /^\d/.test(n));
    const letters = sorted.filter((n) => /^[a-z]/.test(n));
    expect(sorted).toEqual([...digits, ...letters]);
    expect(digits.map((n) => parseInt(n, 10))).toEqual(digits.map((_, i) => i));
    letters.forEach((n, i) => {
      expect(n).toMatch(new RegExp(`^a${i + 1}_`));
    });
  });
});
