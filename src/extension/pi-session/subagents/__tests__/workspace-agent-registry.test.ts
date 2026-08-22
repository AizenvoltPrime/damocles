import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { FakeFileSystemWatcher, __trustEmitter } from 'vscode';
import { WorkspaceAgentRegistry } from '../workspace-agent-registry';
import { DEFAULT_AGENT_NAMES } from '../types';
import type { ParseFrontmatter } from '../custom-agents';

/** Minimal YAML-ish frontmatter parser for the tests (key: value, with bool/number coercion). */
const parseFrontmatter: ParseFrontmatter = ((content: string) => {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
  const fm: Record<string, unknown> = {};
  if (m?.[1] !== undefined) {
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
  __trustEmitter.clear();
});
afterEach(() => {
  registry?.dispose();
  registry = null;
  __trustEmitter.clear();
  // Restore the mock's default so a flipped trust state can't leak into other tests.
  vscode.__setTrusted(true);
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('WorkspaceAgentRegistry', () => {
  it('exposes the embedded default agents', () => {
    const names = makeRegistry().getRegistry().getAllTypes();
    for (const name of DEFAULT_AGENT_NAMES) expect(names).toContain(name);
  });

  it('merges project markdown agents in when the workspace is trusted', () => {
    vscode.__setTrusted(true);
    writeAgent('.pi/agents', 'Reviewer', 'description: Reviews code');
    const config = makeRegistry().getRegistry().getAgentConfig('Reviewer');
    expect(config?.description).toBe('Reviews code');
    expect(config?.source).toBe('project-pi');
  });

  it('trust-gates project markdown agents out when the workspace is untrusted', () => {
    vscode.__setTrusted(false);
    writeAgent('.pi/agents', 'Secret', 'description: untrusted');
    expect(makeRegistry().getRegistry().getAgentConfig('Secret')).toBeUndefined();
    // The embedded defaults are still present (trust gates only project scope).
    for (const name of DEFAULT_AGENT_NAMES) expect(registry!.getRegistry().getAllTypes()).toContain(name);
  });

  it('loads global agents (nested ~/.claude/agents) regardless of trust', () => {
    vscode.__setTrusted(false);
    writeAgentAt(home, '.claude/agents/engineering', 'engineering-ai', 'name: AI Engineer\ndescription: builds AI');
    const config = makeRegistry().getRegistry().getAgentConfig('AI Engineer');
    expect(config?.description).toBe('builds AI');
    expect(config?.source).toBe('global');
  });

  it('watches every discovery dir, including both .damocles dirs', () => {
    const patterns: unknown[] = [];
    const createWatcher = vi
      .spyOn(vscode.workspace, 'createFileSystemWatcher')
      // The fake emits `{ fsPath }` rather than full `Uri` objects, so it is not structurally a
      // `FileSystemWatcher` even though every method the code under test calls is present.
      .mockImplementation(((globPattern: vscode.GlobPattern) => {
        patterns.push(globPattern);
        return new FakeFileSystemWatcher();
      }) as unknown as typeof vscode.workspace.createFileSystemWatcher);
    makeRegistry();

    // A bare glob string reports no events from a directory outside the workspace folders, so every
    // global dir has to be watched through a pattern anchored on its own Uri.
    expect(patterns.filter((p) => !(p instanceof vscode.RelativePattern))).toEqual([]);

    // The mock keeps `RelativePattern.base` as the constructor argument (VS Code normalizes it to a
    // path string), which is what lets an assertion tell a Uri-anchored pattern from a bare glob.
    const bases = patterns.map((p) => (p as unknown as { base: { fsPath: string } }).base.fsPath);
    expect(bases).toEqual([
      join(home, '.claude', 'agents'),
      join(home, '.pi', 'agent', 'agents'),
      join(home, '.damocles', 'agents'),
      join(cwd, '.claude', 'agents'),
      join(cwd, '.pi', 'agents'),
      join(cwd, '.damocles', 'agents'),
    ]);
    createWatcher.mockRestore();
  });

  it('merges .damocles project agents in when the workspace is trusted', () => {
    vscode.__setTrusted(true);
    writeAgent('.damocles/agents', 'Reviewer', 'description: Reviews code');
    const config = makeRegistry().getRegistry().getAgentConfig('Reviewer');
    expect(config?.description).toBe('Reviews code');
    expect(config?.source).toBe('project-damocles');
  });

  it('trust-gates .damocles project agents out when the workspace is untrusted', () => {
    vscode.__setTrusted(false);
    writeAgent('.damocles/agents', 'Reviewer', 'description: Reviews code');
    expect(makeRegistry().getRegistry().getAgentConfig('Reviewer')).toBeUndefined();
  });

  it('surfaces project agents when the user grants trust, with no window reload', () => {
    vscode.__setTrusted(false);
    writeAgent('.damocles/agents', 'Reviewer', 'description: Reviews code');
    const reg = makeRegistry();
    expect(reg.getRegistry().getAgentConfig('Reviewer')).toBeUndefined();

    vscode.__setTrusted(true);
    __trustEmitter.fire();

    expect(reg.getRegistry().getAgentConfig('Reviewer')?.description).toBe('Reviews code');
  });

  it('stops reloading on a trust grant once disposed', () => {
    vscode.__setTrusted(false);
    writeAgent('.damocles/agents', 'Reviewer', 'description: Reviews code');
    const reg = makeRegistry();
    reg.dispose();
    registry = null;

    vscode.__setTrusted(true);
    __trustEmitter.fire();

    expect(reg.getRegistry().getAgentConfig('Reviewer')).toBeUndefined();
  });
});
