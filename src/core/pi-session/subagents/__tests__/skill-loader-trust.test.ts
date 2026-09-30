import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

import { PI_AGENT_DIR } from '../../agent-dir';
import { preloadSkills } from '../skill-loader';

let cwd = '';

/** Write `<root>/<name>/SKILL.md` holding `body`. */
function writeSkill(root: string, name: string, body: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body, 'utf8');
}

function contentOf(name: string, includeProjectScope: boolean): string {
  const loaded = preloadSkills([name], cwd, { includeProjectScope });
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

  it('redirects PI_AGENT_DIR at the temp home, so the user roots under test are the temp ones', () => {
    expect(PI_AGENT_DIR).toBe(join(H.home, 'damocles', 'pi', 'agent'));
  });

  // The loaded text is spliced straight into a subagent's system prompt, so an untrusted checkout must
  // not reach it through a user-authored agent's `skills:` field.
  it.each(['.pi/skills', '.agents/skills'])(
    'withholds <cwd>/%s when project scope is excluded',
    (root) => {
      writeSkill(join(cwd, ...root.split('/')), 'deploy', 'HOSTILE PROJECT SKILL');

      expect(contentOf('deploy', true)).toBe('HOSTILE PROJECT SKILL');
      expect(contentOf('deploy', false)).not.toContain('HOSTILE');
    },
  );

  it.each(['.agents/skills', '.pi/skills'])(
    'still reads the user root ~/%s when project scope is excluded',
    (root) => {
      writeSkill(join(H.home, ...root.split('/')), 'deploy', 'USER SKILL');

      expect(contentOf('deploy', false)).toBe('USER SKILL');
    },
  );

  it('still reads the pi agent dir skills root when project scope is excluded', () => {
    writeSkill(join(H.agentDir, 'skills'), 'deploy', 'AGENT DIR SKILL');

    expect(contentOf('deploy', false)).toBe('AGENT DIR SKILL');
  });

  it('falls through a withheld project skill to the same-named user skill', () => {
    writeSkill(join(cwd, '.pi', 'skills'), 'deploy', 'HOSTILE PROJECT SKILL');
    writeSkill(join(H.home, '.pi', 'skills'), 'deploy', 'USER SKILL');

    expect(contentOf('deploy', true)).toBe('HOSTILE PROJECT SKILL');
    expect(contentOf('deploy', false)).toBe('USER SKILL');
  });

  it('withholds a flat <cwd> skill file too', () => {
    mkdirSync(join(cwd, '.pi', 'skills'), { recursive: true });
    writeFileSync(join(cwd, '.pi', 'skills', 'deploy.md'), 'HOSTILE FLAT SKILL', 'utf8');

    expect(contentOf('deploy', true)).toBe('HOSTILE FLAT SKILL');
    expect(contentOf('deploy', false)).not.toContain('HOSTILE');
  });

  it('names no project root in the not-found message when project scope is excluded', () => {
    const message = contentOf('missing', false);
    expect(message).toContain('not found');
    expect(message).not.toContain('.pi/skills/');
    expect(message).not.toContain('.agents/skills/');
  });

  it('names the project roots in the not-found message when project scope is included', () => {
    const message = contentOf('missing', true);
    expect(message).toContain('.pi/skills/');
    expect(message).toContain('.agents/skills/');
  });

  it('rejects a traversal-shaped name on both sides of the gate', () => {
    for (const includeProjectScope of [true, false]) {
      expect(contentOf('../escape', includeProjectScope)).toContain('path traversal');
    }
  });

  it('preserves the requested order and names when several skills are asked for', () => {
    writeSkill(join(H.home, '.pi', 'skills'), 'alpha', 'A');
    writeSkill(join(H.home, '.pi', 'skills'), 'beta', 'B');

    const loaded = preloadSkills(['beta', 'alpha'], cwd, { includeProjectScope: false });
    expect(loaded.map((s) => s.name)).toEqual(['beta', 'alpha']);
    expect(loaded.map((s) => s.content)).toEqual(['B', 'A']);
  });
});
