import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_ASSET_BYTES, readAssetPath, walkAssetTree, type AssetWalkOptions, type FollowPolicy } from '../asset-walk';

// paths below the scope root, joined with '/', whose network check answers as a drive that did not answer
const H = vi.hoisted(() => ({ timedOut: new Set<string>() }));

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

// A file symlink needs a privilege unprivileged Windows lacks, so the tests that make one report a skip there.
const canSymlinkFiles = ((): boolean => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-walk-probe-'));
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

let tmp: string;
let lines: string[];

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'asset-walk-')));
  lines = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  H.timedOut.clear();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(file: string, text = '---\ndescription: d\n---\nbody\n'): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function link(target: string, at: string, type: 'file' | 'junction' | 'dir'): void {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at, type);
}

// A folder link every host can make: a junction on Windows.
const folderLink = (target: string, at: string): void => link(target, at, process.platform === 'win32' ? 'junction' : 'dir');

function walk(scopeRoot: string, root: string, overrides: Partial<AssetWalkOptions> = {}) {
  return walkAssetTree({ scopeRoot, root, policy: { kind: 'follow' }, maxDepth: 1, dirGlob: '*.md', repeatFolders: 'walk', skipHidden: false, log: (line) => lines.push(line), ...overrides });
}

// Every open, stat and readFile of the promises API, by path, for asserting what a walk never touched.
function spyReads(): string[] {
  const touched: string[] = [];
  for (const name of ['open', 'stat', 'readFile'] as const) {
    const original = fs.promises[name].bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(fs.promises, name).mockImplementation((async (file: fs.PathLike, ...rest: unknown[]) => {
      touched.push(String(file));
      return original(file, ...rest);
    }) as never);
  }
  return touched;
}

describe('walkAssetTree under follow', () => {
  // Windows usually spells the temp folder with an 8.3 name (C:\Users\ASTEFA~1\...), which its realpath expands with no link.
  const spelledTmp = os.tmpdir();
  it.runIf(spelledTmp.toLowerCase() !== fs.realpathSync.native(spelledTmp).toLowerCase())('watches no root of its own when it is spelled with a short name and crosses no link', async () => {
    write(path.join(tmp, 'home', '.claude', 'commands', 'top.md'));
    const spelled = path.join(spelledTmp, path.relative(fs.realpathSync.native(spelledTmp), tmp));

    const result = await walk(path.join(spelled, 'home'), path.join(spelled, 'home', '.claude', 'commands'));

    expect(result.entries.map((entry) => entry.segments.join('/'))).toEqual(['top.md']);
    expect(result.followed).toEqual([]);
  });

  it('reads the files at the top level and one folder down, with the BOM stripped, and enters no deeper', async () => {
    const root = path.join(tmp, 'home', '.claude', 'commands');
    write(path.join(root, 'top.md'), '\uFEFFtop body');
    write(path.join(root, 'gs', 'pickup.md'));
    write(path.join(root, 'gs', 'deep', 'hidden.md'));
    write(path.join(root, 'notes.txt'));

    const result = await walk(path.join(tmp, 'home'), root);

    expect(result.rootAdmitted).toBe(true);
    expect(result.entries.map((entry) => entry.segments.join('/')).sort()).toEqual(['gs/pickup.md', 'top.md']);
    expect(result.entries.find((entry) => entry.segments[0] === 'top.md')).toMatchObject({ kind: 'file', text: 'top body' });
    expect(result.followed).toEqual([]);
    expect(lines.filter((line) => line.includes('not read'))).toHaveLength(1);
  });

  it.skipIf(!canSymlinkFiles)('follows a linked command file, a linked namespace folder and a linked root, naming each through its link', async () => {
    const home = path.join(tmp, 'home');
    const clone = path.join(tmp, 'clone');
    write(path.join(clone, 'pickup.md'), 'pickup body');
    write(path.join(clone, 'commands', 'drop.md'), 'drop body');
    write(path.join(tmp, 'dotfiles', 'claude', 'commands', 'own.md'), 'own body');
    folderLink(path.join(tmp, 'dotfiles', 'claude'), path.join(home, '.claude'));
    const root = path.join(home, '.claude', 'commands');
    link(path.join(clone, 'pickup.md'), path.join(root, 'gs', 'pickup.md'), 'file');
    folderLink(path.join(clone, 'commands'), path.join(root, 'ns'));

    const result = await walk(home, root);

    const files = result.entries.filter((entry) => entry.kind === 'file');
    expect(files.map((entry) => [entry.path, entry.kind === 'file' ? entry.realPath : '', entry.kind === 'file' ? entry.text : '']).sort()).toEqual([
      [path.join(root, 'gs', 'pickup.md'), path.join(clone, 'pickup.md'), 'pickup body'],
      [path.join(root, 'ns', 'drop.md'), path.join(clone, 'commands', 'drop.md'), 'drop body'],
      [path.join(root, 'own.md'), path.join(tmp, 'dotfiles', 'claude', 'commands', 'own.md'), 'own body'],
    ]);
    expect(result.followed).toEqual(expect.arrayContaining([
      { base: path.join(tmp, 'dotfiles', 'claude', 'commands'), glob: '**/*.md' },
      { base: path.join(clone, 'commands'), glob: '*.md' },
      { base: clone, files: [path.join(clone, 'pickup.md')] },
    ]));
  });

  // A watch glob would read [ { * and a leading ! in the name as a pattern, so the link's own entry is watched as a file.
  it.skipIf(!canSymlinkFiles)('withholds a broken link with its readlink text, watching where the link and its target live', async () => {
    const root = path.join(tmp, 'home', '.claude', 'commands');
    const target = path.join(tmp, 'clone', 'gone.md');
    write(target);
    link(target, path.join(root, '!gone[1].md'), 'file');
    fs.rmSync(target);

    const result = await walk(path.join(tmp, 'home'), root);

    expect(result.entries).toEqual([{ kind: 'withheld', reason: { broken: target }, path: path.join(root, '!gone[1].md'), segments: ['!gone[1].md'] }]);
    expect(result.followed).toEqual([{ base: root, files: [path.join(root, '!gone[1].md')] }, { base: path.join(tmp, 'clone'), files: [target] }]);
    expect(lines).toContain(`[assets] ${path.join(root, '!gone[1].md')}: broken link to ${target}`);
  });

  it('withholds a link to a folder above it as a loop and never walks it again', async () => {
    const root = path.join(tmp, 'home', '.claude', 'commands');
    write(path.join(root, 'a.md'));
    write(path.join(root, 'ns', 'b.md'));
    folderLink(root, path.join(root, 'again'));
    folderLink(root, path.join(root, 'ns', 'up'));

    const result = await walk(path.join(tmp, 'home'), root, { maxDepth: 2 });

    expect(result.entries.map((entry) => [entry.segments.join('/'), entry.kind === 'withheld' ? entry.reason : 'file'])).toEqual([
      ['a.md', 'file'],
      ['ns/b.md', 'file'],
      ['again', 'loop'],
      ['ns/up', 'loop'],
    ]);
  });

  it('walks a second link to one folder as a folder of its own', async () => {
    const root = path.join(tmp, 'home', '.claude', 'commands');
    write(path.join(tmp, 'clone', 'pickup.md'));
    folderLink(path.join(tmp, 'clone'), path.join(root, 'gs'));
    folderLink(path.join(tmp, 'clone'), path.join(root, 'team'));

    const result = await walk(path.join(tmp, 'home'), root);

    expect(result.entries.map((entry) => [entry.path, entry.kind])).toEqual([
      [path.join(root, 'gs', 'pickup.md'), 'file'],
      [path.join(root, 'team', 'pickup.md'), 'file'],
    ]);
    expect(lines).toEqual([]);
  });

  it('skips a second link to one folder unlogged when asked to', async () => {
    const root = path.join(tmp, 'home', '.claude', 'skills');
    write(path.join(root, 'tidy', 'SKILL.md'));
    folderLink(path.join(root, 'tidy'), path.join(root, 'tidy-alias'));

    const result = await walk(path.join(tmp, 'home'), root, { dirGlob: 'SKILL.md', repeatFolders: 'skip' });

    expect(result.entries.map((entry) => [entry.path, entry.kind])).toEqual([[path.join(root, 'tidy', 'SKILL.md'), 'file']]);
    expect(lines).toEqual([]);
  });

  it('walks the real folders of a root before any folder link, so a folder linked from an earlier sibling keeps its real path', async () => {
    const root = path.join(tmp, 'home', '.claude', 'agents');
    write(path.join(root, 'c', 'x.md'));
    folderLink(path.join(root, 'c'), path.join(root, 'b', 'l'));

    const skipped = await walk(path.join(tmp, 'home'), root, { maxDepth: 16, repeatFolders: 'skip' });
    const walked = await walk(path.join(tmp, 'home'), root, { maxDepth: 16 });

    expect(skipped.entries.map((entry) => [entry.path, entry.kind])).toEqual([[path.join(root, 'c', 'x.md'), 'file']]);
    expect(walked.entries.map((entry) => [entry.path, entry.kind])).toEqual([
      [path.join(root, 'c', 'x.md'), 'file'],
      [path.join(root, 'b', 'l', 'x.md'), 'file'],
    ]);
    expect(lines).toEqual([]);
  });

  it.skipIf(!canSymlinkFiles)('withholds a link the system cannot resolve for its loop', async () => {
    const root = path.join(tmp, 'home', '.claude', 'commands');
    fs.mkdirSync(root, { recursive: true });
    link(path.join(root, 'b.md'), path.join(root, 'a.md'), 'file');
    link(path.join(root, 'a.md'), path.join(root, 'b.md'), 'file');

    const result = await walk(path.join(tmp, 'home'), root);

    expect(result.entries.map((entry) => (entry.kind === 'withheld' ? entry.reason : 'file'))).toEqual(['loop', 'loop']);
  });

  it('withholds a file over 1 MiB without reading it whole', async () => {
    const root = path.join(tmp, 'home', 'commands');
    write(path.join(root, 'big.md'), 'x'.repeat(MAX_ASSET_BYTES + 1));
    write(path.join(root, 'edge.md'), 'x'.repeat(MAX_ASSET_BYTES));

    const result = await walk(path.join(tmp, 'home'), root);

    expect(result.entries.map((entry) => [entry.segments[0], entry.kind === 'withheld' ? entry.reason : 'file'])).toEqual([['big.md', 'tooLarge'], ['edge.md', 'file']]);
    expect(lines).toContain(`[assets] ${path.join(root, 'big.md')}: tooLarge`);
  });

  it('skips and logs an entry that is no regular file, never opening it', async () => {
    const root = path.join(tmp, 'home', 'commands');
    write(path.join(root, 'real.md'));
    const readdir = fs.promises.readdir.bind(fs.promises) as (dir: string, options: unknown) => Promise<fs.Dirent[]>;
    const fifo = { name: 'pipe.md', isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false, isFIFO: () => true } as unknown as fs.Dirent;
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (dir: string, options: unknown) => [...(await readdir(dir, options)), fifo]) as never);
    const touched = spyReads();

    const result = await walk(path.join(tmp, 'home'), root);

    expect(result.entries.map((entry) => entry.segments[0])).toEqual(['real.md']);
    expect(lines).toContain(`[assets] ${path.join(root, 'pipe.md')}: not a regular file`);
    expect(touched.filter((file) => file.endsWith('pipe.md'))).toEqual([]);
  });

  it.runIf(process.platform !== 'win32')('skips a socket among the command files and never blocks on it', async () => {
    const root = path.join(tmp, 'home', 'commands');
    write(path.join(root, 'real.md'));
    const net = await import('node:net');
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(path.join(root, 'sock.md'), resolve));
    try {
      const result = await walk(path.join(tmp, 'home'), root);
      expect(result.entries.map((entry) => entry.segments[0])).toEqual(['real.md']);
      expect(lines).toContain(`[assets] ${path.join(root, 'sock.md')}: not a regular file`);
    } finally {
      server.close();
    }
  });

  it('skips dot entries and node_modules only when asked', async () => {
    const root = path.join(tmp, 'home', 'agents');
    write(path.join(root, '.hidden.md'));
    write(path.join(root, 'node_modules', 'dep.md'));
    write(path.join(root, 'kept.md'));

    expect((await walk(path.join(tmp, 'home'), root, { skipHidden: true })).entries.map((entry) => entry.segments.join('/'))).toEqual(['kept.md']);
    expect((await walk(path.join(tmp, 'home'), root)).entries.map((entry) => entry.segments.join('/')).sort()).toEqual(['.hidden.md', 'kept.md', 'node_modules/dep.md']);
  });

  it('stops a root at 5,000 entries and says so once', async () => {
    const root = path.join(tmp, 'home', 'commands');
    fs.mkdirSync(root, { recursive: true });
    for (let index = 0; index < 5003; index++) fs.writeFileSync(path.join(root, `c${index}.md`), 'x');

    const result = await walk(path.join(tmp, 'home'), root);

    expect(result.entries).toHaveLength(5000);
    expect(lines.filter((line) => line.includes('stopped after'))).toHaveLength(1);
  }, 60_000);

  it('admits no absent root, and logs nothing for it', async () => {
    const result = await walk(path.join(tmp, 'home'), path.join(tmp, 'home', '.codex', 'prompts'));
    expect(result).toEqual({ entries: [], followed: [], rootAdmitted: false });
    expect(lines).toEqual([]);
  });

  it('withholds a root under a broken ~/.claude link, watching the link in the home folder', async () => {
    const home = path.join(tmp, 'home');
    folderLink(path.join(tmp, 'dotfiles'), path.join(home, '.claude'));

    const result = await walk(home, path.join(home, '.claude', 'commands'));

    expect(result.rootAdmitted).toBe(false);
    expect(result.rootWithheld).toEqual({ broken: expect.stringContaining('dotfiles') });
    expect(result.followed).toEqual(expect.arrayContaining([{ base: home, files: [path.join(home, '.claude')] }]));
  });

  it('reads a skill folder\'s SKILL.md and nothing else in it, so a large folder inside one skill hides no later skill', async () => {
    const root = path.join(tmp, 'home', '.pi', 'skills');
    write(path.join(root, 'a-big', 'SKILL.md'));
    fs.mkdirSync(path.join(root, 'a-big', 'venv'), { recursive: true });
    for (let index = 0; index < 5001; index++) fs.writeFileSync(path.join(root, 'a-big', 'venv', `f${index}`), '');
    write(path.join(root, 'b-next', 'SKILL.md'));
    write(path.join(root, 'group', 'c-nested', 'SKILL.md'));
    write(path.join(root, 'group', 'c-nested', 'inner', 'SKILL.md'));
    write(path.join(root, 'notes.md'));
    write(path.join(root, 'group', 'notes.md'));

    const result = await walk(path.join(tmp, 'home'), root, { maxDepth: 16, rootGlob: '*.md', dirGlob: 'SKILL.md', leafFile: 'SKILL.md', repeatFolders: 'skip', skipHidden: true });

    expect(result.entries.map((entry) => entry.segments.join('/'))).toEqual(['a-big/SKILL.md', 'b-next/SKILL.md', 'group/c-nested/SKILL.md', 'notes.md']);
    expect(lines).toEqual([]);
  }, 60_000);

  it.skipIf(!canSymlinkFiles)('looks inside a folder whose SKILL.md is a broken link, as pi does', async () => {
    const root = path.join(tmp, 'home', '.pi', 'skills');
    link(path.join(tmp, 'gone.md'), path.join(root, 'x', 'SKILL.md'), 'file');
    write(path.join(root, 'x', 'y', 'SKILL.md'));

    const result = await walk(path.join(tmp, 'home'), root, { maxDepth: 16, rootGlob: '*.md', dirGlob: 'SKILL.md', leafFile: 'SKILL.md', repeatFolders: 'skip', skipHidden: true });

    expect(result.entries.map((entry) => [entry.segments.join('/'), entry.kind])).toEqual([['x/SKILL.md', 'withheld'], ['x/y/SKILL.md', 'file']]);
  });

  it('says nothing of the folders below a walk that reads only its root', async () => {
    const root = path.join(tmp, 'home', 'skills');
    write(path.join(root, 'deploy', 'SKILL.md'));
    write(path.join(root, 'deploy.md'));

    const result = await walk(path.join(tmp, 'home'), root, { maxDepth: 0 });

    expect(result.entries.map((entry) => entry.segments.join('/'))).toEqual(['deploy.md']);
    expect(lines).toEqual([]);
  });

  it('withholds an entry and a root whose drive did not answer, and asks to be walked again', async () => {
    const home = path.join(tmp, 'home');
    const root = path.join(home, '.claude', 'commands');
    write(path.join(tmp, 'clone', 'x.md'));
    folderLink(path.join(tmp, 'clone'), path.join(root, 'gs'));
    H.timedOut.add('.claude/commands/gs');

    const entry = await walk(home, root);
    H.timedOut.add('.claude/commands');
    const whole = await walk(home, root);

    expect(entry.entries).toEqual([{ kind: 'withheld', reason: 'unreachable', path: path.join(root, 'gs'), segments: ['gs'] }]);
    expect(entry.followed).toEqual([{ retry: true }]);
    expect(whole).toMatchObject({ entries: [], followed: [{ retry: true }], rootAdmitted: false, rootWithheld: 'unreachable' });
  });
});

describe('readAssetPath', () => {
  const read = (root: string, segments: readonly string[]) =>
    readAssetPath({ scopeRoot: path.join(tmp, 'home'), root, segments, policy: { kind: 'follow' }, log: (line) => lines.push(line) });

  it('reads one file by its path through links, and gives nothing for an absent one', async () => {
    const root = path.join(tmp, 'home', '.pi', 'skills');
    write(path.join(tmp, 'clone', 'deploy.md'), 'deploy body');
    folderLink(path.join(tmp, 'clone'), root);

    expect(await read(root, ['deploy.md'])).toMatchObject({ kind: 'file', path: path.join(root, 'deploy.md'), text: 'deploy body' });
    expect(await read(root, ['absent.md'])).toBeUndefined();
    expect(await read(path.join(tmp, 'home', 'none'), ['absent.md'])).toBeUndefined();
    expect(lines).toEqual([]);
  });

  it.skipIf(!canSymlinkFiles)('withholds a broken link', async () => {
    const root = path.join(tmp, 'home', '.pi', 'skills');
    link(path.join(tmp, 'gone.md'), path.join(root, 'deploy.md'), 'file');

    expect(await read(root, ['deploy.md'])).toEqual({ kind: 'withheld', reason: { broken: path.join(tmp, 'gone.md') }, path: path.join(root, 'deploy.md'), segments: ['deploy.md'] });
  });

  it.runIf(process.platform === 'win32' || process.platform === 'darwin')('finds a file whose name differs in case, as the file system does', async () => {
    const root = path.join(tmp, 'home', '.pi', 'skills');
    write(path.join(root, 'Deploy.md'), 'deploy body');

    expect(await read(root, ['deploy.md'])).toMatchObject({ kind: 'file', text: 'deploy body' });
  });
});

describe('walkAssetTree under insideProject', () => {
  let project: string;
  let outside: string;
  let policy: FollowPolicy;

  beforeEach(() => {
    project = path.join(tmp, 'project');
    outside = path.join(tmp, 'outside');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    policy = { kind: 'insideProject', project: fs.realpathSync.native(project) };
  });

  it.skipIf(!canSymlinkFiles)('follows a link that stays inside the project', async () => {
    const root = path.join(project, '.claude', 'commands');
    write(path.join(project, 'shared', 'inside.md'), 'inside body');
    link(path.join(project, 'shared', 'inside.md'), path.join(root, 'inside.md'), 'file');

    const result = await walk(project, root, { policy });

    expect(result.entries).toMatchObject([{ kind: 'file', text: 'inside body', path: path.join(root, 'inside.md') }]);
  });

  it('drops a file swapped between the check and the read, which the check never judged', async () => {
    const root = path.join(project, '.claude', 'commands');
    const file = write(path.join(root, 'deploy.md'));
    const lstat = fs.promises.lstat.bind(fs.promises) as (file: fs.PathLike) => Promise<fs.Stats>;
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (at: fs.PathLike) => {
      const stats = await lstat(at);
      return String(at) === file ? Object.assign(stats, { dev: stats.dev + 1 }) : stats;
    }) as never);

    const result = await walk(project, root, { policy });

    expect(result.entries).toEqual([]);
    expect(lines).toEqual([`[assets] ${file}: changed while read`]);
  });

  it.skipIf(!canSymlinkFiles)('withholds a file or folder link leading outside, by its name and place, and never opens, stats or reads its target', async () => {
    const root = path.join(project, '.claude', 'commands');
    write(path.join(outside, 'secret.md'), 'secret');
    write(path.join(outside, 'ns', 'x.md'), 'secret');
    link(path.join(outside, 'secret.md'), path.join(root, 'secret.md'), 'file');
    folderLink(path.join(outside, 'ns'), path.join(root, 'gs'));
    const touched = spyReads();

    const result = await walk(project, root, { policy });

    expect(result.entries).toEqual([
      { kind: 'withheld', reason: 'linkOutside', path: path.join(root, 'gs'), segments: ['gs'] },
      { kind: 'withheld', reason: 'linkOutside', path: path.join(root, 'secret.md'), segments: ['secret.md'] },
    ]);
    expect(touched.filter((file) => file.toLowerCase().startsWith(outside.toLowerCase()) || file.startsWith(path.join(root, 'gs')) || file.endsWith('secret.md'))).toEqual([]);
    expect(result.followed).toEqual([]);
  });

  it('withholds a whole root whose link leads outside, reading nothing behind it', async () => {
    write(path.join(outside, 'commands', 'secret.md'));
    folderLink(outside, path.join(project, '.claude'));
    const touched = spyReads();

    const result = await walk(project, path.join(project, '.claude', 'commands'), { policy });

    expect(result).toEqual({ entries: [], followed: [], rootAdmitted: false, rootWithheld: 'linkOutside' });
    expect(lines).toEqual([`[assets] ${path.join(project, '.claude', 'commands')}: linkOutside`]);
    expect(touched).toEqual([]);
  });

  it.skipIf(!canSymlinkFiles)('watches no target of a broken link that would lead outside', async () => {
    const root = path.join(project, '.claude', 'commands');
    const target = write(path.join(outside, 'gone.md'));
    link(target, path.join(root, 'gone.md'), 'file');
    fs.rmSync(target);

    const result = await walk(project, root, { policy });

    expect(result.entries).toEqual([{ kind: 'withheld', reason: { broken: target }, path: path.join(root, 'gone.md'), segments: ['gone.md'] }]);
    expect(result.followed).toEqual([{ base: root, files: [path.join(root, 'gone.md')] }]);
  });

  // A watcher follows a link in its base, so a target folder inside the project by its path but outside by its realpath is not watched.
  it('watches the target folder of a broken link only by its realpath, and only inside the project', async () => {
    const root = path.join(project, '.claude', 'commands');
    fs.mkdirSync(path.join(project, 'real'), { recursive: true });
    folderLink(outside, path.join(project, 'evil'));
    folderLink(path.join(project, 'evil', 'gone'), path.join(root, 'bad'));
    folderLink(path.join(project, 'real', 'gone'), path.join(root, 'good'));

    const result = await walk(project, root, { policy });

    expect(result.entries.map((entry) => entry.segments)).toEqual([['bad'], ['good']]);
    expect(result.followed).toEqual([
      { base: root, files: [path.join(root, 'bad')] },
      { base: root, files: [path.join(root, 'good')] },
      { base: path.join(project, 'real'), files: [path.join(project, 'real', 'gone')] },
    ]);
  });
});

// The network check reads link targets as readlink gives them, so a junction whose readlink is faked onto a share stands
// for a link Windows would follow there.
describe.runIf(process.platform === 'win32')('walkAssetTree on Windows network paths', () => {
  let marker: string;
  let fakeTargets: Map<string, string>;
  let uncCalls: string[];
  // every call but lstat naming a path through a link: the target behind it, which only lstat and readlink of the link avoid
  let throughLink: string[];

  beforeEach(() => {
    marker = path.join(tmp, 'marker');
    fs.mkdirSync(marker, { recursive: true });
    fakeTargets = new Map();
    uncCalls = [];
    throughLink = [];
    const readlink = fs.promises.readlink.bind(fs.promises);
    vi.spyOn(fs.promises, 'readlink').mockImplementation((async (file: fs.PathLike) => fakeTargets.get(String(file).toLowerCase()) ?? readlink(file)) as never);
    for (const name of ['lstat', 'stat', 'realpath', 'open', 'readdir'] as const) {
      const original = fs.promises[name].bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
      vi.spyOn(fs.promises, name).mockImplementation((async (file: fs.PathLike, ...rest: unknown[]) => {
        if (/^[\\/]{2}/.test(String(file))) {
          uncCalls.push(String(file));
          throw new Error(`reached ${String(file)}`);
        }
        if (name !== 'lstat' && fakeTargets.has(String(file).toLowerCase())) throughLink.push(`${name} ${String(file)}`);
        return original(file, ...rest);
      }) as never);
    }
  });

  it('withholds links onto a share and onto WSL as share entries without touching either target', async () => {
    const root = path.join(tmp, 'home', '.claude', 'commands');
    folderLink(marker, path.join(root, 'nas.md'));
    folderLink(marker, path.join(root, 'wsl.md'));
    fakeTargets.set(path.join(root, 'nas.md').toLowerCase(), '\\\\host\\share\\x.md');
    fakeTargets.set(path.join(root, 'wsl.md').toLowerCase(), '\\\\wsl.localhost\\Ubuntu\\x.md');

    const result = await walk(path.join(tmp, 'home'), root);

    expect(result.entries.map((entry) => [entry.segments[0], entry.kind === 'withheld' ? entry.reason : 'file'])).toEqual([['nas.md', 'share'], ['wsl.md', 'share']]);
    expect(uncCalls).toEqual([]);
    expect(throughLink).toEqual([]);
    expect(lines).toEqual([`[assets] ${path.join(root, 'nas.md')}: share`, `[assets] ${path.join(root, 'wsl.md')}: share`]);
  });
});

// A home folder on a share, played by a local folder: every call on \\corp\home\ is answered from it, and readlink answers
// each link's target on the share, as Windows would.
describe.runIf(process.platform === 'win32')('walkAssetTree with the home folder on a share', () => {
  const SHARE = '\\\\corp\\home\\';

  it.skipIf(!canSymlinkFiles)('follows a command linked to another file on that same share, and refuses one onto another share', async () => {
    const local = path.join(tmp, 'share');
    const home = `${SHARE}user`;
    const root = `${home}\\.claude\\commands`;
    const toLocal = (file: string): string => (file.toLowerCase().startsWith(SHARE) ? path.join(local, file.slice(SHARE.length)) : file);
    const toShare = (file: string): string => (file.toLowerCase().startsWith(local.toLowerCase()) ? SHARE + file.slice(local.length + 1) : file);
    write(path.join(local, 'team', 'pickup.md'), 'pickup body');
    link(path.join(local, 'team', 'pickup.md'), path.join(local, 'user', '.claude', 'commands', 'pickup.md'), 'file');
    folderLink(path.join(tmp, 'marker'), path.join(local, 'user', '.claude', 'commands', 'other.md'));
    fs.mkdirSync(path.join(tmp, 'marker'), { recursive: true });
    const targets = new Map([
      [path.join(local, 'user', '.claude', 'commands', 'pickup.md').toLowerCase(), `${SHARE}team\\pickup.md`],
      [path.join(local, 'user', '.claude', 'commands', 'other.md').toLowerCase(), '\\\\elsewhere\\share\\x.md'],
    ]);
    const reached: string[] = [];
    for (const name of ['lstat', 'stat', 'realpath', 'open', 'readdir', 'readlink'] as const) {
      const original = fs.promises[name].bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
      vi.spyOn(fs.promises, name).mockImplementation((async (file: fs.PathLike, ...rest: unknown[]) => {
        const spelled = String(file);
        if (spelled.toLowerCase().startsWith('\\\\elsewhere')) reached.push(spelled);
        const mapped = toLocal(spelled);
        if (name === 'readlink') return targets.get(mapped.toLowerCase()) ?? original(mapped, ...rest);
        const answer = await original(mapped, ...rest);
        return name === 'realpath' ? toShare(answer as string) : answer;
      }) as never);
    }

    const result = await walk(home, root);

    expect(result.entries.map((entry) => [entry.path, entry.kind === 'file' ? entry.text : entry.reason])).toEqual([
      [`${root}\\other.md`, 'share'],
      [`${root}\\pickup.md`, 'pickup body'],
    ]);
    expect(reached).toEqual([]);
  });
});
