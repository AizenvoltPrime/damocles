import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { rgPath } from '@vscode/ripgrep';
import { runProcess } from '../../process-launcher';
import { ALL_IGNORE_FILES, GlobSyntaxError, insideGitRepo, overrideRules, walkFiles, walkTree, type WalkIgnore } from '..';

// Parity with rg 15's own walk (`rg --files --hidden`), the walk Grep and Glob ran before they walked themselves: each case lists
// a fixture tree with real rg and with walkFiles and requires the same files. Unless the walk lists `.git` folders, entries
// inside one are left out of rg's list.

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
}

async function rgFiles(root: string, globs: readonly string[] = [], requireGit = true, { ignore = ALL_IGNORE_FILES, gitFolders = 'skip' }: Switches = {}): Promise<string[]> {
  const args = ['--no-config', '--files', '--hidden', ...(requireGit ? [] : ['--no-require-git']), ...rgIgnoreArgs(ignore), ...globs.flatMap((glob) => ['--glob', glob]), '--', '.'];
  const { exit, stdout, stderr } = await runProcess({ file: rgPath, args, cwd: root, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  if (exit?.code !== 0 && exit?.code !== 1) throw new Error(`rg exited ${exit?.code}: ${stderr.toString()}`);
  return stdout.toString('utf8').split('\n').filter(Boolean).map((line) => line.replace(/^\.[\\/]/, '').replaceAll('\\', '/')).filter((file) => gitFolders === 'list' || !insideGitFolder(file)).sort();
}

async function walked(root: string, globs: readonly string[] = [], requireGit = true, { ignore = ALL_IGNORE_FILES, gitFolders = 'skip' }: Switches = {}): Promise<string[]> {
  const files: string[] = [];
  const walk = walkFiles({ root, requireGit, ignore, gitFolders, overrides: overrideRules(globs), allowedHosts: noHosts, signal: undefined });
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
