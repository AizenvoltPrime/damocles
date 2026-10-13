import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { cn } from '../utils';

const RAMP = ['10', '10.5', '11', '11.5', '12', '12.5', '13', '13.5', '15'];
const RADII = ['5', '6', '7', '8', '9', '10', '11'];

const SRC = join(__dirname, '..', '..', '..');
const style = readFileSync(join(SRC, 'webview', 'style.css'), 'utf8');
const themeNames = (prefix: string): string[] =>
  [...style.matchAll(new RegExp(`--${prefix}-([\\d\\\\.]+):`, 'g'))].map(([, name]) => name!.replaceAll('\\', ''));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return /\.(vue|ts)$/.test(entry.name) ? [full] : [];
  });
}

describe('cn', () => {
  it('keeps a reference font size beside a text colour, and lets a later size win', () => {
    for (const size of RAMP) expect(cn(`text-${size}`, 'text-(--d-faint)')).toBe(`text-${size} text-(--d-faint)`);
    expect(cn('text-sm', 'text-12.5')).toBe('text-12.5');
  });

  it('knows exactly the font sizes and radii style.css defines in @theme', () => {
    expect(themeNames('text')).toEqual(RAMP);
    expect(themeNames('radius')).toEqual(RADII);
  });
});

describe('numeric size classes', () => {
  // Tailwind emits no rule for `text-<n>` or `rounded-<n>` without a matching @theme entry, so a missing one renders nothing.
  it('name only sizes and radii the @theme ramp defines', () => {
    const unknown: string[] = [];
    for (const file of [...sourceFiles(join(SRC, 'webview')), ...sourceFiles(join(SRC, 'desktop', 'shell'))]) {
      const text = readFileSync(file, 'utf8');
      for (const [match, size] of text.matchAll(/(?<![\w-])text-(\d+(?:\.\d+)?)(?![\w.])/g)) {
        if (!RAMP.includes(size!)) unknown.push(`${relative(SRC, file)}: ${match}`);
      }
      for (const [match, radius] of text.matchAll(/(?<![\w-])rounded(?:-[trblxyse]{1,2})?-(\d+(?:\.\d+)?)(?![\w.])/g)) {
        if (!RADII.includes(radius!)) unknown.push(`${relative(SRC, file)}: ${match}`);
      }
    }
    expect(unknown).toEqual([]);
  });
});
