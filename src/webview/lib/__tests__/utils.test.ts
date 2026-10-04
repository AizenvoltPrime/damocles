import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cn } from '../utils';

const RAMP = ['10', '10.5', '11', '11.5', '12.5', '13', '13.5', '15'];

describe('cn', () => {
  it('keeps a reference font size beside a text colour, and lets a later size win', () => {
    for (const size of RAMP) expect(cn(`text-${size}`, 'text-(--d-faint)')).toBe(`text-${size} text-(--d-faint)`);
    expect(cn('text-sm', 'text-12.5')).toBe('text-12.5');
  });

  it('knows exactly the font sizes style.css defines in @theme', () => {
    const style = readFileSync(join(__dirname, '..', '..', 'style.css'), 'utf8');
    const defined = [...style.matchAll(/--text-([\d\\.]+):/g)].map(([, name]) => name!.replaceAll('\\', ''));
    expect(defined).toEqual(RAMP);
  });
});
