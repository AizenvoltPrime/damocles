import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakePlatform } from '../../../__mocks__/fake-platform';
import { folderOnAdminShare } from '../../../__mocks__/admin-share';
import { initPiLoader, type PiCodingAgentModule } from '../../pi-session/pi-loader';
import {
  boundedText,
  discoverCommands,
  discoverSkills,
  findAsset,
  isRunnable,
  mergeAssets,
  skillLinkTargets,
  toMenuCommand,
  toMenuRoot,
  toMenuSkill,
  toPromptTemplate,
  type DiscoveryOptions,
} from '../asset-discovery';

let pi: PiCodingAgentModule;
let tmp: string;
let home: string;
let project: string;
let lines: string[];

beforeAll(async () => {
  pi = (await initPiLoader())!;
});

beforeEach(() => {
  installFakePlatform({ settings: { user: { 'damocles.assetSourcePrecedence': 'claude' } } });
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'asset-discovery-')));
  home = path.join(tmp, 'home');
  project = path.join(tmp, 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  lines = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(file: string, text = '---\ndescription: d\n---\nbody\n'): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

// A file symlink needs a privilege unprivileged Windows lacks, so the tests that make one report a skip there.
const canSymlinkFiles = ((): boolean => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-discovery-probe-'));
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

function link(target: string, at: string, type: 'file' | 'folder'): void {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at, type === 'file' ? 'file' : process.platform === 'win32' ? 'junction' : 'dir');
}

function options(overrides: Partial<DiscoveryOptions> = {}): DiscoveryOptions {
  return { workspacePath: project, homeDir: home, trusted: true, parseFrontmatter: pi.parseFrontmatter, log: (line) => lines.push(line), ...overrides };
}

async function menuCommands(overrides: Partial<DiscoveryOptions> = {}) {
  return mergeAssets((await discoverCommands(options(overrides))).commands).map(toMenuCommand);
}

describe('discoverCommands', () => {
  const PICKUP = '---\ndescription: pick up an issue\nargument-hint: <issue>\n---\nPick up issue $1.\n';

  it.for([
    ['a linked command file', (clone: string) => link(write(path.join(clone, 'pickup.md'), PICKUP), path.join(home, '.claude', 'commands', 'gs', 'pickup.md'), 'file'), true],
    ['a linked namespace folder', (clone: string) => (write(path.join(clone, 'commands', 'pickup.md'), PICKUP), link(path.join(clone, 'commands'), path.join(home, '.claude', 'commands', 'gs'), 'folder')), false],
    ['a linked ~/.claude', (clone: string) => (write(path.join(clone, 'claude', 'commands', 'gs', 'pickup.md'), PICKUP), link(path.join(clone, 'claude'), path.join(home, '.claude'), 'folder')), false],
  ] as const)('lists /gs:pickup through %s', async ([, arrange, fileLink], { skip }) => {
    if (fileLink && !canSymlinkFiles) skip();
    arrange(path.join(tmp, 'clone'));

    expect(await menuCommands()).toEqual([{
      name: 'gs:pickup',
      description: 'pick up an issue',
      argumentHint: '<issue>',
      filePath: path.join(home, '.claude', 'commands', 'gs', 'pickup.md'),
      source: 'user',
      namespace: 'gs',
    }]);
  });

  it.runIf(process.platform === 'win32')('judges the Damocles data folder\'s roots from that folder, so a ~/.damocles moved onto a share lists its commands (win32)', async (ctx) => {
    const real = folderOnAdminShare(ctx, path.join(home, '.damocles'));
    try {
      write(path.join(real, 'commands', 'deploy.md'));
      expect((await menuCommands()).map((command) => command.name)).toContain('deploy');
    } finally {
      fs.rmSync(real, { recursive: true, force: true });
    }
  });

  it('withholds every command in a folder named skill, which pi\'s /skill: prefix claims', async () => {
    write(path.join(project, '.claude', 'commands', 'skill', 'x.md'));

    const rows = await menuCommands();
    expect(rows.map((row) => [row.name, row.withheld])).toEqual([['skill:x', { reason: 'reservedNamespace' }]]);
    // the send path finds no row for pi's own /skill:x, so a skill named x still runs
    expect(findAsset(rows, 'skill:x')).toBeUndefined();
    expect(findAsset(rows, 'SKILL:x')).toBeUndefined();
  });

  it('keeps a command in a folder named Skill runnable, as pi\'s /skill: prefix is case-sensitive', async () => {
    write(path.join(project, '.claude', 'commands', 'Skill', 'x.md'));

    expect((await menuCommands()).map((row) => [row.name, row.withheld])).toEqual([['Skill:x', undefined]]);
  });

  it('lets no withheld skill folder link stand for pi\'s own /skill:<name>', async () => {
    write(path.join(tmp, 'outside', 'x.md'));
    link(path.join(tmp, 'outside'), path.join(project, '.claude', 'commands', 'skill'), 'folder');

    const rows = await menuCommands({ trusted: false });

    expect(rows.map((row) => [row.name, row.withheld?.reason])).toEqual([['skill:', 'linkOutside']]);
    expect(findAsset(rows, 'skill:tidy')).toBeUndefined();
  });

  it('withholds a command whose frontmatter does not parse, carrying a bounded single-line message', async () => {
    write(path.join(project, '.claude', 'commands', 'bad.md'), '---\nargument-hint: [a] [b]\n---\nbody\n');

    const [row] = await menuCommands();
    expect(row?.withheld?.reason).toBe('invalidFrontmatter');
    const detail = row?.withheld?.reason === 'invalidFrontmatter' ? row.withheld.detail : '';
    expect(detail.length).toBeGreaterThan(0);
    expect(detail.length).toBeLessThanOrEqual(200);
    expect([...detail].some((char) => char.charCodeAt(0) < 0x20)).toBe(false);
    expect(row?.description).toBe('');
  });

  it.skipIf(!canSymlinkFiles)('withholds a broken link, naming its target', async () => {
    const target = write(path.join(tmp, 'clone', 'gone.md'));
    link(target, path.join(home, '.claude', 'commands', 'gone.md'), 'file');
    fs.rmSync(target);

    const { commands, followed } = await discoverCommands(options());

    expect(commands.map((command) => [command.name, command.withheld])).toEqual([['gone', { reason: 'broken', target }]]);
    expect(followed.user).toEqual(expect.arrayContaining([{ base: path.join(tmp, 'clone'), files: [target] }]));
    expect(followed.project).toEqual([]);
  });

  describe('in an untrusted project', () => {
    it.skipIf(!canSymlinkFiles)('lists a link staying inside as untrusted, and one leading outside as an inert linkOutside row', async () => {
      const commands = path.join(project, '.claude', 'commands');
      write(path.join(project, 'shared', 'inside.md'));
      write(path.join(tmp, 'outside', 'secret.md'));
      write(path.join(tmp, 'outside', 'ns', 'pickup.md'));
      link(path.join(project, 'shared', 'inside.md'), path.join(commands, 'inside.md'), 'file');
      link(path.join(tmp, 'outside', 'secret.md'), path.join(commands, 'secret.md'), 'file');
      link(path.join(tmp, 'outside', 'ns'), path.join(commands, 'gs'), 'folder');

      const rows = await menuCommands({ trusted: false });

      expect(rows.map((row) => [row.name, row.untrusted, row.withheld?.reason])).toEqual([
        ['gs:', true, 'linkOutside'],
        ['inside', true, undefined],
        ['secret', true, 'linkOutside'],
      ]);
      expect(findAsset(rows, 'GS:pickup')?.name).toBe('gs:');
      expect(findAsset(rows, 'inside')?.name).toBe('inside');
      expect(findAsset(rows, 'other:x')).toBeUndefined();
    });

    it.skipIf(!canSymlinkFiles)('lets a runnable user command win over the inert project row of the same name', async () => {
      write(path.join(tmp, 'outside', 'deploy.md'));
      link(path.join(tmp, 'outside', 'deploy.md'), path.join(project, '.damocles', 'commands', 'deploy.md'), 'file');
      const user = write(path.join(home, '.claude', 'commands', 'deploy.md'));

      const rows = await menuCommands({ trusted: false });

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ filePath: user, source: 'user' });
      expect(isRunnable(rows[0]!)).toBe(true);
    });
  });
});

describe('toPromptTemplate', () => {
  it('names a namespaced template ns:name and describes it by its first line cut at 60 characters, as pi does', async () => {
    const long = 'x'.repeat(61);
    write(path.join(home, '.damocles', 'commands', 'gs', 'pickup.md'), `${long}\nmore\n`);

    const [command] = (await discoverCommands(options())).commands;
    const template = toPromptTemplate(command!, pi.createSyntheticSourceInfo);

    expect(template).toMatchObject({ name: 'gs:pickup', description: `${'x'.repeat(60)}...`, content: `${long}\nmore\n` });
    expect(template.argumentHint).toBeUndefined();
    expect(template.sourceInfo).toMatchObject({ source: 'damocles', scope: 'user', origin: 'top-level' });
  });
});

describe('discoverSkills', () => {
  function writeSkill(folder: string, frontmatter: string): string {
    return write(path.join(folder, 'SKILL.md'), `---\n${frontmatter}\n---\nbody\n`);
  }

  it('lists a linked skill folder once when the project and the user folder both link it', async () => {
    const target = path.join(tmp, 'clone', 'tidy');
    writeSkill(target, 'name: tidy\ndescription: tidy up');
    link(target, path.join(project, '.claude', 'skills', 'tidy'), 'folder');
    link(target, path.join(home, '.claude', 'skills', 'tidy'), 'folder');

    const rows = mergeAssets((await discoverSkills(options())).skills).map(toMenuSkill);

    expect(rows).toEqual([{ name: 'tidy', description: 'tidy up', filePath: path.join(project, '.claude', 'skills', 'tidy', 'SKILL.md'), source: 'project' }]);
  });

  it('keeps the user row of a skill an untrusted project links too, since only the user one runs', async () => {
    const target = path.join(project, 'tools', 'tidy');
    writeSkill(target, 'description: tidy up');
    link(target, path.join(project, '.claude', 'skills', 'tidy'), 'folder');
    link(target, path.join(home, '.claude', 'skills', 'tidy'), 'folder');

    const rows = mergeAssets((await discoverSkills(options({ trusted: false }))).skills).map(toMenuSkill);

    expect(rows.map((row) => [row.name, row.source, isRunnable(row)])).toEqual([['tidy', 'user', true]]);
  });

  it.skipIf(!canSymlinkFiles)('follows a linked SKILL.md', async () => {
    const file = writeSkill(path.join(tmp, 'clone', 'x'), 'description: from a link');
    link(file, path.join(home, '.claude', 'skills', 'linked', 'SKILL.md'), 'file');

    expect((await discoverSkills(options())).skills.map(toMenuSkill)).toEqual([
      { name: 'linked', description: 'from a link', filePath: path.join(home, '.claude', 'skills', 'linked', 'SKILL.md'), source: 'user' },
    ]);
  });

  it('withholds a skill without the description pi requires, and one whose frontmatter does not parse', async () => {
    writeSkill(path.join(home, '.claude', 'skills', 'bare'), 'name: bare');
    write(path.join(home, '.claude', 'skills', 'broken', 'SKILL.md'), '---\nname: [a\n---\n');

    const rows = (await discoverSkills(options())).skills.map(toMenuSkill);

    expect(rows.map((row) => [row.name, row.withheld?.reason])).toEqual([['bare', 'missingDescription'], ['broken', 'invalidFrontmatter']]);
  });

  it('withholds a linked skill folder leading out of an untrusted project', async () => {
    writeSkill(path.join(tmp, 'outside', 'tidy'), 'description: d');
    link(path.join(tmp, 'outside', 'tidy'), path.join(project, '.claude', 'skills', 'tidy'), 'folder');

    const rows = (await discoverSkills(options({ trusted: false }))).skills.map(toMenuSkill);

    expect(rows).toEqual([{ name: 'tidy', description: '', filePath: path.join(project, '.claude', 'skills', 'tidy'), source: 'project', untrusted: true, withheld: { reason: 'linkOutside' } }]);
  });

  // pi loads one skill from a folder reached twice, so the menu lists it once and calls the second link no loop.
  it('lists a skill folder a sibling link repeats once, with no row for the link', async () => {
    writeSkill(path.join(home, '.claude', 'skills', 'tidy'), 'description: tidy up');
    link(path.join(home, '.claude', 'skills', 'tidy'), path.join(home, '.claude', 'skills', 'tidy-alias'), 'folder');

    const rows = (await discoverSkills(options())).skills.map(toMenuSkill);

    expect(rows.map((row) => [row.name, row.withheld])).toEqual([['tidy', undefined]]);
    expect(lines).toEqual([]);
  });

  it.skipIf(!canSymlinkFiles)('lists no skill row for a withheld root-level .md file, which is no skill folder', async () => {
    const skills = path.join(home, '.claude', 'skills');
    link(path.join(tmp, 'gone.md'), path.join(skills, 'notes.md'), 'file');
    link(path.join(tmp, 'gone.md'), path.join(skills, 'SKILL.md'), 'file');
    link(path.join(tmp, 'gone'), path.join(skills, 'tidy'), 'folder');

    const rows = (await discoverSkills(options())).skills.map(toMenuSkill);

    expect(rows.map((row) => [row.name, row.withheld?.reason])).toEqual([['tidy', 'broken']]);
  });

  it('lists no skill pi does not load: one below a skill folder, or under node_modules', async () => {
    writeSkill(path.join(home, '.claude', 'skills', 'outer'), 'description: outer');
    writeSkill(path.join(home, '.claude', 'skills', 'outer', 'inner'), 'description: inner');
    writeSkill(path.join(home, '.claude', 'skills', 'node_modules'), 'description: a package');
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'outer', 'scripts', 'lib'), { recursive: true });

    const rows = (await discoverSkills(options())).skills.map(toMenuSkill);

    expect(rows.map((row) => row.name)).toEqual(['outer']);
    expect(lines).toEqual([]);
  });

  it('lists a skill folder a .gitignore of its root names as no skill, as pi does', async () => {
    writeSkill(path.join(home, '.claude', 'skills', 'drafts'), 'description: not yet');
    writeSkill(path.join(home, '.claude', 'skills', 'tidy'), 'description: tidy up');
    write(path.join(home, '.claude', 'skills', '.gitignore'), '# drafts stay local\ndrafts/\n');

    const rows = (await discoverSkills(options())).skills.map(toMenuSkill);

    expect(rows.map((row) => row.name)).toEqual(['tidy']);
  });
});

describe('withheld roots', () => {
  it('names a commands and a skills folder that a broken ~/.claude withholds, one row each, with its source and reason', async () => {
    link(path.join(tmp, 'dotfiles'), path.join(home, '.claude'), 'folder');

    const commands = await discoverCommands(options());
    const skills = await discoverSkills(options());

    const broken = { reason: 'broken', target: expect.stringContaining('dotfiles') };
    expect(commands.withheldRoots.map((root) => toMenuRoot(root, 'commands'))).toEqual([
      { kind: 'withheldRoot', assets: 'commands', folder: '.claude', source: 'user', filePath: path.join(home, '.claude', 'commands'), withheld: broken },
    ]);
    expect(skills.withheldRoots.map((root) => toMenuRoot(root, 'skills'))).toEqual([
      { kind: 'withheldRoot', assets: 'skills', folder: '.claude', source: 'user', filePath: path.join(home, '.claude', 'skills'), withheld: broken },
    ]);
    expect(commands.commands).toEqual([]);
  });

  it('marks an untrusted project\'s commands folder linked out of it as untrusted and leading outside', async () => {
    write(path.join(tmp, 'outside', 'deploy.md'));
    link(path.join(tmp, 'outside'), path.join(project, '.damocles', 'commands'), 'folder');

    const { withheldRoots } = await discoverCommands(options({ trusted: false }));

    expect(withheldRoots.map((root) => toMenuRoot(root, 'commands'))).toEqual([
      { kind: 'withheldRoot', assets: 'commands', folder: '.damocles', source: 'project', filePath: path.join(project, '.damocles', 'commands'), untrusted: true, withheld: { reason: 'linkOutside' } },
    ]);
  });
});

describe('skillLinkTargets', () => {
  it('admits the user roots and, only when trusted, the project ones, watching the folders their links lead to', async () => {
    writeSkillFile(path.join(home, '.claude', 'skills', 'own'));
    writeSkillFile(path.join(project, '.claude', 'skills', 'own'));
    const target = path.join(tmp, 'clone', 'tidy');
    writeSkillFile(target);
    link(target, path.join(home, '.claude', 'skills', 'deep', 'tidy'), 'folder');
    const set = path.join(tmp, 'clone', 'set');
    writeSkillFile(path.join(set, 'lint'));
    link(set, path.join(home, '.claude', 'skills', 'team'), 'folder');

    const trusted = await skillLinkTargets(options());
    const untrusted = await skillLinkTargets(options({ trusted: false }));

    expect(trusted.roots.map((root) => root.dir)).toEqual([path.join(project, '.claude', 'skills'), path.join(home, '.claude', 'skills')]);
    expect(untrusted.roots.map((root) => root.dir)).toEqual([path.join(home, '.claude', 'skills')]);
    // a skill folder is watched for its SKILL.md, a folder of skills for those below it, each with the ignore files read there
    expect(trusted.followed.user).toEqual([
      { base: target, glob: '{SKILL.md,.gitignore,.ignore,.fdignore}' },
      { base: set, glob: '{**/SKILL.md,**/.gitignore,**/.ignore,**/.fdignore}' },
    ]);
  });

  it.skipIf(!canSymlinkFiles)('watches a linked root-level .md, which pi loads as a skill, and no link inside a skill folder, which pi never enters', async () => {
    const skills = path.join(home, '.claude', 'skills');
    const notes = write(path.join(tmp, 'clone', 'notes.md'));
    link(notes, path.join(skills, 'notes.md'), 'file');
    writeSkillFile(path.join(skills, 'tidy'));
    fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
    link(path.join(tmp, 'data'), path.join(skills, 'tidy', 'data'), 'folder');

    const { followed } = await skillLinkTargets(options({ workspacePath: null }));

    expect(followed.user).toEqual([{ base: path.join(tmp, 'clone'), files: [notes] }]);
  });

  function writeSkillFile(folder: string): void {
    write(path.join(folder, 'SKILL.md'), '---\ndescription: d\n---\n');
  }
});

describe('boundedText', () => {
  it('drops control, bidirectional and line separator characters and keeps at most the given code points', () => {
    expect(boundedText('a\nb\u202Ec\u0007', 100)).toBe('a b c');
    expect(boundedText('a\u061Cb\u2028c\u2029d', 100)).toBe('a b c d');
    expect(boundedText('😀😀😀', 2)).toBe('😀😀');
  });

  it('keeps a broken link\'s target to 1,024 characters', async () => {
    const target = path.join(tmp, 'gone');
    const long = `${target}${`${path.sep}abcdefghi`.repeat(200)}`;
    link(target, path.join(home, '.claude', 'commands', 'gs'), 'folder');
    const readlink = fs.promises.readlink.bind(fs.promises) as (file: fs.PathLike) => Promise<string>;
    vi.spyOn(fs.promises, 'readlink').mockImplementation((async (file: fs.PathLike) => (String(file).endsWith(`${path.sep}gs`) ? long : readlink(file))) as never);

    const [row] = (await discoverCommands(options())).commands.map(toMenuCommand);

    expect(row?.withheld).toEqual({ reason: 'broken', target: long.slice(0, 1024) });
  });
});
