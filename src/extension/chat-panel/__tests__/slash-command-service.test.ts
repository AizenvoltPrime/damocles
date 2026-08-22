import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as nodeOs from 'os';
import * as path from 'path';
import type { MockInstance } from 'vitest';

// User-scope dirs resolve through `os.homedir()`. Redirect it to a temp dir so a developer's real
// `~/.claude/skills` cannot add entries to the results under assertion.
const H = vi.hoisted(() => ({ home: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = () => (H.home !== '' ? H.home : actual.homedir());
  return { ...actual, homedir, default: { ...actual, homedir } };
});

vi.mock('../../logger', () => ({ log: vi.fn() }));

import * as vscode from 'vscode';
import { __trustEmitter, FakeFileSystemWatcher } from 'vscode';
import { SlashCommandService } from '../slash-command-service';
import type { AssetSourcePrecedence } from '../../asset-sources';

/** The three asset sources' on-disk folder names, stated here rather than read from the source. */
const SOURCE_FOLDERS = [
  { commands: '.damocles/commands', skills: '.damocles/skills' },
  { commands: '.claude/commands', skills: '.claude/skills' },
  { commands: '.codex/prompts', skills: '.codex/skills' },
] as const;

/**
 * Flatten a registered watcher pattern to `<kind>:<anchor>|<glob>`. The kind has to survive the
 * flattening: a Uri base and a string base holding the same path are different constructions, and
 * `pi-runtime.ts` anchors its equivalent watchers the same way, so a swap in either direction has to
 * be visible here rather than comparing equal.
 */
function describePattern(pattern: unknown): string {
  if (!(pattern instanceof vscode.RelativePattern)) return `glob:${String(pattern)}`;
  const base = pattern.base;
  if (typeof base === 'string') return `path:${base}|${pattern.pattern}`;
  return `uri:${(base as { fsPath: string }).fsPath}|${pattern.pattern}`;
}

const realGetConfiguration = vscode.workspace.getConfiguration;
const realIsTrusted = vscode.workspace.isTrusted;

function setPrecedence(value: AssetSourcePrecedence): void {
  (vscode.workspace as { getConfiguration: unknown }).getConfiguration = () => ({
    get: (key: string, defaultValue?: unknown) =>
      key === 'assetSourcePrecedence' ? value : defaultValue,
    update: () => Promise.resolve(),
  });
}

function setTrusted(trusted: boolean): void {
  vscode.__setTrusted(trusted);
}

/** Write `<root>/<rel>/<name>/SKILL.md` and return its path. */
function writeSkill(root: string, rel: string, name: string, description: string): string {
  return writeSkillNamed(root, rel, name, name, description);
}

/** Write `<root>/<rel>/<dirName>/SKILL.md` declaring a frontmatter `name:` of `declaredName`. */
function writeSkillNamed(
  root: string,
  rel: string,
  dirName: string,
  declaredName: string,
  description: string,
): string {
  const dir = path.join(root, ...rel.split('/'), dirName);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(
    file,
    `---\nname: ${declaredName}\ndescription: ${description}\n---\n\nbody\n`,
    'utf8',
  );
  return file;
}

/** Write `<root>/<rel>/<name>/SKILL.md` with no frontmatter `name:` field. */
function writeUnnamedSkill(root: string, rel: string, name: string, description: string): string {
  const dir = path.join(root, ...rel.split('/'), name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, `---\ndescription: ${description}\n---\n\nbody\n`, 'utf8');
  return file;
}

/**
 * Create a symlink, returning false when the host refuses. Unprivileged Windows hosts cannot create
 * symlinks, and a test that silently passes there would assert nothing.
 */
function trySymlink(target: string, link: string, type: 'file' | 'dir'): boolean {
  try {
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, type);
    return true;
  } catch (err) {
    console.warn(`Skipping symlink assertion: ${(err as Error).message}`);
    return false;
  }
}

/** Write `<root>/<rel>/<name>.md` and return its path. */
function writeCommand(root: string, rel: string, name: string, description: string): string {
  const dir = path.join(root, ...rel.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.md`);
  fs.writeFileSync(file, `---\ndescription: ${description}\n---\n\nbody\n`, 'utf8');
  return file;
}

describe('SlashCommandService asset-source precedence', () => {
  let ws = '';
  let service: SlashCommandService | null = null;

  function makeService(projectPath: string | null = ws): SlashCommandService {
    service = new SlashCommandService(projectPath);
    return service;
  }

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(nodeOs.tmpdir(), 'scs-ws-'));
    H.home = fs.mkdtempSync(path.join(nodeOs.tmpdir(), 'scs-home-'));
    setPrecedence('claude');
    setTrusted(true);
    __trustEmitter.clear();
  });

  afterEach(() => {
    service?.dispose();
    service = null;
    __trustEmitter.clear();
    (vscode.workspace as { getConfiguration: unknown }).getConfiguration = realGetConfiguration;
    vscode.__setTrusted(realIsTrusted);
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(H.home, { recursive: true, force: true });
    H.home = '';
  });

  describe.each<AssetSourcePrecedence>(['claude', 'codex'])(
    'with assetSourcePrecedence=%s',
    (precedence) => {
      beforeEach(() => setPrecedence(precedence));

      it('de-dups a skill defined in both .damocles and .claude, keeping the .damocles file', async () => {
        const damoclesFile = writeSkill(ws, '.damocles/skills', 'foo', 'damocles version');
        writeSkill(ws, '.claude/skills', 'foo', 'claude version');

        const skills = await makeService().getSkills();
        const foo = skills.filter((s) => s.name === 'foo');
        expect(foo).toHaveLength(1);
        expect(foo[0]?.filePath).toBe(damoclesFile);
        expect(foo[0]?.description).toBe('damocles version');
      });

      it('de-dups a command defined in both .damocles and .claude, keeping the .damocles file', async () => {
        const damoclesFile = writeCommand(ws, '.damocles/commands', 'bar', 'damocles version');
        writeCommand(ws, '.claude/commands', 'bar', 'claude version');

        const commands = await makeService().getCommands();
        const bar = commands.filter((c) => c.name === 'bar');
        expect(bar).toHaveLength(1);
        expect(bar[0]?.filePath).toBe(damoclesFile);
        expect(bar[0]?.description).toBe('damocles version');
      });

      it('lets .damocles beat .codex too', async () => {
        const damoclesFile = writeSkill(ws, '.damocles/skills', 'foo', 'damocles version');
        writeSkill(ws, '.codex/skills', 'foo', 'codex version');

        const foo = (await makeService().getSkills()).filter((s) => s.name === 'foo');
        expect(foo).toHaveLength(1);
        expect(foo[0]?.filePath).toBe(damoclesFile);
      });
    },
  );

  it('orders claude above codex under the claude precedence', async () => {
    const claudeFile = writeSkill(ws, '.claude/skills', 'foo', 'claude version');
    writeSkill(ws, '.codex/skills', 'foo', 'codex version');

    const foo = (await makeService().getSkills()).filter((s) => s.name === 'foo');
    expect(foo).toHaveLength(1);
    expect(foo[0]?.filePath).toBe(claudeFile);
  });

  it('orders codex above claude under the codex precedence', async () => {
    setPrecedence('codex');
    writeSkill(ws, '.claude/skills', 'foo', 'claude version');
    const codexFile = writeSkill(ws, '.codex/skills', 'foo', 'codex version');

    const foo = (await makeService().getSkills()).filter((s) => s.name === 'foo');
    expect(foo).toHaveLength(1);
    expect(foo[0]?.filePath).toBe(codexFile);
  });

  it('lets project .damocles beat user .damocles', async () => {
    const projectFile = writeSkill(ws, '.damocles/skills', 'foo', 'project version');
    writeSkill(H.home, '.damocles/skills', 'foo', 'user version');

    const foo = (await makeService().getSkills()).filter((s) => s.name === 'foo');
    expect(foo).toHaveLength(1);
    expect(foo[0]?.filePath).toBe(projectFile);
    expect(foo[0]?.source).toBe('project');
  });

  it('lets user .damocles beat user .claude', async () => {
    const userDamocles = writeSkill(H.home, '.damocles/skills', 'foo', 'damocles user');
    writeSkill(H.home, '.claude/skills', 'foo', 'claude user');

    const foo = (await makeService().getSkills()).filter((s) => s.name === 'foo');
    expect(foo).toHaveLength(1);
    expect(foo[0]?.filePath).toBe(userDamocles);
    expect(foo[0]?.source).toBe('user');
  });

  it('resolves a user-scope .damocles command when the project has none', async () => {
    const userFile = writeCommand(H.home, '.damocles/commands', 'bar', 'user version');
    const bar = (await makeService().getCommands()).filter((c) => c.name === 'bar');
    expect(bar).toHaveLength(1);
    expect(bar[0]?.filePath).toBe(userFile);
    expect(bar[0]?.source).toBe('user');
  });

  describe('untrusted workspace', () => {
    beforeEach(() => setTrusted(false));

    it('still returns project skills and flags only them as untrusted', async () => {
      writeSkill(ws, '.damocles/skills', 'projectskill', 'project version');
      writeSkill(ws, '.codex/skills', 'codexskill', 'codex project version');
      writeSkill(H.home, '.damocles/skills', 'userskill', 'user version');
      writeSkill(H.home, '.claude/skills', 'claudeuserskill', 'claude user version');

      const skills = await makeService().getSkills();
      const byName = Object.fromEntries(skills.map((s) => [s.name, s]));

      expect(byName['projectskill']?.untrusted).toBe(true);
      expect(byName['codexskill']?.untrusted).toBe(true);
      // An over-broad gate that flags user-scope entries is the failure mode this catches.
      expect(byName['userskill']).toBeDefined();
      expect(byName['userskill']?.untrusted).toBeFalsy();
      expect(byName['claudeuserskill']).toBeDefined();
      expect(byName['claudeuserskill']?.untrusted).toBeFalsy();
    });

    it('still returns project commands and flags only them as untrusted', async () => {
      writeCommand(ws, '.damocles/commands', 'projectcmd', 'project version');
      writeCommand(ws, '.claude/commands', 'claudeprojectcmd', 'claude project version');
      writeCommand(H.home, '.damocles/commands', 'usercmd', 'user version');

      const commands = await makeService().getCommands();
      const byName = Object.fromEntries(commands.map((c) => [c.name, c]));

      expect(byName['projectcmd']?.untrusted).toBe(true);
      expect(byName['claudeprojectcmd']?.untrusted).toBe(true);
      expect(byName['usercmd']).toBeDefined();
      expect(byName['usercmd']?.untrusted).toBeFalsy();
    });

    // A flagged entry is inert, so it must not displace one that runs. Otherwise an untrusted checkout
    // suppresses the user's own tooling by declaring a file of the same name.
    describe.each<AssetSourcePrecedence>(['claude', 'codex'])(
      'a flagged project entry shadowed by a working user entry (precedence=%s)',
      (precedence) => {
        beforeEach(() => setPrecedence(precedence));

        it('yields only the user skill, unflagged', async () => {
          writeSkill(ws, '.damocles/skills', 'foo', 'project version');
          const userFile = writeSkill(H.home, '.damocles/skills', 'foo', 'user version');

          const foo = (await makeService().getSkills()).filter((s) => s.name === 'foo');
          expect(foo).toHaveLength(1);
          expect(foo[0]?.filePath).toBe(userFile);
          expect(foo[0]?.source).toBe('user');
          expect(foo[0]?.untrusted).toBeFalsy();
        });

        it('yields only the user command, unflagged', async () => {
          writeCommand(ws, '.damocles/commands', 'foo', 'project version');
          const userFile = writeCommand(H.home, '.damocles/commands', 'foo', 'user version');

          const foo = (await makeService().getCommands()).filter((c) => c.name === 'foo');
          expect(foo).toHaveLength(1);
          expect(foo[0]?.filePath).toBe(userFile);
          expect(foo[0]?.source).toBe('user');
          expect(foo[0]?.untrusted).toBeFalsy();
        });

        // The refusal branches on this lookup, so an unflagged result here is what lets a shadowed
        // name run.
        it('returns the unflagged user entry from findSkill and findCommand', async () => {
          writeSkill(ws, '.damocles/skills', 'foo', 'project version');
          const userSkill = writeSkill(H.home, '.damocles/skills', 'foo', 'user version');
          writeCommand(ws, '.damocles/commands', 'baz', 'project version');
          const userCommand = writeCommand(H.home, '.damocles/commands', 'baz', 'user version');

          const svc = makeService();

          const skill = await svc.findSkill('foo');
          expect(skill?.filePath).toBe(userSkill);
          expect(skill?.untrusted).toBeFalsy();

          const command = await svc.findCommand('baz');
          expect(command?.filePath).toBe(userCommand);
          expect(command?.untrusted).toBeFalsy();
        });
      },
    );

    // Without this, a "fix" that simply dropped every project entry when untrusted would pass the
    // shadowing tests above while silently deleting the badge and the refusal.
    it('still lists and flags a project entry that no user entry shadows', async () => {
      const projectSkill = writeSkill(ws, '.damocles/skills', 'bar', 'project version');
      const projectCommand = writeCommand(ws, '.damocles/commands', 'bar', 'project version');

      const svc = makeService();

      const skills = (await svc.getSkills()).filter((s) => s.name === 'bar');
      expect(skills).toHaveLength(1);
      expect(skills[0]?.filePath).toBe(projectSkill);
      expect(skills[0]?.untrusted).toBe(true);

      const commands = (await svc.getCommands()).filter((c) => c.name === 'bar');
      expect(commands).toHaveLength(1);
      expect(commands[0]?.filePath).toBe(projectCommand);
      expect(commands[0]?.untrusted).toBe(true);

      // `untrusted: true` off the lookup is exactly the input the refusal path branches on; the refusal
      // itself is asserted in untrusted-invocation.test.ts.
      expect((await svc.findSkill('bar'))?.untrusted).toBe(true);
      expect((await svc.findCommand('bar'))?.untrusted).toBe(true);
    });

    it('upgrades past a second flagged entry to reach the user one', async () => {
      writeSkill(ws, '.damocles/skills', 'foo', 'damocles project version');
      writeSkill(ws, '.claude/skills', 'foo', 'claude project version');
      const userFile = writeSkill(H.home, '.claude/skills', 'foo', 'claude user version');

      const foo = (await makeService().getSkills()).filter((s) => s.name === 'foo');
      expect(foo).toHaveLength(1);
      expect(foo[0]?.filePath).toBe(userFile);
      expect(foo[0]?.untrusted).toBeFalsy();
    });

    it('picks the highest-precedence USER entry when several sources provide the name', async () => {
      writeSkill(ws, '.damocles/skills', 'foo', 'damocles project version');
      writeSkill(ws, '.claude/skills', 'foo', 'claude project version');
      const damoclesUser = writeSkill(H.home, '.damocles/skills', 'foo', 'damocles user version');
      writeSkill(H.home, '.claude/skills', 'foo', 'claude user version');

      const foo = (await makeService().getSkills()).filter((s) => s.name === 'foo');
      expect(foo).toHaveLength(1);
      expect(foo[0]?.filePath).toBe(damoclesUser);
      expect(foo[0]?.untrusted).toBeFalsy();
    });

    it('orders user entries by the configured precedence when .damocles has none', async () => {
      setPrecedence('codex');
      writeSkill(ws, '.damocles/skills', 'foo', 'damocles project version');
      writeSkill(H.home, '.claude/skills', 'foo', 'claude user version');
      const codexUser = writeSkill(H.home, '.codex/skills', 'foo', 'codex user version');

      const foo = (await makeService().getSkills()).filter((s) => s.name === 'foo');
      expect(foo).toHaveLength(1);
      expect(foo[0]?.filePath).toBe(codexUser);
      expect(foo[0]?.untrusted).toBeFalsy();
    });

    // Precedence among flagged entries is untouched: the upgrade rule only fires when an UNflagged
    // entry claims the same name.
    it('keeps .damocles first among flagged entries when nothing unflagged claims the name', async () => {
      const damoclesProject = writeSkill(ws, '.damocles/skills', 'foo', 'damocles project version');
      writeSkill(ws, '.claude/skills', 'foo', 'claude project version');

      const foo = (await makeService().getSkills()).filter((s) => s.name === 'foo');
      expect(foo).toHaveLength(1);
      expect(foo[0]?.filePath).toBe(damoclesProject);
      expect(foo[0]?.untrusted).toBe(true);
    });
  });

  // With no flag in play the upgrade condition can never fire, so project beats user unconditionally.
  describe('trusted workspace is unaffected by the flagged-entry upgrade', () => {
    it('keeps the project winner for both skills and commands', async () => {
      const projectSkill = writeSkill(ws, '.damocles/skills', 'foo', 'project version');
      writeSkill(H.home, '.damocles/skills', 'foo', 'user version');
      const projectCommand = writeCommand(ws, '.damocles/commands', 'foo', 'project version');
      writeCommand(H.home, '.damocles/commands', 'foo', 'user version');

      const svc = makeService();

      const skills = (await svc.getSkills()).filter((s) => s.name === 'foo');
      expect(skills).toHaveLength(1);
      expect(skills[0]?.filePath).toBe(projectSkill);
      expect(skills[0]?.source).toBe('project');
      expect(skills[0]?.untrusted).toBeFalsy();

      const commands = (await svc.getCommands()).filter((c) => c.name === 'foo');
      expect(commands).toHaveLength(1);
      expect(commands[0]?.filePath).toBe(projectCommand);
      expect(commands[0]?.source).toBe('project');
      expect(commands[0]?.untrusted).toBeFalsy();
    });
  });

  describe('granting workspace trust', () => {
    it('drops the untrusted flag from both caches and fires onCacheInvalidate', async () => {
      writeSkill(ws, '.damocles/skills', 'foo', 'project version');
      writeCommand(ws, '.damocles/commands', 'bar', 'project version');
      setTrusted(false);

      const svc = makeService();
      const invalidated = vi.fn();
      svc.setOnCacheInvalidate(invalidated);

      expect((await svc.getSkills())[0]?.untrusted).toBe(true);
      expect((await svc.getCommands())[0]?.untrusted).toBe(true);

      setTrusted(true);
      __trustEmitter.fire();

      expect(invalidated).toHaveBeenCalledTimes(1);
      // A stale cache would replay the flagged entries, so this re-scan is the badge clearing.
      expect((await svc.getSkills())[0]?.untrusted).toBeFalsy();
      expect((await svc.getCommands())[0]?.untrusted).toBeFalsy();
    });

    it('stops re-scanning once disposed', async () => {
      writeSkill(ws, '.damocles/skills', 'foo', 'project version');
      setTrusted(false);

      const svc = makeService();
      const invalidated = vi.fn();
      svc.setOnCacheInvalidate(invalidated);
      await svc.getSkills();

      svc.dispose();
      service = null;
      setTrusted(true);
      __trustEmitter.fire();

      expect(invalidated).not.toHaveBeenCalled();
    });
  });

  describe('findSkill / findCommand', () => {
    it('findSkill returns the SkillInfo for a known skill and undefined otherwise', async () => {
      const file = writeSkill(ws, '.damocles/skills', 'foo', 'damocles version');
      const svc = makeService();

      const found = await svc.findSkill('foo');
      expect(found?.name).toBe('foo');
      expect(found?.filePath).toBe(file);
      expect(found?.untrusted).toBeFalsy();

      await expect(svc.findSkill('nope')).resolves.toBeUndefined();
    });

    it('findSkill returns an untrusted project skill rather than hiding it', async () => {
      writeSkill(ws, '.damocles/skills', 'foo', 'damocles version');
      setTrusted(false);

      const found = await makeService().findSkill('foo');
      expect(found?.name).toBe('foo');
      expect(found?.untrusted).toBe(true);
    });

    it('findCommand returns the CustomSlashCommandInfo for a known command and undefined otherwise', async () => {
      const file = writeCommand(ws, '.damocles/commands', 'bar', 'damocles version');
      const svc = makeService();

      const found = await svc.findCommand('bar');
      expect(found?.name).toBe('bar');
      expect(found?.filePath).toBe(file);
      expect(found?.untrusted).toBeFalsy();

      await expect(svc.findCommand('nope')).resolves.toBeUndefined();
    });

    it('findCommand returns an untrusted project command rather than hiding it', async () => {
      writeCommand(ws, '.damocles/commands', 'bar', 'damocles version');
      setTrusted(false);

      const found = await makeService().findCommand('bar');
      expect(found?.name).toBe('bar');
      expect(found?.untrusted).toBe(true);
    });

    it('matches a name case-insensitively', async () => {
      writeSkill(ws, '.damocles/skills', 'Foo', 'project version');
      writeCommand(ws, '.damocles/commands', 'Bar', 'project version');
      const svc = makeService();

      expect((await svc.findSkill('foo'))?.name).toBe('Foo');
      expect((await svc.findSkill('FOO'))?.name).toBe('Foo');
      expect((await svc.findCommand('bar'))?.name).toBe('Bar');
    });

    // The refusal branches on this lookup, so an exact-case miss silently withholds the refusal for a
    // name a case-insensitive filesystem resolves anyway.
    it('reports an untrusted project skill through a differently-cased name', async () => {
      writeSkill(ws, '.damocles/skills', 'foo', 'project version');
      setTrusted(false);

      const found = await makeService().findSkill('Foo');
      expect(found?.untrusted).toBe(true);
    });

    it('reports an untrusted project command through a differently-cased name', async () => {
      writeCommand(ws, '.damocles/commands', 'bar', 'project version');
      setTrusted(false);

      const found = await makeService().findCommand('BAR');
      expect(found?.untrusted).toBe(true);
    });
  });

  describe('names differing only in case', () => {
    it('yields one skill row, keeping the winner original-cased', async () => {
      const damoclesFile = writeSkill(ws, '.damocles/skills', 'Foo', 'damocles version');
      writeSkill(ws, '.claude/skills', 'foo', 'claude version');

      const skills = await makeService().getSkills();
      expect(skills.filter((s) => s.name.toLowerCase() === 'foo')).toHaveLength(1);
      expect(skills[0]?.name).toBe('Foo');
      expect(skills[0]?.filePath).toBe(damoclesFile);
    });

    it('yields one command row, keeping the winner original-cased', async () => {
      const damoclesFile = writeCommand(ws, '.damocles/commands', 'Bar', 'damocles version');
      writeCommand(ws, '.claude/commands', 'bar', 'claude version');

      const commands = await makeService().getCommands();
      expect(commands.filter((c) => c.name.toLowerCase() === 'bar')).toHaveLength(1);
      expect(commands[0]?.name).toBe('Bar');
      expect(commands[0]?.filePath).toBe(damoclesFile);
    });

    it('lets a working user entry displace a flagged project entry of a different case', async () => {
      setTrusted(false);
      writeSkill(ws, '.damocles/skills', 'Foo', 'project version');
      const userFile = writeSkill(H.home, '.claude/skills', 'foo', 'user version');

      const skills = await makeService().getSkills();
      expect(skills).toHaveLength(1);
      expect(skills[0]?.filePath).toBe(userFile);
      expect(skills[0]?.untrusted).toBeFalsy();
    });
  });

  describe('skill identity', () => {
    it('names a skill by its frontmatter name rather than its directory', async () => {
      writeSkillNamed(ws, '.damocles/skills', 'commit-helper', 'commit', 'renamed skill');

      const skills = await makeService().getSkills();
      expect(skills.map((s) => s.name)).toEqual(['commit']);
      expect(await service?.findSkill('commit')).toBeDefined();
      expect(await service?.findSkill('commit-helper')).toBeUndefined();
    });

    it('falls back to the directory name when no frontmatter name is declared', async () => {
      writeUnnamedSkill(ws, '.damocles/skills', 'plain', 'no name field');

      const skills = await makeService().getSkills();
      expect(skills.map((s) => s.name)).toEqual(['plain']);
    });

    // Pre-approval and invocation must agree on one name, so a frontmatter name the invocation
    // alphabet cannot express is dropped rather than silently reverted to the directory name.
    it.each(['../evil', 'foo..bar', '.hidden', 'a/b'])(
      'drops a skill declaring the unusable frontmatter name %j',
      async (declared) => {
        writeSkillNamed(ws, '.damocles/skills', 'legit', declared, 'hostile rename');

        const skills = await makeService().getSkills();
        expect(skills).toEqual([]);
        expect(await service?.findSkill('legit')).toBeUndefined();
      },
    );

    // A frontmatter key whose value is blank has no value. Reading across the line break would take
    // the next key's line, which names the skill something no one wrote and nothing can invoke.
    it.each([
      ['name:', 'bare'],
      ['name:   ', 'trailing spaces'],
      ['name:\t', 'trailing tab'],
    ])('falls back to the directory name when the declared name is blank (%s)', async (nameLine) => {
      const dir = path.join(ws, '.damocles', 'skills', 'deploy');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        `---\n${nameLine}\ndescription: still discoverable\n---\n\nbody\n`,
        'utf8',
      );

      const skills = await makeService().getSkills();
      expect(skills.map((s) => s.name)).toEqual(['deploy']);
      expect(skills[0]?.description).toBe('still discoverable');
    });

    // Dropping the skill here would hide it from the menu while pi still loads and runs it, so the
    // refusal has to stay reachable under the directory name.
    it('still flags a blank-named project skill as untrusted under its directory name', async () => {
      const dir = path.join(ws, '.damocles', 'skills', 'deploy');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname:\ndescription: d\n---\n\nbody\n', 'utf8');
      setTrusted(false);

      const found = await makeService().findSkill('deploy');
      expect(found?.untrusted).toBe(true);
    });

    it('flags a frontmatter-renamed project skill as untrusted under its declared name', async () => {
      writeSkillNamed(ws, '.damocles/skills', 'innocent', 'commit', 'hostile rename');
      setTrusted(false);

      const found = await makeService().findSkill('commit');
      expect(found?.untrusted).toBe(true);
    });
  });

  describe('blank frontmatter values', () => {
    /** Write `<ws>/.damocles/commands/<name>.md` with `frontmatter` verbatim. */
    function writeRawCommand(name: string, frontmatter: string, body: string): void {
      const dir = path.join(ws, '.damocles', 'commands');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${name}.md`), `---\n${frontmatter}\n---\n\n${body}\n`, 'utf8');
    }

    it.each([
      ['description:', 'bare'],
      ['description:   ', 'trailing spaces'],
    ])('takes the description from the body when the declared one is blank (%s)', async (line) => {
      writeRawCommand('foo', `${line}\nargument-hint: <x>`, 'body line wins');

      const commands = await makeService().getCommands();
      expect(commands[0]?.description).toBe('body line wins');
    });

    // Another key follows, so a separator that spans the line break would capture that key's line.
    it('leaves the argument hint unset when it is blank', async () => {
      writeRawCommand('foo', 'argument-hint:\ndescription: d', 'body');

      const commands = await makeService().getCommands();
      expect(commands[0]?.argumentHint).toBeUndefined();
      expect(commands[0]?.description).toBe('d');
    });

    it('reads a quoted description as its unquoted value', async () => {
      writeRawCommand('foo', 'description: "quoted value"', 'body');

      expect((await makeService().getCommands())[0]?.description).toBe('quoted value');
    });
  });

  describe('symlinks under a command directory', () => {
    let outside = '';

    beforeEach(() => {
      outside = fs.mkdtempSync(path.join(nodeOs.tmpdir(), 'scs-outside-'));
    });

    afterEach(() => {
      fs.rmSync(outside, { recursive: true, force: true });
    });

    it('does not read a symlinked command file', async () => {
      const target = path.join(outside, 'secret.md');
      fs.writeFileSync(target, '---\ndescription: contents from outside the workspace\n---\n', 'utf8');
      writeCommand(ws, '.damocles/commands', 'real', 'a real file');
      if (!trySymlink(target, path.join(ws, '.damocles', 'commands', 'linked.md'), 'file')) return;

      const commands = await makeService().getCommands();
      expect(commands.map((c) => c.name)).toEqual(['real']);
    });

    it('does not descend into a symlinked namespace directory', async () => {
      fs.mkdirSync(path.join(outside, 'ns'), { recursive: true });
      fs.writeFileSync(
        path.join(outside, 'ns', 'secret.md'),
        '---\ndescription: contents from outside the workspace\n---\n',
        'utf8',
      );
      writeCommand(ws, '.damocles/commands', 'real', 'a real file');
      if (!trySymlink(path.join(outside, 'ns'), path.join(ws, '.damocles', 'commands', 'ns'), 'dir')) return;

      const commands = await makeService().getCommands();
      expect(commands.map((c) => c.name)).toEqual(['real']);
    });

    it('does not read a symlinked SKILL.md', async () => {
      const target = path.join(outside, 'SKILL.md');
      fs.writeFileSync(target, '---\nname: linked\ndescription: from outside\n---\n', 'utf8');
      writeSkill(ws, '.damocles/skills', 'real', 'a real skill');
      if (!trySymlink(target, path.join(ws, '.damocles', 'skills', 'linked', 'SKILL.md'), 'file')) return;

      const skills = await makeService().getSkills();
      expect(skills.map((s) => s.name)).toEqual(['real']);
    });
  });

  describe('asset name alphabet', () => {
    it('lists a dotted command name', async () => {
      writeCommand(ws, '.damocles/commands', 'foo.bar', 'dotted');
      const commands = await makeService().getCommands();
      expect(commands.map((c) => c.name)).toEqual(['foo.bar']);
    });

    it('lists a dotted skill directory name', async () => {
      writeSkill(ws, '.damocles/skills', 'foo.bar', 'dotted');
      const skills = await makeService().getSkills();
      expect(skills.map((s) => s.name)).toEqual(['foo.bar']);
    });

    it('namespaces a command in a subdirectory', async () => {
      writeCommand(ws, '.damocles/commands/ns', 'deploy', 'namespaced');
      const commands = await makeService().getCommands();
      expect(commands.map((c) => c.name)).toEqual(['ns:deploy']);
    });

    it('skips a command whose namespace directory name is not a usable segment', async () => {
      writeCommand(ws, '.damocles/commands/weird name!', 'deploy', 'unreachable');
      writeCommand(ws, '.damocles/commands', 'plain', 'reachable');

      const commands = await makeService().getCommands();
      expect(commands.map((c) => c.name)).toEqual(['plain']);
    });

    it('skips a command whose namespace directory name is itself dotted past the alphabet', async () => {
      writeCommand(ws, '.damocles/commands/foo..bar', 'deploy', 'unreachable');

      expect(await makeService().getCommands()).toEqual([]);
    });

    // Anything listed here but unreachable from the invocation alphabet would carry a badge and no
    // refusal, so the scanner must not accept a name the intercept cannot parse.
    it.each(['foo..bar', '.hidden', 'foo.'])('skips the command file for %j', async (name) => {
      const dir = path.join(ws, '.damocles', 'commands');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${name}.md`), '---\ndescription: d\n---\n', 'utf8');

      expect(await makeService().getCommands()).toEqual([]);
    });

    it.each(['foo..bar', '.hidden', 'foo.'])('skips the skill directory for %j', async (name) => {
      writeSkillNamed(ws, '.damocles/skills', name, name, 'd');
      expect(await makeService().getSkills()).toEqual([]);
    });
  });

  describe('file watchers', () => {
    let created: unknown[] = [];
    let watchers: FakeFileSystemWatcher[] = [];
    let spy: MockInstance<typeof vscode.workspace.createFileSystemWatcher> | null = null;

    /** The watcher registered for `<anchor>|<glob>`, so a test names the directory it drives. */
    function watcherFor(descriptor: string): FakeFileSystemWatcher {
      const index = created.map(describePattern).indexOf(descriptor);
      if (index === -1) {
        throw new Error(`no watcher registered for ${descriptor}, got:\n${created.map(describePattern).join('\n')}`);
      }
      return watchers[index]!;
    }

    beforeEach(() => {
      created = [];
      watchers = [];
      spy = vi
        .spyOn(vscode.workspace, 'createFileSystemWatcher')
        // The fake emits `{ fsPath }` rather than full `Uri` objects, so it is not structurally a
        // `FileSystemWatcher` even though every method the code under test calls is present.
        .mockImplementation(((globPattern: vscode.GlobPattern) => {
          created.push(globPattern);
          const watcher = new FakeFileSystemWatcher();
          watchers.push(watcher);
          return watcher;
        }) as unknown as typeof vscode.workspace.createFileSystemWatcher);
    });

    afterEach(() => {
      spy?.mockRestore();
      spy = null;
    });

    it('anchors every registered pattern on the directory it must observe', () => {
      makeService();

      const expected = SOURCE_FOLDERS.flatMap((source) => [
        `path:${ws}|${source.commands}/**/*.md`,
        `path:${ws}|${source.skills}/**/SKILL.md`,
        `path:${ws}|${source.skills}/*`,
        `uri:${path.join(H.home, source.commands)}|**/*.md`,
        `uri:${path.join(H.home, source.skills)}|**/SKILL.md`,
        `uri:${path.join(H.home, source.skills)}|*`,
      ]);

      expect(created.map(describePattern).sort()).toEqual(expected.sort());
    });

    // VS Code reports no events from a bare glob string outside the opened workspace folders, so a
    // user-scope watcher registered that way never fires and the menu goes stale until a reload.
    it('registers no bare glob string', () => {
      makeService();

      expect(created.filter((p) => !(p instanceof vscode.RelativePattern))).toEqual([]);
    });

    // A string base is a different construction from a Uri base even where both resolve to the same
    // folder, and the equivalent watchers elsewhere in the extension anchor on a Uri.
    it('anchors every user-scope watcher on a Uri rather than a path string', () => {
      makeService();

      const homePrefix = path.join(H.home, '.');
      const userAnchors = created
        .map(describePattern)
        .filter((d) => d.includes(homePrefix));

      expect(userAnchors).toHaveLength(9);
      expect(userAnchors.filter((d) => !d.startsWith('uri:'))).toEqual([]);
    });

    // Precedence changes the scan order, not the set of directories, which is why a precedence change
    // clears the caches without rebuilding any watcher.
    it('watches the same directories under either precedence', () => {
      makeService();
      const underClaude = created.map(describePattern).sort();

      service?.dispose();
      created = [];
      setPrecedence('codex');
      makeService();

      expect(created.map(describePattern).sort()).toEqual(underClaude);
    });

    // Registering the right pattern is only half of it. These drive the callback the watcher was
    // registered with, which is what backs the promise that a new file shows up without a reload.
    describe('reacting to a file event', () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('re-scans after a user-scope command file appears', async () => {
        const userCommands = path.join(H.home, '.damocles/commands');
        const svc = makeService();
        const invalidated = vi.fn();
        svc.setOnCacheInvalidate(invalidated);

        expect(await svc.getCommands()).toEqual([]);

        const file = writeCommand(H.home, '.damocles/commands', 'foo', 'appeared later');
        watcherFor(`uri:${userCommands}|**/*.md`).emitCreate(file);

        expect(invalidated).not.toHaveBeenCalled();
        vi.advanceTimersByTime(300);
        expect(invalidated).toHaveBeenCalledTimes(1);

        const commands = await svc.getCommands();
        expect(commands.map((c) => c.name)).toEqual(['foo']);
        expect(commands[0]?.source).toBe('user');
      });

      it('re-scans after a user-scope SKILL.md appears', async () => {
        const userSkills = path.join(H.home, '.damocles/skills');
        const svc = makeService();
        const invalidated = vi.fn();
        svc.setOnCacheInvalidate(invalidated);

        expect(await svc.getSkills()).toEqual([]);

        const file = writeSkill(H.home, '.damocles/skills', 'foo', 'appeared later');
        watcherFor(`uri:${userSkills}|**/SKILL.md`).emitCreate(file);
        vi.advanceTimersByTime(300);

        expect(invalidated).toHaveBeenCalledTimes(1);
        expect((await svc.getSkills()).map((s) => s.name)).toEqual(['foo']);
      });

      it('re-scans after a project-scope command file changes', async () => {
        writeCommand(ws, '.damocles/commands', 'foo', 'first version');
        const svc = makeService();
        const invalidated = vi.fn();
        svc.setOnCacheInvalidate(invalidated);

        expect((await svc.getCommands())[0]?.description).toBe('first version');

        const file = writeCommand(ws, '.damocles/commands', 'foo', 'second version');
        watcherFor(`path:${ws}|.damocles/commands/**/*.md`).emitChange(file);
        vi.advanceTimersByTime(300);

        expect(invalidated).toHaveBeenCalledTimes(1);
        expect((await svc.getCommands())[0]?.description).toBe('second version');
      });

      it('collapses a burst of events into one re-scan', async () => {
        const userCommands = path.join(H.home, '.damocles/commands');
        const svc = makeService();
        const invalidated = vi.fn();
        svc.setOnCacheInvalidate(invalidated);
        await svc.getCommands();

        const watcher = watcherFor(`uri:${userCommands}|**/*.md`);
        const file = writeCommand(H.home, '.damocles/commands', 'foo', 'appeared later');
        watcher.emitCreate(file);
        vi.advanceTimersByTime(100);
        watcher.emitChange(file);
        vi.advanceTimersByTime(100);
        watcher.emitChange(file);
        vi.advanceTimersByTime(300);

        expect(invalidated).toHaveBeenCalledTimes(1);
      });

      it('stops re-scanning after a file event once disposed', async () => {
        const userCommands = path.join(H.home, '.damocles/commands');
        const svc = makeService();
        const invalidated = vi.fn();
        svc.setOnCacheInvalidate(invalidated);
        await svc.getCommands();

        const watcher = watcherFor(`uri:${userCommands}|**/*.md`);
        svc.dispose();
        service = null;
        watcher.emitCreate(path.join(userCommands, 'foo.md'));
        vi.advanceTimersByTime(300);

        expect(invalidated).not.toHaveBeenCalled();
      });
    });

    it('watches only the user directories when no workspace folder is open', () => {
      makeService(null);

      const expected = SOURCE_FOLDERS.flatMap((source) => [
        `uri:${path.join(H.home, source.commands)}|**/*.md`,
        `uri:${path.join(H.home, source.skills)}|**/SKILL.md`,
        `uri:${path.join(H.home, source.skills)}|*`,
      ]);

      expect(created.map(describePattern).sort()).toEqual(expected.sort());
    });
  });

  describe('no workspace folder open', () => {
    it('scans only the user scope and badges nothing as project', async () => {
      writeSkill(H.home, '.damocles/skills', 'userskill', 'user version');
      writeCommand(H.home, '.damocles/commands', 'usercmd', 'user version');

      const svc = makeService(null);

      const skills = await svc.getSkills();
      expect(skills.map((s) => s.name)).toEqual(['userskill']);
      expect(skills.every((s) => s.source === 'user')).toBe(true);

      const commands = await svc.getCommands();
      expect(commands.map((c) => c.name)).toEqual(['usercmd']);
      expect(commands.every((c) => c.source === 'user')).toBe(true);
    });

    // Scanning the home dir as project scope in an untrusted window would badge the user's own skills
    // as withheld.
    it('leaves user entries unflagged in an untrusted window', async () => {
      writeSkill(H.home, '.damocles/skills', 'userskill', 'user version');
      setTrusted(false);

      const skills = await makeService(null).getSkills();
      expect(skills).toHaveLength(1);
      expect(skills[0]?.untrusted).toBeFalsy();
      expect(skills[0]?.source).toBe('user');
    });
  });

  describe('changing damocles.assetSourcePrecedence', () => {
    type ConfigEvent = { affectsConfiguration: (section: string) => boolean };
    let listeners: Array<(e: ConfigEvent) => void> = [];
    let spy: MockInstance<typeof vscode.workspace.onDidChangeConfiguration> | null = null;

    const precedenceChanged: ConfigEvent = {
      affectsConfiguration: (section) => section === 'damocles.assetSourcePrecedence',
    };
    const unrelatedChanged: ConfigEvent = { affectsConfiguration: () => false };

    beforeEach(() => {
      listeners = [];
      spy = vi
        .spyOn(vscode.workspace, 'onDidChangeConfiguration')
        .mockImplementation(((listener: (e: ConfigEvent) => void) => {
          listeners.push(listener);
          return { dispose: () => { listeners = listeners.filter((l) => l !== listener); } };
        }) as unknown as typeof vscode.workspace.onDidChangeConfiguration);
    });

    afterEach(() => {
      spy?.mockRestore();
      spy = null;
    });

    function fire(event: ConfigEvent): void {
      for (const listener of [...listeners]) listener(event);
    }

    it('re-scans so the newly-preferred source wins', async () => {
      const claudeFile = writeSkill(ws, '.claude/skills', 'foo', 'claude version');
      const codexFile = writeSkill(ws, '.codex/skills', 'foo', 'codex version');
      const claudeCommand = writeCommand(ws, '.claude/commands', 'bar', 'claude version');
      const codexCommand = writeCommand(ws, '.codex/prompts', 'bar', 'codex version');

      const svc = makeService();
      const invalidated = vi.fn();
      svc.setOnCacheInvalidate(invalidated);

      expect((await svc.getSkills())[0]?.filePath).toBe(claudeFile);
      expect((await svc.getCommands())[0]?.filePath).toBe(claudeCommand);

      setPrecedence('codex');
      fire(precedenceChanged);

      expect(invalidated).toHaveBeenCalledTimes(1);
      expect((await svc.getSkills())[0]?.filePath).toBe(codexFile);
      expect((await svc.getCommands())[0]?.filePath).toBe(codexCommand);
    });

    it('ignores a change to any other setting', async () => {
      const claudeFile = writeSkill(ws, '.claude/skills', 'foo', 'claude version');
      const codexFile = writeSkill(ws, '.codex/skills', 'foo', 'codex version');

      const svc = makeService();
      const invalidated = vi.fn();
      svc.setOnCacheInvalidate(invalidated);
      await svc.getSkills();

      setPrecedence('codex');
      fire(unrelatedChanged);

      expect(invalidated).not.toHaveBeenCalled();
      expect((await svc.getSkills())[0]?.filePath).toBe(claudeFile);

      // The same fire filtered on the precedence key does re-scan, so the negative above is the filter
      // at work rather than a listener that was never registered.
      fire(precedenceChanged);
      expect(invalidated).toHaveBeenCalledTimes(1);
      expect((await svc.getSkills())[0]?.filePath).toBe(codexFile);
    });

    it('stops re-scanning once disposed', async () => {
      writeSkill(ws, '.claude/skills', 'foo', 'claude version');

      const svc = makeService();
      const invalidated = vi.fn();
      svc.setOnCacheInvalidate(invalidated);
      await svc.getSkills();

      fire(precedenceChanged);
      expect(invalidated).toHaveBeenCalledTimes(1);

      svc.dispose();
      service = null;
      fire(precedenceChanged);

      expect(invalidated).toHaveBeenCalledTimes(1);
    });
  });
});
