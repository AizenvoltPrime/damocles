import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, promises as fsPromises, type PathLike } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadCustomAgents, type ParseFrontmatter } from '../custom-agents';
import { AGENT_SCOPE_BY_SOURCE } from '../types';
import { folderOnAdminShare } from '../../../../__mocks__/admin-share';
import { log } from '../../../logger';

vi.mock('../../../logger', () => ({ log: vi.fn() }));

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
async function load(includeProjectScope: boolean) {
  return (await loadCustomAgents(cwd, parseFrontmatter, { includeProjectScope, homeDir: home })).agents;
}

beforeEach(() => {
  vi.mocked(log).mockClear();
  cwd = mkdtempSync(join(tmpdir(), 'damocles-agents-'));
  home = mkdtempSync(join(tmpdir(), 'damocles-home-'));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('loadCustomAgents', () => {
  it.runIf(process.platform === 'win32')('loads the agents of a ~/.damocles moved onto a share, judged from that folder (win32)', async (ctx) => {
    const real = folderOnAdminShare(ctx, join(home, '.damocles'));
    try {
      writeAgentAt(real, 'agents', 'shared', 'name: Shared\ndescription: on the share');
      expect((await load(false)).get('Shared')?.description).toBe('on the share');
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });

  it('parses frontmatter fields and the body into an AgentConfig', async () => {
    writeAgent('.pi/agents', 'Reviewer', 'description: Reviews code\nmodel: anthropic/claude-x\ntools: read, grep\nprompt_mode: append\nmax_turns: 5', 'REVIEW PROMPT');
    const a = (await load(true)).get('Reviewer')!;
    expect(a.description).toBe('Reviews code');
    expect(a.model).toBe('anthropic/claude-x');
    expect(a.builtinToolNames).toEqual(['read', 'grep']);
    expect(a.promptMode).toBe('append');
    expect(a.maxTurns).toBe(5);
    expect(a.systemPrompt).toBe('REVIEW PROMPT');
    expect(a.source).toBe('project-pi');
  });

  it('tools: * yields undefined builtinToolNames (all tools)', async () => {
    writeAgent('.pi/agents', 'Wild', 'description: d\ntools: *');
    const a = (await load(true)).get('Wild')!;
    expect(a.builtinToolNames).toBeUndefined();
  });

  it('.pi/agents overrides .claude/agents for the same name', async () => {
    writeAgent('.claude/agents', 'Dup', 'description: from claude');
    writeAgent('.pi/agents', 'Dup', 'description: from pi');
    const a = (await load(true)).get('Dup')!;
    expect(a.description).toBe('from pi');
    expect(a.source).toBe('project-pi');
  });

  it('loads .claude/agents (Claude-Code compat) when .pi/agents has no override', async () => {
    writeAgent('.claude/agents', 'Compat', 'description: claude agent');
    const a = (await load(true)).get('Compat')!;
    expect(a.source).toBe('project-claude');
  });

  it('project-scope agents are NOT loaded when the workspace is untrusted', async () => {
    writeAgent('.pi/agents', 'Secret', 'description: untrusted');
    writeAgent('.claude/agents', 'Secret2', 'description: untrusted');
    const agents = (await load(false));
    expect(agents.has('Secret')).toBe(false);
    expect(agents.has('Secret2')).toBe(false);
  });

  it('enabled: false marks the agent disabled', async () => {
    writeAgent('.pi/agents', 'Off', 'description: d\nenabled: false');
    expect((await load(true)).get('Off')!.enabled).toBe(false);
  });

  it('keys agents on the frontmatter name, falling back to the filename stem', async () => {
    writeAgent('.pi/agents', 'engineering-ai-engineer', 'name: AI Engineer\ndescription: builds AI');
    writeAgent('.pi/agents', 'no-name-field', 'description: keyed by filename');
    const agents = (await load(true));
    expect(agents.get('AI Engineer')?.description).toBe('builds AI');
    expect(agents.has('engineering-ai-engineer')).toBe(false);
    expect(agents.get('no-name-field')?.description).toBe('keyed by filename');
  });

  it('discovers global agents from ~/.claude/agents recursively (nested subfolders)', async () => {
    writeAgentAt(home, '.claude/agents/engineering', 'engineering-backend', 'name: Backend Architect\ndescription: designs systems');
    const a = (await load(false)).get('Backend Architect')!;
    expect(a.description).toBe('designs systems');
    expect(a.source).toBe('global');
  });

  it('records the absolute template filePath on each agent', async () => {
    writeAgent('.pi/agents', 'tmpl', 'name: Tmpl\ndescription: d');
    const a = (await load(true)).get('Tmpl')!;
    expect(a.filePath).toBe(join(cwd, '.pi/agents', 'tmpl.md'));
  });

  it('discovers global agents from the pi CLI dir (~/.pi/agent/agents)', async () => {
    writeAgentAt(home, '.pi/agent/agents', 'planner', 'name: PiGlobal\ndescription: pi global agent');
    expect((await load(false)).get('PiGlobal')?.source).toBe('global');
  });

  it('project agents override global agents with the same name', async () => {
    writeAgentAt(home, '.claude/agents', 'shared', 'name: Shared\ndescription: from global');
    writeAgent('.pi/agents', 'shared', 'name: Shared\ndescription: from project');
    const a = (await load(true)).get('Shared')!;
    expect(a.description).toBe('from project');
    expect(a.source).toBe('project-pi');
  });

  it('.damocles/agents overrides both .claude/agents and .pi/agents for the same name', async () => {
    writeAgent('.claude/agents', 'Dup', 'description: from claude');
    writeAgent('.pi/agents', 'Dup', 'description: from pi');
    writeAgent('.damocles/agents', 'Dup', 'description: from damocles');
    const a = (await load(true)).get('Dup')!;
    expect(a.description).toBe('from damocles');
    expect(a.source).toBe('project-damocles');
  });

  it('~/.damocles/agents overrides ~/.claude/agents and ~/.pi/agent/agents for the same name', async () => {
    writeAgentAt(home, '.claude/agents', 'shared', 'name: Shared\ndescription: from global claude');
    writeAgentAt(home, '.pi/agent/agents', 'shared', 'name: Shared\ndescription: from global pi');
    writeAgentAt(home, '.damocles/agents', 'shared', 'name: Shared\ndescription: from global damocles');
    const a = (await load(false)).get('Shared')!;
    expect(a.description).toBe('from global damocles');
    expect(a.source).toBe('global');
  });

  it('project .damocles/agents is NOT loaded when untrusted, while ~/.damocles/agents still is', async () => {
    writeAgent('.damocles/agents', 'ProjectOnly', 'description: untrusted');
    writeAgentAt(home, '.damocles/agents', 'GlobalOnly', 'description: from global damocles');
    const agents = (await load(false));
    expect(agents.has('ProjectOnly')).toBe(false);
    expect(agents.get('GlobalOnly')!.description).toBe('from global damocles');
    expect(agents.get('GlobalOnly')!.source).toBe('global');
  });

  it('discovers .damocles/agents recursively (nested subfolders)', async () => {
    writeAgent('.damocles/agents/engineering', 'engineering-backend', 'name: Backend Architect\ndescription: designs systems');
    const a = (await load(true)).get('Backend Architect')!;
    expect(a.description).toBe('designs systems');
    expect(a.source).toBe('project-damocles');
  });

});

// A file symlink needs a privilege unprivileged Windows lacks, so the tests that make one report a skip there.
const canSymlinkFiles = ((): boolean => {
  const dir = mkdtempSync(join(tmpdir(), 'damocles-probe-'));
  try {
    writeFileSync(join(dir, 'target'), '');
    symlinkSync(join(dir, 'target'), join(dir, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

function link(target: string, at: string, type: 'file' | 'junction' | 'dir'): void {
  mkdirSync(dirname(at), { recursive: true });
  symlinkSync(target, at, type);
}

const folderLink = (target: string, at: string): void => link(target, at, process.platform === 'win32' ? 'junction' : 'dir');

describe('loadCustomAgents through links', () => {
  let outside: string;
  beforeEach(() => {
    outside = mkdtempSync(join(tmpdir(), 'damocles-outside-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(outside, { recursive: true, force: true });
  });

  it.skipIf(!canSymlinkFiles)('loads a linked .md file in a trusted project, next to the real ones', async () => {
    writeAgent('.damocles/agents', 'Real', 'description: a real file');
    writeAgentAt(outside, 'agents', 'Target', 'name: Linked\ndescription: outside the workspace tree');
    link(join(outside, 'agents', 'Target.md'), join(cwd, '.damocles/agents', 'Linked.md'), 'file');

    const agents = await load(true);
    expect(agents.get('Real')!.description).toBe('a real file');
    expect(agents.get('Linked')!.description).toBe('outside the workspace tree');
    expect(agents.get('Linked')!.filePath).toBe(join(cwd, '.damocles/agents', 'Linked.md'));
  });

  it('loads every agent of a linked subfolder of ~/.claude/agents', async () => {
    writeAgentAt(outside, 'agents', 'eng', 'name: Eng\ndescription: from the clone');
    folderLink(join(outside, 'agents'), join(home, '.claude', 'agents', 'eng'));

    expect((await load(false)).get('Eng')!.description).toBe('from the clone');
  });

  it('loads a linked ~/.claude/agents root, and the agents of a linked ~/.claude', async () => {
    writeAgentAt(outside, 'agents', 'rooted', 'name: Rooted\ndescription: linked root');
    folderLink(join(outside, 'agents'), join(home, '.claude', 'agents'));
    expect((await load(false)).get('Rooted')!.description).toBe('linked root');

    rmSync(join(home, '.claude'), { recursive: true, force: true });
    folderLink(outside, join(home, '.claude'));
    expect((await load(false)).get('Rooted')!.description).toBe('linked root');
  });

  it('keys an agent by its name, so the highest-precedence folder wins one file two agents folders link', async () => {
    writeAgentAt(outside, 'agents', 'reviewer', 'name: Reviewer\ndescription: from the dotfiles');
    writeAgentAt(home, '.pi/agent/agents', 'reviewer', 'name: Reviewer\ndescription: from pi');
    folderLink(join(outside, 'agents'), join(home, '.claude', 'agents'));
    folderLink(join(outside, 'agents'), join(home, '.damocles', 'agents'));

    const reviewer = (await load(false)).get('Reviewer')!;

    expect([reviewer.description, reviewer.filePath]).toEqual(['from the dotfiles', join(home, '.damocles', 'agents', 'reviewer.md')]);
  });

  it.skipIf(!canSymlinkFiles)('keeps the last in name order of two links in one folder to one agent folder, and loads a renamed link as an agent of its own', async () => {
    writeAgentAt(outside, 'agents', 'one', 'name: One\ndescription: d');
    writeAgentAt(outside, 'agents', 'unnamed', 'description: no name field');
    folderLink(join(outside, 'agents'), join(home, '.claude', 'agents', 'a'));
    folderLink(join(outside, 'agents'), join(home, '.claude', 'agents', 'b'));
    link(join(outside, 'agents', 'unnamed.md'), join(home, '.claude', 'agents', 'alias.md'), 'file');

    const agents = await load(false);

    expect(agents.get('One')!.filePath).toBe(join(home, '.claude', 'agents', 'b', 'one.md'));
    expect([...agents.keys()].sort()).toEqual(['One', 'alias', 'unnamed']);
  });

  it.skipIf(!canSymlinkFiles)('loads a project agent linked to a user agent file as the project agent', async () => {
    writeAgentAt(home, '.claude/agents', 'x', 'name: X\ndescription: d');
    link(join(home, '.claude', 'agents', 'x.md'), join(cwd, '.damocles', 'agents', 'x.md'), 'file');

    const x = (await load(true)).get('X')!;

    expect([x.source, x.filePath]).toEqual(['project-damocles', join(cwd, '.damocles', 'agents', 'x.md')]);
  });

  it('ends a link loop and keeps loading the rest', async () => {
    writeAgentAt(home, '.claude/agents', 'kept', 'name: Kept\ndescription: d');
    folderLink(join(home, '.claude', 'agents'), join(home, '.claude', 'agents', 'loop'));
    folderLink(join(home, '.claude', 'agents'), join(home, '.claude', 'agents', 'loop2'));

    expect((await load(false)).get('Kept')!.description).toBe('d');
  });

  it('reads no project agents folder while untrusted, whatever it links to', async () => {
    writeAgentAt(outside, 'agents', 'Target', 'name: Linked\ndescription: d');
    folderLink(join(outside, 'agents'), join(cwd, '.damocles', 'agents'));

    expect((await load(false)).has('Linked')).toBe(false);
  });

  it('skips and logs a file whose frontmatter does not parse, a file over 1 MiB and a broken link, and loads the rest', async () => {
    writeAgentAt(home, '.claude/agents', 'kept', 'name: Kept\ndescription: d');
    writeAgentAt(home, '.claude/agents', 'bad', 'name: Bad\ndescription: d');
    writeAgentAt(home, '.claude/agents', 'big', 'name: Big\ndescription: d', 'x'.repeat(1024 * 1024));
    folderLink(join(outside, 'gone'), join(home, '.claude', 'agents', 'eng'));
    const throwing = ((content: string) => {
      if (content.includes('name: Bad')) throw new Error('bad YAML');
      return parseFrontmatter(content);
    }) as ParseFrontmatter;

    const { agents } = await loadCustomAgents(cwd, throwing, { includeProjectScope: false, homeDir: home });

    expect([...agents.keys()]).toEqual(['Kept']);
    expect(vi.mocked(log)).toHaveBeenCalledWith('%s', `[assets] ${join(home, '.claude', 'agents', 'bad.md')}: bad YAML`);
    expect(vi.mocked(log)).toHaveBeenCalledWith('%s', `[assets] ${join(home, '.claude', 'agents', 'big.md')}: tooLarge`);
    expect(vi.mocked(log)).toHaveBeenCalledWith('%s', `[assets] ${join(home, '.claude', 'agents', 'eng')}: broken link to ${join(outside, 'gone')}`);
  });

  // readlink faked onto a share stands for a link Windows would follow there
  it.runIf(process.platform === 'win32')('skips a link onto a share or WSL without touching its target', async () => {
    writeAgentAt(home, '.claude/agents', 'kept', 'name: Kept\ndescription: d');
    writeAgentAt(outside, '', 'remote', 'name: Remote\ndescription: on the share');
    const nas = join(home, '.claude', 'agents', 'nas');
    const wsl = join(home, '.claude', 'agents', 'wsl');
    folderLink(outside, nas);
    folderLink(outside, wsl);
    const fake = new Map([
      [nas.toLowerCase(), '\\\\host\\share\\agents'],
      [wsl.toLowerCase(), '\\\\wsl.localhost\\Ubuntu\\agents'],
    ]);
    const unc: string[] = [];
    const readlink = fsPromises.readlink.bind(fsPromises);
    vi.spyOn(fsPromises, 'readlink').mockImplementation((async (file: PathLike) => fake.get(String(file).toLowerCase()) ?? readlink(file)) as never);
    for (const name of ['lstat', 'stat', 'realpath', 'open', 'readdir'] as const) {
      const original = fsPromises[name].bind(fsPromises) as (...args: unknown[]) => Promise<unknown>;
      vi.spyOn(fsPromises, name).mockImplementation((async (file: PathLike, ...rest: unknown[]) => {
        if (/^[\\/]{2}/.test(String(file))) unc.push(String(file));
        return original(file, ...rest);
      }) as never);
    }

    const agents = await load(false);
    expect(agents.get('Kept')!.description).toBe('d');
    expect(agents.has('Remote')).toBe(false);
    expect(unc).toEqual([]);
    expect(vi.mocked(log)).toHaveBeenCalledWith('%s', `[assets] ${nas}: share`);
    expect(vi.mocked(log)).toHaveBeenCalledWith('%s', `[assets] ${wsl}: share`);
  });
});

describe('AGENT_SCOPE_BY_SOURCE', () => {
  // The @ menu and /context badge each agent through this map, so every source the loader can emit
  // has to land on the scope a user would read off the file's location.
  it('badges a loaded agent by where its file lives', async () => {
    writeAgentAt(home, '.claude/agents', 'g1', 'name: GlobalClaude\ndescription: d');
    writeAgentAt(home, '.pi/agent/agents', 'g2', 'name: GlobalPi\ndescription: d');
    writeAgentAt(home, '.damocles/agents', 'g3', 'name: GlobalDamocles\ndescription: d');
    writeAgent('.claude/agents', 'p1', 'name: ProjectClaude\ndescription: d');
    writeAgent('.pi/agents', 'p2', 'name: ProjectPi\ndescription: d');
    writeAgent('.damocles/agents', 'p3', 'name: ProjectDamocles\ndescription: d');

    const agents = (await load(true));
    const scopeOf = (name: string) => AGENT_SCOPE_BY_SOURCE[agents.get(name)!.source!];

    expect(scopeOf('GlobalClaude')).toBe('user');
    expect(scopeOf('GlobalPi')).toBe('user');
    expect(scopeOf('GlobalDamocles')).toBe('user');
    expect(scopeOf('ProjectClaude')).toBe('project');
    expect(scopeOf('ProjectPi')).toBe('project');
    expect(scopeOf('ProjectDamocles')).toBe('project');
  });

  it('badges an agent carrying no source as user scope', async () => {
    expect(AGENT_SCOPE_BY_SOURCE['default']).toBe('user');
  });
});
