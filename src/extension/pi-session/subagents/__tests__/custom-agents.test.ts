import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCustomAgents, type ParseFrontmatter } from '../custom-agents';
import { AGENT_SCOPE_BY_SOURCE } from '../types';

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

/** Write an agent markdown file under a base dir (`<base>/<dir>/<fileName>.md`). */
function writeAgentAt(base: string, dir: string, fileName: string, frontmatter: string, body = 'BODY'): void {
  mkdirSync(join(base, dir), { recursive: true });
  writeFileSync(join(base, dir, `${fileName}.md`), `---\n${frontmatter}\n---\n${body}`);
}

/** Write a project-scope agent (under the temp cwd). */
function writeAgent(dir: string, fileName: string, frontmatter: string, body = 'BODY'): void {
  writeAgentAt(cwd, dir, fileName, frontmatter, body);
}

/** Load with the test's isolated home dir so real `~/.claude/agents` is never scanned. */
function load(includeProjectScope: boolean) {
  return loadCustomAgents(cwd, parseFrontmatter, { includeProjectScope, homeDir: home });
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'damocles-agents-'));
  home = mkdtempSync(join(tmpdir(), 'damocles-home-'));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('loadCustomAgents', () => {
  it('parses frontmatter fields and the body into an AgentConfig', () => {
    writeAgent('.pi/agents', 'Reviewer', 'description: Reviews code\nmodel: anthropic/claude-x\ntools: read, grep\nprompt_mode: append\nmax_turns: 5', 'REVIEW PROMPT');
    const a = load(true).get('Reviewer')!;
    expect(a.description).toBe('Reviews code');
    expect(a.model).toBe('anthropic/claude-x');
    expect(a.builtinToolNames).toEqual(['read', 'grep']);
    expect(a.promptMode).toBe('append');
    expect(a.maxTurns).toBe(5);
    expect(a.systemPrompt).toBe('REVIEW PROMPT');
    expect(a.source).toBe('project-pi');
  });

  it('tools: * yields undefined builtinToolNames (all tools)', () => {
    writeAgent('.pi/agents', 'Wild', 'description: d\ntools: *');
    const a = load(true).get('Wild')!;
    expect(a.builtinToolNames).toBeUndefined();
  });

  it('.pi/agents overrides .claude/agents for the same name', () => {
    writeAgent('.claude/agents', 'Dup', 'description: from claude');
    writeAgent('.pi/agents', 'Dup', 'description: from pi');
    const a = load(true).get('Dup')!;
    expect(a.description).toBe('from pi');
    expect(a.source).toBe('project-pi');
  });

  it('loads .claude/agents (Claude-Code compat) when .pi/agents has no override', () => {
    writeAgent('.claude/agents', 'Compat', 'description: claude agent');
    const a = load(true).get('Compat')!;
    expect(a.source).toBe('project-claude');
  });

  it('project-scope agents are NOT loaded when the workspace is untrusted', () => {
    writeAgent('.pi/agents', 'Secret', 'description: untrusted');
    writeAgent('.claude/agents', 'Secret2', 'description: untrusted');
    const agents = load(false);
    expect(agents.has('Secret')).toBe(false);
    expect(agents.has('Secret2')).toBe(false);
  });

  it('enabled: false marks the agent disabled', () => {
    writeAgent('.pi/agents', 'Off', 'description: d\nenabled: false');
    expect(load(true).get('Off')!.enabled).toBe(false);
  });

  it('keys agents on the frontmatter name, falling back to the filename stem', () => {
    writeAgent('.pi/agents', 'engineering-ai-engineer', 'name: AI Engineer\ndescription: builds AI');
    writeAgent('.pi/agents', 'no-name-field', 'description: keyed by filename');
    const agents = load(true);
    expect(agents.get('AI Engineer')?.description).toBe('builds AI');
    expect(agents.has('engineering-ai-engineer')).toBe(false);
    expect(agents.get('no-name-field')?.description).toBe('keyed by filename');
  });

  it('discovers global agents from ~/.claude/agents recursively (nested subfolders)', () => {
    writeAgentAt(home, '.claude/agents/engineering', 'engineering-backend', 'name: Backend Architect\ndescription: designs systems');
    const a = load(false).get('Backend Architect')!;
    expect(a.description).toBe('designs systems');
    expect(a.source).toBe('global');
  });

  it('records the absolute template filePath on each agent', () => {
    writeAgent('.pi/agents', 'tmpl', 'name: Tmpl\ndescription: d');
    const a = load(true).get('Tmpl')!;
    expect(a.filePath).toBe(join(cwd, '.pi/agents', 'tmpl.md'));
  });

  it('discovers global agents from the pi CLI dir (~/.pi/agent/agents)', () => {
    writeAgentAt(home, '.pi/agent/agents', 'planner', 'name: PiGlobal\ndescription: pi global agent');
    expect(load(false).get('PiGlobal')?.source).toBe('global');
  });

  it('project agents override global agents with the same name', () => {
    writeAgentAt(home, '.claude/agents', 'shared', 'name: Shared\ndescription: from global');
    writeAgent('.pi/agents', 'shared', 'name: Shared\ndescription: from project');
    const a = load(true).get('Shared')!;
    expect(a.description).toBe('from project');
    expect(a.source).toBe('project-pi');
  });

  it('.damocles/agents overrides both .claude/agents and .pi/agents for the same name', () => {
    writeAgent('.claude/agents', 'Dup', 'description: from claude');
    writeAgent('.pi/agents', 'Dup', 'description: from pi');
    writeAgent('.damocles/agents', 'Dup', 'description: from damocles');
    const a = load(true).get('Dup')!;
    expect(a.description).toBe('from damocles');
    expect(a.source).toBe('project-damocles');
  });

  it('~/.damocles/agents overrides ~/.claude/agents and ~/.pi/agent/agents for the same name', () => {
    writeAgentAt(home, '.claude/agents', 'shared', 'name: Shared\ndescription: from global claude');
    writeAgentAt(home, '.pi/agent/agents', 'shared', 'name: Shared\ndescription: from global pi');
    writeAgentAt(home, '.damocles/agents', 'shared', 'name: Shared\ndescription: from global damocles');
    const a = load(false).get('Shared')!;
    expect(a.description).toBe('from global damocles');
    expect(a.source).toBe('global');
  });

  it('project .damocles/agents is NOT loaded when untrusted, while ~/.damocles/agents still is', () => {
    writeAgent('.damocles/agents', 'ProjectOnly', 'description: untrusted');
    writeAgentAt(home, '.damocles/agents', 'GlobalOnly', 'description: from global damocles');
    const agents = load(false);
    expect(agents.has('ProjectOnly')).toBe(false);
    expect(agents.get('GlobalOnly')!.description).toBe('from global damocles');
    expect(agents.get('GlobalOnly')!.source).toBe('global');
  });

  it('discovers .damocles/agents recursively (nested subfolders)', () => {
    writeAgent('.damocles/agents/engineering', 'engineering-backend', 'name: Backend Architect\ndescription: designs systems');
    const a = load(true).get('Backend Architect')!;
    expect(a.description).toBe('designs systems');
    expect(a.source).toBe('project-damocles');
  });

  it('skips symlinked .md files under .damocles/agents while loading the real ones', () => {
    writeAgent('.damocles/agents', 'Real', 'description: a real file');
    const outside = mkdtempSync(join(tmpdir(), 'damocles-outside-'));
    try {
      writeAgentAt(outside, 'agents', 'Target', 'description: outside the workspace tree');
      let symlinkSupported = true;
      try {
        symlinkSync(join(outside, 'agents', 'Target.md'), join(cwd, '.damocles/agents', 'Linked.md'));
      } catch (err) {
        console.warn(`Skipping symlink-refusal test: symlink creation failed (${(err as Error).message})`);
        symlinkSupported = false;
      }
      if (!symlinkSupported) return;

      const agents = load(true);
      expect(agents.get('Real')!.description).toBe('a real file');
      expect(agents.has('Linked')).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('AGENT_SCOPE_BY_SOURCE', () => {
  // The @ menu and /context badge each agent through this map, so every source the loader can emit
  // has to land on the scope a user would read off the file's location.
  it('badges a loaded agent by where its file lives', () => {
    writeAgentAt(home, '.claude/agents', 'g1', 'name: GlobalClaude\ndescription: d');
    writeAgentAt(home, '.pi/agent/agents', 'g2', 'name: GlobalPi\ndescription: d');
    writeAgentAt(home, '.damocles/agents', 'g3', 'name: GlobalDamocles\ndescription: d');
    writeAgent('.claude/agents', 'p1', 'name: ProjectClaude\ndescription: d');
    writeAgent('.pi/agents', 'p2', 'name: ProjectPi\ndescription: d');
    writeAgent('.damocles/agents', 'p3', 'name: ProjectDamocles\ndescription: d');

    const agents = load(true);
    const scopeOf = (name: string) => AGENT_SCOPE_BY_SOURCE[agents.get(name)!.source!];

    expect(scopeOf('GlobalClaude')).toBe('user');
    expect(scopeOf('GlobalPi')).toBe('user');
    expect(scopeOf('GlobalDamocles')).toBe('user');
    expect(scopeOf('ProjectClaude')).toBe('project');
    expect(scopeOf('ProjectPi')).toBe('project');
    expect(scopeOf('ProjectDamocles')).toBe('project');
  });

  it('badges an agent carrying no source as user scope', () => {
    expect(AGENT_SCOPE_BY_SOURCE['default']).toBe('user');
  });
});
