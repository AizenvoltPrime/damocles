import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// docs/invariants.md "A wallpaper shows through pane tokens": a block of the transcript that touches the wallpaper paints
// its ground at the look's surface alpha (a --surface-* token), and a pane nested inside such a block stays opaque, since
// two alphas would compound to an opacity nobody set.

const COMPONENTS = path.resolve(__dirname, '..', 'components');
const source = (file: string): string => fs.readFileSync(path.join(COMPONENTS, file), 'utf8');

/** The declarations of the first rule in `text` whose selector holds `selector`. */
function rule(text: string, selector: string): string {
  const start = text.indexOf(selector);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return text.slice(text.indexOf('{', start), text.indexOf('}', start));
}

/** The class attribute of the tag that carries `marker`. */
function tagClasses(text: string, marker: string): string {
  const at = text.indexOf(marker);
  expect(at, marker).toBeGreaterThanOrEqual(0);
  const tag = text.slice(text.lastIndexOf('<', at), text.indexOf('>', at));
  return /\bclass="([^"]*)"/.exec(tag)?.[1] ?? '';
}

describe('surfaces over a wallpaper', () => {
  it.each([
    ['ToolCardFrame.vue', 'data-testid="tool-card-frame"', 'bg-(--surface-card)'],
    ['SubagentCard.vue', 'data-testid="subagent-card"', 'bg-(--surface-card)'],
    ['TeamCard.vue', 'data-testid="team-card"', 'bg-(--surface-card)'],
    ['ChatInput.vue', 'group/composer relative', 'bg-(--surface-input)'],
  ])('%s paints its ground at the surface alpha', (file, marker, ground) => {
    const classes = tagClasses(source(file), marker).split(/\s+/);
    expect(classes).toContain(ground);
    expect(classes.filter((name) => /^bg-\(--d-(?:card|code|input|panel|bg)\)$/.test(name))).toEqual([]);
  });

  it('paints the user bubble at the surface alpha in both of its tints', () => {
    const grounds = [...source('UserMessageBlock.vue').matchAll(/"(bg-[^"]+)"/g)].map(([, name]) => name!).filter((name) => name.includes('--surface-') || /--d-(?:card|code)\)/.test(name));
    expect(grounds).toHaveLength(2);
    for (const ground of grounds) expect(ground).toContain('--surface-card)');
  });

  it('paints a code block\'s header and body, a blockquote and a table at the surface alpha', () => {
    const code = source('CodeBlock.vue');
    expect(tagClasses(code, 'justify-between px-3 py-1.5').split(/\s+/)).toContain('bg-(--surface-card)');
    expect(rule(code, '.code-block-content {')).toContain('background: var(--surface-code);');
    const markdown = source('MarkdownRenderer.vue');
    expect(rule(markdown, ':deep(.markdown-blockquote)')).toContain('background: var(--surface-code);');
    expect(rule(markdown, ':deep(.table-wrapper)')).toContain('background: var(--surface-code);');
    // a header row is part of the table's surface, not a pane inside it: it tints the table's ground and never fills it
    expect(rule(markdown, ':deep(th) {')).toContain('background-color: color-mix(in srgb, var(--d-text) 8%, transparent);');
  });

  it.each([
    ['ToolCallCard.vue', 'group relative block w-full overflow-hidden'],
    ['DiffView.vue', 'data-testid="diff-view"'],
    ['LiveOutputPane.vue', 'role="log"'],
    ['LiveOutputPane.vue', 'role="status"'],
  ])('keeps the pane of %s (%s), which sits inside a tool card, opaque', (file, marker) => {
    const classes = tagClasses(source(file), marker).split(/\s+/);
    expect(classes).toContain('bg-(--d-code)');
    expect(classes.filter((name) => name.includes('--surface-'))).toEqual([]);
  });
});
