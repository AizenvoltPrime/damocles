import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PALETTES } from '@shared/themes/builtin';
import { fromOklch } from '@shared/themes/color';
import { contrast, NON_TEXT } from '@shared/themes/contrast';

// The selected project's mark (a letter's ring, a character's outline) is a graphical object, so it keeps 3:1 against the
// sidebar pane at every avatar hue (WCAG 1.4.11). The values are read from the stylesheet, which is their only source.
const css = fs.readFileSync(path.resolve(__dirname, '../style.css'), 'utf8');

function markOf(prefix: string): { l: number; c: number } {
  const found = new RegExp(`${prefix}\\.project-avatar,\\s*${prefix}\\.project-character\\s*\\{\\s*--avatar-mark:\\s*oklch\\(([\\d.]+) ([\\d.]+) var\\(--avatar-hue\\)\\);\\s*\\}`).exec(css);
  if (!found) throw new Error(`no --avatar-mark rule for "${prefix}"`);
  return { l: Number(found[1]), c: Number(found[2]) };
}

const HUES = Array.from({ length: 360 }, (_, hue) => hue);

describe('the selection mark of a project avatar', () => {
  it.each([
    ['dark', markOf('')],
    ['light', markOf(':where\\(\\.vscode-light\\) ')],
  ] as const)('keeps 3:1 against the %s sidebar pane at every hue', (kind, mark) => {
    const pane = BUILTIN_PALETTES[kind]['--d-pane-sidebar']!;
    const low = HUES.map((h) => ({ h, ratio: contrast(fromOklch({ ...mark, h }), pane) })).filter(({ ratio }) => ratio < NON_TEXT);
    expect(low).toEqual([]);
  });

  it('has one hue and chroma in both palettes', () => {
    expect(markOf(':where\\(\\.vscode-light\\) ').c).toBe(markOf('').c);
  });
});
