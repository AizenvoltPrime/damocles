import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { rgPath } from '@vscode/ripgrep';
import { runProcess } from '../../../process-launcher';
import { GlobSyntaxError, overrideRules } from '../rg-ignore';
import { insideGitRepo, walkFiles, walkTree } from '../search-walk';

// Parity with rg 15's own walk (`rg --files --hidden`), the walk Grep and Glob ran before they walked themselves: each case lists
// a fixture tree with real rg and with walkFiles and requires the same files. Entries inside a `.git` folder are left out of
// rg's list, since the walk skips that folder.

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

const insideGitFolder = (file: string): boolean => file.split('/').slice(0, -1).includes('.git');

async function rgFiles(root: string, globs: readonly string[] = [], requireGit = true): Promise<string[]> {
  const args = ['--no-config', '--files', '--hidden', ...(requireGit ? [] : ['--no-require-git']), ...globs.flatMap((glob) => ['--glob', glob]), '--', '.'];
  const { exit, stdout, stderr } = await runProcess({ file: rgPath, args, cwd: root, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  if (exit?.code !== 0 && exit?.code !== 1) throw new Error(`rg exited ${exit?.code}: ${stderr.toString()}`);
  return stdout.toString('utf8').split('\n').filter(Boolean).map((line) => line.replace(/^\.[\\/]/, '').replaceAll('\\', '/')).filter((file) => !insideGitFolder(file)).sort();
}

async function walked(root: string, globs: readonly string[] = [], requireGit = true): Promise<string[]> {
  const files: string[] = [];
  const walk = walkFiles({ root, requireGit, overrides: overrideRules(globs), allowedHosts: noHosts, signal: undefined });
  for await (const file of walk.files) files.push(file.replaceAll('\\', '/'));
  expect(walk.errors).toEqual([]);
  return files.sort();
}

async function parity(root: string, globs: readonly string[] = [], requireGit = true): Promise<string[]> {
  const expected = await rgFiles(root, globs, requireGit);
  expect(await walked(root, globs, requireGit), `globs ${JSON.stringify(globs)}, requireGit ${requireGit}`).toEqual(expected);
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

  it('BOM, CRLF and a line that is not UTF-8, which ends the file', async () => {
    const gitignore = Buffer.concat([Buffer.from('\uFEFF*.bom\r\n*.crlf\r\n'), Buffer.from([0x78, 0xff, 0x0a]), Buffer.from('*.after\n')]);
    await parity(tree({ '.git/': '', '.gitignore': gitignore, 'a.bom': '', 'a.crlf': '', 'a.after': '', 'a.txt': '' }));
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
      const early = walkFiles({ root, requireGit: true, overrides: overrideRules([]), allowedHosts: noHosts, signal: undefined });
      // a's listing is awaited while y's, read ahead, fails
      for (let next = await early.files.next(); next.value !== path.join('a', 'f.txt'); next = await early.files.next()) expect(next.done).toBe(false);
      await early.files.return();
      const full = walkFiles({ root, requireGit: true, overrides: overrideRules([]), allowedHosts: noHosts, signal: undefined });
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
