import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '..', '..');
const SOURCE = /\.(?:ts|vue|mjs|cjs|js|css)$/;

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules') return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.isFile() && SOURCE.test(entry.name) ? [full] : [];
  });
}

// Git takes a file holding a NUL byte for binary: its diffs and blame go, merges conflict, and autocrlf skips it.
describe('source files', () => {
  it('hold no NUL byte; a NUL in a string is written \\0', () => {
    const withNul = ['src', 'scripts', 'e2e'].flatMap((dir) => sources(path.join(ROOT, dir))).filter((file) => fs.readFileSync(file).includes(0));
    expect(withNul.map((file) => path.relative(ROOT, file))).toEqual([]);
  });
});
