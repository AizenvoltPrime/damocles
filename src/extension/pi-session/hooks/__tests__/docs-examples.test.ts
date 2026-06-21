import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { stripJsonComments } from '../config';
import { hookConfigSchema } from '../types';

/** Pull every ```jsonc fenced block that defines a top-level `hooks` object out of a markdown file. */
function hooksJsoncBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const fence = /```jsonc\r?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(markdown)) !== null) {
    if (m[1].includes('"hooks"')) blocks.push(m[1]);
  }
  return blocks;
}

describe('hooks docs examples (US-011)', () => {
  const repoRoot = path.resolve(__dirname, '../../../../..');
  const docPaths = [path.join(repoRoot, 'docs', 'hooks.md'), path.join(repoRoot, 'README.md')];

  it.each(docPaths)('every hooks.json example in %s validates against the US-001 zod schema', (docPath) => {
    const markdown = fs.readFileSync(docPath, 'utf-8');
    const blocks = hooksJsoncBlocks(markdown);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      const parsed = JSON.parse(stripJsonComments(block));
      const result = hookConfigSchema.safeParse(parsed);
      expect(result.success, `invalid example:\n${block}`).toBe(true);
    }
  });
});
