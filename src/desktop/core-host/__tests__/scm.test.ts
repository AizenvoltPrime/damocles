import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RelayCredential } from '../../../core/scm/askpass/askpass-server';
import { installedCredentialRelay, type RelayIdentity } from '../../../core/scm/askpass/credential-relay';
import { FakeSettings, FakeTrust, folder, git, GIT_PATH, HAS_GIT, MapMemento, makeRepo, useGitSandbox, waitFor, watchers, write } from '../../../core/scm/__tests__/git-harness';
import { parseGitVersion } from '../../../core/scm/git-version';
import type { GitCredentialAnswer } from '../../../shared/git-credential';
import type { LocalizedText } from '../../../shared/localized-text';
import { createDesktopLocalizationService } from '../../local-services/localization-service';
import type { RepoSnapshot, ScmEvent } from '../../../core/scm/scm-service';
import { createCoreEndpoint, createLoopback, createMainEndpoint, processActor, type AskQuestion, type CoreEndpoint, type MainEndpoint, type ScmMirrorPatch } from '../../core-protocol';
import { createActorContext, type ActorContext } from '../../core-protocol/actor';
import { createClientMirrors, createCoreRouter } from '../../daemon/core-routes';
import { createRunRegistry } from '../../daemon/run-registry';
import type { CorePlatform } from '../platform';
import { startCoreScm, type CoreScm } from '../scm';
import type { RemoteHost } from '../../../platform/remote-host';
import { createFakeRemoteHost } from '../../../__mocks__/fake-remote-host';
import { installedCredentialHelper } from '../../../core/scm/askpass/credential-config';
import { runPinnedTurn } from '../../../core/client-snapshots';
import { knownSecrets } from '../../../core/forge/known-secrets';

// the askpass server's relay handler, which runs in whatever async context its connection gives it
const relayHandler = vi.hoisted(() => ({ current: undefined as RelayCredential | undefined }));
vi.mock('../../../core/scm/askpass/askpass-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/scm/askpass/askpass-server')>();
  return {
    ...actual,
    createAskpassServer: (deps: Parameters<typeof actual.createAskpassServer>[0]) => {
      relayHandler.current = deps.credential;
      return actual.createAskpassServer(deps);
    },
  };
});

/** Core's scm mirror as main receives it: what goes out for listed and dropped repositories, and before which event. */
useGitSandbox();

type Seen = { readonly patch: ScmMirrorPatch } | { readonly event: ScmEvent };

let running: CoreScm | undefined;
afterEach(() => {
  running?.dispose();
  running = undefined;
});

function corePlatform(endpoint: CoreEndpoint, trusted: string, remote: boolean, credentialRelay: RelayIdentity | undefined, remoteHost?: RemoteHost): CorePlatform {
  const trust = new FakeTrust();
  trust.trusted.add(path.resolve(trusted).toLowerCase());
  return {
    endpoint,
    init: { git: { available: true, path: GIT_PATH, version: parseGitVersion(git(['--version'], trusted)) }, paths: { unpackedRoot: '/app', askpass: { askpass: '/a', sshAskpass: '/s', node: '/n', main: '/m', ...(credentialRelay ? { credentialRelay } : {}) } }, ...(remote ? { remote: { hostId: 'h1' } } : {}) },
    localization: { t: (message: string) => message },
    trust,
    fileWatchers: watchers,
    settings: new FakeSettings(),
    state: { global: new MapMemento() },
    notifications: { info: async () => undefined },
    secrets: { get: async () => undefined },
    ...(remoteHost ? { remote: remoteHost } : {}),
  } as unknown as CorePlatform;
}

// mainActors: main's side reads the client each request was sent to, which core stamps from processActor
function start(trusted: string, remote = false, credentialRelay?: RelayIdentity, logs: string[] = [], remoteHost?: RemoteHost, mainActors?: ActorContext): { seen: Seen[]; asked: AskQuestion[]; trashed: string[]; mainEndpoint: MainEndpoint; call: (method: string, args: unknown[]) => Promise<unknown> } {
  const { main, core } = createLoopback();
  const violations: string[] = [];
  const mainEndpoint = createMainEndpoint(main, () => undefined, (error) => violations.push(error.message), mainActors);
  const platform = corePlatform(createCoreEndpoint(core, () => undefined, undefined, mainActors ? processActor : undefined), trusted, remote, credentialRelay, remoteHost);
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
  const relayIdentity = (): RelayIdentity => ({ helper: '/srv/damocles/dist/git-credential/git-credential-relay.sh', nonce: 'c'.repeat(64), handle: relayHandle() });
  const servedRequests = (mainEndpoint: MainEndpoint) => {
    const requests: Array<{ readonly op: string; readonly fields: unknown; readonly targetHelper: boolean }> = [];
    mainEndpoint.serve('askpass.credential', (request): GitCredentialAnswer => {
      requests.push(request);
      return request.op === 'get' ? { kind: 'credential', username: 'ada', password: 'relayed-7f3a' } : { kind: 'none' };
    });
    return requests;
  };

  it('sends a managed server\'s request with its origin, runs the target\'s own helpers on delegate, then today\'s relay; others as today', async () => {
    const repo = makeRepo(folder('relay-forge'));
    const identity = relayIdentity();
    const fake = createFakeRemoteHost();
    fake.set('clientForges', 'client-a', { servers: [{ id: 'gitlab.com', webUrl: 'https://gitlab.com', gitHosts: ['gitlab.com'], hasAccount: true }] });
    const { mainEndpoint } = start(repo, true, identity, [], fake.remote);
    const requests: Array<Record<string, unknown>> = [];
    mainEndpoint.serve('askpass.credential', (request): GitCredentialAnswer => {
      requests.push(request);
      return request.origin !== undefined ? { kind: 'delegate' } : { kind: 'credential', username: 'ada', password: 'relayed-7f3a' };
    });
    await waitFor(() => installedCredentialRelay() !== undefined || undefined, 'the relay installed');
    const managed = { protocol: 'https', host: 'gitlab.com', path: 'g/p.git' };
    await expect(relayRequest(identity, { op: 'get', cwd: repo, fields: managed })).resolves.toContain('relayed-7f3a');
    expect(requests).toEqual([
      { op: 'get', fields: managed, targetHelper: false, origin: { kind: 'terminal' }, cwd: repo },
      expect.not.objectContaining({ origin: expect.anything() }),
    ]);
    requests.length = 0;
    await relayRequest(identity, { op: 'get', cwd: repo, fields: { protocol: 'https', host: 'github.com', path: 'o/r.git' } });
    expect(requests).toEqual([expect.not.objectContaining({ origin: expect.anything() })]);
    // a store is never sent anywhere
    requests.length = 0;
    await expect(relayRequest(identity, { op: 'store', cwd: repo, fields: managed, password: 'tok' })).resolves.toBe('{"kind":"none"}\n');
    expect(requests).toEqual([]);
    await running!.close();
  });

  // One credential request as an agent shell's helper sends it; resolves the answer line, '' when the connection was dropped.
  const shellAsk = (shell: { readonly env: Readonly<Record<string, string>> }, cwd: string): Promise<string> => new Promise((resolve) => {
    const socket = net.connect(shell.env['DAMOCLES_ASKPASS_HANDLE']!);
    let reply = '';
    socket.on('data', (chunk: Buffer) => (reply += chunk.toString('utf8')));
    socket.on('error', () => undefined);
    socket.on('close', () => resolve(reply));
    socket.write(`${JSON.stringify({ nonce: shell.env['DAMOCLES_CREDENTIAL_NONCE'], kind: 'credential', op: 'get', cwd, fields: { protocol: 'https', host: 'gitlab.com', path: 'g/p.git' } })}\n`);
  });

  it('asks for an agent shell only the client its origin names while a turn of its chat holds that pin, not an older turn\'s, and nothing once the pin is let go', async () => {
    const repo = makeRepo(folder('relay-shell-pin'));
    const identity = relayIdentity();
    const fake = createFakeRemoteHost();
    fake.set('clientAuth', 'client-b', { providers: {} });
    fake.set('clientForges', 'client-a', { servers: [{ id: 'gitlab.com', webUrl: 'https://gitlab.com', gitHosts: ['gitlab.com'], hasAccount: true }] });
    fake.set('clientForges', 'client-b', { servers: [{ id: 'gitlab.com', webUrl: 'https://gitlab.com', gitHosts: ['gitlab.com'], hasAccount: true }] });
    const mainActors = createActorContext();
    const { mainEndpoint } = start(repo, true, identity, [], fake.remote, mainActors);
    const requests: Array<Record<string, unknown>> = [];
    mainEndpoint.serve('askpass.credential', (request): GitCredentialAnswer => {
      requests.push({ ...request, to: mainActors.current() });
      return { kind: 'credential', username: 'oauth2', password: 'bound-token' };
    });
    await waitFor(() => installedCredentialRelay() !== undefined || undefined, 'the relay installed');
    // a background agent keeps the chat's first turn, pinned to client-a, running while its second turn is pinned to client-b
    let releaseFirst!: () => void;
    const first = runPinnedTurn(fake.remote, 'p1', () => new Promise<void>((resolve) => (releaseFirst = resolve)));
    fake.setActor('client-b');
    let releaseSecond!: () => void;
    const second = runPinnedTurn(fake.remote, 'p1', () => new Promise<void>((resolve) => (releaseSecond = resolve)));
    fake.setActor('client-a');
    const origin = { kind: 'agentShell' as const, panelId: 'p1', sessionId: 's1', toolCallId: 'call-2', clientId: 'client-b' };
    const shell = await installedCredentialHelper()!.register(origin);
    try {
      await expect(shellAsk(shell, repo)).resolves.toContain('bound-token');
      expect(requests).toEqual([expect.objectContaining({ origin, to: 'client-b' })]);
      requests.length = 0;
      releaseSecond();
      await second;
      // client-a's pin is still held for the chat, but the shell's own turn let go of client-b
      await expect(shellAsk(shell, repo)).resolves.toBe('{"kind":"none"}\n');
      expect(requests).toEqual([]);
    } finally {
      releaseSecond();
      releaseFirst();
      await Promise.all([first, second]);
      shell.dispose();
    }
    await running!.close();
  });

  it('asks for an agent shell only as an agent shell, of the client its turn is pinned to, and nothing outside a turn', async () => {
    const repo = makeRepo(folder('relay-shell'));
    const identity = relayIdentity();
    const fake = createFakeRemoteHost();
    // the acting device has the account; the device the turn is pinned to has none
    fake.set('clientAuth', 'client-b', { providers: {} });
    fake.set('clientForges', 'client-b', { servers: [{ id: 'gitlab.com', webUrl: 'https://gitlab.com', gitHosts: ['gitlab.com'], hasAccount: true }] });
    const { mainEndpoint } = start(repo, true, identity, [], fake.remote);
    const requests: Array<Record<string, unknown>> = [];
    mainEndpoint.serve('askpass.credential', (request): GitCredentialAnswer => {
      requests.push(request);
      return { kind: 'credential', username: 'oauth2', password: 'bound-token' };
    });
    await waitFor(() => installedCredentialRelay() !== undefined || undefined, 'the relay installed');
    const shell = await installedCredentialHelper()!.register({ kind: 'agentShell', panelId: 'p1', sessionId: 's1', toolCallId: 'call-1', clientId: 'client-a' });
    const ask = (): Promise<string> => new Promise((resolve) => {
      const socket = net.connect(shell.env['DAMOCLES_ASKPASS_HANDLE']!);
      let reply = '';
      socket.on('data', (chunk: Buffer) => (reply += chunk.toString('utf8')));
      socket.on('error', () => undefined);
      socket.on('close', () => resolve(reply));
      socket.write(`${JSON.stringify({ nonce: shell.env['DAMOCLES_CREDENTIAL_NONCE'], kind: 'credential', op: 'get', cwd: repo, fields: { protocol: 'https', host: 'gitlab.com', path: 'g/p.git' } })}\n`);
    });
    // outside every turn of its chat: nothing, asked of no device
    await expect(ask()).resolves.toBe('{"kind":"none"}\n');
    expect(requests).toEqual([]);
    let release!: () => void;
    const turn = runPinnedTurn(fake.remote, 'p1', () => new Promise<void>((resolve) => (release = resolve)));
    fake.setActor('client-b');
    try {
      await ask();
      // the pinned device manages no server, so today's relay asks it, never as a terminal and never with the acting device's accounts
      expect(requests).toHaveLength(1);
      expect(requests[0]).not.toHaveProperty('origin');
    } finally {
      release();
      await turn;
      shell.dispose();
    }
    await running!.close();
  });

  it('masks what the target\'s own helpers gave an agent shell on delegate, as a relayed token is masked', async () => {
    const repo = makeRepo(folder('relay-shell-delegate'));
    const identity = relayIdentity();
    const fake = createFakeRemoteHost();
    fake.set('clientAuth', 'client-b', { providers: {} });
    fake.set('clientForges', 'client-b', { servers: [{ id: 'gitlab.com', webUrl: 'https://gitlab.com', gitHosts: ['gitlab.com'], hasAccount: true }] });
    const { mainEndpoint } = start(repo, true, identity, [], fake.remote);
    const requests: Array<Record<string, unknown>> = [];
    mainEndpoint.serve('askpass.credential', (request): GitCredentialAnswer => {
      requests.push(request);
      return { kind: 'delegate' };
    });
    const savedGlobal = process.env['GIT_CONFIG_GLOBAL'];
    const global = path.join(folder('relay-shell-global'), 'global.gitconfig');
    fs.writeFileSync(global, '[protocol "file"]\n\tallow = always\n[credential]\n\thelper = "!f() { echo username=target-user; echo password=target-pass-91c2; }; f"\n');
    process.env['GIT_CONFIG_GLOBAL'] = global;
    await waitFor(() => installedCredentialRelay() !== undefined || undefined, 'the relay installed');
    const shell = await installedCredentialHelper()!.register({ kind: 'agentShell', panelId: 'p1', sessionId: 's1', toolCallId: 'call-1', clientId: 'client-b' });
    let release!: () => void;
    fake.setActor('client-b');
    const turn = runPinnedTurn(fake.remote, 'p1', () => new Promise<void>((resolve) => (release = resolve)));
    try {
      const reply = await new Promise<string>((resolve) => {
        const socket = net.connect(shell.env['DAMOCLES_ASKPASS_HANDLE']!);
        let text = '';
        socket.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
        socket.on('error', () => undefined);
        socket.on('close', () => resolve(text));
        socket.write(`${JSON.stringify({ nonce: shell.env['DAMOCLES_CREDENTIAL_NONCE'], kind: 'credential', op: 'get', cwd: repo, fields: { protocol: 'https', host: 'gitlab.com', path: 'g/p.git' } })}\n`);
      });
      expect(reply).toContain('"password":"target-pass-91c2"');
      expect(requests).toHaveLength(1);
      expect(knownSecrets().mask('git printed target-pass-91c2')).toBe('git printed ***');
    } finally {
      release();
      await turn;
      shell.dispose();
      if (savedGlobal === undefined) delete process.env['GIT_CONFIG_GLOBAL'];
      else process.env['GIT_CONFIG_GLOBAL'] = savedGlobal;
    }
    await running!.close();
  });

  it('answers a refusal for a managed server as the client\'s core gave it, with no relay', async () => {
    const repo = makeRepo(folder('relay-refused'));
    const identity = relayIdentity();
    const fake = createFakeRemoteHost();
    fake.set('clientForges', 'client-a', { servers: [{ id: 'gitlab.com', webUrl: 'https://gitlab.com', gitHosts: ['gitlab.com'], hasAccount: true }] });
    const { mainEndpoint } = start(repo, true, identity, [], fake.remote);
    const requests: unknown[] = [];
    mainEndpoint.serve('askpass.credential', (request): GitCredentialAnswer => {
      requests.push(request);
      return { kind: 'refused', message: 'Turn on "Agent shells may use this account".' };
    });
    await waitFor(() => installedCredentialRelay() !== undefined || undefined, 'the relay installed');
    await expect(relayRequest(identity, { op: 'get', cwd: repo, fields: { protocol: 'https', host: 'gitlab.com', path: 'g/p.git' } })).resolves.toContain('"kind":"refused"');
    expect(requests).toHaveLength(1);
    await running!.close();
  });

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
    for (const erase of [{ password: 'saved-on-the-target' }, {}, { password: 'relayed-7f3a' }, { password: 'relayed-7f3a' }]) {
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

  it('sends a request made inside a device\'s work to the acting client, never to that device, which is away', async () => {
    const repo = makeRepo(folder('relay-actor'));
    const identity = relayIdentity();
    const quiet = (): void => undefined;
    const coreLoop = createLoopback();
    const coreEndpoint = createCoreEndpoint(coreLoop.core, quiet, undefined, processActor);
    const router = createCoreRouter({
      core: createMainEndpoint(coreLoop.main, quiet, undefined, processActor),
      state: { snapshot: () => ({}), update: async () => undefined, flush: async () => undefined },
      registry: createRunRegistry(),
      mirrors: createClientMirrors(),
      secrets: new Map(),
      e2eHooks: false,
      reload: quiet,
      agentShellUrl: quiet,
      clientPolicyChanged: quiet,
      actorIntentExpiryMs: 50,
      log: quiet,
    });
    const mirrors = { trust: { keys: [] }, folders: { folders: [] }, editor: {}, terminal: { shown: false, shortcut: '' }, language: { language: 'en' as const }, clientAuth: { providers: {} }, clientUser: { settings: {}, permissionRules: [] }, clientPolicy: { voice: false, allowBypass: false } };
    const answered: string[] = [];
    const device = (clientId: string, lost: () => boolean): void => {
      const loop = createLoopback();
      const main = createMainEndpoint(loop.main, quiet, (error) => { throw error; });
      main.serve('askpass.credential', (): GitCredentialAnswer => {
        answered.push(clientId);
        return { kind: 'credential', username: clientId, password: 'relayed-7f3a' };
      });
      router.attach({ id: clientId, clientId, hostId: 'h1', features: new Set(), transport: loop.core, mirrors, close: quiet, drained: () => Promise.resolve(), lost, onLostChange: () => ({ dispose: quiet }) });
    };
    try {
      let away = false;
      device('device-a', () => away);
      device('device-b', () => false);
      // device a's work starts this core, so the relay's first listen runs as that actor
      processActor.run('device-a', () => {
        running = startCoreScm(corePlatform(coreEndpoint, repo, true, identity), { appendLine: quiet, show: quiet, dispose: quiet }, quiet);
      });
      await waitFor(() => installedCredentialRelay() !== undefined || undefined, 'the relay installed');
      away = true;
      // a connection handler keeps the async context of the listen, here device a's work
      const request = { op: 'get' as const, cwd: repo, fields: { protocol: 'https', host: 'github.com' } };
      const answer = await processActor.run('device-a', () => relayHandler.current!(request, { kind: 'terminal' }, new AbortController().signal));
      expect(answer).toMatchObject({ kind: 'credential', username: 'device-b' });
      await expect(relayRequest(identity, request)).resolves.toContain('"username":"device-b"');
      expect(answered).toEqual(['device-b', 'device-b']);
      await running!.close();
    } finally {
      router.dispose();
    }
  });

  it('judges a managed server by the acting client\'s accounts, never by the actor of the work the relay listened in', async () => {
    const repo = makeRepo(folder('relay-actor-managed'));
    const identity = relayIdentity();
    const fake = createFakeRemoteHost();
    fake.set('clientAuth', 'client-b', { providers: {} });
    fake.set('clientForges', 'client-a', { servers: [{ id: 'gitlab.com', webUrl: 'https://gitlab.com', gitHosts: ['gitlab.com'], hasAccount: true }] });
    // as core-host/platform/clients.ts reads it: an attached actor, else the acting client the daemon names
    const clients = { ...fake.remote.clients, acting: () => processActor.current() ?? 'client-a' };
    const { mainEndpoint } = start(repo, true, identity, [], { ...fake.remote, clients });
    const requests: Array<Record<string, unknown>> = [];
    mainEndpoint.serve('askpass.credential', (request): GitCredentialAnswer => {
      requests.push(request);
      return { kind: 'credential', username: 'oauth2', password: 'bound-token' };
    });
    await waitFor(() => installedCredentialRelay() !== undefined || undefined, 'the relay installed');
    const request = { op: 'get' as const, cwd: repo, fields: { protocol: 'https', host: 'gitlab.com', path: 'g/p.git' } };
    await processActor.run('client-b', () => relayHandler.current!(request, { kind: 'terminal' }, new AbortController().signal));
    expect(requests).toEqual([expect.objectContaining({ origin: { kind: 'terminal' } })]);
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
