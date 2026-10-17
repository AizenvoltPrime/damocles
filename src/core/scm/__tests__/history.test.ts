import { describe, expect, it } from 'vitest';
import { GitOutputTooLargeError, GitUntrustedError, type GitResult } from '../git-runner';
import { parseDecorations, parseHistory, parseShortStat, readHeadRefs, resolveBaseRef } from '../history';
import type { Repository } from '../repository';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const LONG = 'e'.repeat(64);

// One commit as `log -z --format=HISTORY_FORMAT` prints it.
const record = (hash: string, parents: string, decorations: string, subject = 'subject', author = 'Ann Author', email = 'ann@example.com', time = '1700000000'): string =>
  [hash, parents, author, email, time, decorations, subject].join('\0');

describe('parseHistory', () => {
  it('reads seven NUL-separated fields per commit and a NUL between commits', () => {
    const output = [record(A, B, 'HEAD -> refs/heads/main', 'second, with: punctuation'), record(B, '', '', 'first')].join('\0');
    expect(parseHistory(output)).toEqual([
      { hash: A, parents: [B], author: 'Ann Author', email: 'ann@example.com', authorDate: 1_700_000_000_000, subject: 'second, with: punctuation', refs: [{ id: 'refs/heads/main', name: 'main', kind: 'branch', current: true }] },
      { hash: B, parents: [], author: 'Ann Author', email: 'ann@example.com', authorDate: 1_700_000_000_000, subject: 'first', refs: [] },
    ]);
  });

  it('keeps an octopus merge\'s parents in order and accepts 64-hex object names', () => {
    expect(parseHistory(record(A, `${B} ${C} ${D}`, ''))[0]!.parents).toEqual([B, C, D]);
    const [sha256] = parseHistory(record(LONG, A.repeat(1).padEnd(64, 'a'), 'refs/heads/main'));
    expect(sha256).toMatchObject({ hash: LONG, parents: ['a'.repeat(64)], refs: [{ id: 'refs/heads/main', kind: 'branch', current: false }] });
  });

  it('reads a grafted root (a shallow clone\'s boundary) as a commit without parents and no grafted badge', () => {
    expect(parseHistory(record(A, '', 'grafted, HEAD -> refs/heads/main'))[0]).toMatchObject({ parents: [], refs: [{ id: 'refs/heads/main', current: true }] });
  });

  it('throws on a record that does not line up, so a stray field never shifts the rest or ends paging quietly', () => {
    expect(() => parseHistory([record(A, B, ''), record('not-a-hash', '', ''), record(B, '', '')].join('\0'))).toThrow('does not line up');
    expect(() => parseHistory(record(A, 'HEAD', ''))).toThrow('does not line up');
    expect(() => parseHistory(record(A, B, '', 's', 'a', 'e', 'soon'))).toThrow('does not line up');
    expect(parseHistory('')).toEqual([]);
  });
});

describe('parseDecorations', () => {
  it('reads HEAD\'s branch, a detached HEAD, branches, remote branches and tags, and marks the base ref', () => {
    expect(parseDecorations('HEAD -> refs/heads/main, tag: refs/tags/v1.0, refs/remotes/origin/main, refs/remotes/origin/HEAD, refs/heads/feat/a, refs/remotes/up/main', 'refs/remotes/up/main')).toEqual([
      { id: 'refs/heads/main', name: 'main', kind: 'branch', current: true },
      { id: 'refs/tags/v1.0', name: 'v1.0', kind: 'tag', current: false },
      { id: 'refs/remotes/origin/main', name: 'origin/main', kind: 'remote', current: false },
      { id: 'refs/heads/feat/a', name: 'feat/a', kind: 'branch', current: false },
      { id: 'refs/remotes/up/main', name: 'up/main', kind: 'base', current: false },
    ]);
    expect(parseDecorations('HEAD, refs/heads/topic')).toEqual([
      { id: 'HEAD', name: 'HEAD', kind: 'head', current: true },
      { id: 'refs/heads/topic', name: 'topic', kind: 'branch', current: false },
    ]);
    expect(parseDecorations('refs/stash, replaced, grafted')).toEqual([]);
    expect(parseDecorations('')).toEqual([]);
  });
});

describe('parseShortStat', () => {
  it('reads files, insertions and deletions, any of the last two absent', () => {
    expect(parseShortStat(' 3 files changed, 10 insertions(+), 2 deletions(-)\n')).toEqual({ files: 3, insertions: 10, deletions: 2 });
    expect(parseShortStat(' 1 file changed, 1 insertion(+)\n')).toEqual({ files: 1, insertions: 1, deletions: 0 });
    expect(parseShortStat(' 1 file changed, 4 deletions(-)\n')).toEqual({ files: 1, insertions: 0, deletions: 4 });
    expect(parseShortStat('')).toEqual({ files: 0, insertions: 0, deletions: 0 });
  });
});

// A repository's refs, upstreams, config, reflogs, remotes and symbolic refs, answered as git prints them.
interface Model {
  readonly refs: Readonly<Record<string, string>>;
  readonly upstreams?: Readonly<Record<string, string>>;
  readonly mergeBaseConfig?: string;
  readonly reflogs?: Readonly<Record<string, readonly string[]>>;
  readonly remotes?: readonly string[];
  readonly symrefs?: Readonly<Record<string, string>>;
}

function fakeRepo(model: Model): Repository & { readonly calls: string[][] } {
  const calls: string[][] = [];
  const ok = (stdout: string, exitCode = 0): GitResult => ({ exitCode, stdout: Buffer.from(stdout), stderr: '' } as GitResult);
  const read = async (args: readonly string[]): Promise<GitResult> => {
    calls.push([...args]);
    const patterns = args.filter((arg) => arg.startsWith('refs/') || arg === 'HEAD');
    if (args[0] === 'config') return model.mergeBaseConfig === undefined ? ok('', 1) : ok(`${model.mergeBaseConfig}\n`);
    if (args[0] === 'remote') return ok((model.remotes ?? []).map((name) => `${name}\n`).join(''));
    if (args[0] === 'log') return ok((model.reflogs?.[patterns[0]!] ?? []).map((line) => `${line}\n`).join(''));
    if (args[0] === 'for-each-ref') {
      const format = args.find((arg) => arg.startsWith('--format='))!;
      const lines = Object.entries(model.refs).filter(([ref]) => patterns.some((pattern) => ref === pattern || ref.startsWith(`${pattern}/`)));
      if (format.includes('%(symref)')) return ok(lines.map(([ref]) => `${ref}\0${model.symrefs?.[ref] ?? ''}\n`).join(''));
      if (format.includes('%(upstream)')) return ok(lines.map(([ref]) => `${ref}\0${model.upstreams?.[ref] ?? ''}\n`).join(''));
      return ok(lines.map(([ref, hash]) => `${ref}\0commit\0${hash}\0\0\n`).join(''));
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  return { read, endOfOptions: () => ['--end-of-options'], calls } as unknown as Repository & { readonly calls: string[][] };
}

describe('resolveBaseRef', () => {
  const refs = {
    'refs/heads/topic': A,
    'refs/heads/feat': B,
    'refs/remotes/origin/main': C,
    'refs/remotes/origin/HEAD': C,
    'refs/remotes/origin/dev': D,
    'refs/remotes/origin/feat': B,
    'refs/remotes/up/main': D,
    'refs/remotes/up/HEAD': D,
  };
  const symrefs = { 'refs/remotes/origin/HEAD': 'refs/remotes/origin/main', 'refs/remotes/up/HEAD': 'refs/remotes/up/main' };
  const remotes = ['origin', 'up'];

  it('takes branch.<name>.vscode-merge-base first when it names a remote branch that exists', async () => {
    const repo = fakeRepo({ refs, symrefs, remotes, mergeBaseConfig: 'origin/dev', reflogs: { 'refs/heads/topic': ['branch: Created from feat'] } });
    expect(await resolveBaseRef(repo, 'topic', undefined)).toBe('refs/remotes/origin/dev');
    // the config is read, never written
    expect(repo.calls.filter((call) => call[0] === 'config')).toEqual([['config', '--get', 'branch.topic.vscode-merge-base']]);
  });

  it('ignores a configured local branch or a gone remote branch, and takes the reflog\'s "Created from" next', async () => {
    for (const mergeBaseConfig of ['feat', 'origin/gone']) {
      const repo = fakeRepo({ refs, symrefs, remotes, mergeBaseConfig, upstreams: { 'refs/heads/feat': 'refs/remotes/origin/feat' }, reflogs: { 'refs/heads/topic': ['commit: work', 'branch: Created from origin/dev'] } });
      expect(await resolveBaseRef(repo, 'topic', undefined)).toBe('refs/remotes/origin/dev');
    }
  });

  it('follows a local branch the reflog names to its upstream, and a branch created from HEAD to HEAD\'s checkout entry', async () => {
    const upstreams = { 'refs/heads/feat': 'refs/remotes/origin/feat' };
    expect(await resolveBaseRef(fakeRepo({ refs, symrefs, remotes, upstreams, reflogs: { 'refs/heads/topic': ['branch: Created from feat'] } }), 'topic', undefined)).toBe('refs/remotes/origin/feat');
    const fromHead = fakeRepo({
      refs,
      symrefs,
      remotes,
      upstreams,
      reflogs: {
        'refs/heads/topic': ['branch: Created from HEAD'],
        // newest first: the oldest checkout onto topic names where it started
        HEAD: ['checkout: moving from topic to main', 'checkout: moving from main to topic', 'checkout: moving from feat to topic', 'commit: x'],
      },
    });
    expect(await resolveBaseRef(fromHead, 'topic', undefined)).toBe('refs/remotes/origin/feat');
  });

  it('falls back to what the upstream remote\'s HEAD points to, else origin\'s, when the reflog says nothing usable', async () => {
    const twice = { 'refs/heads/topic': ['branch: Created from origin/dev', 'branch: Created from origin/main'] };
    expect(await resolveBaseRef(fakeRepo({ refs, symrefs, remotes, reflogs: twice }), 'topic', 'refs/remotes/up/topic')).toBe('refs/remotes/up/main');
    expect(await resolveBaseRef(fakeRepo({ refs, symrefs, remotes }), 'topic', undefined)).toBe('refs/remotes/origin/main');
    // a local branch created from with no upstream gives no base
    expect(await resolveBaseRef(fakeRepo({ refs, symrefs: {}, remotes, reflogs: { 'refs/heads/topic': ['branch: Created from feat'] } }), 'topic', undefined)).toBeUndefined();
    expect(await resolveBaseRef(fakeRepo({ refs, remotes: [] }), 'topic', undefined)).toBeUndefined();
  });
});

describe('readHeadRefs', () => {
  // HEAD on topic at A with origin/topic as its upstream; the reflog read answers as failing says
  const repoWith = (failing: Error) => {
    const ok = (stdout: string, exitCode = 0): GitResult => ({ exitCode, stdout: Buffer.from(stdout), stderr: '' } as GitResult);
    const read = async (args: readonly string[]): Promise<GitResult> => {
      if (args[0] === 'rev-parse') return ok(`${A}\n`);
      if (args[0] === 'symbolic-ref') return ok('refs/heads/topic\n');
      if (args[0] === 'config') return ok('', 1);
      if (args[0] === 'log') throw failing;
      if (args[0] === 'for-each-ref') {
        const format = args.find((arg) => arg.startsWith('--format='))!;
        const ref = args.at(-1)!;
        if (format.includes('%(upstream)')) return ok(ref === 'refs/heads/topic' ? 'refs/heads/topic\0refs/remotes/origin/topic\n' : '');
        return ok(ref === 'refs/remotes/origin/topic' ? `${ref}\0commit\0${B}\0\0\n` : '');
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    };
    return { read, endOfOptions: () => ['--end-of-options'] } as unknown as Repository;
  };

  it('leaves out a base ref whose reflog cannot be read, logging why, and keeps HEAD and its upstream', async () => {
    const log: string[] = [];
    const refs = await readHeadRefs(repoWith(new GitOutputTooLargeError(16 * 1024 * 1024)), (line) => log.push(line));
    expect(refs).toEqual({ head: { id: 'refs/heads/topic', name: 'topic', revision: A }, upstream: { id: 'refs/remotes/origin/topic', name: 'origin/topic', revision: B } });
    expect(log).toHaveLength(1);
    expect(log[0]).toContain('the base ref of topic could not be read');
  });

  it('still fails the load when git stops running there, which no base ref explains', async () => {
    const log: string[] = [];
    await expect(readHeadRefs(repoWith(new GitUntrustedError()), (line) => log.push(line))).rejects.toBeInstanceOf(GitUntrustedError);
    expect(log).toEqual([]);
  });
});
