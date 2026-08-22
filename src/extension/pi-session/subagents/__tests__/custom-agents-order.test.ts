import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Directory enumeration order is filesystem-dependent, so the loader must not inherit it. Reversing
// readdirSync here makes an unsorted loader pick the other file and fail.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const readdirSync = (...args: Parameters<typeof actual.readdirSync>) =>
    [...actual.readdirSync(...args)].reverse();
  return { ...actual, readdirSync, default: { ...actual, readdirSync } };
});

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCustomAgents, type ParseFrontmatter } from '../custom-agents';

/** Minimal YAML-ish frontmatter parser for the tests (key: value, with bool/number coercion). */
const parseFrontmatter: ParseFrontmatter = ((content: string) => {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
  const fm: Record<string, unknown> = {};
  if (m?.[1] !== undefined) {
    for (const line of m[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return { frontmatter: fm, body: m ? m[2] : content };
}) as ParseFrontmatter;

let cwd = '';
let home = '';

function writeAgent(dir: string, fileName: string, frontmatter: string): void {
  mkdirSync(join(cwd, dir), { recursive: true });
  writeFileSync(join(cwd, dir, `${fileName}.md`), `---\n${frontmatter}\n---\nBODY`);
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'damocles-agent-order-'));
  home = mkdtempSync(join(tmpdir(), 'damocles-agent-order-home-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('loadCustomAgents intra-directory ordering', () => {
  it('resolves a duplicate name in one directory to the alphabetically last file', () => {
    writeAgent('.pi/agents', 'a-first', 'name: Dup\ndescription: from a-first');
    writeAgent('.pi/agents', 'z-last', 'name: Dup\ndescription: from z-last');

    const agents = loadCustomAgents(cwd, parseFrontmatter, {
      includeProjectScope: true,
      homeDir: home,
    });
    expect(agents.get('Dup')?.description).toBe('from z-last');
    expect(agents.get('Dup')?.filePath).toBe(join(cwd, '.pi/agents', 'z-last.md'));
  });

  it('resolves a duplicate name across sibling subdirectories deterministically', () => {
    writeAgent('.pi/agents/aaa', 'one', 'name: Dup\ndescription: from aaa');
    writeAgent('.pi/agents/zzz', 'one', 'name: Dup\ndescription: from zzz');

    const agents = loadCustomAgents(cwd, parseFrontmatter, {
      includeProjectScope: true,
      homeDir: home,
    });
    expect(agents.get('Dup')?.description).toBe('from zzz');
  });

  it('keeps distinct names regardless of enumeration order', () => {
    writeAgent('.pi/agents', 'a-first', 'name: Alpha\ndescription: a');
    writeAgent('.pi/agents', 'z-last', 'name: Zulu\ndescription: z');

    const agents = loadCustomAgents(cwd, parseFrontmatter, {
      includeProjectScope: true,
      homeDir: home,
    });
    expect([...agents.keys()].sort()).toEqual(['Alpha', 'Zulu']);
  });
});
