import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { rgPath } from '@vscode/ripgrep';
import { runProcess } from '../../process-launcher';
import { ALL_IGNORE_FILES, GlobSyntaxError, insideGitRepo, overrideRules, walkFiles, walkTree, type WalkIgnore } from '..';

// Parity with rg 15's own walk (`rg --files --hidden`), the walk Grep and Glob ran before they walked themselves: each case lists
// a fixture tree with real rg and with walkFiles and requires the same files; under followLinks, `rg --follow`. Unless the walk
// lists `.git` folders, entries inside one are left out of rg's list.

const noHosts = (): Promise<ReadonlySet<string>> => Promise.resolve(new Set());
let base: string;
let home: string;
let counter = 0;

beforeAll(() => {
  // the long spelling: the ignore crate replaces every `~` of an excludesFile path, which an 8.3 temp path holds
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-walk-')));
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
  vi.unstubAllEnvs();
  home = path.join(base, `home-${++counter}`);
  fs.mkdirSync(home);
  // rg and os.homedir() read USERPROFILE on Windows and HOME elsewhere
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', '');
});

/** A tree under base: a name ending in `/` is a folder, any other a file with that content. */
function tree(entries: Record<string, string | Buffer>): string {
  const root = path.join(base, `t-${++counter}`);
  fs.mkdirSync(root);
  for (const [name, content] of Object.entries(entries)) {
    const at = path.join(root, name);
    if (name.endsWith('/')) fs.mkdirSync(at, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.writeFileSync(at, content);
    }
  }
  return root;
}

// rg's flags for the walk's ignore switches
const rgIgnoreArgs = (ignore: WalkIgnore): string[] => [...(ignore.files ? [] : ['--no-ignore']), ...(ignore.global ? [] : ['--no-ignore-global']), ...(ignore.parents ? [] : ['--no-ignore-parent'])];

const insideGitFolder = (file: string): boolean => file.split('/').slice(0, -1).includes('.git');

interface Switches {
  readonly ignore?: WalkIgnore;
  readonly gitFolders?: 'skip' | 'list';
  // the walk's followLinks, rg's --follow
  readonly followLinks?: boolean;
}

async function rgFiles(root: string, globs: readonly string[] = [], requireGit = true, { ignore = ALL_IGNORE_FILES, gitFolders = 'skip', followLinks = false }: Switches = {}): Promise<string[]> {
  const args = ['--no-config', '--files', '--hidden', ...(followLinks ? ['--follow'] : []), ...(requireGit ? [] : ['--no-require-git']), ...rgIgnoreArgs(ignore), ...globs.flatMap((glob) => ['--glob', glob]), '--', '.'];
  const { exit, stdout, stderr } = await runProcess({ file: rgPath, args, cwd: root, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  if (exit?.code !== 0 && exit?.code !== 1) throw new Error(`rg exited ${exit?.code}: ${stderr.toString()}`);
  return stdout.toString('utf8').split('\n').filter(Boolean).map((line) => line.replace(/^\.[\\/]/, '').replaceAll('\\', '/')).filter((file) => gitFolders === 'list' || !insideGitFolder(file)).sort();
}

async function walked(root: string, globs: readonly string[] = [], requireGit = true, { ignore = ALL_IGNORE_FILES, gitFolders = 'skip', followLinks = false }: Switches = {}): Promise<string[]> {
  const files: string[] = [];
  const walk = walkFiles({ root, requireGit, ignore, gitFolders, overrides: overrideRules(globs), allowedHosts: noHosts, signal: undefined, ...(followLinks ? { followLinks: true } : {}) });
  for await (const batch of walk.files) files.push(...batch.map((file) => file.replaceAll('\\', '/')));
  expect(walk.errors).toEqual([]);
  return files.sort();
}

async function parity(root: string, globs: readonly string[] = [], requireGit = true, switches: Switches = {}): Promise<string[]> {
  const expected = await rgFiles(root, globs, requireGit, switches);
  expect(await walked(root, globs, requireGit, switches), `globs ${JSON.stringify(globs)}, requireGit ${requireGit}, ${JSON.stringify(switches)}`).toEqual(expected);
  return expected;
}

describe('the walk lists what rg 15 lists', () => {
  it('nested .gitignore files with negations, anchors and folder-only lines', async () => {
    const root = tree({
      '.git/': '',
      '.gitignore': '*.log\n!keep.log\nbuild/\n/top.txt\ndocs/*.md\n!docs/keep.md\nlink.txt/\n',
      'a.log': '', 'keep.log': '', 'top.txt': '', 'build.txt': '', 'link.txt': '',
      'sub/.gitignore': '!*.log\nlocal.txt\n/anchored.txt\n',
      'sub/b.log': '', 'sub/local.txt': '', 'sub/anchored.txt': '', 'sub/deep/anchored.txt': '', 'sub/top.txt': '', 'sub/build/y.txt': '',
      'build/x.txt': '', 'docs/a.md': '', 'docs/keep.md': '', 'docs/sub/b.md': '',
    });
    expect(await parity(root)).toContain('sub/b.log');
  });

  it('.rgignore over .ignore over .gitignore, the kind before the depth, and a whitelisted folder', async () => {
    const root = tree({
      '.git/': '',
      '.rgignore': '!x.txt\nv.txt\n',
      '.ignore': '!dist/\nz.md\nw.md\n',
      '.gitignore': 'dist/\nz.md\n!w.md\n',
      'sub/.gitignore': 'x.txt\ny.txt\n', 'sub/.ignore': '!w.md\n', 'sub/.rgignore': '!v.txt\n',
      'sub/x.txt': '', 'sub/y.txt': '', 'sub/w.md': '', 'sub/v.txt': '', 'v.txt': '', 'w.md': '', 'z.md': '', 'dist/a.js': '',
    });
    expect(await parity(root)).toEqual(expect.arrayContaining(['dist/a.js', 'sub/x.txt', 'sub/v.txt', 'sub/w.md']));
  });

  it('hidden files and folders', async () => {
    await parity(tree({ '.git/': '', '.env': '', '.hidden/a.txt': '', 'sub/.dot/b': '', '.gitignore': '.secret\n', '.secret': '', 'sub/.secret': '' }));
  });

  it('info/exclude, below .gitignore', async () => {
    const root = tree({ '.git/info/exclude': '*.tmp\n!keep.tmp\n', '.gitignore': '*.bak\n!kept.tmp\n', 'a.tmp': '', 'keep.tmp': '', 'kept.tmp': '', 'a.bak': '', 'sub/b.tmp': '' });
    expect(await parity(root)).toEqual(['.gitignore', 'keep.tmp', 'kept.tmp']);
  });

  it('git\'s global excludes from ~/.gitconfig, then the XDG config, then XDG\'s git/ignore, inside a repository only', async () => {
    const files = { 'z.g1': '', 'z.g2': '', 'z.g3': '', 'z.g4': '', 'rootonly.txt': '', 'sub/rootonly.txt': '' };
    const root = tree({ '.git/': '', ...files });
    const outside = tree(files);
    const xdg = path.join(base, `xdg-${counter}`);
    const write = (file: string, text: string): void => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    };
    write(path.join(base, 'g1'), '*.g1\n/rootonly.txt\n');
    write(path.join(base, 'g2'), '*.g2\n');
    write(path.join(xdg, 'git', 'ignore'), '*.g3\n');
    write(path.join(home, 'g4'), '*.g4\n');
    vi.stubEnv('XDG_CONFIG_HOME', xdg);
    write(path.join(xdg, 'git', 'config'), `[core]\n  excludesfile = "${path.join(base, 'g2').replaceAll('\\', '/')}"\n`);
    write(path.join(home, '.gitconfig'), `[core]\n\texcludesFile = ${path.join(base, 'g1').replaceAll('\\', '/')}\n`);
    expect(await parity(root)).not.toContain('z.g1');
    expect(await parity(outside)).toContain('z.g1');
    fs.rmSync(path.join(home, '.gitconfig'));
    expect(await parity(root)).not.toContain('z.g2');
    fs.rmSync(path.join(xdg, 'git', 'config'));
    expect(await parity(root)).not.toContain('z.g3');
    vi.stubEnv('XDG_CONFIG_HOME', '');
    write(path.join(home, '.gitconfig'), '[user]\n\tname = x\n[core]\n\tEXCLUDESFILE=~/g4\n');
    expect(await parity(root)).not.toContain('z.g4');
    // an excludesFile that does not exist: no global excludes, and no default either
    write(path.join(home, '.config', 'git', 'ignore'), '*.g1\n');
    write(path.join(home, '.gitconfig'), '[core]\n\texcludesFile = ~/missing\n');
    expect(await parity(root)).toContain('z.g1');
  });

  it('nested repositories end .gitignore and info/exclude above them, never .ignore', async () => {
    const root = tree({
      '.git/info/exclude': '*.e\n', '.gitignore': '*.q\n', '.ignore': '*.i\n',
      'x.q': '', 'x.i': '', 'x.e': '', 'inner/.git/': '', 'inner/y.q': '', 'inner/y.i': '', 'inner/y.e': '',
      'jj/.jj/': '', 'jj/z.q': '', 'file/.git': 'not a pointer\n', 'file/w.q': '',
    });
    expect(await parity(root)).toEqual(expect.arrayContaining(['inner/y.q', 'inner/y.e', 'jj/z.q', 'file/w.q']));
    await parity(root, [], false);
  });

  it('submodule and worktree .git files with a local gitdir', async () => {
    const root = tree({
      '.git/modules/sub/info/exclude': '*.sm\n', 'sub/.git': 'gitdir: ../.git/modules/sub\n', 'sub/a.sm': '', 'sub/a.txt': '',
      'common/info/exclude': '*.wt\n', 'gd/commondir': '../common\n', 'wt/b.wt': '', 'wt/b.txt': '',
      'wt2/.git': 'gitdir: gd\n', 'wt2/c.wt': '', 'wt3/d.wt': '', 'nocommon/x.wt': '',
    });
    fs.writeFileSync(path.join(root, 'wt', '.git'), `gitdir: ${path.join(root, 'gd')}\n`);
    fs.writeFileSync(path.join(root, 'wt3', '.git'), `gitdir: ${path.join(root, 'gd')}\r\n`);
    fs.mkdirSync(path.join(root, 'gd2'));
    fs.writeFileSync(path.join(root, 'nocommon', '.git'), `gitdir: ${path.join(root, 'gd2')}\n`);
    const listed = await parity(root);
    expect(listed).toEqual(expect.arrayContaining(['sub/a.sm', 'nocommon/x.wt']));
    expect(listed).not.toContain('wt/b.wt');
    expect(await parity(path.join(root, 'wt'))).toEqual(['.git', 'b.txt']);
  });

  it('a search rooted below a repository reads the folders above it, and one inside an ignored folder lists it', async () => {
    const outer = tree({
      '.ignore': '*.p\n', '.gitignore': '*.o\n',
      'repo/.git/': '', 'repo/.gitignore': '/sub/anch.txt\n*.r\nbuild/\n',
      'repo/sub/anch.txt': '', 'repo/sub/x.p': '', 'repo/sub/x.o': '', 'repo/sub/x.r': '', 'repo/sub/deep/anch.txt': '', 'repo/build/out.txt': '',
    });
    expect(await parity(path.join(outer, 'repo', 'sub'))).toEqual(['deep/anch.txt', 'x.o']);
    expect(await parity(path.join(outer, 'repo', 'build'))).toEqual(['out.txt']);
  });

  it('a search rooted through a junction reads the folders above its target', async () => {
    const outer = tree({ 'repo/.git/': '', 'repo/.gitignore': '*.r\n', 'repo/sub/x.r': '', 'repo/sub/x.t': '' });
    const link = path.join(base, `j-${counter}`);
    fs.symlinkSync(path.join(outer, 'repo', 'sub'), link, 'junction');
    expect(await parity(link)).toEqual(['x.t']);
  });

  it('--glob filters, an include beating .gitignore, and Glob\'s excludes', async () => {
    const root = tree({
      '.git/': '', '.gitignore': 'ignored.ts\nbuild/\n',
      'src/a.ts': '', 'src/b.js': '', 'src/deep/c.ts': '', 'src/src/f.ts': '', 'ignored.ts': '', 'build/d.ts': '', 'node_modules/p/e.ts': '', 'top.ts': '',
    });
    for (const globs of [['*.ts'], ['!*.ts'], ['src'], ['/src/*.ts'], ['src/**'], ['ignored.ts'], ['build'], ['*.{ts,js}'], ['**/deep/*'], ['!**/node_modules/**', '!**/.git/**'], ['*.ts', '!src/**']]) {
      await parity(root, globs);
    }
  });

  it('no repository, with and without require-git', async () => {
    const root = tree({ '.gitignore': '*.q\n', 'x.q': '', 'inner/.git/': '', 'inner/y.q': '', 'inner/.gitignore': '*.z\n', 'inner/w.z': '' });
    expect(await parity(root)).toEqual(['.gitignore', 'inner/.gitignore', 'inner/y.q', 'x.q']);
    expect(await parity(root, [], false)).toEqual(['.gitignore', 'inner/.gitignore']);
    expect(await insideGitRepo(root)).toBe(false);
    expect(await insideGitRepo(path.join(root, 'inner'))).toBe(true);
  });

  // globset matches a whole-path literal, a basename literal and an extension by lookup and any other glob by regex: the last line
  // that matches decides whichever way each is matched
  it('the last matching line decides across literal, basename, extension and regex globs', async () => {
    const files = { 'x.y': '', 'a.b.y': '', '.y': '', 'k.y': '', 'deep/er/x.y': '', 'deep/er/z.y': '', 'deep/x.y': '', 'er/k.y': '', 'é.y': '', 'sub/é.y': '' };
    const root = tree({ '.git/': '', ...files });
    for (const lines of [
      ['*.y', '!x.y', '!/deep/er/z.y', 'deep/er/x.y'],
      ['x.y', '!*.y', 'k*', '!**/er/*'],
      ['**/er/*', '!z.y', '!*.b.y', '*.b.y', '!é.y'],
      ['*.', '.y', '/x.y', '!deep/x.y', 'deep/**', '!*.y'],
      ['*.y', '!sub/é.y', '!/k.y', '!a.b.y', '*.b.*'],
    ]) {
      fs.writeFileSync(path.join(root, '.gitignore'), `${lines.join('\n')}\n`);
      await parity(root);
      await parity(root, lines.map((line) => (line.startsWith('!') ? line.slice(1) : `!${line}`)));
    }
  });

  it('BOM, CRLF and a line that is not UTF-8, which ends the file', async () => {
    const gitignore = Buffer.concat([Buffer.from('\uFEFF*.bom\r\n*.crlf\r\n'), Buffer.from([0x78, 0xff, 0x0a]), Buffer.from('*.after\n')]);
    await parity(tree({ '.git/': '', '.gitignore': gitignore, 'a.bom': '', 'a.crlf': '', 'a.after': '', 'a.txt': '' }));
  });
});

const SWITCHES: readonly WalkIgnore[] = [true, false].flatMap((files) => [true, false].flatMap((global) => [true, false].map((parents) => ({ files, global, parents }))));

describe('the ignore switches list what rg lists with the same flags', () => {
  const kinds = ['x.p', 'x.o', 'x.e', 'x.q', 'x.i', 'x.r', 'x.g', 'x.t', 'sub/y.q', 'sub/y.t'];
  beforeEach(() => {
    fs.writeFileSync(path.join(home, '.gitconfig'), `[core]\n\texcludesFile = ${path.join(home, 'global').replaceAll('\\', '/')}\n`);
    fs.writeFileSync(path.join(home, 'global'), '*.g\n');
  });

  it('a root below a repository, whose folders above it hold rules', async () => {
    const outer = tree({
      '.git/info/exclude': '*.e\n', '.ignore': '*.p\n', '.gitignore': '*.o\n',
      'root/.gitignore': '*.q\n', 'root/.ignore': '*.i\n', 'root/.rgignore': '*.r\n', 'root/sub/.gitignore': '!y.q\n',
      ...Object.fromEntries(kinds.map((name) => [`root/${name}`, ''])),
    });
    const root = path.join(outer, 'root');
    for (const ignore of SWITCHES) {
      for (const globs of [[], ['!x.t'], ['*.q']]) await parity(root, globs, true, { ignore });
    }
    // the folders above still mark the repository, so the root's .gitignore applies
    expect(await walked(root, [], true, { ignore: { ...ALL_IGNORE_FILES, parents: false } })).toEqual(['.gitignore', '.ignore', '.rgignore', 'sub/.gitignore', 'sub/y.q', 'sub/y.t', 'x.e', 'x.o', 'x.p', 'x.t']);
  });

  it('a root that is a repository', async () => {
    const root = tree({
      '.git/info/exclude': '*.e\n', '.gitignore': '*.q\n', '.ignore': '*.i\n', '.rgignore': '*.r\n', 'sub/.gitignore': '!y.q\n',
      ...Object.fromEntries(kinds.map((name) => [name, ''])),
    });
    for (const ignore of SWITCHES) {
      for (const globs of [[], ['!x.t'], ['*.q']]) await parity(root, globs, true, { ignore });
    }
    expect(await walked(root, [], true, { ignore: { ...ALL_IGNORE_FILES, global: false } })).toContain('x.g');
    expect(await walked(root, [], true, { ignore: { files: false, global: true, parents: true } })).toEqual(expect.arrayContaining(kinds));
  });
});

describe('gitFolders', () => {
  const repository = (): string => tree({
    '.git/HEAD': 'ref', '.git/objects/ab/cd': '', '.git/info/exclude': 'HEAD\n*.e\n', '.gitignore': '*.q\n',
    'a.txt': '', 'x.e': '', 'x.q': '', 'inner/.git/config': '', 'inner/b.txt': '',
  });

  it('\'list\' walks a .git folder as rg does, its own info/exclude applying, under every switch', async () => {
    const root = repository();
    for (const ignore of SWITCHES) await parity(root, [], true, { ignore, gitFolders: 'list' });
    const listed = await parity(root, [], true, { gitFolders: 'list' });
    expect(listed).toEqual(expect.arrayContaining(['.git/info/exclude', '.git/objects/ab/cd', 'inner/.git/config']));
    expect(listed).not.toContain('.git/HEAD');
    expect(await parity(root, [], true, { ignore: { files: false, global: true, parents: true }, gitFolders: 'list' })).toContain('.git/HEAD');
    expect(await parity(root, ['!**/.git'], true, { gitFolders: 'list' })).toEqual(['.gitignore', 'a.txt', 'inner/b.txt']);
  });

  it('\'skip\' lists nothing inside a .git folder, and its info/exclude still applies', async () => {
    const root = repository();
    for (const ignore of SWITCHES) {
      const listed = await walked(root, [], true, { ignore, gitFolders: 'skip' });
      expect(listed.filter((file) => insideGitFolder(file))).toEqual([]);
      expect(listed.includes('x.e')).toBe(!ignore.files);
    }
  });
});

describe.runIf(process.platform === 'win32')('links under every switch (win32)', () => {
  it('lists no link and enters none, a .git link included', async () => {
    const root = tree({ 'a.txt': '', 'real/b.txt': '' });
    const outside = tree({ 'c.txt': '', 'HEAD': '' });
    fs.symlinkSync(outside, path.join(root, 'j'), 'junction');
    fs.symlinkSync(outside, path.join(root, '.git'), 'junction');
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, 'dangling'), 'junction');
    for (const ignore of SWITCHES) {
      for (const gitFolders of ['skip', 'list'] as const) {
        expect(await parity(root, [], true, { ignore, gitFolders })).toEqual(['a.txt', 'real/b.txt']);
      }
    }
  });
});

/** Each glob as a `.gitignore` line, as a `--glob` include and as a `--glob` exclude. */
describe('the glob dialect is globset\'s', () => {
  const names = [
    'ab.txt', 'ac.txt', 'aX.txt', 'a{b,c}.txt', 'p.txt', 'p1.txt', 'p2.txt', 'p{1..3}.txt', 'p{,1}.txt', ']a.txt', 'b.txt', '-.txt', 'z.txt',
    'a/c', 'aXc', 'abc', '[z].txt', 'é.txt', 'e.txt', 'UPPER.TXT', 'lower.txt', '#hash.txt', '!bang.txt', 'x.y', 'x', 'deep/er/x.y', 'foo', 'trail',
    'dir/x.txt', 'dir/sub/x.txt', 'a\\b.txt'.replace('\\', '-'),
  ];
  let root: string;
  beforeAll(() => {
    root = tree(Object.fromEntries([['.git/', ''], ...names.map((name) => [name, ''])]));
  });

  const globs = [
    '{ab,ac}.txt', '{ab}.txt', 'a{X,{b,c}}.txt', 'p{,1}.txt', 'p{1..3}.txt', 'a{b,c}.txt',
    '[ab].txt', '[!a]*.txt', '[^a]*.txt', '[]a].txt', '[a-].txt', '[-a].txt', 'a[!X]c', '[[:alpha:]].txt', '[z].txt', '\\[z\\].txt', 'a[\\]]c',
    '**/x.y', 'deep/**', 'deep/**/x.y', '**x.y', 'x**', '**', 'dir/**/x.txt', '**/er/*',
    '\\#hash.txt', '#hash.txt', '\\!bang.txt', 'trail\\ ', 'trail   ', 'lower.txt\t',
    '*.TXT', '*.txt', 'UPPER.txt', '/x', '/x.y', '/deep', 'x.y/', 'deep/', 'er/', '?.txt', 'é.txt', '*',
    '[unclosed', '[z-a]', '{a', 'a}', 'foo\\', '',
  ];

  it.each(globs)('%j', async (glob) => {
    fs.writeFileSync(path.join(root, '.gitignore'), `${glob}\n`);
    await parity(root);
    fs.rmSync(path.join(root, '.gitignore'));
    for (const line of [glob, `!${glob}`]) {
      const expected = await rgFiles(root, [line]).then((files) => ({ files }), (error: Error) => ({ error: /error parsing glob '([^']*)': ([^\r\n]*)/.exec(error.message)?.slice(1) }));
      const actual = await walked(root, [line]).then((files) => ({ files }), (error: Error) => {
        expect(error).toBeInstanceOf(GlobSyntaxError);
        return { error: /error parsing glob '([^']*)': (.*)/.exec(error.message)?.slice(1) };
      });
      expect(actual, `--glob ${JSON.stringify(line)}`).toEqual(expected);
    }
  });
});

describe.runIf(process.platform === 'win32')('a pointer whose place cannot be decided (win32)', () => {
  // two junctions naming each other: networkReach of a path through them fails with ELOOP
  function loopTree(): string {
    const root = tree({ '.git/': '', 'a/f.txt': '', 'top.txt': '', 'y/c.txt': '' });
    fs.symlinkSync(path.join(root, 'loop2'), path.join(root, 'loop1'), 'junction');
    fs.symlinkSync(path.join(root, 'loop1'), path.join(root, 'loop2'), 'junction');
    fs.writeFileSync(path.join(root, 'y', '.git'), `gitdir: ${path.join(root, 'loop1', 'x')}\n`);
    return root;
  }

  it('fails the walk that reaches it, and leaves no rejection behind a walk that ends before it', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const root = loopTree();
      const early = walkFiles({ root, requireGit: true, ignore: ALL_IGNORE_FILES, gitFolders: 'skip', overrides: overrideRules([]), allowedHosts: noHosts, signal: undefined });
      // a's listing is awaited while y's, read ahead, fails
      for (let next = await early.files.next(); !next.value?.includes(path.join('a', 'f.txt')); next = await early.files.next()) expect(next.done).toBe(false);
      await early.files.return();
      const full = walkFiles({ root, requireGit: true, ignore: ALL_IGNORE_FILES, gitFolders: 'skip', overrides: overrideRules([]), allowedHosts: noHosts, signal: undefined });
      await expect((async () => { for await (const _ of full.files) { /* drained */ } })()).rejects.toMatchObject({ code: 'ELOOP' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe.runIf(process.platform === 'win32')('links (win32)', () => {
  it('lists no link, follows none, and lists what rg lists without --follow', async () => {
    const root = tree({ '.git/': '', 'a.txt': '', 'real/b.txt': '', '.gitignore': '*.ign\n' });
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'j'), 'junction');
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, 'dangling'), 'junction');
    expect(await parity(root)).toEqual(['.gitignore', 'a.txt', 'real/b.txt']);
  });
});

describe.runIf(process.platform !== 'win32')('a newline in a folder name (POSIX)', () => {
  // globset's regexes match a newline wherever a glob's `**` or `*` may
  it('is matched as rg matches it', async () => {
    const root = tree({ '.git/': '', '.gitignore': '**/deep/*.md\n*.log\nnew*/b.md\n', 'new\nline/deep/a.md': '', 'new\nline/x.log': '', 'new\nline/b.md': '', 'new\nline/keep.txt': '' });
    const { exit, stdout } = await runProcess({ file: rgPath, args: ['--no-config', '--files', '--hidden', '--null', '--', '.'], cwd: root, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(exit?.code).toBe(0);
    const expected = stdout.toString('utf8').split('\0').filter(Boolean).map((line) => line.replace(/^\.\//, '')).sort();
    expect(expected).toEqual(['.gitignore', 'new\nline/keep.txt']);
    expect(await walked(root)).toEqual(expected);
  });
});

describe.runIf(process.platform !== 'win32')('a name ending in a dot (POSIX)', () => {
  // globset gives such a name its basename and extension (file_name is None only for an empty path or a `..` basename)
  it('is matched as rg matches it, by a literal line and by an extension line', async () => {
    const root = tree({ '.git/': '', 'x.': '', 'a/b.': '', 'a/x.': '', 'a/c.d': '', 'keep.txt': '' });
    for (const lines of [['x.'], ['*.'], ['x.', '*.']]) {
      fs.writeFileSync(path.join(root, '.gitignore'), `${lines.join('\n')}\n`);
      await parity(root);
      fs.rmSync(path.join(root, '.gitignore'));
      await parity(root, lines);
      await parity(root, lines.map((line) => `!${line}`));
    }
  });
});

// A folder link every host can make: a junction on Windows, a symlink elsewhere.
const folderLink = (target: string, at: string): void => fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');

describe.runIf(process.platform !== 'win32')('followLinks lists what rg --follow lists (POSIX)', () => {
  it('a folder link and a file link out of the root, with the ignore rules on the path through each, under every switch', async () => {
    const outside = tree({ 'c.txt': '', 'skip.log': '', 'deep/d.txt': '', '.gitignore': 'own.txt\n', 'own.txt': '', 'keep.txt': '' });
    const root = tree({ '.git/': '', '.gitignore': '*.log\nlinked/deep/\n', 'a.txt': '', 'real/b.txt': '' });
    folderLink(outside, path.join(root, 'linked'));
    fs.symlinkSync(path.join(outside, 'c.txt'), path.join(root, 'file-link.txt'));
    expect(await parity(root, [], true, { followLinks: true })).toEqual(['.gitignore', 'a.txt', 'file-link.txt', 'linked/.gitignore', 'linked/c.txt', 'linked/keep.txt', 'real/b.txt']);
    for (const ignore of SWITCHES) await parity(root, [], true, { ignore, followLinks: true });
    await parity(root, ['!linked/c.txt', '!file-link.txt'], true, { followLinks: true });
  });

  it('a link inside a linked folder, followed from the path through both', async () => {
    const further = tree({ 'f.txt': '' });
    const outside = tree({ 'c.txt': '' });
    folderLink(further, path.join(outside, 'further'));
    const root = tree({ '.git/': '', 'a.txt': '' });
    folderLink(outside, path.join(root, 'linked'));
    expect(await parity(root, [], true, { followLinks: true })).toEqual(['a.txt', 'linked/c.txt', 'linked/further/f.txt']);
  });
});

describe('followLinks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ends at a link to a folder the walk entered, an ancestor included, and lists each file once', async () => {
    const root = tree({ '.git/': '', 'a.txt': '', 'sub/b.txt': '' });
    folderLink(root, path.join(root, 'sub', 'back'));
    folderLink(path.join(root, 'sub'), path.join(root, 'sub', 'self'));
    expect(await walked(root, [], true, { followLinks: true })).toEqual(['a.txt', 'sub/b.txt']);
  });

  it('lists a sibling folder by its own path, never through a link beside it, whatever the listing order', async () => {
    const root = tree({ '.git/': '', 'b/x.txt': '' });
    folderLink(path.join(root, 'b'), path.join(root, 'a-link'));
    folderLink(path.join(root, 'b'), path.join(root, 'z-link'));
    expect(await walked(root, [], true, { followLinks: true })).toEqual(['b/x.txt']);
  });

  it('ends at a link to the folder above the root, listing the root once more below it, as rg --follow does', async () => {
    const above = tree({ 'proj/.git/': '', 'proj/a.txt': '', 'sibling.txt': '' });
    const root = path.join(above, 'proj');
    folderLink(above, path.join(root, 'up'));
    expect(await walked(root, [], true, { followLinks: true })).toEqual(['a.txt', 'up/proj/a.txt', 'up/sibling.txt']);
  });

  it('enters a folder two links lead to once, by the first link it lists', async () => {
    const outside = tree({ 'c.txt': '' });
    const root = tree({ '.git/': '', 'a.txt': '' });
    folderLink(outside, path.join(root, 'one'));
    folderLink(outside, path.join(root, 'two'));
    const listed = await walked(root, [], true, { followLinks: true });
    expect([['a.txt', 'one/c.txt'], ['a.txt', 'two/c.txt']]).toContainEqual(listed);
  });

  it('leaves out a link whose target is gone, and two links leading to each other, reporting neither', async () => {
    const root = tree({ '.git/': '', 'a.txt': '' });
    const gone = tree({});
    folderLink(gone, path.join(root, 'dangling'));
    fs.rmSync(gone, { recursive: true });
    folderLink(path.join(root, 'loop2'), path.join(root, 'loop1'));
    folderLink(path.join(root, 'loop1'), path.join(root, 'loop2'));
    expect(await walked(root, [], true, { followLinks: true })).toEqual(['a.txt']);
  });

  it('reports a link it cannot stat as rg reports an unreadable folder, and goes on', async () => {
    const outside = tree({ 'c.txt': '' });
    const root = tree({ '.git/': '', 'a.txt': '' });
    folderLink(outside, path.join(root, 'locked'));
    const stat = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (file: fs.PathLike, ...rest: unknown[]) => {
      if (String(file) === path.join(root, 'locked')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return stat(file, ...(rest as []));
    }) as never);
    const walk = walkFiles({ root, requireGit: true, ignore: ALL_IGNORE_FILES, gitFolders: 'skip', overrides: overrideRules([]), allowedHosts: noHosts, signal: undefined, followLinks: true });
    const files: string[] = [];
    for await (const batch of walk.files) files.push(...batch);
    expect(files).toEqual(['a.txt']);
    expect(walk.errors).toEqual(['locked: EACCES: permission denied']);
  });

  it('never reads through a .git that is a link, under either gitFolders, and lists nothing of it', async () => {
    const outside = tree({ 'HEAD': '', 'info/exclude': 'a.txt\n' });
    const root = tree({ 'a.txt': '', 'b.txt': '' });
    folderLink(outside, path.join(root, '.git'));
    const named: string[] = [];
    for (const name of ['lstat', 'stat', 'realpath', 'readdir', 'readFile', 'readlink', 'open'] as const) {
      const original = fs.promises[name].bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
      vi.spyOn(fs.promises, name).mockImplementation((async (file: fs.PathLike, ...rest: unknown[]) => {
        if (String(file).startsWith(path.join(root, '.git'))) named.push(`${name} ${String(file)}`);
        return original(file, ...rest);
      }) as never);
    }
    for (const gitFolders of ['skip', 'list'] as const) expect(await walked(root, [], true, { gitFolders, followLinks: true })).toEqual(['a.txt', 'b.txt']);
    expect(named).toEqual([]);
  });

  it('reads no ignore file that is a link, as without it', async (context) => {
    const outside = tree({ 'rules': 'hidden.txt\n' });
    const root = tree({ '.git/': '', 'hidden.txt': '', 'shown.txt': '' });
    try {
      fs.symlinkSync(path.join(outside, 'rules'), path.join(root, '.gitignore'), 'file');
    } catch (err) {
      // a file symlink on Windows needs Developer Mode or an elevated process
      if ((err as NodeJS.ErrnoException).code === 'EPERM') context.skip();
      throw err;
    }
    expect(await walked(root, [], true, { followLinks: true })).toEqual(['.gitignore', 'hidden.txt', 'shown.txt']);
  });

  it('makes no call naming a link the rules ignore both as a file and as a folder', async () => {
    const outside = tree({ 'c.txt': '' });
    const root = tree({ '.git/': '', '.gitignore': 'skipped\n', 'a.txt': '' });
    const link = path.join(root, 'skipped');
    folderLink(outside, link);
    const named: string[] = [];
    for (const name of ['lstat', 'stat', 'realpath', 'readdir', 'readFile', 'readlink', 'open'] as const) {
      const original = fs.promises[name].bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
      vi.spyOn(fs.promises, name).mockImplementation((async (file: fs.PathLike, ...rest: unknown[]) => {
        if (String(file).startsWith(link)) named.push(`${name} ${String(file)}`);
        return original(file, ...rest);
      }) as never);
    }
    expect(await walked(root, [], true, { followLinks: true })).toEqual(['.gitignore', 'a.txt']);
    expect(named).toEqual([]);
  });

  it('stats and realpaths a link below a followed folder by its path from the root, where an ancestor now leads', async () => {
    const secret = tree({ 's.txt': '' });
    const elsewhere = tree({ 'e.txt': '' });
    const before = tree({});
    const after = tree({});
    folderLink(secret, path.join(before, 'b'));
    folderLink(elsewhere, path.join(after, 'b'));
    const root = tree({ '.git/': '' });
    const ancestor = path.join(root, 'a');
    folderLink(before, ancestor);
    const named: string[] = [];
    const stat = fs.promises.stat.bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
    const realpath = fs.promises.realpath.bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (file: fs.PathLike, ...rest: unknown[]) => {
      named.push(`stat ${String(file)}`);
      return stat(file, ...rest);
    }) as never);
    let repointed = false;
    vi.spyOn(fs.promises, 'realpath').mockImplementation((async (file: fs.PathLike, ...rest: unknown[]) => {
      named.push(`realpath ${String(file)}`);
      const real = await realpath(file, ...rest);
      // a is queued at this realpath; it leads elsewhere before the link inside it is checked
      if (String(file) === ancestor && !repointed) {
        repointed = true;
        fs.unlinkSync(ancestor);
        folderLink(after, ancestor);
      }
      return real;
    }) as never);
    expect(await walked(root, [], true, { followLinks: true })).toEqual(['a/b/e.txt']);
    const inner = named.filter((call) => call.endsWith(`${path.sep}b`));
    expect(inner).toEqual([`stat ${path.join(root, 'a', 'b')}`, `realpath ${path.join(root, 'a', 'b')}`]);
  });

  it('settles every link check of a folder before it fails with one that threw', async () => {
    const outside = tree({ 'c.txt': '' });
    const root = tree({ '.git/': '', 'a.txt': '' });
    folderLink(outside, path.join(root, 'bad'));
    folderLink(outside, path.join(root, 'slow'));
    const order: string[] = [];
    let release = (): void => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    let slowSettled = (): void => {};
    const slowDone = new Promise<void>((resolve) => (slowSettled = resolve));
    const stat = fs.promises.stat.bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (file: fs.PathLike, ...rest: unknown[]) => {
      if (path.basename(String(file)) === 'bad') throw new Error('not an errno failure');
      if (path.basename(String(file)) === 'slow') {
        await released;
        order.push('slow check settled');
        slowSettled();
      }
      return stat(file, ...rest);
    }) as never);
    const walk = walkFiles({ root, requireGit: true, ignore: ALL_IGNORE_FILES, gitFolders: 'skip', overrides: overrideRules([]), allowedHosts: noHosts, signal: undefined, followLinks: true });
    setTimeout(release, 50);
    await expect(walk.files.next().finally(() => order.push('walk failed'))).rejects.toThrow('not an errno failure');
    await slowDone;
    expect(order).toEqual(['slow check settled', 'walk failed']);
  });

  it('starts no link check of a folder once one threw', async () => {
    const outside = tree({ 'c.txt': '' });
    const root = tree({ '.git/': '' });
    for (let index = 0; index < 9; index++) folderLink(outside, path.join(root, `l${index}`));
    const checked: string[] = [];
    const stat = fs.promises.stat.bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (file: fs.PathLike, ...rest: unknown[]) => {
      const name = path.basename(String(file));
      if (!/^l\d$/.test(name)) return stat(file, ...rest);
      checked.push(name);
      if (name === 'l0') throw new Error('not an errno failure');
      await new Promise((resolve) => setTimeout(resolve, 20));
      return stat(file, ...rest);
    }) as never);
    const walk = walkFiles({ root, requireGit: true, ignore: ALL_IGNORE_FILES, gitFolders: 'skip', overrides: overrideRules([]), allowedHosts: noHosts, signal: undefined, followLinks: true });
    await expect(walk.files.next()).rejects.toThrow('not an errno failure');
    expect(checked).not.toContain('l8');
  });

  it('checks at most eight links of a folder at once, and starts none after an abort', async () => {
    const outside = tree({ 'c.txt': '' });
    const root = tree({ '.git/': '' });
    for (let index = 0; index < 20; index++) folderLink(outside, path.join(root, `l${String(index).padStart(2, '0')}`));
    let running = 0;
    let most = 0;
    let started = 0;
    let release = (): void => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const stat = fs.promises.stat.bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (file: fs.PathLike, ...rest: unknown[]) => {
      if (!/^l\d\d$/.test(path.basename(String(file)))) return stat(file, ...rest);
      started++;
      most = Math.max(most, ++running);
      await released;
      running--;
      return stat(file, ...rest);
    }) as never);
    const controller = new AbortController();
    const walk = walkFiles({ root, requireGit: true, ignore: ALL_IGNORE_FILES, gitFolders: 'skip', overrides: overrideRules([]), allowedHosts: noHosts, signal: controller.signal, followLinks: true });
    const first = walk.files.next();
    await vi.waitFor(() => expect(started).toBe(8));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect([started, most]).toEqual([8, 8]);
    controller.abort();
    release();
    await expect(first).rejects.toThrow('Operation aborted');
    expect(started).toBe(8);
  });
});

describe.runIf(process.platform === 'win32')('followLinks keys a folder it entered by its realpath as spelled (win32)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // A realpath faked to differ from an entered folder only in case stands for a case-sensitive folder holding a and A.
  it('enters a link whose realpath differs only in case from a folder it entered', async () => {
    const root = tree({ '.git/': '', 'A/x.txt': '' });
    const link = path.join(root, 'l');
    folderLink(tree({ 'y.txt': '' }), link);
    const realpath = fs.promises.realpath.bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(fs.promises, 'realpath').mockImplementation((async (file: fs.PathLike, ...rest: unknown[]) => (String(file) === link ? path.join(root, 'a') : realpath(file, ...rest))) as never);
    expect(await walked(root, [], true, { followLinks: true })).toEqual(['A/x.txt', 'l/x.txt']);
  });
});

describe('timed files', () => {
  const PLANS = { extension: '.md', folder: 'plans', word: 'plan' } as const;
  const at = (day: number): Date => new Date(Date.UTC(2020, 0, day));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function timedWalk(root: string, followLinks: boolean): Promise<{ files: string[]; modified: Record<string, number>; statted: string[] }> {
    const statted: string[] = [];
    const stat = fs.promises.stat.bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (file: fs.PathLike, ...rest: unknown[]) => {
      statted.push(path.relative(root, String(file)).replaceAll('\\', '/'));
      return stat(file, ...rest);
    }) as never);
    const walk = walkFiles({ root, requireGit: true, ignore: ALL_IGNORE_FILES, gitFolders: 'skip', overrides: overrideRules([]), allowedHosts: noHosts, signal: undefined, timed: PLANS, ...(followLinks ? { followLinks: true } : {}) });
    const files: string[] = [];
    for await (const batch of walk.files) files.push(...batch.map((file) => file.replaceAll('\\', '/')));
    const modified = Object.fromEntries([...walk.modified].map(([file, time]) => [file.replaceAll('\\', '/'), time]));
    return { files: files.sort(), modified, statted };
  }

  it('returns the modified time of each listed file the rule names, below a followed link too, and stats no other file', async () => {
    const outside = tree({ 'rollout-plan.md': '', 'notes.md': '' });
    const root = tree({ '.git/': '', '.gitignore': 'ignored-plan.md\n', 'plans/a.md': '', 'b.ts': '', 'PLAN.md': '', 'ignored-plan.md': '' });
    folderLink(outside, path.join(root, 'linked'));
    fs.utimesSync(path.join(root, 'plans', 'a.md'), at(2), at(2));
    fs.utimesSync(path.join(root, 'PLAN.md'), at(3), at(3));
    fs.utimesSync(path.join(outside, 'rollout-plan.md'), at(4), at(4));
    const { files, modified, statted } = await timedWalk(root, true);
    expect(files).toEqual(['.gitignore', 'PLAN.md', 'b.ts', 'linked/notes.md', 'linked/rollout-plan.md', 'plans/a.md']);
    expect(modified).toEqual({ 'PLAN.md': at(3).getTime(), 'plans/a.md': at(2).getTime(), 'linked/rollout-plan.md': at(4).getTime() });
    expect(statted.filter((file) => /b\.ts|notes\.md|ignored-plan\.md|\.gitignore/.test(file))).toEqual([]);
  });

  it('takes a file link\'s time from the one stat of its path through the link', async (context) => {
    const outside = tree({ 'target.md': '' });
    fs.utimesSync(path.join(outside, 'target.md'), at(5), at(5));
    const root = tree({ '.git/': '' });
    try {
      fs.symlinkSync(path.join(outside, 'target.md'), path.join(root, 'plan.md'), 'file');
    } catch (err) {
      // a file symlink on Windows needs Developer Mode or an elevated process
      if ((err as NodeJS.ErrnoException).code === 'EPERM') context.skip();
      throw err;
    }
    const { files, modified, statted } = await timedWalk(root, true);
    expect(files).toEqual(['plan.md']);
    expect(modified).toEqual({ 'plan.md': at(5).getTime() });
    expect(statted.filter((file) => file === 'plan.md')).toEqual(['plan.md']);
  });
});

describe('skipRealUnder', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function listed(root: string, skipRealUnder?: readonly string[]): Promise<string[]> {
    const walk = walkFiles({ root, requireGit: true, ignore: ALL_IGNORE_FILES, gitFolders: 'skip', overrides: overrideRules([]), allowedHosts: noHosts, signal: undefined, followLinks: true, ...(skipRealUnder ? { skipRealUnder } : {}) });
    const files: string[] = [];
    for await (const batch of walk.files) files.push(...batch.map((file) => file.replaceAll('\\', '/')));
    expect(walk.errors).toEqual([]);
    return files.sort();
  }

  it('lists no file a link leads to under the folders, and lists a link out of them, one inside them included', async () => {
    const project = tree({ 'docs/d.md': '' });
    const store = tree({ 'pkg/index.js': '' });
    const shared = tree({ 's.txt': '' });
    folderLink(shared, path.join(project, 'docs', 'ext'));
    const root = tree({ '.git/': '', 'own.txt': '' });
    folderLink(path.join(project, 'docs'), path.join(root, 'docs'));
    folderLink(store, path.join(root, 'deps'));
    expect(await listed(root)).toEqual(['deps/pkg/index.js', 'docs/d.md', 'docs/ext/s.txt', 'own.txt']);
    expect(await listed(root, [project])).toEqual(['deps/pkg/index.js', 'docs/ext/s.txt', 'own.txt']);
  });

  it('lists a file reached without a link, also when the walk\'s root lies under the folders', async () => {
    const project = tree({ 'work/a.txt': '', 'other/o.txt': '' });
    const root = path.join(project, 'work');
    folderLink(path.join(project, 'other'), path.join(root, 'back'));
    expect(await listed(root, [project])).toEqual(['a.txt']);
  });

  it('lists no file link whose realpath lies under the folders', async (context) => {
    const project = tree({ '.env': '' });
    const elsewhere = tree({ 'keep.txt': '' });
    const root = tree({ '.git/': '' });
    try {
      fs.symlinkSync(path.join(project, '.env'), path.join(root, '.env'), 'file');
      fs.symlinkSync(path.join(elsewhere, 'keep.txt'), path.join(root, 'keep.txt'), 'file');
    } catch (err) {
      // a file symlink on Windows needs Developer Mode or an elevated process
      if ((err as NodeJS.ErrnoException).code === 'EPERM') context.skip();
      throw err;
    }
    expect(await listed(root)).toEqual(['.env', 'keep.txt']);
    expect(await listed(root, [project])).toEqual(['keep.txt']);
  });
});

describe.runIf(process.platform === 'win32')('followLinks through junctions (win32)', () => {
  it('lists a junction\'s files by the path through it, its own .gitignore and the root\'s rules on that path applying', async () => {
    const outside = tree({ 'c.txt': '', 'skip.txt': '', '.gitignore': 'own.txt\n', 'own.txt': '', 'deep/d.txt': '' });
    const root = tree({ '.git/': '', '.gitignore': 'j/skip.txt\n', 'a.txt': '' });
    folderLink(outside, path.join(root, 'j'));
    expect(await walked(root, [], true, { followLinks: true })).toEqual(['.gitignore', 'a.txt', 'j/.gitignore', 'j/c.txt', 'j/deep/d.txt']);
    expect(await walked(root, ['!j/deep/'], true, { followLinks: true })).toEqual(['.gitignore', 'a.txt', 'j/.gitignore', 'j/c.txt']);
    expect(await walked(root)).toEqual(['.gitignore', 'a.txt']);
  });
});

// The network check reads link targets as readlink gives them, so a junction whose readlink is faked onto a share stands for a
// link Windows would follow there.
describe.runIf(process.platform === 'win32')('followLinks onto Windows network paths (win32)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Fakes readlink of each junction onto its share target, and records any call naming a UNC path, and every call but lstat
  // naming a faked link or a path below it: the target behind it, which only lstat and readlink of the link avoid.
  function fakeShares(fakeTargets: ReadonlyMap<string, string>): { readonly uncCalls: string[]; readonly throughLink: string[] } {
    const uncCalls: string[] = [];
    const throughLink: string[] = [];
    const links = [...fakeTargets.keys()].map((link) => link.toLowerCase());
    const readlink = fs.promises.readlink.bind(fs.promises);
    vi.spyOn(fs.promises, 'readlink').mockImplementation((async (file: fs.PathLike) => fakeTargets.get(String(file).toLowerCase()) ?? readlink(file)) as never);
    for (const name of ['lstat', 'stat', 'realpath', 'open', 'readdir', 'readFile'] as const) {
      const original = fs.promises[name].bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
      vi.spyOn(fs.promises, name).mockImplementation((async (file: fs.PathLike, ...rest: unknown[]) => {
        if (/^[\\/]{2}/.test(String(file))) {
          uncCalls.push(String(file));
          throw new Error(`reached ${String(file)}`);
        }
        if (name !== 'lstat' && links.some((link) => String(file).toLowerCase().startsWith(link))) throughLink.push(`${name} ${String(file)}`);
        return original(file, ...rest);
      }) as never);
    }
    return { uncCalls, throughLink };
  }

  it('skips a junction onto a share and one onto WSL, contacting neither and naming neither\'s target', async () => {
    const marker = tree({ 'secret.txt': '' });
    const root = tree({ '.git/': '', 'a.txt': '' });
    folderLink(marker, path.join(root, 'nas'));
    folderLink(marker, path.join(root, 'wsl'));
    const { uncCalls, throughLink } = fakeShares(new Map([[path.join(root, 'nas').toLowerCase(), '\\\\host\\share\\x'], [path.join(root, 'wsl').toLowerCase(), '\\\\wsl.localhost\\Ubuntu\\x']]));
    expect(await walked(root, [], true, { followLinks: true })).toEqual(['a.txt']);
    expect(uncCalls).toEqual([]);
    expect(throughLink).toEqual([]);
  });

  it('skips a junction onto a share inside a followed junction, judged from the root through the outer one', async () => {
    const marker = tree({ 'secret.txt': '' });
    const outside = tree({ 'c.txt': '' });
    folderLink(marker, path.join(outside, 'nas'));
    const root = tree({ '.git/': '', 'a.txt': '' });
    folderLink(outside, path.join(root, 'j'));
    // the outer junction's own path, and the path the walk reads the followed folder at
    const { uncCalls, throughLink } = fakeShares(new Map([[path.join(root, 'j', 'nas').toLowerCase(), '\\\\host\\share\\x'], [path.join(outside, 'nas').toLowerCase(), '\\\\host\\share\\x']]));
    expect(await walked(root, [], true, { followLinks: true })).toEqual(['a.txt', 'j/c.txt']);
    expect(uncCalls).toEqual([]);
    expect(throughLink).toEqual([]);
  });

  it('skips a junction onto a share whose host the walk\'s allowedHosts names, which place .git pointers only', async () => {
    const marker = tree({ 'secret.txt': '' });
    const root = tree({ '.git/': '', 'a.txt': '' });
    folderLink(marker, path.join(root, 'nas'));
    const { uncCalls, throughLink } = fakeShares(new Map([[path.join(root, 'nas').toLowerCase(), '\\\\host\\share\\x']]));
    const walk = walkFiles({ root, requireGit: true, ignore: ALL_IGNORE_FILES, gitFolders: 'skip', overrides: overrideRules([]), allowedHosts: () => Promise.resolve(new Set(['host'])), signal: undefined, followLinks: true });
    const files: string[] = [];
    for await (const batch of walk.files) files.push(...batch);
    expect(files).toEqual(['a.txt']);
    expect(walk.errors).toEqual([]);
    expect(uncCalls).toEqual([]);
    expect(throughLink).toEqual([]);
  });
});

describe('walkFiles batches', () => {
  it('yields one batch per folder it lists, empty for a folder that lists no file', async () => {
    const root = tree({ '.git/': '', '.gitignore': '*.log\n', 'a.txt': '', 'empty/': '', 'logs/x.log': '' });
    const walk = walkFiles({ root, requireGit: true, ignore: ALL_IGNORE_FILES, gitFolders: 'skip', overrides: overrideRules([]), allowedHosts: noHosts, signal: undefined });
    const batches: string[][] = [];
    for await (const batch of walk.files) batches.push(batch.map((file) => file.replaceAll('\\', '/')).sort());
    expect(batches.sort((a, b) => b.length - a.length)).toEqual([['.gitignore', 'a.txt'], [], []]);
  });
});

describe('walkTree: every entry, with no ignore rule', () => {
  it('lists hidden files, a .git folder and ignored files, folder by folder', async () => {
    const root = tree({ '.git/HEAD': 'ref', '.gitignore': '*.log\n', 'a.log': '', '.hidden': '', 'sub/s.txt': '', 'empty/': '' });
    const entries: string[] = [];
    for await (const entry of walkTree(root, undefined)) entries.push(`${entry.kind} ${entry.rel.replaceAll('\\', '/')}`);
    expect(entries.sort()).toEqual(['file .git/HEAD', 'file .gitignore', 'file .hidden', 'file a.log', 'file sub/s.txt', 'folder .git', 'folder empty', 'folder sub']);
  });

  it('stops at an aborted signal', async () => {
    const root = tree({ 'a.txt': '' });
    const controller = new AbortController();
    controller.abort();
    await expect((async () => {
      for await (const entry of walkTree(root, controller.signal)) void entry;
    })()).rejects.toThrow('Operation aborted');
  });
});

describe.runIf(process.platform === 'win32')('walkTree: links (win32)', () => {
  it('reports a junction, a symlink and a dangling link as links and enters none', async () => {
    const root = tree({ 'a.txt': '', 'real/b.txt': '' });
    const outside = tree({ 'c.txt': '' });
    fs.symlinkSync(outside, path.join(root, 'j'), 'junction');
    fs.symlinkSync(path.join(outside, 'c.txt'), path.join(root, 'f'), 'file');
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, 'dangling'), 'junction');
    const entries: string[] = [];
    for await (const entry of walkTree(root, undefined)) entries.push(`${entry.kind} ${entry.rel.replaceAll('\\', '/')}`);
    expect(entries.sort()).toEqual(['file a.txt', 'file real/b.txt', 'folder real', 'link dangling', 'link f', 'link j']);
  });
});
