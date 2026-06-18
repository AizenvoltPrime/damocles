import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { WorkspaceAgentRegistry } from '../workspace-agent-registry';
import { DEFAULT_AGENT_NAMES } from '../types';
import type { ParseFrontmatter } from '../custom-agents';

/** Minimal YAML-ish frontmatter parser for the tests (key: value, with bool/number coercion). */
const parseFrontmatter: ParseFrontmatter = ((content: string) => {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
  const fm: Record<string, unknown> = {};
  if (m) {
    for (const line of m[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const raw = line.slice(idx + 1).trim();
      fm[key] = raw === 'true' ? true : raw === 'false' ? false : /^-?\d+$/.test(raw) ? Number(raw) : raw;
    }
  }
  return { frontmatter: fm, body: m ? m[2] : content };
}) as ParseFrontmatter;

let cwd: string;
let home: string;
let registry: WorkspaceAgentRegistry | null = null;

function writeAgentAt(base: string, dir: string, name: string, frontmatter: string, body = 'BODY'): void {
  mkdirSync(join(base, dir), { recursive: true });
  writeFileSync(join(base, dir, `${name}.md`), `---\n${frontmatter}\n---\n${body}`);
}

function writeAgent(dir: string, name: string, frontmatter: string, body = 'BODY'): void {
  writeAgentAt(cwd, dir, name, frontmatter, body);
}

/** Construct with the test's isolated home dir so real `~/.claude/agents` is never scanned. */
function makeRegistry(): WorkspaceAgentRegistry {
  registry = new WorkspaceAgentRegistry(cwd, parseFrontmatter, { homeDir: home });
  return registry;
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'damocles-ws-agents-'));
  home = mkdtempSync(join(tmpdir(), 'damocles-ws-home-'));
});
afterEach(() => {
  registry?.dispose();
  registry = null;
  // Restore the mock's default so a flipped trust state can't leak into other tests.
  (vscode.workspace as { isTrusted: boolean }).isTrusted = true;
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('WorkspaceAgentRegistry', () => {
  it('exposes the embedded default agents', () => {
    const names = makeRegistry().getRegistry().getAllTypes();
    for (const name of DEFAULT_AGENT_NAMES) expect(names).toContain(name);
  });

  it('merges project markdown agents in when the workspace is trusted', () => {
    (vscode.workspace as { isTrusted: boolean }).isTrusted = true;
    writeAgent('.pi/agents', 'Reviewer', 'description: Reviews code');
    const config = makeRegistry().getRegistry().getAgentConfig('Reviewer');
    expect(config?.description).toBe('Reviews code');
    expect(config?.source).toBe('project-pi');
  });

  it('trust-gates project markdown agents out when the workspace is untrusted', () => {
    (vscode.workspace as { isTrusted: boolean }).isTrusted = false;
    writeAgent('.pi/agents', 'Secret', 'description: untrusted');
    expect(makeRegistry().getRegistry().getAgentConfig('Secret')).toBeUndefined();
    // The embedded defaults are still present (trust gates only project scope).
    for (const name of DEFAULT_AGENT_NAMES) expect(registry!.getRegistry().getAllTypes()).toContain(name);
  });

  it('loads global agents (nested ~/.claude/agents) regardless of trust', () => {
    (vscode.workspace as { isTrusted: boolean }).isTrusted = false;
    writeAgentAt(home, '.claude/agents/engineering', 'engineering-ai', 'name: AI Engineer\ndescription: builds AI');
    const config = makeRegistry().getRegistry().getAgentConfig('AI Engineer');
    expect(config?.description).toBe('builds AI');
    expect(config?.source).toBe('global');
  });
});
