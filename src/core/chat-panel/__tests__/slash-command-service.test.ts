import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as nodeOs from 'os';
import * as path from 'path';

// User-scope dirs resolve through `os.homedir()`. Redirect it to a temp dir so a developer's real
// `~/.claude/skills` cannot add entries to the results under assertion.
// timedOut: paths below the scope root, joined with '/', whose network check answers as a drive that did not answer
const H = vi.hoisted(() => ({ home: '', timedOut: new Set<string>() }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = () => (H.home !== '' ? H.home : actual.homedir());
  return { ...actual, homedir, default: { ...actual, homedir } };
});

vi.mock('../../local-links', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../local-links')>();
  return {
    ...actual,
    followsLocalLinksOnly: async (...args: Parameters<typeof actual.followsLocalLinksOnly>): Promise<boolean> => {
      if (H.timedOut.has(args[1].join('/'))) throw Object.assign(new Error('the drive did not answer'), { code: 'ETIMEDOUT' });
      return actual.followsLocalLinksOnly(...args);
    },
  };
});

vi.mock('../../logger', () => ({ log: vi.fn() }));

import { installFakePlatform, type FakeFileWatcher, type FakePlatform } from '../../../__mocks__/fake-platform';
import { SlashCommandService } from '../slash-command-service';
import { initPiLoader } from '../../pi-session/pi-loader';
import { DRIVE_ANSWER_TTL_MS } from '../../local-links';
import type { AssetSourcePrecedence } from '../../../shared/types/settings';

// pi's one-time module load, paid here so no test's timeout measures it.
beforeAll(async () => {
  await initPiLoader();
});

/** The three asset sources' on-disk folder names, stated here rather than read from the source. */
const SOURCE_FOLDERS = [
  { commands: '.damocles/commands', skills: '.damocles/skills' },
  { commands: '.claude/commands', skills: '.claude/skills' },
  { commands: '.codex/prompts', skills: '.codex/skills' },
] as const;

/** What a skill root's recursive watch matches: every SKILL.md and every ignore file the skill walks read, stated here. */
const SKILL_FILES = '{SKILL.md,.gitignore,.ignore,.fdignore}';

/** Flatten a registered watcher to `<base>|<glob>`, or `workspace:<glob>` for a workspace-wide one. */
function describeWatcher(watcher: FakeFileWatcher): string {
  return watcher.base === null ? `workspace:${watcher.glob}` : `${watcher.base}|${watcher.glob}`;
}

let platform: FakePlatform;

function setPrecedence(value: AssetSourcePrecedence): void {
  void platform.settings.update('damocles.assetSourcePrecedence', value, 'user');
}

function setTrusted(trusted: boolean): void {
  platform.trust.setTrusted(trusted);
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

// A file symlink needs a privilege unprivileged Windows lacks, so the tests that make one report a skip there.
const canSymlinkFiles = ((): boolean => {
  const dir = fs.mkdtempSync(path.join(nodeOs.tmpdir(), 'scs-probe-'));
  try {
    fs.writeFileSync(path.join(dir, 'target'), '');
    fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

function fileLink(target: string, link: string): void {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, 'file');
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
    service = new SlashCommandService(projectPath, platform);
    return service;
  }

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(nodeOs.tmpdir(), 'scs-ws-'));
    H.home = fs.mkdtempSync(path.join(nodeOs.tmpdir(), 'scs-home-'));
    platform = installFakePlatform({ settings: { user: { 'damocles.assetSourcePrecedence': 'claude' } } });
  });

  afterEach(() => {
    service?.dispose();
    service = null;
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

      platform.trust.grantTrust([ws]);

      expect(invalidated).toHaveBeenCalledTimes(1);
      // A stale cache would replay the flagged entries, so this re-scan is the badge clearing.
      expect((await svc.getSkills())[0]?.untrusted).toBeFalsy();
      expect((await svc.getCommands())[0]?.untrusted).toBeFalsy();
    });

    // A panel moved onto a just-added project scans it before the grant lands; that scan must not outlive the grant.
    it('a scan in flight when trust is granted neither caches nor returns the flagged entries', async () => {
      writeSkill(ws, '.damocles/skills', 'foo', 'project version');
      writeCommand(ws, '.damocles/commands', 'bar', 'project version');
      setTrusted(false);

      const svc = makeService();
      const skills = svc.getSkills();
      const commands = svc.getCommands();
      platform.trust.grantTrust([ws]);

      expect((await skills)[0]?.untrusted).toBeFalsy();
      expect((await commands)[0]?.untrusted).toBeFalsy();
      expect((await svc.findSkill('foo'))?.untrusted).toBeFalsy();
      expect((await svc.findCommand('bar'))?.untrusted).toBeFalsy();
    });

    it('flags the project entries again on a revoke after the grant', async () => {
      writeSkill(ws, '.damocles/skills', 'foo', 'project version');
      writeCommand(ws, '.damocles/commands', 'bar', 'project version');
      setTrusted(false);

      const svc = makeService();
      const invalidated = vi.fn();
      svc.setOnCacheInvalidate(invalidated);
      platform.trust.grantTrust([ws]);
      expect((await svc.getSkills())[0]?.untrusted).toBeFalsy();
      expect((await svc.getCommands())[0]?.untrusted).toBeFalsy();

      platform.trust.revokeTrust([ws]);

      expect(invalidated).toHaveBeenCalledTimes(2);
      expect((await svc.getSkills())[0]?.untrusted).toBe(true);
      expect((await svc.getCommands())[0]?.untrusted).toBe(true);
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
      platform.trust.grantTrust([ws]);

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

    // pi strips a BOM before reading frontmatter, so the agent loads this skill as `commit`.
    it('names a skill whose SKILL.md starts with a BOM by its frontmatter name', async () => {
      const file = writeSkillNamed(ws, '.damocles/skills', 'commit-helper', 'commit', 'renamed skill');
      fs.writeFileSync(file, `\uFEFF${fs.readFileSync(file, 'utf8')}`, 'utf8');

      const skills = await makeService().getSkills();
      expect(skills.map((s) => [s.name, s.description])).toEqual([['commit', 'renamed skill']]);
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

    it('reads the frontmatter of a command file that starts with a BOM', async () => {
      const dir = path.join(ws, '.damocles', 'commands');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'foo.md'), '\uFEFF---\ndescription: d\nargument-hint: <x>\n---\n\nbody\n', 'utf8');

      const commands = await makeService().getCommands();
      expect(commands[0]?.description).toBe('d');
      expect(commands[0]?.argumentHint).toBe('<x>');
    });
  });

  describe('links under the asset folders', () => {
    let outside = '';

    beforeEach(() => {
      outside = fs.realpathSync.native(fs.mkdtempSync(path.join(nodeOs.tmpdir(), 'scs-outside-')));
    });

    afterEach(() => {
      fs.rmSync(outside, { recursive: true, force: true });
    });

    // A folder link every host can make: a junction on Windows, which needs no privilege.
    function folderLink(target: string, link: string): void {
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    }

    function writeAt(file: string, text = '---\ndescription: from the clone\n---\nPick up issue $1.\n'): string {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, 'utf8');
      return file;
    }

    it.skipIf(!canSymlinkFiles)('follows a linked command file in a namespace folder', async () => {
      const target = writeAt(path.join(outside, 'pickup.md'));
      fileLink(target, path.join(H.home, '.claude', 'commands', 'gs', 'pickup.md'));

      const commands = await makeService().getCommands();
      expect(commands.map((c) => [c.name, c.description, c.withheld])).toEqual([['gs:pickup', 'from the clone', undefined]]);
    });

    it('follows a namespace folder that is a junction or a folder link', async () => {
      writeAt(path.join(outside, 'commands', 'pickup.md'));
      folderLink(path.join(outside, 'commands'), path.join(H.home, '.claude', 'commands', 'gs'));

      expect((await makeService().getCommands()).map((c) => c.name)).toEqual(['gs:pickup']);
      expect((await service!.findCommand('gs:pickup'))?.filePath).toBe(path.join(H.home, '.claude', 'commands', 'gs', 'pickup.md'));
    });

    it('follows a linked ~/.damocles root', async () => {
      writeAt(path.join(outside, 'dotfiles', 'commands', 'gs', 'pickup.md'));
      folderLink(path.join(outside, 'dotfiles'), path.join(H.home, '.damocles'));

      expect((await makeService().getCommands()).map((c) => c.name)).toEqual(['gs:pickup']);
    });

    it.skipIf(!canSymlinkFiles)('follows a linked skill folder and a linked SKILL.md', async () => {
      writeSkill(outside, 'skills', 'tidy', 'tidy up');
      folderLink(path.join(outside, 'skills', 'tidy'), path.join(ws, '.damocles', 'skills', 'tidy'));
      const file = writeSkill(outside, 'more', 'lint', 'lint it');
      fileLink(file, path.join(H.home, '.claude', 'skills', 'lint', 'SKILL.md'));

      expect((await makeService().getSkills()).map((s) => [s.name, s.source])).toEqual([['lint', 'user'], ['tidy', 'project']]);
    });

    it('lists a skill folder linked from both the project and the user folder once', async () => {
      writeSkill(outside, 'skills', 'tidy', 'tidy up');
      folderLink(path.join(outside, 'skills', 'tidy'), path.join(ws, '.claude', 'skills', 'tidy'));
      folderLink(path.join(outside, 'skills', 'tidy'), path.join(H.home, '.claude', 'skills', 'tidy'));

      expect((await makeService().getSkills()).map((s) => [s.name, s.source])).toEqual([['tidy', 'project']]);
    });

    it('shows a link loop as an inert row', async () => {
      writeCommand(ws, '.damocles/commands', 'real', 'a real file');
      folderLink(path.join(ws, '.damocles', 'commands'), path.join(ws, '.damocles', 'commands', 'again'));

      const commands = await makeService().getCommands();
      expect(commands.map((c) => [c.name, c.withheld])).toEqual([['again:', { reason: 'loop' }], ['real', undefined]]);
      expect((await service!.findCommand('again:anything'))?.withheld).toEqual({ reason: 'loop' });
    });

    it('withholds every command under commands/skill, which pi\'s /skill: prefix claims', async () => {
      writeCommand(ws, '.damocles/commands/skill', 'x', 'shadowed');

      expect((await makeService().getCommands()).map((c) => [c.name, c.withheld])).toEqual([['skill:x', { reason: 'reservedNamespace' }]]);
    });

    it.runIf(process.platform !== 'win32')('skips a socket named like a command and lists the rest', async () => {
      writeCommand(ws, '.damocles/commands', 'real', 'a real file');
      const net = await import('net');
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(path.join(ws, '.damocles', 'commands', 'sock.md'), resolve));
      try {
        expect((await makeService().getCommands()).map((c) => c.name)).toEqual(['real']);
      } finally {
        server.close();
      }
    });

    it('lists one unavailable row for each folder a broken ~/.claude withholds', async () => {
      folderLink(path.join(outside, 'gone'), path.join(H.home, '.claude'));

      const roots = await makeService().getWithheldRoots();

      expect(roots.map((root) => [root.assets, root.folder, root.source, root.withheld])).toEqual([
        ['commands', '.claude', 'user', { reason: 'broken', target: path.join(outside, 'gone') }],
        ['skills', '.claude', 'user', { reason: 'broken', target: path.join(outside, 'gone') }],
      ]);
    });

    describe('a commands folder on a drive that did not answer', () => {
      beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      });

      afterEach(() => {
        H.timedOut.clear();
        vi.useRealTimers();
      });

      it('rescans once the drive probe\'s answer expired, and lists the folder once the drive answers', async () => {
        writeCommand(H.home, '.claude/commands', 'deploy', 'ship it');
        H.timedOut.add('.claude/commands');
        const svc = makeService(null);
        const invalidated = vi.fn();
        svc.setOnCacheInvalidate(invalidated);

        expect((await svc.getWithheldRoots()).map((root) => [root.assets, root.withheld])).toEqual([['commands', { reason: 'unreachable' }]]);

        H.timedOut.clear();
        await vi.advanceTimersByTimeAsync(DRIVE_ANSWER_TTL_MS + 300);

        expect(invalidated).toHaveBeenCalledTimes(1);
        expect(await svc.getWithheldRoots()).toEqual([]);
        expect((await svc.getCommands()).map((c) => c.name)).toEqual(['deploy']);
      });
    });

    describe('in an untrusted project', () => {
      it('lists an unavailable row asking for trust for a commands folder linked out of the project, and its commands once trusted', async () => {
        writeAt(path.join(outside, 'deploy.md'));
        folderLink(outside, path.join(ws, '.damocles', 'commands'));
        setTrusted(false);
        const svc = makeService();

        expect(await svc.getWithheldRoots()).toEqual([
          { kind: 'withheldRoot', assets: 'commands', folder: '.damocles', source: 'project', filePath: path.join(ws, '.damocles', 'commands'), untrusted: true, withheld: { reason: 'linkOutside' } },
        ]);

        platform.trust.grantTrust([ws]);

        expect(await svc.getWithheldRoots()).toEqual([]);
        expect((await svc.getCommands()).map((c) => c.name)).toEqual(['deploy']);
      });

      it.skipIf(!canSymlinkFiles)('lists a link that stays inside as untrusted and one leading outside as an inert row, never reading its target', async () => {
        writeCommand(ws, 'shared', 'inside', 'inside the project');
        fileLink(path.join(ws, 'shared', 'inside.md'), path.join(ws, '.damocles', 'commands', 'inside.md'));
        writeAt(path.join(outside, 'ns', 'pickup.md'));
        folderLink(path.join(outside, 'ns'), path.join(ws, '.damocles', 'commands', 'gs'));
        setTrusted(false);
        const touched: string[] = [];
        for (const name of ['open', 'stat', 'readFile'] as const) {
          const original = fs.promises[name].bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
          vi.spyOn(fs.promises, name).mockImplementation((async (file: fs.PathLike, ...rest: unknown[]) => {
            touched.push(String(file));
            return original(file, ...rest);
          }) as never);
        }

        const commands = await makeService().getCommands();

        expect(commands.map((c) => [c.name, c.untrusted, c.withheld])).toEqual([['gs:', true, { reason: 'linkOutside' }], ['inside', true, undefined]]);
        expect(touched.filter((file) => file.toLowerCase().startsWith(outside.toLowerCase()) || file.includes(`${path.sep}gs`))).toEqual([]);
        expect((await service!.findCommand('gs:pickup'))?.withheld).toEqual({ reason: 'linkOutside' });
        vi.restoreAllMocks();
      });

      it('follows the outside link once trust is granted and withholds it again on a revoke, with no reload', async () => {
        writeAt(path.join(outside, 'ns', 'pickup.md'));
        folderLink(path.join(outside, 'ns'), path.join(ws, '.damocles', 'commands', 'gs'));
        setTrusted(false);
        const svc = makeService();

        expect((await svc.findCommand('gs:pickup'))?.withheld).toEqual({ reason: 'linkOutside' });

        platform.trust.grantTrust([ws]);
        const granted = await svc.findCommand('gs:pickup');
        expect([granted?.name, granted?.untrusted, granted?.withheld]).toEqual(['gs:pickup', undefined, undefined]);

        platform.trust.revokeTrust([ws]);
        expect((await svc.findCommand('gs:pickup'))?.withheld).toEqual({ reason: 'linkOutside' });
      });
    });

    describe('refresh behind a link', () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it.skipIf(!canSymlinkFiles).each(['user', 'project'] as const)('re-reads a %s-scope linked command after its target is renamed over, as git writes it', async (scope) => {
        const target = writeAt(path.join(outside, 'pickup.md'), '---\ndescription: first\n---\nbody\n');
        const root = scope === 'user' ? H.home : ws;
        fileLink(target, path.join(root, '.claude', 'commands', 'gs', 'pickup.md'));
        const svc = makeService();
        const invalidated = vi.fn();
        svc.setOnCacheInvalidate(invalidated);
        expect((await svc.getCommands())[0]?.description).toBe('first');

        const next = writeAt(path.join(outside, 'pickup.md.tmp'), '---\ndescription: second\n---\nbody\n');
        fs.renameSync(next, target);
        platform.fileWatchers.watcher(outside, '*').fireCreate(target);
        vi.advanceTimersByTime(300);

        expect(invalidated).toHaveBeenCalledTimes(1);
        expect((await svc.getCommands())[0]?.description).toBe('second');
      });

      it.skipIf(!canSymlinkFiles)('shows a broken link with its target and lists the command once the target is restored', async () => {
        const target = writeAt(path.join(outside, 'pickup.md'));
        fileLink(target, path.join(H.home, '.claude', 'commands', 'pickup.md'));
        fs.rmSync(target);
        const svc = makeService();

        expect((await svc.getCommands()).map((c) => [c.name, c.withheld])).toEqual([['pickup', { reason: 'broken', target }]]);

        writeAt(target);
        platform.fileWatchers.watcher(outside, '*').fireCreate(target);
        vi.advanceTimersByTime(300);

        expect((await svc.getCommands()).map((c) => [c.name, c.withheld])).toEqual([['pickup', undefined]]);
      });

      it.skipIf(!canSymlinkFiles)('ignores a change beside the target in its folder', async () => {
        const target = writeAt(path.join(outside, 'pickup.md'));
        fileLink(target, path.join(H.home, '.claude', 'commands', 'pickup.md'));
        const svc = makeService();
        const invalidated = vi.fn();
        svc.setOnCacheInvalidate(invalidated);
        await svc.getCommands();

        platform.fileWatchers.watcher(outside, '*').fireChange(path.join(outside, 'unrelated.md'));
        vi.advanceTimersByTime(300);

        expect(invalidated).not.toHaveBeenCalled();
      });
    });

    // The network check reads link targets as readlink gives them, so a junction whose readlink is faked onto a share
    // stands for a link Windows would follow there.
    it.runIf(process.platform === 'win32')('shows links onto a network share and WSL as inert rows, reaching neither', async () => {
      const commands = path.join(H.home, '.claude', 'commands');
      folderLink(outside, path.join(commands, 'nas.md'));
      folderLink(outside, path.join(commands, 'wsl.md'));
      const fakes = new Map([
        [path.join(commands, 'nas.md').toLowerCase(), '\\\\host\\share\\x.md'],
        [path.join(commands, 'wsl.md').toLowerCase(), '\\\\wsl.localhost\\Ubuntu\\x.md'],
      ]);
      const readlink = fs.promises.readlink.bind(fs.promises);
      vi.spyOn(fs.promises, 'readlink').mockImplementation((async (file: fs.PathLike) => fakes.get(String(file).toLowerCase()) ?? readlink(file)) as never);
      const reached: string[] = [];
      for (const name of ['lstat', 'stat', 'realpath', 'open'] as const) {
        const original = fs.promises[name].bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
        vi.spyOn(fs.promises, name).mockImplementation((async (file: fs.PathLike, ...rest: unknown[]) => {
          if (/^[\\/]{2}/.test(String(file)) || (name !== 'lstat' && fakes.has(String(file).toLowerCase()))) reached.push(`${name} ${String(file)}`);
          return original(file, ...rest);
        }) as never);
      }

      const rows = await makeService().getCommands();

      expect(rows.map((c) => [c.name, c.withheld])).toEqual([['nas', { reason: 'share' }], ['wsl', { reason: 'share' }]]);
      expect(reached).toEqual([]);
      vi.restoreAllMocks();
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
    /** Every live watcher, flattened, so a test names the directory it drives. */
    function registered(): string[] {
      return platform.fileWatchers.watchers.filter((w) => !w.disposed).map(describeWatcher);
    }

    /** A user dir's watcher: based at the Damocles data folder for ~/.damocles, else the home folder, so the watcher judges `.claude`. */
    function user(dir: string, glob: string): string {
      return dir.startsWith('.damocles/') ? `${path.join(H.home, '.damocles')}|${dir.slice('.damocles/'.length)}/${glob}` : `${H.home}|${dir}/${glob}`;
    }

    it('anchors every registered watcher on the network-rule base of the directory it must observe', () => {
      makeService();

      const expected = SOURCE_FOLDERS.flatMap((source) => [
        `${ws}|${source.commands}/**`,
        `${ws}|${source.skills}/**/${SKILL_FILES}`,
        `${ws}|${source.skills}/*`,
        user(source.commands, '**'),
        user(source.skills, `**/${SKILL_FILES}`),
        user(source.skills, '*'),
      ]);

      expect(registered().sort()).toEqual(expected.sort());
    });

    // VS Code reports no events from a workspace glob outside the opened workspace folders, so a
    // user-scope watcher registered that way never fires and the menu goes stale until a reload.
    it('registers no workspace-wide watcher', () => {
      makeService();

      expect(registered().filter((d) => d.startsWith('workspace:'))).toEqual([]);
    });

    // Precedence changes the scan order, not the set of directories, which is why a precedence change
    // clears the caches without rebuilding any watcher.
    it('watches the same directories under either precedence', () => {
      makeService();
      const underClaude = registered().sort();

      service?.dispose();
      setPrecedence('codex');
      makeService();

      expect(registered().sort()).toEqual(underClaude);
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
        const svc = makeService();
        const invalidated = vi.fn();
        svc.setOnCacheInvalidate(invalidated);

        expect(await svc.getCommands()).toEqual([]);

        const file = writeCommand(H.home, '.damocles/commands', 'foo', 'appeared later');
        platform.fileWatchers.watcher(path.join(H.home, '.damocles'), 'commands/**').fireCreate(file);

        expect(invalidated).not.toHaveBeenCalled();
        vi.advanceTimersByTime(300);
        expect(invalidated).toHaveBeenCalledTimes(1);

        const commands = await svc.getCommands();
        expect(commands.map((c) => c.name)).toEqual(['foo']);
        expect(commands[0]?.source).toBe('user');
      });

      it('re-scans after a user-scope SKILL.md appears', async () => {
        const svc = makeService();
        const invalidated = vi.fn();
        svc.setOnCacheInvalidate(invalidated);

        expect(await svc.getSkills()).toEqual([]);

        const file = writeSkill(H.home, '.damocles/skills', 'foo', 'appeared later');
        platform.fileWatchers.watcher(path.join(H.home, '.damocles'), `skills/**/${SKILL_FILES}`).fireCreate(file);
        vi.advanceTimersByTime(300);

        expect(invalidated).toHaveBeenCalledTimes(1);
        expect((await svc.getSkills()).map((s) => s.name)).toEqual(['foo']);
      });

      // The skill walks read the ignore files of every folder they enter, as pi does.
      it('re-scans after an ignore file below the skills folder changes', async () => {
        writeSkill(ws, '.damocles/skills/group', 'foo', 'ignored later');
        const svc = makeService();
        const invalidated = vi.fn();
        svc.setOnCacheInvalidate(invalidated);
        await svc.getSkills();

        const ignoreFile = path.join(ws, '.damocles', 'skills', 'group', '.gitignore');
        fs.writeFileSync(ignoreFile, 'foo/\n', 'utf8');
        platform.fileWatchers.watcher(ws, `.damocles/skills/**/${SKILL_FILES}`).fireCreate(ignoreFile);
        vi.advanceTimersByTime(300);

        expect(invalidated).toHaveBeenCalledTimes(1);
      });

      it('re-scans after a project-scope command file changes', async () => {
        writeCommand(ws, '.damocles/commands', 'foo', 'first version');
        const svc = makeService();
        const invalidated = vi.fn();
        svc.setOnCacheInvalidate(invalidated);

        expect((await svc.getCommands())[0]?.description).toBe('first version');

        const file = writeCommand(ws, '.damocles/commands', 'foo', 'second version');
        platform.fileWatchers.watcher(ws, '.damocles/commands/**').fireChange(file);
        vi.advanceTimersByTime(300);

        expect(invalidated).toHaveBeenCalledTimes(1);
        expect((await svc.getCommands())[0]?.description).toBe('second version');
      });

      // A skill approval prompt reads the description from the menu's cache, which only a watched change refreshes.
      it('describes a skill from its cached scan until a watched change', async () => {
        writeSkill(ws, '.damocles/skills', 'foo', 'first version');
        const svc = makeService();

        expect(await svc.describeSkill('foo')).toBe('first version');
        const file = writeSkill(ws, '.damocles/skills', 'foo', 'second version');
        expect(await svc.describeSkill('FOO')).toBe('first version');

        platform.fileWatchers.watcher(ws, `.damocles/skills/**/${SKILL_FILES}`).fireChange(file);
        vi.advanceTimersByTime(300);

        expect(await svc.describeSkill('foo')).toBe('second version');
      });

      it('describes no skill that cannot run', async () => {
        writeSkill(ws, '.damocles/skills', 'foo', 'project skill');
        setTrusted(false);
        const svc = makeService();

        expect(await svc.describeSkill('foo')).toBeUndefined();
        expect(await svc.describeSkill('nope')).toBeUndefined();
      });

      // A namespace link has no .md suffix, and no recursive watch enters a link, so only its own entry's events reach the menu.
      it.each([
        ['user', () => H.home],
        ['project', () => ws],
      ])('re-scans when a %s namespace link commands/gs is made, removed or re-pointed', async (_scope, baseOf) => {
        const svc = makeService();
        const invalidated = vi.fn();
        svc.setOnCacheInvalidate(invalidated);
        await svc.getCommands();

        const base = baseOf();
        const link = path.join(base, '.claude', 'commands', 'gs');
        const live = platform.fileWatchers.watchers.filter((w) => !w.disposed && w.base === base);
        for (const fire of [(w: FakeFileWatcher) => w.fireCreate(link), (w: FakeFileWatcher) => w.fireDelete(link), (w: FakeFileWatcher) => w.fireChange(link)]) {
          for (const watcher of live) fire(watcher);
          vi.advanceTimersByTime(300);
        }

        expect(invalidated).toHaveBeenCalledTimes(3);
      });

      it('collapses a burst of events into one re-scan', async () => {
        const svc = makeService();
        const invalidated = vi.fn();
        svc.setOnCacheInvalidate(invalidated);
        await svc.getCommands();

        const watcher = platform.fileWatchers.watcher(path.join(H.home, '.damocles'), 'commands/**');
        const file = writeCommand(H.home, '.damocles/commands', 'foo', 'appeared later');
        watcher.fireCreate(file);
        vi.advanceTimersByTime(100);
        watcher.fireChange(file);
        vi.advanceTimersByTime(100);
        watcher.fireChange(file);
        vi.advanceTimersByTime(300);

        expect(invalidated).toHaveBeenCalledTimes(1);
      });

      it('stops re-scanning after a file event once disposed', async () => {
        const userCommands = path.join(H.home, '.damocles/commands');
        const svc = makeService();
        const invalidated = vi.fn();
        svc.setOnCacheInvalidate(invalidated);
        await svc.getCommands();

        const watcher = platform.fileWatchers.watcher(path.join(H.home, '.damocles'), 'commands/**');
        svc.dispose();
        service = null;
        watcher.fireCreate(path.join(userCommands, 'foo.md'));
        vi.advanceTimersByTime(300);

        expect(invalidated).not.toHaveBeenCalled();
      });
    });

    it('watches only the user directories when no workspace folder is open', () => {
      makeService(null);

      const expected = SOURCE_FOLDERS.flatMap((source) => [user(source.commands, '**'), user(source.skills, `**/${SKILL_FILES}`), user(source.skills, '*')]);

      expect(registered().sort()).toEqual(expected.sort());
    });
  });

  // A panel on folder B gets a service built for B; nothing it lists or watches may come from A.
  describe('one service per folder', () => {
    let other = '';

    beforeEach(() => {
      other = fs.mkdtempSync(path.join(nodeOs.tmpdir(), 'scs-ws-b-'));
    });

    afterEach(() => {
      fs.rmSync(other, { recursive: true, force: true });
    });

    it("lists only its own folder's project assets beside the user ones", async () => {
      writeCommand(ws, '.damocles/commands', 'acmd', 'folder A');
      writeSkill(ws, '.damocles/skills', 'askill', 'folder A');
      writeCommand(other, '.damocles/commands', 'bcmd', 'folder B');
      writeSkill(other, '.damocles/skills', 'bskill', 'folder B');
      writeCommand(H.home, '.damocles/commands', 'usercmd', 'user');

      const svc = makeService(other);

      expect((await svc.getCommands()).map((c) => c.name).sort()).toEqual(['bcmd', 'usercmd']);
      expect((await svc.getSkills()).map((s) => s.name)).toEqual(['bskill']);
      expect(await svc.findCommand('acmd')).toBeUndefined();
      expect(await svc.findSkill('askill')).toBeUndefined();
    });

    it('anchors its project watchers on its own folder and never on another', () => {
      makeService(other);
      const anchors = platform.fileWatchers.watchers
        .filter((w) => w.base !== null && !w.base.startsWith(H.home))
        .map(describeWatcher);
      expect(anchors).toHaveLength(SOURCE_FOLDERS.length * 3);
      expect(anchors.every((d) => d.startsWith(`${other}|`))).toBe(true);
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

      expect(invalidated).toHaveBeenCalledTimes(1);
      expect((await svc.getSkills())[0]?.filePath).toBe(codexFile);
      expect((await svc.getCommands())[0]?.filePath).toBe(codexCommand);
    });

    it('ignores a change to any other setting', async () => {
      writeSkill(ws, '.claude/skills', 'foo', 'claude version');
      const codexFile = writeSkill(ws, '.codex/skills', 'foo', 'codex version');

      const svc = makeService();
      const invalidated = vi.fn();
      svc.setOnCacheInvalidate(invalidated);
      await svc.getSkills();

      await platform.settings.update('damocles.model', 'gpt-6.1-sol', 'user');

      expect(invalidated).not.toHaveBeenCalled();

      // A precedence change does re-scan, so the negative above is the filter at work rather than a
      // listener that was never registered.
      setPrecedence('codex');
      expect(invalidated).toHaveBeenCalledTimes(1);
      expect((await svc.getSkills())[0]?.filePath).toBe(codexFile);
    });

    it('stops re-scanning once disposed', async () => {
      writeSkill(ws, '.claude/skills', 'foo', 'claude version');

      const svc = makeService();
      const invalidated = vi.fn();
      svc.setOnCacheInvalidate(invalidated);
      await svc.getSkills();

      setPrecedence('codex');
      expect(invalidated).toHaveBeenCalledTimes(1);

      svc.dispose();
      service = null;
      setPrecedence('claude');

      expect(invalidated).toHaveBeenCalledTimes(1);
    });
  });
});
