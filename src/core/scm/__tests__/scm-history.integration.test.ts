import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGitRunner } from '../git-runner';
import { parseGitVersion } from '../git-version';
import { GitUntrustedError } from '../errors';
import { loadHistory } from '../history';
import { Repository } from '../repository';
import type { ScmEvent } from '../scm-service';
import { folder, git, GIT_PATH, harness, HAS_GIT, makeRepo, ready, sandbox, statusOf, useGitSandbox, waitFor, write, type Harness } from './git-harness';

/** The Graph's history (slice 13) against real repositories: paging, counts, the base ref, details and cherry-pick. */
useGitSandbox();

function commit(repo: string, file: string, text: string, message: string): string {
  write(path.join(repo, file), text);
  git(['add', '.'], repo);
  git(['commit', '--quiet', '-m', message], repo);
  return git(['rev-parse', 'HEAD'], repo).trim();
}

function bare(name: string): string {
  const dir = path.join(folder(`${name}-root`), `${name}.git`);
  git(['init', '--quiet', '--bare', '-b', 'main', dir], sandbox);
  return dir;
}

async function open(project: string): Promise<{ h: Harness; repoId: string }> {
  const h = harness({ trusted: [project] });
  h.service.setProjects([{ key: 'p', path: project }]);
  const repoId = (await ready(h)).repos[0]!.repoId;
  await waitFor(() => statusOf(h, repoId), 'a first status');
  return { h, repoId };
}

async function loadAll(h: Harness, repoId: string, choice: Parameters<Harness['service']['historyLoad']>[1]) {
  const first = await h.service.historyLoad(repoId, choice);
  if (!first) throw new Error('unborn');
  return first;
}

// count commits on main after its tip, in one git fast-import, each changing n.txt; their hashes, oldest first
function commits(repo: string, count: number): string[] {
  const parent = git(['rev-parse', 'HEAD'], repo).trim();
  const stream = Array.from({ length: count }, (_, i) => {
    const text = `${i}\n`;
    return `commit refs/heads/main\nmark :${i + 1}\ncommitter T <t@damocles.invalid> ${1_700_000_000 + i} +0000\ndata ${`c${i}`.length}\nc${i}\n${i === 0 ? `from ${parent}\n` : ''}M 100644 inline n.txt\ndata ${text.length}\n${text}\n`;
  }).join('');
  execFileSync(GIT_PATH!, ['fast-import', '--quiet', '--force'], { cwd: repo, input: stream });
  git(['reset', '--quiet', '--hard', 'main'], repo);
  return git(['rev-list', '--reverse', `${parent}..main`], repo).trim().split('\n');
}

describe.skipIf(!HAS_GIT)('the Graph\'s history', { timeout: 120_000 }, () => {
  it('pages 50 commits at a time from the snapshot the load resolved, so a commit made meanwhile shows in no later page', async () => {
    const repo = makeRepo(folder('paging'));
    const made = [git(['rev-parse', 'HEAD'], repo).trim()];
    made.push(...commits(repo, 119));
    const { h, repoId } = await open(repo);
    const { load, commits: first } = await loadAll(h, repoId, 'auto');
    expect(load.resolvedRefs).toEqual(['refs/heads/main']);
    expect(load.tips).toEqual([made.at(-1)]);
    expect(first.map((entry) => entry.hash)).toEqual(made.slice(-50).reverse());
    expect(first[0]!.refs).toEqual([{ id: 'refs/heads/main', name: 'main', kind: 'branch', current: true }]);
    const later = commit(repo, 'n.txt', 'later\n', 'later');
    const second = await h.service.historyPage(repoId, load.tips, 50, undefined);
    const third = await h.service.historyPage(repoId, load.tips, 100, undefined);
    expect([...first, ...second, ...third].map((entry) => entry.hash)).toEqual([...made].reverse());
    expect(third).toHaveLength(20);
    expect([...second, ...third].some((entry) => entry.hash === later)).toBe(false);
    // a new load sees it
    expect((await loadAll(h, repoId, 'auto')).commits[0]!.hash).toBe(later);
    h.service.dispose();
  });

  it('counts incoming and outgoing commits against the upstream, with their merge base', async () => {
    const origin = bare('counts');
    const work = makeRepo(folder('counts'));
    git(['remote', 'add', 'origin', origin], work);
    git(['push', '--quiet', '-u', 'origin', 'main'], work);
    const base = git(['rev-parse', 'HEAD'], work).trim();
    const other = folder('counts-other');
    git(['clone', '--quiet', origin, other], sandbox);
    git(['config', 'user.email', 'o@damocles.invalid'], other);
    git(['config', 'user.name', 'Other'], other);
    commit(other, 'b.txt', '1\n', 'theirs 1');
    commit(other, 'b.txt', '2\n', 'theirs 2');
    git(['push', '--quiet', 'origin', 'main'], other);
    git(['fetch', '--quiet', 'origin'], work);
    commit(work, 'a.txt', 'mine\n', 'mine');
    const { h, repoId } = await open(work);
    const { load } = await loadAll(h, repoId, 'auto');
    expect(load).toMatchObject({ ahead: 1, behind: 2, mergeBase: base });
    expect(load.headRefs.upstream).toMatchObject({ id: 'refs/remotes/origin/main', name: 'origin/main' });
    expect(load.headRefs.base).toBeUndefined();
    expect(load.resolvedRefs).toEqual(['refs/heads/main', 'refs/remotes/origin/main']);
    // two refs picked, one deleted since: it drops out; every one gone reads as Auto
    git(['branch', 'topic', base], work);
    const picked = await loadAll(h, repoId, ['refs/heads/topic', 'refs/heads/gone']);
    expect(picked.load.resolvedRefs).toEqual(['refs/heads/topic']);
    expect((await loadAll(h, repoId, ['refs/heads/gone'])).load.resolvedRefs).toEqual(load.resolvedRefs);
    // All: every branch, remote branch and tag, never a remote's HEAD
    git(['tag', 'v1', base], work);
    git(['remote', 'set-head', 'origin', 'main'], work);
    expect([...(await loadAll(h, repoId, 'all')).load.resolvedRefs].sort()).toEqual(['refs/heads/main', 'refs/heads/topic', 'refs/remotes/origin/main', 'refs/tags/v1']);
    h.service.dispose();
  });

  it('reads the base ref from branch.<name>.vscode-merge-base, else the reflog, never writing the config, and shows it only when it differs from the upstream', async () => {
    const origin = bare('base');
    const work = makeRepo(folder('base'));
    git(['remote', 'add', 'origin', origin], work);
    git(['push', '--quiet', '-u', 'origin', 'main'], work);
    git(['push', '--quiet', 'origin', 'main:dev'], work);
    git(['fetch', '--quiet', 'origin'], work);
    git(['checkout', '--quiet', '-b', 'topic', 'origin/dev', '--no-track'], work);
    const { h, repoId } = await open(work);
    // the reflog: "branch: Created from origin/dev"
    expect((await loadAll(h, repoId, 'auto')).load.headRefs.base).toMatchObject({ id: 'refs/remotes/origin/dev', name: 'origin/dev' });
    git(['config', 'branch.topic.vscode-merge-base', 'origin/main'], work);
    const { load } = await loadAll(h, repoId, 'auto');
    expect(load.headRefs.base).toMatchObject({ id: 'refs/remotes/origin/main' });
    expect(load.resolvedRefs).toEqual(['refs/heads/topic', 'refs/remotes/origin/main']);
    const configs = (): string => git(['config', '--get-regexp', 'vscode-merge-base'], work);
    expect(configs().trim()).toBe('branch.topic.vscode-merge-base origin/main');
    git(['config', '--unset', 'branch.topic.vscode-merge-base'], work);
    await loadAll(h, repoId, 'auto');
    expect(() => configs()).toThrow();
    // a base equal to the upstream is not shown
    git(['branch', '--quiet', '--set-upstream-to', 'origin/dev'], work);
    expect((await loadAll(h, repoId, 'auto')).load.headRefs).toMatchObject({ upstream: { id: 'refs/remotes/origin/dev' } });
    expect((await loadAll(h, repoId, 'auto')).load.headRefs.base).toBeUndefined();
    h.service.dispose();
  });

  it('shows HEAD\'s commit alone for a detached HEAD, and nothing for an unborn one', async () => {
    const repo = makeRepo(folder('detached'));
    const first = git(['rev-parse', 'HEAD'], repo).trim();
    commit(repo, 'b.txt', 'b\n', 'second');
    git(['checkout', '--quiet', '--detach', first], repo);
    const { h, repoId } = await open(repo);
    const { load, commits } = await loadAll(h, repoId, 'auto');
    expect(load.headRefs).toEqual({ head: { id: 'HEAD', name: first.slice(0, 7), revision: first } });
    expect(load.resolvedRefs).toEqual(['HEAD']);
    expect(commits.map((entry) => entry.hash)).toEqual([first]);
    expect(commits[0]!.refs).toEqual([{ id: 'HEAD', name: 'HEAD', kind: 'head', current: true }]);
    // All holds a detached HEAD no ref reaches, as git's --all does, so Go to Current finds it
    const lone = commit(repo, 'c.txt', 'c\n', 'on the detached HEAD');
    const all = await loadAll(h, repoId, 'all');
    expect(all.load.resolvedRefs[0]).toBe('HEAD');
    expect(all.load.tips).toContain(lone);
    expect(all.commits.map((entry) => entry.hash)).toContain(lone);
    h.service.dispose();
    const unborn = folder('unborn');
    git(['init', '--quiet', '-b', 'main', unborn], sandbox);
    const empty = await open(unborn);
    expect(await empty.h.service.historyLoad(empty.repoId, 'auto')).toBeUndefined();
    empty.h.service.dispose();
  });

  it('reads a shallow clone\'s boundary commit without parents, and a SHA-256 repository\'s 64-hex names', async () => {
    const source = makeRepo(folder('shallow-source'));
    commit(source, 'b.txt', 'b\n', 'second');
    const shallow = path.join(folder('shallow'), 'clone');
    git(['clone', '--quiet', '--depth', '1', `file://${source.replace(/\\/g, '/')}`, shallow], sandbox);
    const { h, repoId } = await open(fs.realpathSync.native(shallow));
    const { commits, load } = await loadAll(h, repoId, 'auto');
    expect(commits).toHaveLength(1);
    expect(commits[0]!.parents).toEqual([]);
    expect(load.mergeBase).toBe(commits[0]!.hash);
    h.service.dispose();
    const sha256 = folder('sha256');
    git(['init', '--quiet', '--object-format=sha256', '-b', 'main', sha256], sandbox);
    git(['config', 'user.email', 't@damocles.invalid'], sha256);
    git(['config', 'user.name', 'T'], sha256);
    const root = commit(sha256, 'a.txt', 'a\n', 'root');
    const tip = commit(sha256, 'a.txt', 'b\n', 'tip');
    const long = await open(sha256);
    const read = await loadAll(long.h, long.repoId, 'auto');
    expect(read.commits.map((entry) => [entry.hash, entry.parents])).toEqual([[tip, [root]], [root, []]]);
    expect(tip).toHaveLength(64);
    long.h.service.dispose();
  });

  it('reads a commit\'s message, stat and files against its first parent, a root commit against the empty tree', async () => {
    const repo = makeRepo(folder('details'));
    const root = git(['rev-parse', 'HEAD'], repo).trim();
    write(path.join(repo, 'b.txt'), 'one\ntwo\n');
    git(['mv', 'a.txt', 'renamed.txt'], repo);
    git(['add', '.'], repo);
    git(['commit', '--quiet', '-m', 'Subject line', '-m', 'Body paragraph.'], repo);
    const second = git(['rev-parse', 'HEAD'], repo).trim();
    const { h, repoId } = await open(repo);
    expect(await h.service.commitDetails(repoId, root)).toMatchObject({ hash: root, parents: [], message: 'first', messageTruncated: false, author: 'Seed', stat: { files: 1, insertions: 1, deletions: 0 }, files: [{ path: 'a.txt', status: 'A' }], filesTruncated: false });
    const details = await h.service.commitDetails(repoId, second);
    expect(details).toMatchObject({ parents: [root], message: 'Subject line\n\nBody paragraph.', author: 'Damocles Tests', email: 'tests@damocles.invalid', stat: { files: 2, insertions: 2, deletions: 0 } });
    expect([...details.files].sort((a, b) => a.path.localeCompare(b.path))).toEqual([{ path: 'b.txt', status: 'A' }, { path: 'renamed.txt', oldPath: 'a.txt', status: 'R' }]);
    // log.showSignature=true would otherwise run gpg for the stat of every expanded commit
    const stats = h.log.filter((line) => line.includes('--shortstat'));
    expect(stats.length).toBeGreaterThan(0);
    for (const line of stats) expect(line).toContain('--no-show-signature');
    expect(await h.service.commitMessage(repoId, second)).toBe('Subject line\n\nBody paragraph.');
    // a tree is an object of the repository but no commit
    const tree = git(['rev-parse', `${second}^{tree}`], repo).trim();
    expect(await h.service.isCommit(repoId, tree)).toBe(false);
    expect(await h.service.isCommit(repoId, second)).toBe(true);
    expect(await h.service.isCommit(repoId, 'f'.repeat(40))).toBe(false);
    expect(await h.service.resolveTypedCommit(repoId, 'HEAD~1')).toBe(root);
    expect(await h.service.resolveTypedCommit(repoId, '--output=x')).toBeUndefined();
    expect(await h.service.resolveTypedCommit(repoId, 'nope')).toBeUndefined();
    h.service.dispose();
  });

  it('cherry-picks a commit cleanly, stops on a conflict with the cherry-pick in progress, and aborts an empty one', async () => {
    const repo = makeRepo(folder('pick'));
    git(['checkout', '--quiet', '-b', 'side'], repo);
    const clean = commit(repo, 'side.txt', 'side\n', 'side file');
    const conflicting = commit(repo, 'a.txt', 'theirs\n', 'side edit');
    git(['checkout', '--quiet', 'main'], repo);
    commit(repo, 'a.txt', 'ours\n', 'main edit');
    const { h, repoId } = await open(repo);
    expect(await h.service.cherryPick(repoId, clean)).toBe('ok');
    expect(git(['log', '-1', '--format=%s'], repo).trim()).toBe('side file');
    // the same changes again are already present
    expect(await h.service.cherryPick(repoId, clean)).toBe('empty');
    expect(fs.existsSync(path.join(repo, '.git', 'CHERRY_PICK_HEAD'))).toBe(false);
    expect(statusOf(h, repoId)?.operation).toBeNull();
    expect(await h.service.cherryPick(repoId, conflicting)).toBe('conflict');
    expect(statusOf(h, repoId)?.operation).toBe('cherryPick');
    expect(statusOf(h, repoId)?.groups.merge.map((change) => change.path)).toEqual(['a.txt']);
    await h.service.abortOperation(repoId);
    // a merge commit without -m is refused before git changes anything
    git(['checkout', '--quiet', '-b', 'merged', 'side'], repo);
    git(['merge', '--quiet', '--no-ff', '-m', 'merge', 'main', '-X', 'ours'], repo);
    const merge = git(['rev-parse', 'HEAD'], repo).trim();
    git(['checkout', '--quiet', 'main'], repo);
    await expect(h.service.cherryPick(repoId, merge)).rejects.toThrow();
    expect(fs.existsSync(path.join(repo, '.git', 'CHERRY_PICK_HEAD'))).toBe(false);
    h.service.dispose();
  });

  it('refuses a cherry-pick while the user\'s own cherry-pick sequence is stopped, leaving HEAD and the sequence as they were', async () => {
    const repo = makeRepo(folder('pick-busy'));
    git(['checkout', '--quiet', '-b', 'side'], repo);
    const first = commit(repo, 'side.txt', 'side\n', 'side file');
    const second = commit(repo, 'a.txt', 'theirs\n', 'side edit');
    git(['checkout', '--quiet', 'main'], repo);
    commit(repo, 'a.txt', 'ours\n', 'main edit');
    expect(() => git(['cherry-pick', first, second], repo)).toThrow();
    // resolved to ours: nothing unmerged and nothing staged, the state an empty pick would leave
    git(['checkout', '--ours', '--', 'a.txt'], repo);
    git(['add', 'a.txt'], repo);
    const head = git(['rev-parse', 'HEAD'], repo).trim();
    const picking = fs.readFileSync(path.join(repo, '.git', 'CHERRY_PICK_HEAD'), 'utf8');
    expect(fs.existsSync(path.join(repo, '.git', 'sequencer'))).toBe(true);
    const { h, repoId } = await open(repo);
    const events: ScmEvent[] = [];
    h.service.onDidChange((event) => void events.push(event));
    await expect(h.service.cherryPick(repoId, first)).rejects.toThrow('in progress');
    // git never ran, so no ref moved and the Graph is told nothing
    expect(events.filter((event) => event.kind === 'artifacts')).toEqual([]);
    expect(git(['rev-parse', 'HEAD'], repo).trim()).toBe(head);
    expect(git(['log', '-1', '--format=%s'], repo).trim()).toBe('side file');
    expect(fs.readFileSync(path.join(repo, '.git', 'CHERRY_PICK_HEAD'), 'utf8')).toBe(picking);
    expect(fs.existsSync(path.join(repo, '.git', 'sequencer'))).toBe(true);
    h.service.dispose();
  });

  it('reads no merge base for an upstream with an unrelated history, and still counts both sides', async () => {
    const work = makeRepo(folder('unrelated'));
    // its own root, which a seed commit made in the same second as work's would not be
    const other = folder('unrelated-other');
    git(['init', '--quiet', '-b', 'main', other], sandbox);
    git(['config', 'user.email', 'o@damocles.invalid'], other);
    git(['config', 'user.name', 'Other'], other);
    commit(other, 'c.txt', 'c\n', 'their root');
    commit(other, 'b.txt', 'b\n', 'theirs');
    git(['remote', 'add', 'origin', other], work);
    git(['fetch', '--quiet', 'origin'], work);
    git(['branch', '--quiet', '--set-upstream-to', 'origin/main'], work);
    const { h, repoId } = await open(work);
    const { load } = await loadAll(h, repoId, 'auto');
    expect(load.mergeBase).toBeUndefined();
    expect(load).toMatchObject({ ahead: 1, behind: 2 });
    h.service.dispose();
  });

  it('runs no git in an untrusted project: no repository opens, and a repository whose project is untrusted refuses before spawning', async () => {
    const repo = makeRepo(folder('untrusted'));
    const h = harness({ trusted: [] });
    h.service.setProjects([{ key: 'p', path: repo }]);
    await waitFor(() => h.service.view('p')?.state === 'untrusted', 'the untrusted state');
    expect(h.service.view('p')!.repos).toEqual([]);
    await expect(h.service.historyLoad('repo-1', 'auto')).rejects.toThrow('Unknown repository');
    h.service.dispose();
    const log: string[] = [];
    const runner = createGitRunner({ git: { path: GIT_PATH!, version: parseGitVersion(git(['--version'], sandbox))! }, log: { appendLine: (line) => log.push(line) }, isTrusted: () => false });
    const repository = new Repository({ root: repo, gitDir: path.join(repo, '.git'), commonDir: path.join(repo, '.git'), kind: 'root', project: repo }, runner);
    await expect(loadHistory(repository, 'all', (line) => log.push(line))).rejects.toBeInstanceOf(GitUntrustedError);
    expect(log).toEqual([]);
    repository.dispose();
    expect(h.log).toEqual([]);
  });
});
