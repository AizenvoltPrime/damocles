import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// The user roots resolve through `os.homedir()` and `PI_AGENT_DIR`. Point both at temp dirs so a
// developer's real `~/.pi/skills` cannot decide the outcome of a test. `PI_AGENT_DIR` is a module
// constant, so the double is a getter that re-reads the current temp path on every access.
const H = vi.hoisted(() => ({ home: '', agentDir: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = () => (H.home !== '' ? H.home : actual.homedir());
  return { ...actual, homedir, default: { ...actual, homedir } };
});

vi.mock('../../agent-dir', () => ({
  get PI_AGENT_DIR(): string {
    return H.agentDir;
  },
}));

vi.mock('../../../logger', () => ({ log: vi.fn() }));

import { PI_AGENT_DIR } from '../../agent-dir';
import { folderOnAdminShare } from '../../../../__mocks__/admin-share';
import { log } from '../../../logger';
import { preloadSkills } from '../skill-loader';

let cwd = '';

/** Write `<root>/<name>/SKILL.md` holding `body`. */
function writeSkill(root: string, name: string, body: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body, 'utf8');
}

async function contentOf(name: string, includeProjectScope: boolean): Promise<string> {
  const loaded = await preloadSkills([name], cwd, { includeProjectScope });
  return loaded[0]?.content ?? '';
}

describe('preloadSkills trust gate', () => {
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'skill-loader-cwd-'));
    H.home = mkdtempSync(join(tmpdir(), 'skill-loader-home-'));
    H.agentDir = join(H.home, 'damocles', 'pi', 'agent');
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(H.home, { recursive: true, force: true });
    H.home = '';
    H.agentDir = '';
  });

  it('redirects PI_AGENT_DIR at the temp home, so the user roots under test are the temp ones', async () => {
    expect(PI_AGENT_DIR).toBe(join(H.home, 'damocles', 'pi', 'agent'));
  });

  // The loaded text is spliced straight into a subagent's system prompt, so an untrusted checkout must
  // not reach it through a user-authored agent's `skills:` field.
  it.each(['.pi/skills', '.agents/skills'])(
    'withholds <cwd>/%s when project scope is excluded',
    async (root) => {
      writeSkill(join(cwd, ...root.split('/')), 'deploy', 'HOSTILE PROJECT SKILL');

      expect(await contentOf('deploy', true)).toBe('HOSTILE PROJECT SKILL');
      expect(await contentOf('deploy', false)).not.toContain('HOSTILE');
    },
  );

  it.each(['.agents/skills', '.pi/skills'])(
    'still reads the user root ~/%s when project scope is excluded',
    async (root) => {
      writeSkill(join(H.home, ...root.split('/')), 'deploy', 'USER SKILL');

      expect(await contentOf('deploy', false)).toBe('USER SKILL');
    },
  );

  it('still reads the pi agent dir skills root when project scope is excluded', async () => {
    writeSkill(join(H.agentDir, 'skills'), 'deploy', 'AGENT DIR SKILL');

    expect(await contentOf('deploy', false)).toBe('AGENT DIR SKILL');
  });

  it('falls through a withheld project skill to the same-named user skill', async () => {
    writeSkill(join(cwd, '.pi', 'skills'), 'deploy', 'HOSTILE PROJECT SKILL');
    writeSkill(join(H.home, '.pi', 'skills'), 'deploy', 'USER SKILL');

    expect(await contentOf('deploy', true)).toBe('HOSTILE PROJECT SKILL');
    expect(await contentOf('deploy', false)).toBe('USER SKILL');
  });

  it('withholds a flat <cwd> skill file too', async () => {
    mkdirSync(join(cwd, '.pi', 'skills'), { recursive: true });
    writeFileSync(join(cwd, '.pi', 'skills', 'deploy.md'), 'HOSTILE FLAT SKILL', 'utf8');

    expect(await contentOf('deploy', true)).toBe('HOSTILE FLAT SKILL');
    expect(await contentOf('deploy', false)).not.toContain('HOSTILE');
  });

  it('names no project root in the not-found message when project scope is excluded', async () => {
    const message = await contentOf('missing', false);
    expect(message).toContain('not found');
    expect(message).not.toContain('.pi/skills/');
    expect(message).not.toContain('.agents/skills/');
  });

  it('names the project roots in the not-found message when project scope is included', async () => {
    const message = await contentOf('missing', true);
    expect(message).toContain('.pi/skills/');
    expect(message).toContain('.agents/skills/');
  });

  it('rejects a traversal-shaped name on both sides of the gate', async () => {
    for (const includeProjectScope of [true, false]) {
      expect(await contentOf('../escape', includeProjectScope)).toContain('path traversal');
    }
  });

  it('preserves the requested order and names when several skills are asked for', async () => {
    writeSkill(join(H.home, '.pi', 'skills'), 'alpha', 'A');
    writeSkill(join(H.home, '.pi', 'skills'), 'beta', 'B');

    const loaded = await preloadSkills(['beta', 'alpha'], cwd, { includeProjectScope: false });
    expect(loaded.map((s) => s.name)).toEqual(['beta', 'alpha']);
    expect(loaded.map((s) => s.content)).toEqual(['B', 'A']);
  });
});

// A folder link every host can make: a junction on Windows.
function folderLink(target: string, at: string): void {
  mkdirSync(dirname(at), { recursive: true });
  symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
}

describe('preloadSkills through links', () => {
  let outside = '';
  beforeEach(() => {
    vi.mocked(log).mockClear();
    cwd = mkdtempSync(join(tmpdir(), 'skill-loader-cwd-'));
    H.home = mkdtempSync(join(tmpdir(), 'skill-loader-home-'));
    H.agentDir = join(H.home, 'damocles', 'pi', 'agent');
    outside = mkdtempSync(join(tmpdir(), 'skill-loader-outside-'));
  });

  afterEach(() => {
    for (const dir of [cwd, H.home, outside]) rmSync(dir, { recursive: true, force: true });
    H.home = '';
    H.agentDir = '';
  });

  it.runIf(process.platform === 'win32')('judges links above the pi agent folder from the Damocles data folder, so a pi folder linked onto a share is not read (win32)', async (ctx) => {
    H.agentDir = join(H.home, '.damocles', 'pi', 'agent');
    const real = folderOnAdminShare(ctx, join(H.home, '.damocles', 'pi'));
    try {
      writeSkill(join(real, 'agent', 'skills'), 'deploy', 'ON THE SHARE');
      expect(await contentOf('deploy', false)).not.toBe('ON THE SHARE');
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });

  it('preloads a linked skill folder', async () => {
    writeSkill(outside, 'deploy', 'LINKED SKILL');
    folderLink(join(outside, 'deploy'), join(H.home, '.pi', 'skills', 'deploy'));

    expect(await contentOf('deploy', false)).toBe('LINKED SKILL');
  });

  it('preloads a skill under a linked skills root and under a linked folder of skills', async () => {
    writeSkill(join(outside, 'set'), 'deploy', 'NESTED SKILL');
    folderLink(join(outside, 'set'), join(H.home, '.agents', 'skills', 'team'));
    expect(await contentOf('deploy', false)).toBe('NESTED SKILL');

    rmSync(join(H.home, '.agents'), { recursive: true, force: true });
    folderLink(join(outside, 'set'), join(H.home, '.agents', 'skills'));
    expect(await contentOf('deploy', false)).toBe('NESTED SKILL');
  });

  it('ends a link loop in a skills root and still finds the skill', async () => {
    const root = join(H.home, '.pi', 'skills');
    writeSkill(root, 'deploy', 'REAL SKILL');
    folderLink(root, join(root, 'loop'));
    folderLink(root, join(root, 'loop2'));

    expect(await contentOf('deploy', false)).toBe('REAL SKILL');
  });

  it('never treats a SKILL.md below another skill as a skill', async () => {
    const root = join(H.home, '.pi', 'skills');
    writeSkill(root, 'outer', 'OUTER');
    writeSkill(join(root, 'outer'), 'deploy', 'NESTED');

    expect(await contentOf('deploy', false)).toContain('not found');
  });

  it('reads nothing inside a skill folder, so a large folder in one skill hides no skill after it', async () => {
    const root = join(H.home, '.pi', 'skills');
    writeSkill(root, 'a-big', 'BIG');
    mkdirSync(join(root, 'a-big', 'venv'), { recursive: true });
    for (let index = 0; index < 5001; index++) writeFileSync(join(root, 'a-big', 'venv', `f${index}`), '');
    writeSkill(root, 'b-next', 'NEXT');

    expect(await contentOf('b-next', false)).toBe('NEXT');
    expect(vi.mocked(log)).not.toHaveBeenCalled();
  }, 60_000);

  it.runIf(process.platform === 'win32' || process.platform === 'darwin')('finds <root>/<name>.md by the file system\'s case rules', async () => {
    mkdirSync(join(H.home, '.pi', 'skills'), { recursive: true });
    writeFileSync(join(H.home, '.pi', 'skills', 'Deploy.md'), 'FLAT SKILL', 'utf8');

    expect(await contentOf('deploy', false)).toBe('FLAT SKILL');
  });

  it('skips a SKILL.md over 1 MiB and a broken skill folder link, and finds the next root\'s skill', async () => {
    writeSkill(join(H.agentDir, 'skills'), 'deploy', 'x'.repeat(1024 * 1024 + 1));
    folderLink(join(outside, 'gone'), join(H.home, '.agents', 'skills', 'deploy'));
    writeSkill(join(H.home, '.pi', 'skills'), 'deploy', 'LEGACY SKILL');

    expect(await contentOf('deploy', false)).toBe('LEGACY SKILL');
    expect(vi.mocked(log)).toHaveBeenCalledWith('%s', `[assets] ${join(H.agentDir, 'skills', 'deploy', 'SKILL.md')}: tooLarge`);
    expect(vi.mocked(log)).toHaveBeenCalledWith('%s', `[assets] ${join(H.home, '.agents', 'skills', 'deploy')}: broken link to ${join(outside, 'gone')}`);
  });

  it('reads no project skills root while untrusted, whatever it links to', async () => {
    writeSkill(outside, 'deploy', 'HOSTILE LINKED SKILL');
    folderLink(outside, join(cwd, '.pi', 'skills'));

    expect(await contentOf('deploy', true)).toBe('HOSTILE LINKED SKILL');
    expect(await contentOf('deploy', false)).not.toContain('HOSTILE');
  });
});
