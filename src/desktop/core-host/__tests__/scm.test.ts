import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installedCredentialRelay, type RelayIdentity } from '../../../core/scm/askpass/credential-relay';
import { FakeSettings, FakeTrust, folder, git, GIT_PATH, HAS_GIT, MapMemento, makeRepo, useGitSandbox, waitFor, watchers, write } from '../../../core/scm/__tests__/git-harness';
import { parseGitVersion } from '../../../core/scm/git-version';
import type { GitCredentialAnswer } from '../../../shared/git-credential';
import type { LocalizedText } from '../../../shared/localized-text';
import { createDesktopLocalizationService } from '../../local-services/localization-service';
import type { RepoSnapshot, ScmEvent } from '../../../core/scm/scm-service';
import { createCoreEndpoint, createLoopback, createMainEndpoint, type AskQuestion, type MainEndpoint, type ScmMirrorPatch } from '../../core-protocol';
import type { CorePlatform } from '../platform';
import { startCoreScm, type CoreScm } from '../scm';

/** Core's scm mirror as main receives it: what goes out for listed and dropped repositories, and before which event. */
useGitSandbox();

type Seen = { readonly patch: ScmMirrorPatch } | { readonly event: ScmEvent };

let running: CoreScm | undefined;
afterEach(() => {
  running?.dispose();
  running = undefined;
});

function start(trusted: string, remote = false, credentialRelay?: RelayIdentity, logs: string[] = []): { seen: Seen[]; asked: AskQuestion[]; trashed: string[]; mainEndpoint: MainEndpoint; call: (method: string, args: unknown[]) => Promise<unknown> } {
  const { main, core } = createLoopback();
  const violations: string[] = [];
  const mainEndpoint = createMainEndpoint(main, () => undefined, (error) => violations.push(error.message));
  const endpoint = createCoreEndpoint(core, () => undefined);
  const trust = new FakeTrust();
  trust.trusted.add(path.resolve(trusted).toLowerCase());
  const platform = {
    endpoint,
    init: { git: { available: true, path: GIT_PATH, version: parseGitVersion(git(['--version'], trusted)) }, paths: { askpass: { askpass: '/a', sshAskpass: '/s', node: '/n', main: '/m', ...(credentialRelay ? { credentialRelay } : {}) } }, ...(remote ? { remote: { hostId: 'h1' } } : {}) },
    localization: { t: (message: string) => message },
    trust,
    fileWatchers: watchers,
    settings: new FakeSettings(),
    state: { global: new MapMemento() },
    notifications: { info: async () => undefined },
    secrets: { get: async () => undefined },
  } as unknown as CorePlatform;
  running = startCoreScm(platform, { appendLine: (line) => logs.push(line), show: () => undefined, dispose: () => undefined }, (line) => logs.push(line));
  const seen: Seen[] = [];
  const asked: AskQuestion[] = [];
  const trashed: string[] = [];
  mainEndpoint.serve('dialogs.ask', (question) => {
    asked.push(question);
    return 0;
  });
  mainEndpoint.serve('shell.trash', ({ path: file }) => {
    trashed.push(file);
    fs.rmSync(file);
  });
  mainEndpoint.onMirror('scm', (patch) => seen.push({ patch }));
  mainEndpoint.onEvent('scm.changed', ({ event }) => seen.push({ event: event as ScmEvent }));
  return {
    seen,
    asked,
    trashed,
    mainEndpoint,
    call: async (method, args) => {
      const result = await mainEndpoint.request('scm.call', { method: method as never, args });
      expect(violations).toEqual([]);
      return result;
    },
  };
}

const patches = (seen: readonly Seen[]): ScmMirrorPatch[] => seen.flatMap((item) => ('patch' in item ? [item.patch] : []));

describe.runIf(HAS_GIT)('core\'s scm mirror', { timeout: 60_000 }, () => {
  it('publishes a listed repository whole once per status revision, its busy flips as flags, and every delta before its event', async () => {
    const repo = makeRepo(folder('mirror'));
    const { seen, call } = start(repo);
    await call('setProjects', [[{ key: 'p', path: repo }]]);
    const whole = (): Array<ScmMirrorPatch & { kind: 'repository' }> => patches(seen).filter((patch): patch is ScmMirrorPatch & { kind: 'repository' } => patch.kind === 'repository' && patch.repository !== undefined);
    const first = await waitFor(() => whole().find((patch) => (patch.repository!.snapshot as RepoSnapshot).status !== undefined), 'a published status');
    const repoId = first.repoId;
    const viewAt = seen.findIndex((item) => 'patch' in item && item.patch.kind === 'view' && (item.patch.view as { repos: unknown[] } | undefined)?.repos.length === 1);
    expect(viewAt).toBeGreaterThanOrEqual(0);
    expect(seen.findIndex((item) => 'patch' in item && item.patch.kind === 'repository')).toBeGreaterThan(viewAt);

    // a stage is an index write, so the queue goes busy and idle around it, and its status lands after
    write(path.join(repo, 'a.txt'), 'two\n');
    const before = seen.length;
    await call('stage', [repoId, ['a.txt']]);
    await waitFor(() => whole().some((patch) => (patch.repository!.snapshot as RepoSnapshot).revision > (first.repository!.snapshot as RepoSnapshot).revision) && seen.slice(before).some((item) => 'patch' in item && item.patch.kind === 'repositoryState' && !item.patch.busy), 'the stage landing');
    const after = patches(seen.slice(before)).filter((patch) => 'repoId' in patch && patch.repoId === repoId);
    expect(after.some((patch) => patch.kind === 'repositoryState' && patch.busy)).toBe(true);
    const revisions = whole().map((patch) => (patch.repository!.snapshot as RepoSnapshot).revision);
    expect(new Set(revisions).size).toBe(revisions.length);

    // each repository event follows a delta for its repository
    seen.forEach((item, index) => {
      if (!('event' in item) || item.event.kind !== 'repository') return;
      const changedRepo = item.event.repoId;
      expect(seen.slice(0, index).some((earlier) => 'patch' in earlier && 'repoId' in earlier.patch && earlier.patch.repoId === changedRepo)).toBe(true);
    });

    // a project removed publishes its repository's close before the repository's event
    const dropAt = seen.length;
    await call('setProjects', [[]]);
    const closedEvent = (item: Seen): boolean => 'event' in item && item.event.kind === 'repository' && item.event.repoId === repoId;
    await waitFor(() => seen.slice(dropAt).some(closedEvent), 'the repository\'s event');
    const dropped = seen.slice(dropAt);
    const closedAt = dropped.findIndex((item) => 'patch' in item && item.patch.kind === 'repository' && item.patch.repoId === repoId && item.patch.repository === undefined);
    expect(closedAt).toBeGreaterThanOrEqual(0);
    expect(closedAt).toBeLessThan(dropped.findIndex(closedEvent));
  });
});

describe.runIf(HAS_GIT)("a daemon's core's git credential relay", { timeout: 60_000 }, () => {
  // a handle in its own private folder on POSIX, a pipe with a random name on Windows, as the daemon makes them
  const handles: string[] = [];
  const relayHandle = (): string => {
    if (process.platform === 'win32') return `\\\\.\\pipe\\damocles-relay-${randomBytes(16).toString('hex')}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-relay-'));
    fs.chmodSync(dir, 0o700);
    handles.push(dir);
    return path.join(dir, 'askpass.sock');
  };
  afterEach(() => {
    for (const dir of handles.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  const answers = (handle: string): Promise<boolean> => new Promise((resolve) => {
    const socket = net.connect(handle);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

  it('listens at the handle the daemon publishes after it made the relay\'s folder again, and gives spawns that handle', async () => {
    const repo = makeRepo(folder('relay-move'));
    const first: RelayIdentity = { helper: '/srv/damocles/dist/git-credential/git-credential-relay.sh', nonce: 'b'.repeat(64), handle: relayHandle() };
    const { mainEndpoint } = start(repo, true, first);
    await waitFor(() => installedCredentialRelay()?.handle === first.handle || undefined, 'the relay installed');
    expect(await answers(first.handle)).toBe(true);
    const moved = relayHandle();
    mainEndpoint.publish('hostSockets', { relayHandle: moved });
    await waitFor(() => installedCredentialRelay()?.handle === moved || undefined, 'the relay moved');
    expect(installedCredentialRelay()?.nonce).toBe(first.nonce);
    expect(await answers(moved)).toBe(true);
    expect(await answers(first.handle)).toBe(false);
    await running!.close();
  });

  // One credential request as the relay helper sends it; resolves the answer line, '' when the connection was dropped.
  const relayRequest = (identity: RelayIdentity, body: Record<string, unknown>): Promise<string> => new Promise((resolve) => {
    const socket = net.connect(identity.handle);
    let reply = '';
    socket.on('data', (chunk: Buffer) => (reply += chunk.toString('utf8')));
    socket.on('error', () => undefined);
    socket.on('close', () => resolve(reply));
    socket.write(`${JSON.stringify({ nonce: identity.nonce, kind: 'credential', ...body })}\n`);
  });
  const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
  const relayIdentity = (): RelayIdentity => ({ helper: '/srv/damocles/dist/git-credential/git-credential-relay.sh', nonce: 'c'.repeat(64), handle: relayHandle() });
  const servedRequests = (mainEndpoint: MainEndpoint) => {
    const requests: Array<{ readonly op: string; readonly fields: unknown; readonly targetHelper: boolean }> = [];
    mainEndpoint.serve('askpass.credential', (request): GitCredentialAnswer => {
      requests.push(request);
      return request.op === 'get' ? { kind: 'credential', username: 'ada', password: 'relayed-7f3a' } : { kind: 'none' };
    });
    return requests;
  };

  it('passes an erase on to the client only when it names the password the relay answered, once', async () => {
    const repo = makeRepo(folder('relay-erase'));
    const identity = relayIdentity();
    const logs: string[] = [];
    const { mainEndpoint } = start(repo, true, identity, logs);
    const requests = servedRequests(mainEndpoint);
    await waitFor(() => installedCredentialRelay() !== undefined || undefined, 'the relay installed');
    const fields = { protocol: 'https', host: 'github.com', username: 'ada' };
    await expect(relayRequest(identity, { op: 'get', cwd: repo, fields })).resolves.toContain('"password":"relayed-7f3a"');
    // a refusal of the target's own credential, an erase naming no password, and the relayed one twice
    for (const erase of [{ passwordHash: sha256('saved-on-the-target') }, {}, { passwordHash: sha256('relayed-7f3a') }, { passwordHash: sha256('relayed-7f3a') }]) {
      await expect(relayRequest(identity, { op: 'erase', cwd: repo, fields, ...erase })).resolves.toBe('{"kind":"none"}\n');
    }
    expect(requests.map((request) => request.op)).toEqual(['get', 'erase']);
    expect(logs.join('\n')).not.toContain('relayed-7f3a');
    await running!.close();
  });

  it('reads the helpers of the repository a trusted project holds when git runs the helper in its subfolder', async () => {
    const repo = makeRepo(folder('relay-subfolder'));
    git(['config', 'credential.helper', 'store'], repo);
    const sub = path.join(repo, 'sub');
    fs.mkdirSync(sub);
    const identity = relayIdentity();
    const { mainEndpoint, call } = start(repo, true, identity);
    const requests = servedRequests(mainEndpoint);
    await call('setProjects', [[{ key: 'p', path: repo }]]);
    await waitFor(() => running!.service.view('p')?.state === 'ready' || undefined, 'the project discovered');
    await waitFor(() => installedCredentialRelay() !== undefined || undefined, 'the relay installed');
    await relayRequest(identity, { op: 'get', cwd: sub, fields: { protocol: 'https', host: 'github.com' } });
    expect(requests).toEqual([expect.objectContaining({ op: 'get', targetHelper: true })]);
    await running!.close();
  });

  it('warns of a target helper when it cannot read them, and still asks', async () => {
    const elsewhere = folder('relay-unreadable');
    const identity = relayIdentity();
    const { mainEndpoint } = start(makeRepo(folder('relay-project')), true, identity);
    const requests = servedRequests(mainEndpoint);
    await waitFor(() => installedCredentialRelay() !== undefined || undefined, 'the relay installed');
    // the probe's empty folder cannot be made
    const missing = path.join(elsewhere, 'missing');
    for (const key of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(key, missing);
    try {
      await expect(relayRequest(identity, { op: 'get', cwd: elsewhere, fields: { protocol: 'https', host: 'github.com' } })).resolves.toContain('"kind":"credential"');
    } finally {
      vi.unstubAllEnvs();
    }
    expect(requests).toEqual([expect.objectContaining({ op: 'get', targetHelper: true })]);
    await running!.close();
  });

  it('listens again when a git call or agent shell wants the relay after its listen failed', async () => {
    const repo = makeRepo(folder('relay-relisten'));
    let identity: RelayIdentity;
    let unblock: () => Promise<void>;
    if (process.platform === 'win32') {
      identity = relayIdentity();
      const holder = net.createServer();
      await new Promise<void>((resolve) => holder.listen(identity.handle, resolve));
      unblock = () => new Promise<void>((resolve) => holder.close(() => resolve()));
    } else {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-relay-'));
      handles.push(dir);
      const missing = path.join(dir, 'later');
      identity = { ...relayIdentity(), handle: path.join(missing, 'askpass.sock') };
      unblock = async () => fs.mkdirSync(missing, { mode: 0o700 });
    }
    const logs: string[] = [];
    start(repo, true, identity, logs);
    await waitFor(() => logs.some((line) => line.includes('git credential relay')) || undefined, 'the failed listen');
    await unblock();
    await waitFor(() => installedCredentialRelay()?.handle === identity.handle || undefined, 'the relay listening again');
    expect(await answers(identity.handle)).toBe(true);
    await running!.close();
  });
});

describe.runIf(HAS_GIT)("core's commit", { timeout: 60_000 }, () => {
  it("answers a refusal with its LocalizedText and a failed git commit with git's own words, which main renders in its language", async () => {
    const repo = makeRepo(folder('commit-refusal'));
    write(path.join(repo, 'a.txt'), 'edit\n');
    git(['add', 'a.txt'], repo);
    const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
    write(hook, '#!/bin/sh\necho refused by the hook >&2\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    const { seen, call, mainEndpoint } = start(repo);
    await call('setProjects', [[{ key: 'p', path: repo }]]);
    const listed = await waitFor(() => patches(seen).find((patch) => patch.kind === 'repository' && ((patch.repository?.snapshot as RepoSnapshot | undefined)?.status?.groups.index.length ?? 0) > 0), 'a.txt staged');
    const commit = (noVerify: boolean) => mainEndpoint.request('scm.commit', { repoId: (listed as { repoId: string }).repoId, message: 'Blocked', variant: { scope: 'auto', amend: false, signoff: false, noVerify, empty: false }, saved: [] });
    const el = createDesktopLocalizationService(process.cwd(), 'el', () => undefined);

    const refused = await commit(true);
    expect(refused).toEqual({ ok: false, reason: 'failed', error: { message: 'Commits without verification are not allowed, please enable them with the "Allow no-verify commits" setting.' } });
    expect(el.render((refused as { error: LocalizedText }).error)).toBe('Οι υποβολές χωρίς επαλήθευση δεν επιτρέπονται. Ενεργοποιήστε τις με τη ρύθμιση «Να επιτρέπονται υποβολές χωρίς επαλήθευση».');

    const failed = await commit(false);
    expect(failed).toEqual({ ok: false, reason: 'failed', error: { message: '{0}', args: ['refused by the hook'] } });
    expect(el.render((failed as { error: LocalizedText }).error)).toBe('refused by the hook');
  });
});

describe.runIf(HAS_GIT)("core's discard", { timeout: 60_000 }, () => {
  async function discardJunk(remote: boolean): Promise<{ asked: AskQuestion[]; trashed: string[]; junk: string }> {
    const repo = makeRepo(folder(remote ? 'discard-remote' : 'discard-local'));
    const junk = path.join(repo, 'junk.txt');
    write(junk, 'junk\n');
    const { seen, asked, trashed, call } = start(repo, remote);
    await call('setProjects', [[{ key: 'p', path: repo }]]);
    const listed = await waitFor(() => patches(seen).find((patch) => patch.kind === 'repository' && ((patch.repository?.snapshot as RepoSnapshot | undefined)?.status?.groups.workingTree.length ?? 0) > 0), 'junk.txt listed');
    expect(await call('discard', [(listed as { repoId: string }).repoId, ['junk.txt']])).toBe(true);
    return { asked, trashed, junk };
  }

  it("deletes permanently on a daemon's core, after saying so, and never asks main to trash", async () => {
    const { asked, trashed, junk } = await discardJunk(true);
    expect(asked[0]).toMatchObject({ actions: [{ message: 'Delete File' }], detail: { message: 'This is IRREVERSIBLE!\nThis file will be FOREVER LOST if you proceed.' } });
    expect(trashed).toEqual([]);
    expect(fs.existsSync(junk)).toBe(false);
  });

  it('asks main to trash on a local core', async () => {
    const { asked, trashed, junk } = await discardJunk(false);
    expect(asked[0]!.actions).toEqual([{ message: process.platform === 'win32' ? 'Move to Recycle Bin' : 'Move to Trash' }]);
    expect(trashed).toEqual([junk]);
  });
});
