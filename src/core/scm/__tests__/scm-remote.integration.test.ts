import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startGitHttpServer, type GitHttpServer } from './git-http-server';
import { createAskpassServer, type AskpassServer, type CredentialPrompt } from '../askpass/askpass-server';
import { createGitRunner, GitError, GitQueueDisposedError, GitUntrustedError, parseGitVersion, type GitCall } from '../git-runner';
import { gitErrorText, PLAIN_VARIANT, RemoteCancelledError, StashKeptError, SyncBranchChangedError } from '../scm-service';
import { SCM_SETTING_KEYS } from '../settings-keys';
import { folder, freshStatus, git, GIT_PATH, harness, HAS_GIT, makeRepo, ready, sandbox, statusOf, unremovable, useGitSandbox, viewOf, waitFor, write, type Harness } from './git-harness';

/** Remotes, fetch, pull, push, sync and clone against bare repositories and a local git http-backend, with real git. */
useGitSandbox();

// git against this process's own http server, which a synchronous spawn would block from answering
const gitAsync = (args: string[], cwd: string): Promise<unknown> => promisify(execFile)(GIT_PATH!, args, { cwd });

const USER = 'ada';
const PASSWORD = 'sentinel-password-9271';

function bare(name: string): string {
  const dir = path.join(folder(`${name}-root`), `${name}.git`);
  git(['init', '--quiet', '--bare', '-b', 'main', dir], sandbox);
  return dir;
}

// A work tree whose main tracks origin/main of a fresh bare repository holding its first commit.
function tracked(name: string): { work: string; origin: string } {
  const origin = bare(name);
  const work = makeRepo(folder(name));
  git(['remote', 'add', 'origin', origin], work);
  git(['push', '--quiet', '-u', 'origin', 'main'], work);
  return { work, origin };
}

// A commit made by someone else straight into the bare repository, through a second clone.
function commitUpstream(origin: string, file: string, text: string): void {
  const other = folder('other');
  git(['clone', '--quiet', origin, other], sandbox);
  git(['config', 'user.email', 'o@damocles.invalid'], other);
  git(['config', 'user.name', 'Other'], other);
  write(path.join(other, file), text);
  git(['add', '.'], other);
  git(['commit', '--quiet', '-m', `upstream ${file}`], other);
  git(['push', '--quiet', 'origin', 'HEAD:main'], other);
}

async function open(project: string, opts: Parameters<typeof harness>[0] = {}): Promise<{ h: Harness; repoId: string }> {
  const h = harness({ trusted: [project], ...opts });
  h.service.setProjects([{ key: 'p', path: project }]);
  const repoId = (await ready(h)).repos[0]!.repoId;
  await waitFor(() => statusOf(h, repoId), 'a first status');
  return { h, repoId };
}

const log = (h: Harness): string => [...h.log, ...h.serviceLog].join('\n');

function locks(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }) as string[]).filter((file) => file.endsWith('.lock'));
}

describe.skipIf(!HAS_GIT)('remote operations against bare repositories', { timeout: 120_000 }, () => {
  it('adds and removes a remote, lists only names it can pass on, and refuses a name that is an option', async () => {
    const work = makeRepo(folder('remotes'));
    const origin = bare('remotes');
    git(['config', 'remote.-x.url', origin], work);
    const { h, repoId } = await open(work);
    await h.service.addRemote(repoId, 'origin', origin);
    expect((await freshStatus(h, repoId)).remotes).toEqual(['origin']);
    expect((await h.service.remotes(repoId)).map((remote) => remote.name)).toEqual(['origin']);
    await expect(h.service.addRemote(repoId, '-x', origin)).rejects.toThrow();
    await expect(h.service.addRemote(repoId, 'up', '--upload-pack=touch pwned')).rejects.toThrow();
    expect(git(['config', '--get-regexp', '^remote\\..*\\.url$'], work).split('\n').filter(Boolean)).toHaveLength(2);
    await h.service.removeRemote(repoId, 'origin');
    expect((await freshStatus(h, repoId)).remotes).toEqual([]);
    await expect(h.service.removeRemote(repoId, '-x')).rejects.toThrow();
    h.service.dispose();
  });

  it('fetches, counts the commits behind, prunes on Fetch (Prune) and on every fetch with pruneOnFetch', async () => {
    const { work, origin } = tracked('fetch');
    const { h, repoId } = await open(work);
    expect(statusOf(h, repoId)!.upstream).toEqual({ remote: 'origin', branch: 'main', ahead: 0, behind: 0 });
    commitUpstream(origin, 'b.txt', 'b\n');
    git(['push', '--quiet', 'origin', 'main:gone'], work);
    await h.service.fetch(repoId, {});
    expect((await freshStatus(h, repoId)).upstream).toEqual({ remote: 'origin', branch: 'main', ahead: 0, behind: 1 });
    expect(git(['branch', '-r'], work)).toContain('origin/gone');
    git(['push', '--quiet', 'origin', '--delete', 'gone'], work);
    git(['update-ref', 'refs/remotes/origin/gone', 'HEAD'], work);
    await h.service.fetch(repoId, {});
    expect(git(['branch', '-r'], work)).toContain('origin/gone');
    await h.service.fetch(repoId, { prune: true });
    expect(git(['branch', '-r'], work)).not.toContain('origin/gone');
    git(['update-ref', 'refs/remotes/origin/gone', 'HEAD'], work);
    await h.settings.update(SCM_SETTING_KEYS.pruneOnFetch, true);
    await h.service.fetch(repoId, {});
    expect(git(['branch', '-r'], work)).not.toContain('origin/gone');
    expect(h.log.some((line) => line.includes('> git fetch --prune'))).toBe(true);
    expect(h.service.snapshot(repoId)!.lastRemote).toMatchObject({ op: 'fetch', outcome: 'ok' });
    h.service.dispose();
  });

  it('pulls with a rebase onto the upstream, keeping the local commit on top', async () => {
    const { work, origin } = tracked('rebase');
    commitUpstream(origin, 'b.txt', 'b\n');
    write(path.join(work, 'c.txt'), 'c\n');
    git(['add', '.'], work);
    git(['commit', '--quiet', '-m', 'local'], work);
    const { h, repoId } = await open(work);
    await h.service.pull(repoId, { rebase: true });
    expect(git(['log', '--format=%s', '-3'], work).trim().split('\n')).toEqual(['local', 'upstream b.txt', 'first']);
    expect(git(['rev-list', '--merges', '--count', 'HEAD'], work).trim()).toBe('0');
    expect(h.log.some((line) => line.includes('> git pull -r --end-of-options origin refs/heads/main'))).toBe(true);
    h.service.dispose();
  });

  it('shows git\'s refusal to pull over local changes, and with autoStash stashes, pulls and restores them', async () => {
    const { work, origin } = tracked('autostash');
    commitUpstream(origin, 'a.txt', 'upstream\n');
    const { h, repoId } = await open(work);
    write(path.join(work, 'a.txt'), 'local edit\n');
    await freshStatus(h, repoId);
    const refused = await h.service.pull(repoId, { rebase: false }).then(() => undefined, (err: unknown) => err);
    expect(refused).toBeInstanceOf(GitError);
    expect(gitErrorText(refused)).toMatch(/^error: Your local changes to the following files would be overwritten by merge/);
    expect(fs.readFileSync(path.join(work, 'a.txt'), 'utf8')).toBe('local edit\n');

    const { work: work2, origin: origin2 } = tracked('autostash-on');
    commitUpstream(origin2, 'z.txt', 'z\n');
    const on = await open(work2);
    write(path.join(work2, 'a.txt'), 'local edit\n');
    await freshStatus(on.h, on.repoId);
    await on.h.settings.update(SCM_SETTING_KEYS.autoStash, true);
    await on.h.service.pull(on.repoId, { rebase: false });
    expect(fs.readFileSync(path.join(work2, 'a.txt'), 'utf8')).toBe('local edit\n');
    expect(fs.existsSync(path.join(work2, 'z.txt'))).toBe(true);
    expect(git(['stash', 'list'], work2).trim()).toBe('');
    expect(on.h.log.some((line) => line.includes('> git pull --autostash'))).toBe(true);
    h.service.dispose();
    on.h.service.dispose();
  });

  it('with a git before 2.27, stashes around the pull itself as VS Code does, quietly, and applies back exactly the stash it made', async () => {
    const { work, origin } = tracked('old-git');
    commitUpstream(origin, 'z.txt', 'z\n');
    const oldLog: string[] = [];
    const old = createGitRunner({ git: { path: GIT_PATH!, version: { major: 2, minor: 26, patch: 0 } }, log: { appendLine: (line) => oldLog.push(line) }, isTrusted: () => true });
    const { h, repoId } = await open(work, { runner: old });
    write(path.join(work, 'a.txt'), 'local edit\n');
    await freshStatus(h, repoId);
    await h.settings.update(SCM_SETTING_KEYS.autoStash, true);
    await h.service.pull(repoId, { rebase: false });
    expect(fs.readFileSync(path.join(work, 'a.txt'), 'utf8')).toBe('local edit\n');
    expect(fs.existsSync(path.join(work, 'z.txt'))).toBe(true);
    expect(git(['stash', 'list'], work)).toBe('');
    expect(oldLog.some((line) => line.includes('> git stash push --include-untracked'))).toBe(true);
    expect(oldLog.some((line) => / stash apply --index --quiet (--end-of-options )?[0-9a-f]{40,64} \[/.test(line))).toBe(true);
    expect(oldLog.some((line) => line.includes('> git stash drop --quiet "stash@{0}"'))).toBe(true);
    expect(oldLog.some((line) => line.includes('--autostash') || line.includes('stash pop'))).toBe(false);
    h.service.dispose();
  });

  it('with a git before 2.27, applies no stash when the pull stashed nothing, though the status it last read showed changes', async () => {
    const { work, origin } = tracked('old-git-clean');
    commitUpstream(origin, 'z.txt', 'z\n');
    write(path.join(work, 'a.txt'), 'unrelated\n');
    git(['stash', 'push', '--quiet', '-m', 'unrelated'], work);
    const unrelated = git(['rev-parse', 'refs/stash'], work).trim();
    const old = createGitRunner({ git: { path: GIT_PATH!, version: { major: 2, minor: 26, patch: 0 } }, log: { appendLine: () => undefined }, isTrusted: () => true });
    const { h, repoId } = await open(work, { runner: old });
    write(path.join(work, 'a.txt'), 'gone again\n');
    await freshStatus(h, repoId);
    // the change is gone before the pull runs, while the snapshot still lists it
    write(path.join(work, 'a.txt'), 'one\n');
    await h.settings.update(SCM_SETTING_KEYS.autoStash, true);
    await h.service.pull(repoId, { rebase: false });
    expect(fs.readFileSync(path.join(work, 'a.txt'), 'utf8')).toBe('one\n');
    expect(git(['rev-parse', 'refs/stash'], work).trim()).toBe(unrelated);
    h.service.dispose();
  });

  it('keeps the changes in the stash list and says so when the stash cannot be applied back after the pull', async () => {
    const { work, origin } = tracked('old-git-kept');
    commitUpstream(origin, 'a.txt', 'upstream\n');
    const old = createGitRunner({ git: { path: GIT_PATH!, version: { major: 2, minor: 26, patch: 0 } }, log: { appendLine: () => undefined }, isTrusted: () => true });
    const { h, repoId } = await open(work, { runner: old });
    write(path.join(work, 'a.txt'), 'local edit\n');
    await freshStatus(h, repoId);
    await h.settings.update(SCM_SETTING_KEYS.autoStash, true);
    const kept = await h.service.pull(repoId, { rebase: false }).then(() => undefined, (err: unknown) => err);
    expect(kept).toBeInstanceOf(StashKeptError);
    expect(kept).toMatchObject({ outcome: 'ok', message: 'Your changes were stashed for this operation and could not be applied back, so they are kept in the stash list.' });
    expect(git(['rev-parse', 'refs/stash'], work).trim()).toBe((kept as StashKeptError).stash);
    expect(git(['log', '-1', '--format=%s', 'HEAD'], work).trim()).toBe('upstream a.txt');
    // the pull itself went through; only the changes stashed around it stayed behind
    expect(h.service.snapshot(repoId)!.lastRemote).toMatchObject({ op: 'pull', outcome: 'ok', stashKept: true });
    h.service.dispose();
  });

  it('resolves a commit only once the status shows it, so a push right after it targets the new branch the commit made', async () => {
    const { work, origin } = tracked('commit-push');
    const { h, repoId } = await open(work);
    h.settings.values.set(SCM_SETTING_KEYS.branchProtection, ['main']);
    h.settings.values.set(SCM_SETTING_KEYS.branchProtectionPrompt, 'alwaysCommitToNewBranch');
    write(path.join(work, 'b.txt'), 'b\n');
    git(['add', 'b.txt'], work);
    expect(await h.service.commit(repoId, 'On a new branch', PLAIN_VARIANT, { branchName: async () => 'feature' })).toEqual({ ok: true });
    const status = h.service.snapshot(repoId)!.status!;
    expect(status.head).toEqual({ type: 'branch', name: 'feature' });
    expect(status.commit?.subject).toBe('On a new branch');
    expect(status.upstream).toBeNull();
    await h.service.push(repoId, { remote: 'origin', branch: (status.head as { name: string }).name, setUpstream: true, followTags: false, force: false });
    expect(git(['log', '-1', '--format=%s', 'refs/heads/feature'], origin).trim()).toBe('On a new branch');
    expect(git(['log', '-1', '--format=%s', 'refs/heads/main'], origin).trim()).toBe('first');
    h.service.dispose();
  });

  it('pulls the upstream of the branch checked out when the pull runs, and Sync refuses once the branch is not the one confirmed', async () => {
    const { work, origin } = tracked('fresh-target');
    git(['push', '--quiet', 'origin', 'main:other'], work);
    git(['fetch', '--quiet', 'origin'], work);
    git(['branch', '--quiet', '--track', 'other', 'origin/other'], work);
    const other = folder('fresh-target-other');
    git(['clone', '--quiet', '-b', 'other', origin, other], sandbox);
    write(path.join(other, 'o.txt'), 'o\n');
    git(['add', '.'], other);
    git(['-c', 'user.name=O', '-c', 'user.email=o@d.invalid', 'commit', '--quiet', '-m', 'on other'], other);
    git(['push', '--quiet', 'origin', 'other'], other);
    const { h, repoId } = await open(work);
    h.settings.values.set(SCM_SETTING_KEYS.confirmSync, false);
    expect(statusOf(h, repoId)!.head).toEqual({ type: 'branch', name: 'main' });
    // a terminal checks out another branch; the snapshot still says main
    git(['checkout', '--quiet', 'other'], work);
    await h.service.pull(repoId, { rebase: false });
    expect(h.log.some((line) => line.includes('> git pull --end-of-options origin refs/heads/other'))).toBe(true);
    expect(git(['log', '-1', '--format=%s', 'main'], work).trim()).toBe('first');
    expect(fs.existsSync(path.join(work, 'o.txt'))).toBe(true);
    expect(statusOf(h, repoId)!.head).toEqual({ type: 'branch', name: 'other' });
    git(['checkout', '--quiet', 'main'], work);
    const pulls = h.log.filter((line) => line.includes('> git pull')).length;
    const changed = await h.service.sync(repoId, false).then(() => undefined, (err: unknown) => err);
    expect(changed).toBeInstanceOf(SyncBranchChangedError);
    expect(changed).toMatchObject({ stage: 'pull', confirmed: { branch: 'other', remote: 'origin', upstreamBranch: 'other' }, found: { branch: 'main', remote: 'origin', upstreamBranch: 'main' } });
    expect(h.log.filter((line) => line.includes('> git pull')).length).toBe(pulls);
    expect(h.service.snapshot(repoId)!.lastRemote).toMatchObject({ op: 'sync', outcome: 'failed', stashKept: false });
    h.service.dispose();
  });

  it('pulls and pushes an upstream a pull cannot name as remote and branch as git itself does, never as refs/heads/<its ref>', async () => {
    const { work, origin } = tracked('pull-ref');
    const other = folder('pull-ref-other');
    git(['clone', '--quiet', origin, other], sandbox);
    write(path.join(other, 'pr.txt'), 'pr\n');
    git(['add', '.'], other);
    git(['-c', 'user.name=O', '-c', 'user.email=o@d.invalid', 'commit', '--quiet', '-m', 'pull request'], other);
    git(['push', '--quiet', 'origin', 'HEAD:refs/pull/1/head'], other);
    git(['config', '--add', 'remote.origin.fetch', '+refs/pull/*/head:refs/remotes/origin/pr/*'], work);
    git(['config', 'branch.main.merge', 'refs/pull/1/head'], work);
    git(['fetch', '--quiet', 'origin'], work);
    const { h, repoId } = await open(work);
    h.settings.values.set(SCM_SETTING_KEYS.confirmSync, false);
    expect(statusOf(h, repoId)!.upstream).toEqual({ remote: 'origin', branch: 'refs/pull/1/head', ahead: 0, behind: 1 });
    await h.service.pull(repoId, { rebase: false });
    expect(h.log.some((line) => /^> git pull \[/.test(line))).toBe(true);
    expect(fs.existsSync(path.join(work, 'pr.txt'))).toBe(true);
    write(path.join(work, 'mine.txt'), 'm\n');
    git(['add', '.'], work);
    git(['commit', '--quiet', '-m', 'mine'], work);
    await freshStatus(h, repoId);
    // git's own push refuses an upstream whose name differs from the branch's (push.default simple)
    await expect(h.service.sync(repoId, false)).rejects.toBeInstanceOf(GitError);
    expect(h.log.some((line) => /^> git push \[/.test(line))).toBe(true);
    expect(git(['for-each-ref', '--format=%(refname)', 'refs/heads/refs/'], origin).trim()).toBe('');
    h.service.dispose();
  });

  it('runs a remote operation without askpass when its registration fails, logging one line, and still reports the operation\'s own failure', async () => {
    const { work, origin } = tracked('no-askpass');
    commitUpstream(origin, 'b.txt', 'b\n');
    const calls: GitCall[] = [];
    const version = parseGitVersion(git(['--version'], sandbox))!;
    const base = createGitRunner({ git: { path: GIT_PATH!, version }, log: { appendLine: () => undefined }, isTrusted: () => true });
    const recording = { ...base, run: (call: GitCall) => (calls.push(call), base.run(call)) };
    const broken: AskpassServer = { register: () => Promise.reject(new Error('listen ENAMETOOLONG')), dispose: async () => undefined };
    const { h, repoId } = await open(work, { runner: recording, askpass: broken });
    await h.service.fetch(repoId, {});
    expect((await freshStatus(h, repoId)).upstream).toMatchObject({ behind: 1 });
    expect(h.serviceLog.filter((line) => line.startsWith('[scm] credential prompts are unavailable'))).toEqual(['[scm] credential prompts are unavailable for this fetch: listen ENAMETOOLONG']);
    await expect(h.service.fetch(repoId, { remote: 'missing' })).rejects.toBeInstanceOf(GitError);
    // autofetch never fetches without its background registration, which keeps any askpass from prompting
    const fetches = calls.filter((call) => call.args.includes('fetch')).length;
    h.service.setAutofetchProject('p');
    await waitFor(() => h.serviceLog.includes('[scm] autofetch failed: listen ENAMETOOLONG'), 'the autofetch failure');
    expect(calls.filter((call) => call.args.includes('fetch')).length).toBe(fetches);
    h.service.dispose();
  });

  it('autofetches in English, so a refused credential is told from git\'s words', async () => {
    const { work, origin } = tracked('autofetch-english');
    commitUpstream(origin, 'b.txt', 'b\n');
    const calls: GitCall[] = [];
    const version = parseGitVersion(git(['--version'], sandbox))!;
    const base = createGitRunner({ git: { path: GIT_PATH!, version }, log: { appendLine: () => undefined }, isTrusted: () => true });
    const { h, repoId } = await open(work, { runner: { ...base, run: (call: GitCall) => (calls.push(call), base.run(call)) } });
    h.service.setAutofetchProject('p');
    await waitFor(() => statusOf(h, repoId)?.upstream?.behind === 1, 'the autofetch');
    const background = calls.find((call) => call.args.includes('fetch'))!;
    expect(base.envFor(background)['LC_ALL']).toBe('C');
    h.service.dispose();
  });

  it('autofetches as soon as the selected project\'s repository with a remote has a status, at startup and after a trust grant', async () => {
    const { work, origin } = tracked('autofetch-start');
    commitUpstream(origin, 'up.txt', 'u\n');
    const h = harness({ trusted: [work] });
    h.service.setProjects([{ key: 'p', path: work }]);
    h.service.setAutofetchProject('p');
    const repoId = (await ready(h)).repos[0]!.repoId;
    await waitFor(() => statusOf(h, repoId)?.upstream?.behind === 1, 'the first round at startup');
    h.service.dispose();

    const { work: later, origin: laterOrigin } = tracked('autofetch-grant');
    commitUpstream(laterOrigin, 'up.txt', 'u\n');
    const g = harness();
    g.service.setProjects([{ key: 'p', path: later }]);
    g.service.setAutofetchProject('p');
    await waitFor(() => viewOf(g, 'p').state === 'untrusted', 'the untrusted state');
    g.trust.grant(later);
    const grantedId = (await ready(g)).repos[0]!.repoId;
    await waitFor(() => statusOf(g, grantedId)?.upstream?.behind === 1, 'the first round after the grant');
    g.service.dispose();
  });

  it('pushes to the upstream, pushes annotated tags with Follow Tags, and force pushes only with a lease after the question', async () => {
    const { work, origin } = tracked('push');
    const { h, repoId } = await open(work);
    write(path.join(work, 'b.txt'), 'b\n');
    git(['add', '.'], work);
    git(['commit', '--quiet', '-m', 'second'], work);
    git(['tag', '-a', 'v1', '-m', 'release'], work);
    expect((await freshStatus(h, repoId)).upstream).toMatchObject({ ahead: 1, behind: 0 });
    expect(await h.service.push(repoId, { remote: 'origin', branch: 'main', setUpstream: false, followTags: false, force: false })).toBe(true);
    expect(git(['rev-parse', 'main'], origin).trim()).toBe(git(['rev-parse', 'HEAD'], work).trim());
    expect(git(['tag'], origin).trim()).toBe('');
    await h.service.push(repoId, { setUpstream: false, followTags: true, force: false });
    expect(git(['tag'], origin).trim()).toBe('v1');

    git(['commit', '--quiet', '--amend', '-m', 'second, reworded'], work);
    await freshStatus(h, repoId);
    await expect(h.service.push(repoId, { remote: 'origin', branch: 'main', setUpstream: false, followTags: false, force: true })).rejects.toThrow(/Force push is not allowed/);
    expect(h.questions).toEqual([]);
    await h.settings.update(SCM_SETTING_KEYS.allowForcePush, true);
    h.answers = [undefined];
    expect(await h.service.push(repoId, { remote: 'origin', branch: 'main', setUpstream: false, followTags: false, force: true })).toBe(false);
    expect(h.questions[0]).toMatchObject({ severity: 'danger', actions: ['Force Push'], cancelLabel: 'Cancel' });
    h.answers = [0];
    expect(await h.service.push(repoId, { remote: 'origin', branch: 'main', setUpstream: false, followTags: false, force: true })).toBe(true);
    expect(git(['log', '-1', '--format=%s', 'main'], origin).trim()).toBe('second, reworded');
    const forced = h.log.find((line) => line.includes('> git push --force-with-lease'))!;
    expect(forced).not.toMatch(/ --force( |$)/);
    const version = parseGitVersion(git(['--version'], sandbox))!;
    if (version.major > 2 || version.minor >= 30) expect(forced).toContain('--force-if-includes');
    h.service.dispose();
  });

  it('publishes a branch with -u and syncs: asks first, pulls, then pushes what is ahead', async () => {
    const { work, origin } = tracked('sync');
    git(['checkout', '--quiet', '-b', 'feature'], work);
    const { h, repoId } = await open(work);
    expect(statusOf(h, repoId)!.upstream).toBeNull();
    await h.service.push(repoId, { remote: 'origin', branch: 'feature', setUpstream: true, followTags: false, force: false });
    expect((await freshStatus(h, repoId)).upstream).toEqual({ remote: 'origin', branch: 'feature', ahead: 0, behind: 0 });

    const other = folder('sync-other');
    git(['clone', '--quiet', '-b', 'feature', origin, other], sandbox);
    write(path.join(other, 'theirs.txt'), 't\n');
    git(['add', '.'], other);
    git(['-c', 'user.name=O', '-c', 'user.email=o@d.invalid', 'commit', '--quiet', '-m', 'theirs'], other);
    git(['push', '--quiet', 'origin', 'feature'], other);
    write(path.join(work, 'mine.txt'), 'm\n');
    git(['add', '.'], work);
    git(['commit', '--quiet', '-m', 'mine'], work);
    await freshStatus(h, repoId);
    h.answers = [undefined];
    expect(await h.service.sync(repoId, false)).toBe(false);
    expect(h.questions[0]!.message).toBe('This action will pull and push commits from and to "origin/feature".');
    h.answers = [1];
    expect(await h.service.sync(repoId, true)).toBe(true);
    expect(h.settings.values.get(SCM_SETTING_KEYS.confirmSync)).toBe(false);
    expect(git(['log', '-1', '--format=%s', 'feature'], origin).trim()).toBe('mine');
    expect((await freshStatus(h, repoId)).upstream).toMatchObject({ ahead: 0, behind: 0 });
    expect(h.service.snapshot(repoId)!.lastRemote).toMatchObject({ op: 'sync', outcome: 'ok' });
    h.service.dispose();
  });

  it('clones into a new folder named after the URL, then the next free name', async () => {
    const { origin } = tracked('cloned');
    const parent = folder('clones');
    const h = harness();
    const first = await h.service.clone(origin, parent, false);
    expect(first).toBe(path.join(parent, 'cloned'));
    expect(git(['log', '-1', '--format=%s'], first).trim()).toBe('first');
    expect(await h.service.clone(origin, parent, false)).toBe(path.join(parent, 'cloned-1'));
    // a folder the user trusted once and deleted since is never a clone's target, so the clone never starts trusted
    h.trust.trusted.add(path.join(parent, 'cloned-2').toLowerCase());
    expect(await h.service.clone(origin, parent, false)).toBe(path.join(parent, 'cloned-3'));
    expect(h.service.cloneState()).toMatchObject({ running: null, last: { outcome: 'ok' } });
    expect(h.log.every((line) => !line.includes('protocol.file.allow'))).toBe(true);
    h.service.dispose();
  });

  it('ends a cancelled clone as cancelled when its folder cannot be removed, and logs that', async () => {
    const parent = folder('clone-held');
    let releaseFile: (() => Promise<void>) | undefined;
    const version = parseGitVersion(git(['--version'], sandbox))!;
    const base = createGitRunner({ git: { path: GIT_PATH!, version }, log: { appendLine: () => undefined }, isTrusted: () => true });
    const runner = {
      ...base,
      clone: async (call: { readonly args: readonly string[]; readonly signal: AbortSignal }) => {
        const held = path.join(call.args.at(-1)!, 'held.txt');
        fs.writeFileSync(held, '');
        releaseFile = await unremovable(held);
        return new Promise<never>((_resolve, reject) => call.signal.addEventListener('abort', () => reject(call.signal.reason)));
      },
    };
    const h = harness({ runner });
    const cloned = h.service.clone('https://example.com/held.git', parent, false);
    await waitFor(() => releaseFile, 'the clone started');
    h.service.cancelClone();
    try {
      await expect(cloned).rejects.toBeInstanceOf(RemoteCancelledError);
    } finally {
      await releaseFile!();
    }
    expect(h.serviceLog.some((line) => line.startsWith('[scm] the folder of a cancelled clone was not removed'))).toBe(true);
    expect(h.service.cloneState()).toMatchObject({ running: null, last: { outcome: 'cancelled' } });
    h.service.dispose();
  });
});

describe.skipIf(!HAS_GIT)('remote operations over http with askpass', { timeout: 120_000 }, () => {
  let root: string;
  let server: GitHttpServer;
  let slow: GitHttpServer;
  let open_: GitHttpServer;
  let paths: { askpass: string; sshAskpass: string; node: string; main: string };

  beforeAll(async () => {
    if (!HAS_GIT) return;
    root = folder('http');
    const app = path.join(sandbox, 'askpass-app');
    await build({ entryPoints: [path.resolve(__dirname, '..', '..', '..', 'desktop', 'askpass', 'askpass-main.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node24', outfile: path.join(app, 'askpass-main.js'), logLevel: 'silent' });
    const scripts = path.resolve(__dirname, '..', '..', '..', '..', 'resources', 'askpass');
    for (const name of fs.readdirSync(scripts)) {
      fs.copyFileSync(path.join(scripts, name), path.join(app, name));
      fs.chmodSync(path.join(app, name), 0o755);
    }
    paths = { askpass: path.join(app, 'askpass.sh'), sshAskpass: path.join(app, 'ssh-askpass.sh'), node: process.execPath, main: path.join(app, 'askpass-main.js') };
    server = await startGitHttpServer({ root, user: USER, password: PASSWORD });
    slow = await startGitHttpServer({ root });
    open_ = await startGitHttpServer({ root });
  });

  afterAll(async () => {
    await server?.close();
    await slow?.close();
    await open_?.close();
  });

  function servedRepo(name: string): string {
    const dir = path.join(root, `${name}.git`);
    git(['init', '--quiet', '--bare', '-b', 'main', dir], sandbox);
    const seed = makeRepo(folder(`${name}-seed`));
    git(['push', '--quiet', dir, 'main'], seed);
    return dir;
  }

  function askpass(answers: Record<CredentialPrompt['kind'], string | undefined>): { server: AskpassServer; prompts: CredentialPrompt[]; log: string[] } {
    const prompts: CredentialPrompt[] = [];
    const log: string[] = [];
    const created = createAskpassServer({ paths, prompt: async (prompt) => (prompts.push(prompt), answers[prompt.kind]), log: (line) => log.push(line) });
    return { server: created, prompts, log };
  }

  it('pushes over basic auth through the askpass helper and the prompt bridge, and no answer reaches a log', async () => {
    const served = servedRepo('auth');
    const work = folder('auth-work');
    git(['clone', '--quiet', served, work], sandbox);
    git(['remote', 'set-url', 'origin', server.url('auth.git')], work);
    git(['config', 'user.email', 'a@damocles.invalid'], work);
    git(['config', 'user.name', 'Ada'], work);
    const credentials = askpass({ username: USER, password: PASSWORD, passphrase: undefined, confirm: undefined, notice: undefined });
    const { h, repoId } = await open(work, { askpass: credentials.server });
    write(path.join(work, 'b.txt'), 'b\n');
    git(['add', '.'], work);
    git(['commit', '--quiet', '-m', 'over http'], work);
    await h.service.push(repoId, { remote: 'origin', branch: 'main', setUpstream: true, followTags: false, force: false });
    expect(git(['log', '-1', '--format=%s', 'main'], path.join(root, 'auth.git')).trim()).toBe('over http');
    expect(credentials.prompts.map((prompt) => prompt.kind)).toEqual(['username', 'password']);
    expect(credentials.prompts[0]!.text).toContain('127.0.0.1');
    for (const text of [log(h), credentials.log.join('\n')]) {
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(`${USER}:`);
    }
    h.service.dispose();
    await credentials.server.dispose();
  });

  it('autofetches in the background without prompting, logs a failure once, and counts the commits behind after a good fetch', async () => {
    const origin = servedRepo('auto');
    const work = folder('auto-work');
    await gitAsync(['clone', '--quiet', open_.url('auto.git'), work], sandbox);
    const credentials = askpass({ username: USER, password: PASSWORD, passphrase: undefined, confirm: undefined, notice: undefined });
    const { h, repoId } = await open(fs.realpathSync.native(work), { askpass: credentials.server });
    commitUpstream(origin, 'up.txt', 'u\n');
    h.service.setAutofetchProject('p');
    await waitFor(() => statusOf(h, repoId)?.upstream?.behind === 1, 'autofetch counts one commit behind');

    // a failure that is no credential's keeps fetching, and is logged once
    const fetches = (): number => h.log.filter((line) => /^> git fetch( |$)/.test(line)).length;
    git(['remote', 'set-url', 'origin', path.join(sandbox, 'no-such-repository.git')], work);
    for (const round of [1, 2]) {
      const before = fetches();
      h.service.autofetchNow();
      await waitFor(() => fetches() > before, `autofetch round ${round}`);
    }
    expect(h.serviceLog.filter((line) => line.startsWith('[scm] autofetch failed'))).toHaveLength(1);

    git(['remote', 'set-url', 'origin', server.url('auto.git')], work);
    h.service.autofetchNow();
    await waitFor(() => h.serviceLog.filter((line) => line.startsWith('[scm] autofetch failed')).length === 2, 'the credential failure');
    expect(credentials.prompts).toEqual([]);
    expect(credentials.log.filter((line) => line.includes('answered with a cancel')).length).toBeGreaterThanOrEqual(1);
    expect(h.service.snapshot(repoId)!.running).toBeNull();
    h.service.dispose();
    await credentials.server.dispose();
  });

  it('removes a killed fetch\'s locks only once the engine write running in the repository ended, and never that write\'s lock', async () => {
    servedRepo('wait-locks');
    const work = folder('wait-locks-work');
    await gitAsync(['clone', '--quiet', slow.url('wait-locks.git'), work], sandbox);
    const { h, repoId } = await open(fs.realpathSync.native(work));
    const repo = h.service.repository(repoId)!.repo;
    slow.hold();
    const held = slow.requests.held;
    const fetched = h.service.fetch(repoId, {}).then(() => 'fetched', (err: unknown) => err);
    await waitFor(() => slow.requests.held > held, 'the fetch reaches the server');
    const lock = path.join(work, '.git', 'packed-refs.lock');
    let release!: () => void;
    const writing = repo.mutate(async () => {
      fs.writeFileSync(lock, '');
      await new Promise<void>((resolve) => (release = resolve));
      fs.rmSync(lock);
    });
    await waitFor(() => release, 'the engine write');
    h.service.cancel(repoId);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(fs.existsSync(lock)).toBe(true);
    expect(h.service.snapshot(repoId)!.running).toBe('fetch');
    release();
    await writing;
    expect(await fetched).toBeInstanceOf(RemoteCancelledError);
    slow.release();
    h.service.dispose();
  });

  it('runs one remote operation per common dir, and a linked worktree\'s engine write keeps its lock through the other worktree\'s cancel', async () => {
    servedRepo('sibling');
    const work = fs.realpathSync.native(folder('sibling-work'));
    await gitAsync(['clone', '--quiet', slow.url('sibling.git'), work], sandbox);
    const linked = path.join(fs.realpathSync.native(folder('sibling-linked')), 'wt');
    git(['worktree', 'add', '--quiet', '-b', 'wt', linked], work);
    const h = harness({ trusted: [work, linked] });
    h.service.setProjects([{ key: 'p', path: work }, { key: 'w', path: linked }]);
    const mainId = (await ready(h, 1, 'p')).repos[0]!.repoId;
    const linkedId = (await ready(h, 1, 'w')).repos[0]!.repoId;
    await waitFor(() => statusOf(h, mainId) && statusOf(h, linkedId), 'both statuses');
    slow.hold();
    const held = slow.requests.held;
    const fetched = h.service.fetch(mainId, {}).then(() => 'fetched', (err: unknown) => err);
    await waitFor(() => slow.requests.held > held, 'the fetch reaches the server');
    await expect(h.service.fetch(linkedId, {})).rejects.toThrow('Another remote operation is running in this repository.');
    const lock = path.join(work, '.git', 'refs', 'remotes', 'origin', 'x.lock');
    let release!: () => void;
    const writing = h.service.repository(linkedId)!.repo.mutate(async () => {
      fs.writeFileSync(lock, '');
      await new Promise<void>((resolve) => (release = resolve));
      fs.rmSync(lock);
    });
    await waitFor(() => release, 'the linked worktree\'s engine write');
    h.service.cancel(mainId);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(fs.existsSync(lock)).toBe(true);
    release();
    await writing;
    expect(await fetched).toBeInstanceOf(RemoteCancelledError);
    slow.release();
    h.service.dispose();
  });

  it('removes the locks of a fetch the repository\'s closing killed', async () => {
    servedRepo('closed-locks');
    const work = folder('closed-locks-work');
    await gitAsync(['clone', '--quiet', slow.url('closed-locks.git'), work], sandbox);
    const { h, repoId } = await open(fs.realpathSync.native(work));
    slow.hold();
    const held = slow.requests.held;
    const fetched = h.service.fetch(repoId, {}).then(() => 'fetched', (err: unknown) => err);
    await waitFor(() => slow.requests.held > held, 'the fetch reaches the server');
    // what a fetch killed while it writes leaves behind
    const lock = path.join(work, '.git', 'refs', 'remotes', 'origin', 'main.lock');
    fs.writeFileSync(lock, '');
    h.service.setProjects([]);
    expect(await fetched).toBeInstanceOf(GitQueueDisposedError);
    expect(fs.existsSync(lock)).toBe(false);
    expect(h.serviceLog).toContain('[scm] removed the lock files a killed fetch left: refs/remotes/origin/main.lock');
    slow.release();
    h.service.dispose();
  });

  it('still ends a cancel as cancelled when a lock it left cannot be removed, and logs it', async () => {
    servedRepo('held-lock');
    const work = folder('held-lock-work');
    await gitAsync(['clone', '--quiet', slow.url('held-lock.git'), work], sandbox);
    const { h, repoId } = await open(fs.realpathSync.native(work));
    slow.hold();
    const held = slow.requests.held;
    const fetched = h.service.fetch(repoId, {});
    await waitFor(() => slow.requests.held > held, 'the fetch reaches the server');
    const lock = path.join(work, '.git', 'refs', 'remotes', 'origin', 'zz.lock');
    fs.writeFileSync(lock, '');
    const releaseLock = await unremovable(lock);
    try {
      h.service.cancel(repoId);
      await expect(fetched).rejects.toBeInstanceOf(RemoteCancelledError);
    } finally {
      await releaseLock();
    }
    expect(h.serviceLog.some((line) => line.startsWith('[scm] a lock file a killed fetch left could not be removed: refs/remotes/origin/zz.lock'))).toBe(true);
    slow.release();
    h.service.dispose();
  });

  it('applies a cancelled pull\'s stash back, with a git before 2.27, and ends it as cancelled', async () => {
    servedRepo('cancel-stash');
    const work = fs.realpathSync.native(folder('cancel-stash-work'));
    await gitAsync(['clone', '--quiet', slow.url('cancel-stash.git'), work], sandbox);
    const old = createGitRunner({ git: { path: GIT_PATH!, version: { major: 2, minor: 26, patch: 0 } }, log: { appendLine: () => undefined }, isTrusted: () => true });
    const { h, repoId } = await open(work, { runner: old });
    write(path.join(work, 'a.txt'), 'local edit\n');
    await freshStatus(h, repoId);
    await h.settings.update(SCM_SETTING_KEYS.autoStash, true);
    slow.hold();
    const held = slow.requests.held;
    const pulled = h.service.pull(repoId, { rebase: false });
    await waitFor(() => slow.requests.held > held, 'the pull reaches the server');
    h.service.cancel(repoId);
    await expect(pulled).rejects.toBeInstanceOf(RemoteCancelledError);
    slow.release();
    expect(fs.readFileSync(path.join(work, 'a.txt'), 'utf8')).toBe('local edit\n');
    expect(git(['stash', 'list'], work)).toBe('');
    h.service.dispose();
  });

  // git exits 0 when its own autostash cannot be applied back, and stores the entry under the reflog message "autostash"
  it('reports the autostash git kept after a pull it could not apply back, lists it, and leaves an older stash alone', async () => {
    const { work, origin } = tracked('native-kept');
    write(path.join(work, 'b.txt'), 'unrelated\n');
    git(['stash', 'push', '--quiet', '--include-untracked', '-m', 'unrelated'], work);
    const unrelated = git(['rev-parse', 'refs/stash'], work).trim();
    commitUpstream(origin, 'a.txt', 'upstream\n');
    const { h, repoId } = await open(work);
    write(path.join(work, 'a.txt'), 'local edit\n');
    await freshStatus(h, repoId);
    await h.settings.update(SCM_SETTING_KEYS.autoStash, true);
    const kept = await h.service.pull(repoId, { rebase: false }).then(() => undefined, (err: unknown) => err);
    expect(h.log.some((line) => line.includes('> git pull --autostash'))).toBe(true);
    expect(kept).toBeInstanceOf(StashKeptError);
    expect(kept).toMatchObject({ outcome: 'ok', message: 'Your changes were stashed for this operation and could not be applied back, so they are kept in the stash list.' });
    const stash = git(['rev-parse', 'refs/stash'], work).trim();
    expect(stash).not.toBe(unrelated);
    expect((kept as StashKeptError).stash).toBe(stash);
    expect(git(['log', '-1', '--format=%s', 'HEAD'], work).trim()).toBe('upstream a.txt');
    expect(await h.service.artifacts(repoId, 'stashes')).toMatchObject({
      group: 'stashes',
      rows: [{ index: 0, hash: stash, description: 'autostash', branch: null }, { index: 1, hash: unrelated, description: 'unrelated', branch: 'main' }],
    });
    // the pull itself went through; only the changes stashed around it stayed behind
    expect(h.service.snapshot(repoId)!.lastRemote).toMatchObject({ op: 'pull', outcome: 'ok', stashKept: true });

    // a pull with nothing to stash reports no kept stash, though the list already holds one
    git(['reset', '--quiet', '--hard'], work);
    commitUpstream(origin, 'z.txt', 'z\n');
    await freshStatus(h, repoId);
    await h.service.pull(repoId, { rebase: false });
    expect(git(['rev-parse', 'refs/stash'], work).trim()).toBe(stash);
    expect(h.service.snapshot(repoId)!.lastRemote).toMatchObject({ op: 'pull', outcome: 'ok', stashKept: false });
    h.service.dispose();
  });

  it('stops Sync before the push when git kept the autostash of its pull', async () => {
    const { work, origin } = tracked('native-kept-sync');
    commitUpstream(origin, 'a.txt', 'upstream\n');
    const upstream = git(['rev-parse', 'main'], origin).trim();
    write(path.join(work, 'c.txt'), 'local commit\n');
    git(['add', 'c.txt'], work);
    git(['commit', '--quiet', '-m', 'local c.txt'], work);
    const { h, repoId } = await open(work);
    write(path.join(work, 'a.txt'), 'local edit\n');
    await freshStatus(h, repoId);
    h.settings.values.set(SCM_SETTING_KEYS.confirmSync, false);
    await h.settings.update(SCM_SETTING_KEYS.autoStash, true);
    const kept = await h.service.sync(repoId, true).then(() => undefined, (err: unknown) => err);
    expect(kept).toBeInstanceOf(StashKeptError);
    expect((kept as StashKeptError).stash).toBe(git(['rev-parse', 'refs/stash'], work).trim());
    expect(git(['log', '-1', '--format=%s', 'HEAD'], work).trim()).toBe('local c.txt');
    expect(git(['rev-parse', 'main'], origin).trim()).toBe(upstream);
    // the pull went through, but the sync stopped before its push
    expect(h.service.snapshot(repoId)!.lastRemote).toMatchObject({ op: 'sync', outcome: 'failed', stashKept: true });
    h.service.dispose();
  });

  it('reports the fenced pull\'s stash as kept when the project is untrusted before it can be applied back', async () => {
    servedRepo('kept-untrusted');
    const work = fs.realpathSync.native(folder('kept-untrusted-work'));
    await gitAsync(['clone', '--quiet', slow.url('kept-untrusted.git'), work], sandbox);
    const declined = path.join(work, 'declined');
    fs.mkdirSync(declined);
    const h = harness({ trusted: [work] });
    h.service.setProjects([{ key: 'p', path: work }, { key: 'd', path: declined }]);
    const repoId = (await ready(h, 1, 'p')).repos[0]!.repoId;
    await waitFor(() => statusOf(h, repoId), 'a first status');
    write(path.join(work, 'a.txt'), 'local edit\n');
    slow.hold();
    const held = slow.requests.held;
    const pulled = h.service.pull(repoId, { rebase: false }).then(() => undefined, (err: unknown) => err);
    await waitFor(() => slow.requests.held > held, 'the pull reaches the server');
    h.trust.revoke(work);
    slow.release();
    const kept = await pulled;
    expect(kept).toBeInstanceOf(StashKeptError);
    expect(kept).toMatchObject({ outcome: 'ok', cause: expect.any(GitUntrustedError) });
    expect(git(['rev-parse', 'refs/stash'], work).trim()).toBe((kept as StashKeptError).stash);
    expect(fs.readFileSync(path.join(work, 'a.txt'), 'utf8')).toBe('one\n');
    h.service.dispose();
  });

  it('kills the git http-backend processes still running when the test server closes', async () => {
    const own = await startGitHttpServer({ root });
    servedRepo('close-server');
    const request = http.request(own.url('close-server.git/git-upload-pack'), { method: 'POST', headers: { 'Content-Type': 'application/x-git-upload-pack-request' } });
    request.on('error', () => undefined);
    request.write('0032want ');
    await waitFor(() => own.backendPids().length > 0, 'a running http-backend');
    const pids = own.backendPids();
    await own.close();
    for (const pid of pids) expect(() => process.kill(pid, 0), String(pid)).toThrow();
    request.destroy();
  });

  it('cancels a pull against a slow server: the snapshot shows it running, its process tree dies and no lock remains', async () => {
    servedRepo('slow');
    const work = folder('slow-work');
    await gitAsync(['clone', '--quiet', slow.url('slow.git'), work], sandbox);
    const { h, repoId } = await open(fs.realpathSync.native(work));
    slow.hold();
    const held = slow.requests.held;
    const pulled = h.service.pull(repoId, { rebase: false });
    await waitFor(() => slow.requests.held > held, 'the pull reaches the server');
    expect(h.service.snapshot(repoId)!.running).toBe('pull');
    h.service.cancel(repoId);
    await expect(pulled).rejects.toBeInstanceOf(RemoteCancelledError);
    slow.release();
    expect(h.service.snapshot(repoId)).toMatchObject({ running: null, lastRemote: { op: 'pull', outcome: 'cancelled' } });
    expect(locks(path.join(work, '.git'))).toEqual([]);
    expect(h.log.some((line) => line.includes('> git pull') && line.endsWith('cancelled'))).toBe(true);
    h.service.dispose();
  });

  it('cancels a clone: its folder goes and no lock remains', async () => {
    servedRepo('cancel-clone');
    const parent = folder('cancel-clones');
    const h = harness();
    slow.hold();
    const held = slow.requests.held;
    const cloned = h.service.clone(slow.url('cancel-clone.git'), parent, false);
    await waitFor(() => slow.requests.held > held, 'the clone reaches the server');
    expect(h.service.cloneState().running).toEqual({ name: 'cancel-clone' });
    h.service.cancelClone();
    await expect(cloned).rejects.toBeInstanceOf(RemoteCancelledError);
    slow.release();
    expect(fs.readdirSync(parent)).toEqual([]);
    expect(h.service.cloneState()).toMatchObject({ running: null, last: { outcome: 'cancelled' } });
    h.service.dispose();
  });

  it('clones recursively, checking out a submodule served by the same backend, without protocol.file.allow', async () => {
    servedRepo('child');
    const parentRepo = path.join(root, 'parent.git');
    git(['init', '--quiet', '--bare', '-b', 'main', parentRepo], sandbox);
    const seed = makeRepo(folder('parent-seed'));
    await gitAsync(['submodule', 'add', '--quiet', open_.url('child.git'), 'child'], seed);
    git(['-c', 'user.name=S', '-c', 'user.email=s@d.invalid', 'commit', '--quiet', '-m', 'add child'], seed);
    git(['push', '--quiet', parentRepo, 'main'], seed);
    const h = harness();
    const target = await h.service.clone(open_.url('parent.git'), folder('recursive'), true);
    expect(fs.readFileSync(path.join(target, 'child', 'a.txt'), 'utf8')).toBe('one\n');
    expect(h.log.some((line) => line.includes('> git clone --recurse-submodules --'))).toBe(true);
    expect(h.log.every((line) => !line.includes('protocol.file.allow'))).toBe(true);
    h.service.dispose();
  });
});
