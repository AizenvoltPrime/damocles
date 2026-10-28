import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitError } from '../../../core/scm/errors';
import { createCoreEndpoint, createLoopback, createMainEndpoint, processActor, type MainEndpoint } from '../../core-protocol';
import { CLIENT_STATE_KEYS, CORE_TO_MAIN, MAIN_TO_CORE, type ChatEntry, type StateScope } from '../../core-protocol/messages';
import { LANGUAGE_PREFERENCE_KEY } from '../../../shared/language-preference';
import { OPENAI_PREFER_API_KEY_STATE } from '../../../core/pi-session/openai-auth';
import { providerPreferApiKeyState } from '../../../core/pi-session/provider-auth';
import { KEY_PROVIDER_IDS } from '../../../shared/settings-sections';
import {
  CORE_EVENT_ROUTES,
  CORE_MIRROR_ROUTES,
  CORE_PANEL_OP_ROUTES,
  CORE_REQUEST_ROUTES,
  createClientMirrors,
  createCoreRouter,
  MAIN_EVENT_ROUTES,
  MAIN_PANEL_OP_ROUTES,
  MAIN_REQUEST_ROUTES,
  MIRROR_TOPIC_ROUTES,
  type ClientMirrors,
  type CoreRouter,
} from '../core-routes';
import type { DaemonState } from '../daemon-state';
import { createRunRegistry, type RunRegistry } from '../run-registry';
import { CodecError } from '../../../remote/codec';

const quiet = (): void => undefined;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function memoryState(): DaemonState & { readonly writes: Array<[StateScope, string, unknown]> } {
  const writes: Array<[StateScope, string, unknown]> = [];
  const client: Record<StateScope, Map<string, unknown>> = { global: new Map(), workspace: new Map() };
  return {
    writes,
    snapshot: (scope) => Object.fromEntries(client[scope]),
    update: async (scope, key, value) => {
      if (CLIENT_STATE_KEYS.includes(key)) throw new Error(`${key} is set on the client`);
      writes.push([scope, key, value]);
    },
    applyClient: (scope, key, value) => {
      if (!CLIENT_STATE_KEYS.includes(key)) return false;
      client[scope].set(key, value);
      return true;
    },
    flush: async () => undefined,
  };
}

const emptyMirrors = {
  state: { global: {}, workspace: {} },
  trust: { keys: [] },
  folders: { folders: [] },
  editor: {},
  terminal: { shown: false, shortcut: '' },
  language: { language: 'en' as const },
  clientAuth: { providers: {} },
  clientUser: { settings: {}, permissionRules: [] },
  clientPolicy: { voice: false, allowBypass: false },
};

interface Harness {
  readonly core: ReturnType<typeof createCoreEndpoint>;
  readonly router: CoreRouter;
  readonly state: ReturnType<typeof memoryState>;
  readonly registry: RunRegistry;
  readonly reload: ReturnType<typeof vi.fn>;
  readonly secrets: Map<string, string | undefined>;
  readonly mirrors: ClientMirrors;
  // clientId: the hello's, the connection id when absent
  // lose and resume: the connection enters and leaves its reconnection grace
  client(id: string, hostId?: string, drained?: () => Promise<void>, clientId?: string): { readonly main: MainEndpoint; readonly close: ReturnType<typeof vi.fn>; readonly raw: { post(message: unknown): void }; detach(): void; lose(): void; resume(): void };
}

let current: Harness | undefined;

function setUp(options: { e2eHooks?: boolean } = {}): Harness {
  const coreLoop = createLoopback();
  const daemonMain = createMainEndpoint(coreLoop.main, quiet, undefined, processActor);
  const core = createCoreEndpoint(coreLoop.core, quiet, undefined, processActor);
  const state = memoryState();
  const registry = createRunRegistry();
  const reload = vi.fn();
  const secrets = new Map<string, string | undefined>();
  const mirrors = createClientMirrors();
  const router = createCoreRouter({ core: daemonMain, state, registry, mirrors, secrets, e2eHooks: options.e2eHooks ?? false, reload, log: quiet });
  const harness: Harness = {
    core,
    router,
    state,
    registry,
    reload,
    secrets,
    mirrors,
    client: (id, hostId = 'h1', drained = () => Promise.resolve(), clientId = id) => {
      const loop = createLoopback();
      const close = vi.fn();
      const main = createMainEndpoint(loop.main, quiet, (error) => { throw error; });
      let lost = false;
      const lostChange = new Set<() => void>();
      const setLost = (value: boolean): void => {
        lost = value;
        for (const listener of [...lostChange]) listener();
      };
      const onLostChange = (listener: () => void): { dispose(): void } => {
        lostChange.add(listener);
        return { dispose: () => { lostChange.delete(listener); } };
      };
      const attached = router.attach({ id, clientId, hostId, transport: loop.core, mirrors: emptyMirrors, close, drained, lost: () => lost, onLostChange });
      return { main, close, raw: loop.main, detach: () => attached.dispose(), lose: () => setLost(true), resume: () => setLost(false) };
    },
  };
  current = harness;
  return harness;
}

afterEach(() => {
  current?.router.dispose();
  current = undefined;
});

const entry = (panelId: string, viewId: string): ChatEntry => ({
  panelId,
  viewId,
  sessionId: 'S1',
  hasConversation: true,
  folder: { key: '/srv/app', fsPath: '/srv/app', name: 'app', label: 'app', projectScope: true },
  permissions: { permissionMode: 'default', dangerouslySkipPermissions: false },
});

describe('core routes', () => {
  it('route every message of the core protocol', () => {
    const keys = (value: object): string[] => Object.keys(value).sort();
    expect(keys(CORE_REQUEST_ROUTES)).toEqual(keys(CORE_TO_MAIN.requests));
    expect(keys(CORE_EVENT_ROUTES)).toEqual(keys(CORE_TO_MAIN.events));
    expect(keys(CORE_MIRROR_ROUTES)).toEqual(keys(CORE_TO_MAIN.mirrors));
    expect(keys(CORE_PANEL_OP_ROUTES)).toEqual(keys(CORE_TO_MAIN.panelOps));
    expect(keys(MAIN_REQUEST_ROUTES)).toEqual(keys(MAIN_TO_CORE.requests));
    expect(keys(MAIN_EVENT_ROUTES)).toEqual(keys(MAIN_TO_CORE.events));
    expect(keys(MIRROR_TOPIC_ROUTES)).toEqual(keys(MAIN_TO_CORE.mirrors));
    expect(keys(MAIN_PANEL_OP_ROUTES)).toEqual(keys(MAIN_TO_CORE.panelOps));
  });

  it('name the client state keys by the constants core reads them with', () => {
    expect([...CLIENT_STATE_KEYS].sort()).toEqual([LANGUAGE_PREFERENCE_KEY, OPENAI_PREFER_API_KEY_STATE, ...KEY_PROVIDER_IDS.map(providerPreferApiKeyState)].sort());
    expect(CLIENT_STATE_KEYS).toContain('damocles.kimi-coding.preferApiKey');
    expect(CLIENT_STATE_KEYS).not.toContain('damocles.github-copilot.preferApiKey');
  });

  it('refuse core\'s clipboard.writeText and shell.trash without asking a client', async () => {
    const h = setUp();
    const client = h.client('c1');
    const asked = vi.fn();
    client.main.serve('clipboard.writeText', asked);
    client.main.serve('shell.trash', asked);
    await expect(h.core.request('clipboard.writeText', { text: 'x' })).rejects.toThrow('not available');
    await expect(h.core.request('shell.trash', { path: '/srv/app/a' })).rejects.toThrow('not available');
    expect(asked).not.toHaveBeenCalled();
  });

  it('send core\'s client requests to the acting client, and answer them itself with none attached', async () => {
    const h = setUp();
    expect(await h.core.request('notifications.show', { severity: 'info', message: 'hi', actions: [] })).toBeUndefined();
    expect(await h.core.request('askpass.prompt', { kind: 'password', text: 'pw?' })).toEqual({ cancelled: true });
    await expect(h.core.request('worktrees.runSetup', { worktreeId: 'w', cwd: '/x', commands: [], env: {} })).rejects.toThrow('No client');
    const first = h.client('c1');
    const second = h.client('c2');
    first.main.serve('notifications.show', () => 'first');
    second.main.serve('notifications.show', () => 'second');
    expect(await h.core.request('notifications.show', { severity: 'info', message: 'hi', actions: [] })).toBe('second');
    // a client's message makes it the acting one
    await first.main.request('catalog.list', { projectKey: '/srv/app', complete: false }).catch(() => undefined);
    expect(await h.core.request('notifications.show', { severity: 'info', message: 'hi', actions: [] })).toBe('first');
  });

  it('publish a client that attached fresh after a drop as the acting client before its first message, so core refreshes for it', async () => {
    const h = setUp();
    const seen: string[] = [];
    h.core.onMirror('actingClient', (patch) => seen.push(`acting:${(patch as { clientId?: string }).clientId ?? 'none'}`));
    const before = h.client('connection-1');
    await before.main.request('catalog.list', { projectKey: '/srv/app', complete: false }).catch(() => undefined);
    // the daemon no longer held the dropped connection: the same device attaches again under a new connection id
    before.detach();
    const after = h.client('connection-2');
    await after.main.request('catalog.list', { projectKey: '/srv/app', complete: false }).catch(() => undefined);
    await flush();
    expect(seen.filter((entry) => entry !== 'acting:none')).toEqual(['acting:connection-1', 'acting:connection-2']);
  });

  it('read editor.readText with no client only inside an open project', async () => {
    const h = setUp();
    await expect(h.core.request('editor.readText', { path: process.execPath })).rejects.toThrow('outside the open projects');
  });

  it('refuse a CLIENT_STATE_KEYS write from core, and a client\'s write of any other key', async () => {
    const h = setUp();
    const deltas: unknown[] = [];
    h.core.onMirror('state', (patch) => deltas.push(patch));
    await expect(h.core.request('state.update', { scope: 'global', key: LANGUAGE_PREFERENCE_KEY, value: 'el' })).rejects.toThrow('set on the client');
    await h.core.request('state.update', { scope: 'global', key: 'damocles.other', value: 1 });
    expect(h.state.writes).toEqual([['global', 'damocles.other', 1]]);
    expect(deltas).toEqual([{ scope: 'global', key: 'damocles.other', value: 1 }]);
    const client = h.client('c1');
    client.main.publish('state', { scope: 'global', key: 'damocles.other', value: 2 });
    client.main.publish('state', { scope: 'global', key: LANGUAGE_PREFERENCE_KEY, value: 'el' });
    expect(deltas.slice(1)).toEqual([{ scope: 'global', key: LANGUAGE_PREFERENCE_KEY, value: 'el' }]);
  });

  it('refuse core.shutdown, browser pages and the e2e hooks from a client, and drop power events', async () => {
    const h = setUp();
    const client = h.client('c1');
    const served = vi.fn();
    h.core.serve('core.shutdown', served);
    h.core.serve('chats.restorePages', served);
    h.core.serve('browser.newPage', served);
    h.core.serve('e2e.routedRequests', () => []);
    await expect(client.main.request('core.shutdown', {})).rejects.toThrow('not available');
    await expect(client.main.request('chats.restorePages', { viewId: 'v', urls: [] })).rejects.toThrow('not available');
    await expect(client.main.request('browser.newPage', { chatViewId: 'v' })).rejects.toThrow('not available');
    await expect(client.main.request('e2e.routedRequests', {})).rejects.toThrow('only with e2e hooks');
    const power = vi.fn();
    h.core.onEvent('power.suspend', power);
    h.core.onEvent('power.resume', power);
    client.main.emit('power.suspend', {});
    client.main.emit('power.resume', {});
    expect(served).not.toHaveBeenCalled();
    expect(power).not.toHaveBeenCalled();
  });

  it('serve the e2e hooks when the daemon runs with them', async () => {
    const h = setUp({ e2eHooks: true });
    const client = h.client('c1');
    h.core.serve('e2e.routedRequests', () => ['https://a/']);
    expect(await client.main.request('e2e.routedRequests', {})).toEqual(['https://a/']);
  });

  it('keep core\'s secrets in the acting client\'s namespace for the host, and refuse provider keys', async () => {
    const h = setUp();
    const client = h.client('c1', 'host-a');
    const store = new Map<string, string>([['remote/host-a/mcp.token', 'secret'], ['remote/other/x', 'y'], ['remote/host-a/damocles.openai.apiKey', 'sk-client']]);
    client.main.serve('secrets.get', ({ key }) => store.get(key));
    client.main.serve('secrets.store', ({ key, value }) => { store.set(key, value); });
    client.main.serve('secrets.keys', () => [...store.keys()]);
    expect(await h.core.request('secrets.get', { key: 'mcp.token' })).toBe('secret');
    await h.core.request('secrets.store', { key: 'mcp.other', value: 'v' });
    expect(store.get('remote/host-a/mcp.other')).toBe('v');
    expect([...await h.core.request('secrets.keys', {})].sort()).toEqual(['mcp.other', 'mcp.token']);
    for (const key of ['damocles.openai.apiKey', 'damocles.explore.apiKey.openrouter']) {
      expect(await h.core.request('secrets.get', { key })).toBeUndefined();
      await expect(h.core.request('secrets.store', { key, value: 'k' })).rejects.toThrow('provider key');
      await expect(h.core.request('secrets.delete', { key })).rejects.toThrow('provider key');
    }
    const changed = vi.fn();
    h.core.onEvent('secrets.changed', changed);
    client.main.emit('secrets.changed', { key: 'remote/other/x' });
    client.main.emit('secrets.changed', { key: 'remote/host-a/mcp.token' });
    expect(changed.mock.calls).toEqual([[{ key: 'mcp.token' }]]);
    expect(h.secrets.has('mcp.token')).toBe(false);
  });

  it('rebuild a fault from core and send it on to the client by name', async () => {
    const h = setUp();
    const client = h.client('c1');
    h.core.serve('scm.call', () => {
      throw new GitError('git failed', 128, '', 'fatal: no');
    });
    const failure = await client.main.request('scm.call', { method: 'fetch', args: [] }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(GitError);
    expect((failure as GitError).exitCode).toBe(128);
  });

  it('give a fresh endpoint the materialized mirrors as deltas from version 1, chats only of its own views', async () => {
    const h = setUp();
    const first = h.client('c1');
    h.core.serve('chats.restore', () => undefined);
    await first.main.request('chats.restore', { viewId: 'view-1' });
    h.core.publish('folderTargets', { defaultKey: '/srv/app', targets: [] });
    h.core.publish('worktrees', { records: [] });
    h.core.publish('chats', { panelId: 'panel-1', entry: entry('panel-1', 'view-1') });
    h.core.publish('chats', { panelId: 'panel-2', entry: entry('panel-2', 'view-2') });
    h.core.publish('scm', { kind: 'view', projectKey: '/srv/app', view: { state: 'ready' } });
    h.core.publish('scm', { kind: 'repository', repoId: 'repo-1', repository: { projectKey: '/srv/app', projectPath: '/srv/app', kind: 'root', root: '/srv/app', gitDir: '/srv/app/.git', commonDir: '/srv/app/.git', snapshot: {} } });
    h.core.publish('scm', { kind: 'repositoryState', repoId: 'repo-1', busy: true, running: null, lastRemote: null });
    h.core.publish('scm', { kind: 'clone', state: { phase: 'idle' } });

    // a second endpoint, as a reattach gets, sees every topic from version 1 (the endpoint refuses any other version)
    const seen: Array<[string, unknown]> = [];
    const loop = createLoopback();
    const main = createMainEndpoint(loop.main, quiet, (error) => { throw error; });
    for (const topic of ['folderTargets', 'worktrees', 'chats', 'scm'] as const) main.onMirror(topic, (patch) => seen.push([topic, patch]));
    const close = vi.fn();
    h.router.attach({ id: 'c2', clientId: 'c2', hostId: 'h2', transport: loop.core, mirrors: emptyMirrors, close, drained: () => Promise.resolve(), lost: () => false, onLostChange: () => ({ dispose: () => undefined }) });
    expect(seen.map(([topic]) => topic)).toEqual(['folderTargets', 'worktrees', 'scm', 'scm', 'scm', 'scm']);
    expect(close).not.toHaveBeenCalled();

    // a reattach under the same id starts with no views, so it gets no chats until it joins them
    const chats: unknown[] = [];
    const third = createLoopback();
    const thirdMain = createMainEndpoint(third.main, quiet);
    thirdMain.onMirror('chats', (patch) => chats.push(patch));
    const attached = h.router.attach({ id: 'c1', clientId: 'c1', hostId: 'h1', transport: third.core, mirrors: emptyMirrors, close: vi.fn(), drained: () => Promise.resolve(), lost: () => false, onLostChange: () => ({ dispose: () => undefined }) });
    expect(chats).toEqual([]);
    attached.dispose();
  });

  it('send each client the chats of the panels it views and never another client\'s', async () => {
    const h = setUp();
    h.core.serve('chats.restore', () => undefined);
    const first = h.client('c1');
    const second = h.client('c2');
    const seen: Record<string, unknown[]> = { c1: [], c2: [] };
    first.main.onMirror('chats', (patch) => seen['c1']!.push(patch));
    second.main.onMirror('chats', (patch) => seen['c2']!.push(patch));
    await first.main.request('chats.restore', { viewId: 'view-1' });
    await second.main.request('chats.restore', { viewId: 'view-2' });
    h.core.publish('chats', { panelId: 'panel-1', entry: entry('panel-1', 'view-1') });
    h.core.publish('chats', { panelId: 'panel-2', entry: entry('panel-2', 'view-2') });
    expect(seen['c1']).toEqual([{ panelId: 'panel-1', entry: entry('panel-1', 'view-1') }]);
    expect(seen['c2']).toEqual([{ panelId: 'panel-2', entry: entry('panel-2', 'view-2') }]);
  });

  it('publish the latest folder set when an earlier one still asks whether a leaving folder is busy', async () => {
    const h = setUp();
    const published: unknown[] = [];
    h.core.onMirror('folders', (patch) => published.push(patch));
    const answers: Array<(busy: boolean) => void> = [];
    h.core.serve('chats.projectBusy', () => new Promise<boolean>((resolve) => answers.push(resolve)));
    const client = h.client('c1');
    const x = { fsPath: '/srv/x', name: 'x' };
    client.main.publish('folders', { folders: [x] });
    await flush();
    client.main.publish('folders', { folders: [] });
    await flush();
    client.main.publish('folders', { folders: [x] });
    await flush();
    expect(answers).toHaveLength(1);
    answers[0]!(false);
    await flush();
    expect(published.at(-1)).toEqual({ folders: [x] });
  });

  it('give core the acting client\'s client state, and the last attached client\'s language once a later one detaches', async () => {
    const h = setUp();
    const state: unknown[] = [];
    const language: unknown[] = [];
    h.core.onMirror('state', (patch) => state.push(patch));
    h.core.onMirror('language', (patch) => language.push(patch));
    const first = h.client('c1');
    first.main.publish('state', { scope: 'global', key: LANGUAGE_PREFERENCE_KEY, value: 'el' });
    first.main.publish('language', { language: 'el' });
    const second = h.client('c2');
    second.main.publish('state', { scope: 'global', key: LANGUAGE_PREFERENCE_KEY, value: 'en' });
    expect(state.at(-1)).toEqual({ scope: 'global', key: LANGUAGE_PREFERENCE_KEY, value: 'en' });
    expect(language.at(-1)).toEqual({ language: 'en' });
    // c1 acts: core has its value before its message
    await first.main.request('catalog.list', { projectKey: '/srv/app', complete: false }).catch(() => undefined);
    expect(state.at(-1)).toEqual({ scope: 'global', key: LANGUAGE_PREFERENCE_KEY, value: 'el' });
    second.detach();
    expect(language.at(-1)).toEqual({ language: 'el' });
  });

  it('let a detached client go, its listeners included', async () => {
    setFlagsFromString('--expose_gc');
    const gc = runInNewContext('gc') as () => void;
    const h = setUp();
    const attach = (): WeakRef<object> => {
      const loop = createLoopback();
      const attached = h.router.attach({ id: 'gone', clientId: 'gone', hostId: 'h1', transport: loop.core, mirrors: emptyMirrors, close: () => undefined, drained: () => Promise.resolve(), lost: () => false, onLostChange: () => ({ dispose: () => undefined }) });
      attached.dispose();
      return new WeakRef(loop.core);
    };
    const transport = attach();
    for (let round = 0; round < 3 && transport.deref() !== undefined; round++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      gc();
    }
    expect(transport.deref()).toBeUndefined();
  });

  it('close only the client whose channel carries a malformed envelope', async () => {
    const h = setUp();
    const bad = h.client('bad');
    const good = h.client('good');
    good.main.serve('notifications.show', () => 'ok');
    expect(() => bad.raw.post({ kind: 'request', id: 'x' })).not.toThrow();
    expect(bad.close).toHaveBeenCalled();
    expect(good.close).not.toHaveBeenCalled();
    expect(await h.core.request('notifications.show', { severity: 'info', message: 'hi', actions: [] })).toBe('ok');
  });

  it('answer views.drained once the viewing client\'s core channel drained, and at once for a view no client shows', async () => {
    const h = setUp();
    let release!: () => void;
    h.client('c1', 'h1', () => new Promise<void>((resolve) => (release = resolve)));
    h.core.postPanel('view-1', 'create', { kind: 'chat', title: 'Replay', localResourceRoots: [] });
    await expect(h.core.request('views.drained', { viewId: 'view-9' })).resolves.toBeUndefined();
    let answered = false;
    void h.core.request('views.drained', { viewId: 'view-1' }).then(() => { answered = true; });
    await flush();
    expect(answered).toBe(false);
    release();
    await vi.waitFor(() => expect(answered).toBe(true));
  });

  it('drive the run registry only from chat.activity and chat.turnSettled, under the chat\'s title', async () => {
    const h = setUp();
    h.client('c1');
    h.core.postPanel('view-1', 'create', { kind: 'chat', title: 'Fix the parser', localResourceRoots: [] });
    h.core.publish('chats', { panelId: 'panel-1', entry: entry('panel-1', 'view-1') });
    h.core.emit('chat.changes', { panelId: 'panel-1', totals: {}, generation: 1 });
    h.core.emit('chat.worktreeState', { event: { panelId: 'panel-1', projectPath: '/srv/app', workingFolder: '/srv/app', busy: true, state: { phase: 'ready', place: 'project', canHandOff: false } } } as never);
    expect(h.registry.isEmpty()).toBe(true);
    h.core.emit('chat.activity', { panelId: 'panel-1', activity: { state: 'running', pendingKinds: [], pendingPrompts: [], background: false } });
    expect(h.registry.runs()).toEqual([{ kind: 'chat', id: 'panel-1', projectKey: '/srv/app', title: 'Fix the parser', state: 'running', providers: [] }]);
    h.core.postPanel('view-1', 'setTitle', { title: 'Parser fixed' });
    h.core.emit('chat.activity', { panelId: 'panel-1', activity: { state: 'running', pendingKinds: [], pendingPrompts: [], background: false } });
    expect(h.registry.runs()[0]?.title).toBe('Parser fixed');
    h.core.emit('chat.turnSettled', { panelId: 'panel-1', outcome: { kind: 'completed' } });
    expect(h.registry.isEmpty()).toBe(true);
  });

  it('give a run to the client whose work started it, else to the acting client', async () => {
    const h = setUp();
    h.client('connection-1', 'h1', () => Promise.resolve(), 'device-a');
    h.client('connection-2', 'h1', () => Promise.resolve(), 'device-b');
    const running = { state: 'running', pendingKinds: [], pendingPrompts: [], background: false } as const;
    processActor.run('device-a', () => h.core.emit('chat.activity', { panelId: 'panel-1', activity: running }));
    h.core.emit('chat.activity', { panelId: 'panel-2', activity: running });
    await flush();
    expect(h.registry.ownRuns('device-a').map((run) => run.id)).toEqual(['panel-1']);
    expect(h.registry.ownRuns('device-b').map((run) => run.id)).toEqual(['panel-2']);
  });

  it('keep a detached panel while its turn runs and dispose it once the turn settles', async () => {
    const h = setUp();
    const client = h.client('c1');
    const disposed: unknown[] = [];
    h.core.onPanel((viewId, envelope) => {
      if (envelope.op === 'disposed') disposed.push([viewId, envelope.op, envelope.payload]);
    });
    h.core.serve('chats.restore', () => undefined);
    await client.main.request('chats.restore', { viewId: 'view-1' });
    h.core.publish('chats', { panelId: 'panel-1', entry: entry('panel-1', 'view-1') });
    h.core.emit('chat.activity', { panelId: 'panel-1', activity: { state: 'running', pendingKinds: [], pendingPrompts: [], background: false } });
    client.detach();
    expect(disposed).toEqual([]);
    h.core.emit('chat.turnSettled', { panelId: 'panel-1', outcome: { kind: 'completed' } });
    expect(disposed).toEqual([['view-1', 'disposed', { reason: 'detach' }]]);
  });

  it('dispose a panel at once on a user close, and refuse an unload while a run holds it', async () => {
    const h = setUp();
    const client = h.client('c1');
    const ops: unknown[] = [];
    h.core.onPanel((viewId, envelope) => {
      if (envelope.op === 'disposed') ops.push([viewId, envelope.op, envelope.payload]);
    });
    h.core.serve('chats.restore', () => undefined);
    const unload = vi.fn(() => true);
    h.core.serve('chats.unload', unload);
    await client.main.request('chats.restore', { viewId: 'view-1' });
    h.core.publish('chats', { panelId: 'panel-1', entry: entry('panel-1', 'view-1') });
    h.core.emit('chat.activity', { panelId: 'panel-1', activity: { state: 'running', pendingKinds: [], pendingPrompts: [], background: false } });
    expect(await client.main.request('chats.unload', { viewId: 'view-1', empty: false })).toBe(false);
    expect(unload).not.toHaveBeenCalled();
    client.main.postPanel('view-1', 'disposed', { reason: 'user' });
    expect(ops).toEqual([['view-1', 'disposed', { reason: 'user' }]]);
  });

  it('rejoin a view by its panel token under the client\'s new view id', async () => {
    const h = setUp();
    const client = h.client('c1');
    h.core.serve('chats.restore', () => undefined);
    await client.main.request('chats.restore', { viewId: 'view-1' });
    const messages: unknown[] = [];
    h.core.onPanel((viewId, envelope) => messages.push([viewId, envelope.op]));
    client.main.postPanel('view-1', 'message', { message: { type: 'ready', panelToken: 'token-1' } });
    h.core.publish('chats', { panelId: 'panel-1', entry: entry('panel-1', 'view-1') });
    h.core.emit('chat.activity', { panelId: 'panel-1', activity: { state: 'running', pendingKinds: [], pendingPrompts: [], background: false } });
    client.detach();

    const again = h.client('c1');
    const joins: unknown[] = [];
    h.core.serve('views.join', (params) => {
      joins.push(params);
      return { panelId: 'panel-1' };
    });
    const posted: unknown[] = [];
    again.main.onPanel((viewId, envelope) => posted.push([viewId, envelope.op]));
    const chats: unknown[] = [];
    again.main.onMirror('chats', (patch) => chats.push(patch));
    expect(await again.main.request('views.join', { viewId: 'view-9', viewKey: 'unknown' })).toBeNull();
    expect(await again.main.request('views.join', { viewId: 'view-2', viewKey: 'token-1' })).toEqual({ panelId: 'panel-1' });
    expect(joins).toEqual([{ viewId: 'view-1', viewKey: 'token-1', joining: 'view-2' }]);
    expect(chats).toEqual([{ panelId: 'panel-1', entry: { ...entry('panel-1', 'view-1'), viewId: 'view-2' } }]);
    h.core.postPanel('view-1', 'post', { type: 'partial', json: '{}' });
    expect(posted).toEqual([['view-2', 'post']]);
    again.main.postPanel('view-2', 'message', { message: { type: 'x' } });
    expect(messages.at(-1)).toEqual(['view-1', 'message']);
    await flush();
  });

  it('map settings attachments per client', async () => {
    const h = setUp();
    const first = h.client('c1');
    const second = h.client('c2');
    const attached: Array<{ attachment: number }> = [];
    h.core.serve('settingsView.attach', (params) => { attached.push(params); });
    await first.main.request('settingsView.attach', { panelId: 'panel-1', attachment: 1 });
    await second.main.request('settingsView.attach', { panelId: 'panel-2', attachment: 1, scope: 'machine' });
    expect(new Set(attached.map((params) => params.attachment)).size).toBe(2);
    await expect(first.main.request('settingsView.attach', { panelId: 'panel-1', attachment: 1 })).rejects.toThrow('already attached');
    const posts: unknown[] = [];
    second.main.onEvent('settingsView.post', (payload) => posts.push(payload));
    first.main.onEvent('settingsView.post', () => posts.push('wrong client'));
    h.core.emit('settingsView.post', { attachment: attached[1]!.attachment, message: { type: 'x' } });
    expect(posts).toEqual([{ attachment: 1, message: { type: 'x' } }]);
  });

  it('refuse a browser page core opens', async () => {
    const h = setUp();
    const client = h.client('c1');
    const created = vi.fn();
    client.main.onPanel(created);
    const ops: unknown[] = [];
    h.core.onPanel((viewId, envelope) => ops.push([viewId, envelope.op]));
    h.core.postPanel('page-1', 'create', { kind: 'browser', title: 'x', localResourceRoots: [] });
    expect(created).not.toHaveBeenCalled();
    expect(ops).toEqual([['page-1', 'disposed']]);
  });

  it('answer network.resolveProxy itself and restart core for lifecycle.reload', async () => {
    const h = setUp();
    expect(await h.core.request('network.resolveProxy', { url: 'https://a/' })).toBe('DIRECT');
    await h.core.request('lifecycle.reload', {});
    await flush();
    expect(h.reload).toHaveBeenCalledTimes(1);
  });
});

describe('a client the wire refuses a message for', () => {
  const OVERSIZED = 'oversized-marker';

  // a client whose transport refuses any message carrying OVERSIZED, as the wire refuses one over its bound
  function boundedClient(h: Harness, id: string): { readonly main: MainEndpoint; readonly close: ReturnType<typeof vi.fn> } {
    const loop = createLoopback();
    const close = vi.fn();
    const main = createMainEndpoint(loop.main, quiet, (error) => { throw error; });
    const transport = {
      post: (message: unknown): void => {
        if (JSON.stringify(message).includes(OVERSIZED)) throw new CodecError('a message over the bound');
        loop.core.post(message);
      },
      onMessage: loop.core.onMessage,
    };
    h.router.attach({ id, clientId: id, hostId: 'h1', transport, mirrors: emptyMirrors, close, drained: () => Promise.resolve(), lost: () => false, onLostChange: () => ({ dispose: () => undefined }) });
    return { main, close };
  }

  it('is closed alone: the other clients get every mirror patch and event, and the closed one nothing more', () => {
    const h = setUp();
    const bounded = boundedClient(h, 'c1');
    const other = h.client('c2');
    const seen: Record<string, unknown[]> = { c1: [], c2: [] };
    bounded.main.onMirror('scm', (patch) => seen['c1']!.push(patch));
    other.main.onMirror('scm', (patch) => seen['c2']!.push(patch));
    bounded.main.onEvent('chat.turnSettled', (payload) => seen['c1']!.push(payload));
    other.main.onEvent('chat.turnSettled', (payload) => seen['c2']!.push(payload));
    const oversized = { kind: 'view' as const, projectKey: '/srv/app', view: { state: 'ready', note: OVERSIZED } };
    const next = { kind: 'view' as const, projectKey: '/srv/app', view: { state: 'ready' } };
    h.core.publish('scm', oversized);
    h.core.publish('scm', next);
    h.core.emit('chat.turnSettled', { panelId: 'panel-1', outcome: 'done' });
    expect(seen['c2']).toEqual([oversized, next, { panelId: 'panel-1', outcome: 'done' }]);
    expect(seen['c1']).toEqual([]);
    expect(bounded.close).toHaveBeenCalledExactlyOnceWith('a message over the bound');
    expect(other.close).not.toHaveBeenCalled();
  });

  it('is closed when an event for all clients is refused, and the clients after it still get that event', () => {
    const h = setUp();
    const bounded = boundedClient(h, 'c1');
    const other = h.client('c2');
    const events: unknown[] = [];
    other.main.onEvent('chat.turnSettled', (payload) => events.push(payload));
    h.core.emit('chat.turnSettled', { panelId: OVERSIZED, outcome: 'done' });
    expect(events).toEqual([{ panelId: OVERSIZED, outcome: 'done' }]);
    expect(bounded.close).toHaveBeenCalledOnce();
  });

  it('is closed when its snapshot is refused', () => {
    const h = setUp();
    h.core.publish('folderTargets', { defaultKey: '/srv/app', targets: [{ key: '/srv/app', fsPath: '/srv/app', name: OVERSIZED, label: 'app', projectScope: true }] });
    expect(boundedClient(h, 'c1').close).toHaveBeenCalledOnce();
  });

  it('is closed when a post to a view it shows is refused', async () => {
    const h = setUp();
    h.core.serve('chats.restore', () => undefined);
    const bounded = boundedClient(h, 'c1');
    await bounded.main.request('chats.restore', { viewId: 'view-1' });
    h.core.postPanel('view-1', 'post', { type: 'x', json: OVERSIZED });
    expect(bounded.close).toHaveBeenCalledOnce();
  });
});

describe('several clients', () => {
  // client a shows panel-1 in view-1 (its page holds token-1); client b joins it by its stored session
  async function shared(h: Harness, drainedB?: () => Promise<void>) {
    h.core.serve('chats.restore', () => undefined);
    const joins: Array<Record<string, unknown>> = [];
    h.core.serve('views.join', (params) => {
      joins.push(params);
      return { panelId: 'panel-1' };
    });
    const a = h.client('connection-1', 'h1', () => Promise.resolve(), 'device-a');
    await a.main.request('chats.restore', { viewId: 'view-1' });
    a.main.postPanel('view-1', 'message', { message: { type: 'ready', panelToken: 'token-1' } });
    h.core.publish('chats', { panelId: 'panel-1', entry: entry('panel-1', 'view-1') });
    const b = h.client('connection-2', 'h1', drainedB, 'device-b');
    expect(await b.main.request('views.join', { viewId: 'view-b', viewKey: 'token-of-b', sessionId: 'S1' })).toEqual({ panelId: 'panel-1' });
    const keyOfB = joins[0]!['joining'] as string;
    return { a, b, joins, keyOfB };
  }

  it('let another device join a panel a client views, by the stored session it holds, with the panel\'s own token', async () => {
    const h = setUp();
    const { b, joins } = await shared(h);
    expect(joins).toEqual([{ viewId: 'view-1', viewKey: 'token-1', joining: expect.stringMatching(/^view-\d+$/) }]);
    const chats: unknown[] = [];
    b.main.onMirror('chats', (patch) => chats.push(patch));
    h.core.publish('chats', { panelId: 'panel-1', entry: entry('panel-1', 'view-1') });
    expect(chats).toEqual([{ panelId: 'panel-1', entry: { ...entry('panel-1', 'view-1'), viewId: 'view-b' } }]);
  });

  it('fan panel ops out to every view, a keyed post to that view alone and an except post to the others', async () => {
    const h = setUp();
    const { a, b, keyOfB } = await shared(h);
    const seen: Array<[string, string, string, unknown]> = [];
    a.main.onPanel((viewId, envelope) => seen.push(['a', viewId, envelope.op, envelope.payload]));
    b.main.onPanel((viewId, envelope) => seen.push(['b', viewId, envelope.op, envelope.payload]));
    h.core.postPanel('view-1', 'setTitle', { title: 'Shared' });
    h.core.postPanel('view-1', 'post', { type: 'sessionCleared', json: '{}', viewKey: keyOfB });
    h.core.postPanel('view-1', 'post', { type: 'processing', json: '{}', except: [keyOfB] });
    h.core.postPanel('view-1', 'post', { type: 'statusUpdate', json: '{}' });
    expect(seen).toEqual([
      ['a', 'view-1', 'setTitle', { title: 'Shared' }],
      ['b', 'view-b', 'setTitle', { title: 'Shared' }],
      ['b', 'view-b', 'post', { type: 'sessionCleared', json: '{}' }],
      ['a', 'view-1', 'post', { type: 'processing', json: '{}' }],
      ['a', 'view-1', 'post', { type: 'statusUpdate', json: '{}' }],
      ['b', 'view-b', 'post', { type: 'statusUpdate', json: '{}' }],
    ]);
  });

  it('stamp each message with the key of the view that sent it, over any key a client put there', async () => {
    const h = setUp();
    const { a, b, keyOfB } = await shared(h);
    const messages: unknown[] = [];
    h.core.onPanel((viewId, envelope) => messages.push([viewId, envelope.payload]));
    b.main.postPanel('view-b', 'message', { message: { type: 'sendMessage' }, viewKey: 'view-forged' });
    a.main.postPanel('view-1', 'message', { message: { type: 'sendMessage' } });
    const keyOfA = (messages[1] as [string, { viewKey?: string }])[1].viewKey;
    expect(messages).toEqual([
      ['view-1', { message: { type: 'sendMessage' }, viewKey: keyOfB }],
      ['view-1', { message: { type: 'sendMessage' }, viewKey: keyOfA }],
    ]);
    expect(typeof keyOfA).toBe('string');
    expect(keyOfA).not.toBe(keyOfB);
    // the key a's message carried is the one core reaches a's view alone by
    const seen: string[] = [];
    a.main.onPanel(() => seen.push('a'));
    b.main.onPanel(() => seen.push('b'));
    h.core.postPanel('view-1', 'post', { type: 'x', json: '{}', viewKey: keyOfA! });
    expect(seen).toEqual(['a']);
  });

  it('keep a panel another client still shows when one closes or detaches from it', async () => {
    const h = setUp();
    const { a, b } = await shared(h);
    const ops: unknown[] = [];
    h.core.onPanel((viewId, envelope) => {
      if (envelope.op === 'disposed') ops.push([viewId, envelope.op, envelope.payload]);
    });
    b.main.postPanel('view-b', 'disposed', { reason: 'user' });
    const c = h.client('connection-3', 'h1', () => Promise.resolve(), 'device-c');
    expect(await c.main.request('views.join', { viewId: 'view-c', viewKey: 'token-1' })).toEqual({ panelId: 'panel-1' });
    a.detach();
    expect(ops).toEqual([]);
    c.main.postPanel('view-c', 'disposed', { reason: 'user' });
    expect(ops).toEqual([['view-1', 'disposed', { reason: 'user' }]]);
  });

  it('answer a view\'s keyed views.drained once that view\'s client drained, whatever the other clients\' queues', async () => {
    const h = setUp();
    let releaseB!: () => void;
    const backlog = new Promise<void>((resolve) => (releaseB = resolve));
    const { keyOfB } = await shared(h, () => backlog);
    let keyed = false;
    let everyone = false;
    void h.core.request('views.drained', { viewId: 'view-1', viewKey: keyOfB }).then(() => { keyed = true; });
    void h.core.request('views.drained', { viewId: 'view-1' }).then(() => { everyone = true; });
    await flush();
    expect([keyed, everyone]).toEqual([false, false]);
    releaseB();
    await vi.waitFor(() => expect([keyed, everyone]).toEqual([true, true]));
  });

  it("answer a's keyed views.drained at once while only b's channel is backed up", async () => {
    const h = setUp();
    const { a } = await shared(h, () => new Promise<void>(() => undefined));
    const keys: string[] = [];
    h.core.onPanel((_viewId, envelope) => {
      const key = (envelope.payload as { viewKey?: string }).viewKey;
      if (key !== undefined) keys.push(key);
    });
    a.main.postPanel('view-1', 'message', { message: { type: 'x' } });
    await expect(h.core.request('views.drained', { viewId: 'view-1', viewKey: keys[0]! })).resolves.toBeUndefined();
  });

  it('close only the unloading client\'s view of a panel another client still shows, without asking core', async () => {
    const h = setUp();
    const { a, b } = await shared(h);
    const unload = vi.fn(() => true);
    h.core.serve('chats.unload', unload);
    const toCore: Array<[string, string]> = [];
    h.core.onPanel((viewId, envelope) => toCore.push([viewId, envelope.op]));
    const toA: unknown[] = [];
    const toB: unknown[] = [];
    a.main.onPanel((viewId, envelope) => toA.push([viewId, envelope.op]));
    b.main.onPanel((viewId, envelope) => toB.push([viewId, envelope.op]));
    const chatsOfA: unknown[] = [];
    a.main.onMirror('chats', (patch) => chatsOfA.push(patch));
    expect(await a.main.request('chats.unload', { viewId: 'view-1', empty: false })).toBe(true);
    expect(unload).not.toHaveBeenCalled();
    expect(toA).toEqual([['view-1', 'close']]);
    expect(chatsOfA).toEqual([{ panelId: 'panel-1' }]);
    expect(toCore.filter(([, op]) => op === 'disposed')).toEqual([]);
    h.core.postPanel('view-1', 'post', { type: 'x', json: '{}' });
    expect(toB).toEqual([['view-b', 'post']]);
    expect(toA).toEqual([['view-1', 'close']]);
    // the last view's unload is core's to decide
    expect(await b.main.request('chats.unload', { viewId: 'view-b', empty: false })).toBe(true);
    expect(unload).toHaveBeenCalledWith({ viewId: 'view-1', empty: false }, expect.anything());
  });

  it('tell core a view is gone when its client lets go of a panel that stays, so core forgets its key', async () => {
    const h = setUp();
    const { b, keyOfB } = await shared(h);
    const toCore: unknown[] = [];
    h.core.onPanel((viewId, envelope) => toCore.push([viewId, envelope.op, envelope.payload]));
    b.main.postPanel('view-b', 'disposed', { reason: 'detach' });
    expect(toCore).toEqual([['view-1', 'viewDetached', { viewKey: keyOfB }]]);
  });

  it('drop a client\'s viewDetached, which only the daemon sends', async () => {
    const h = setUp();
    const { a } = await shared(h);
    const toCore: unknown[] = [];
    h.core.onPanel((viewId, envelope) => toCore.push([viewId, envelope.op]));
    a.main.postPanel('view-1', 'viewDetached', { viewKey: 'view-1' });
    expect(toCore).toEqual([]);
  });

  it('send a binary post with a view key to that view alone and one with except to the others, without either field', async () => {
    const h = setUp();
    const { a, b, keyOfB } = await shared(h);
    const seen: unknown[] = [];
    a.main.onPanel((_viewId, envelope) => seen.push(['a', envelope.op, envelope.payload]));
    b.main.onPanel((_viewId, envelope) => seen.push(['b', envelope.op, envelope.payload]));
    h.core.postPanel('view-1', 'postBinary', { message: { type: 'frame', n: 1 }, viewKey: keyOfB });
    h.core.postPanel('view-1', 'postBinary', { message: { type: 'frame', n: 2 }, except: [keyOfB] });
    expect(seen).toEqual([
      ['b', 'postBinary', { message: { type: 'frame', n: 1 } }],
      ['a', 'postBinary', { message: { type: 'frame', n: 2 } }],
    ]);
  });

  it('refuse a restore of a view another client shows, which only views.join joins', async () => {
    const h = setUp();
    const { b } = await shared(h);
    let restores = 0;
    h.core.serve('chats.restore', () => {
      restores++;
    });
    await expect(b.main.request('chats.restore', { viewId: 'view-1' })).rejects.toThrow('belongs to another client');
    expect(restores).toBe(0);
  });

  it('keep a view a client already shows when its rejoin finds no panel or fails', async () => {
    const h = setUp();
    const { a } = await shared(h);
    const toA: unknown[] = [];
    a.main.onPanel((viewId, envelope) => toA.push([viewId, envelope.op]));
    h.core.serve('views.join', () => null);
    expect(await a.main.request('views.join', { viewId: 'view-1', viewKey: 'token-1' })).toBeNull();
    h.core.serve('views.join', () => {
      throw new Error('core failed');
    });
    await expect(a.main.request('views.join', { viewId: 'view-1', viewKey: 'token-1' })).rejects.toThrow('core failed');
    h.core.postPanel('view-1', 'post', { type: 'x', json: '{}' });
    expect(toA).toEqual([['view-1', 'post']]);
  });
});

describe('a client inside its reconnection grace', () => {
  it('is absent for a credential ask, and answers again once it resumed', async () => {
    const h = setUp();
    const a = h.client('connection-1', 'h1', () => Promise.resolve(), 'device-a');
    a.main.serve('user.credentials', () => ({ type: 'api_key' as const, key: 'from-a' }));
    a.lose();
    await expect(h.core.request('user.credentials', { provider: 'anthropic', clientId: 'device-a' })).rejects.toThrow('credential-client-absent');
    a.resume();
    expect(await h.core.request('user.credentials', { provider: 'anthropic', clientId: 'device-a' })).toEqual({ type: 'api_key', key: 'from-a' });
  });

  it('makes a credential ask it was answering fail as absent the moment it is lost', async () => {
    const h = setUp();
    const a = h.client('connection-1', 'h1', () => Promise.resolve(), 'device-a');
    let asked!: () => void;
    const pending = new Promise<void>((resolve) => (asked = resolve));
    a.main.serve('user.credentials', async () => {
      asked();
      return new Promise<never>(() => undefined);
    });
    const answer = h.core.request('user.credentials', { provider: 'anthropic', clientId: 'device-a' });
    await pending;
    a.lose();
    await expect(answer).rejects.toThrow('credential-client-absent');
  });

  it('reads as detached to core while lost and attached again on its resume, so core re-asks a turn waiting for it', async () => {
    const h = setUp();
    const auth: unknown[] = [];
    h.core.onMirror('clientAuth', (patch) => auth.push(patch));
    const a = h.client('connection-1', 'h1', () => Promise.resolve(), 'device-a');
    await flush();
    auth.length = 0;
    a.lose();
    await flush();
    expect(auth).toEqual([{ clientId: 'device-a' }]);
    a.resume();
    await flush();
    expect(auth).toEqual([{ clientId: 'device-a' }, { clientId: 'device-a', value: emptyMirrors.clientAuth }]);
  });

  it('is not waited for by an unkeyed views.drained, also when it is lost while the ask waits', async () => {
    const h = setUp();
    const { b } = await (async () => {
      h.core.serve('chats.restore', () => undefined);
      h.core.serve('views.join', () => ({ panelId: 'panel-1' }));
      const first = h.client('connection-1', 'h1', () => Promise.resolve(), 'device-a');
      await first.main.request('chats.restore', { viewId: 'view-1' });
      first.main.postPanel('view-1', 'message', { message: { type: 'ready', panelToken: 'token-1' } });
      h.core.publish('chats', { panelId: 'panel-1', entry: entry('panel-1', 'view-1') });
      const second = h.client('connection-2', 'h1', () => new Promise<void>(() => undefined), 'device-b');
      await second.main.request('views.join', { viewId: 'view-b', viewKey: 'token-1' });
      return { b: second };
    })();
    b.lose();
    await expect(h.core.request('views.drained', { viewId: 'view-1' })).resolves.toBeUndefined();
    b.resume();
    let answered = false;
    void h.core.request('views.drained', { viewId: 'view-1' }).then(() => { answered = true; });
    await flush();
    expect(answered).toBe(false);
    b.lose();
    await vi.waitFor(() => expect(answered).toBe(true));
  });

  it('is not waited for by a keyed views.drained of its view, so a join to it ends while it is away', async () => {
    const h = setUp();
    h.core.serve('chats.restore', () => undefined);
    const joins: Array<Record<string, unknown>> = [];
    h.core.serve('views.join', (params) => {
      joins.push(params);
      return { panelId: 'panel-1' };
    });
    const a = h.client('connection-1', 'h1', () => Promise.resolve(), 'device-a');
    await a.main.request('chats.restore', { viewId: 'view-1' });
    a.main.postPanel('view-1', 'message', { message: { type: 'ready', panelToken: 'token-1' } });
    h.core.publish('chats', { panelId: 'panel-1', entry: entry('panel-1', 'view-1') });
    const b = h.client('connection-2', 'h1', () => new Promise<void>(() => undefined), 'device-b');
    await b.main.request('views.join', { viewId: 'view-b', viewKey: 'token-1' });
    const keyOfB = joins[0]!['joining'] as string;
    let answered = false;
    void h.core.request('views.drained', { viewId: 'view-1', viewKey: keyOfB }).then(() => { answered = true; });
    await flush();
    expect(answered).toBe(false);
    b.lose();
    await vi.waitFor(() => expect(answered).toBe(true));
    await expect(h.core.request('views.drained', { viewId: 'view-1', viewKey: keyOfB })).resolves.toBeUndefined();
  });

  it('is left out of the clientAuth and actingClient mirrors a restarted core starts from, and back in them on its resume', async () => {
    const h = setUp();
    const b = h.client('connection-2', 'h1', () => Promise.resolve(), 'device-b');
    const a = h.client('connection-1', 'h1', () => Promise.resolve(), 'device-a');
    await flush();
    expect(h.mirrors.actingClient).toEqual({ clientId: 'device-a' });
    a.lose();
    expect([...h.mirrors.clientAuth.keys()]).toEqual(['device-b']);
    expect(h.mirrors.actingClient).toEqual({ clientId: 'device-b' });
    b.lose();
    expect([...h.mirrors.clientAuth.keys()]).toEqual([]);
    expect(h.mirrors.actingClient).toEqual({});
    a.resume();
    expect(h.mirrors.clientAuth.get('device-a')).toEqual(emptyMirrors.clientAuth);
    expect(h.mirrors.actingClient).toEqual({ clientId: 'device-a' });
  });

  it('gets no request while it is the actor or acting client: another attached client does, else none', async () => {
    const h = setUp();
    const a = h.client('c1');
    const b = h.client('c2');
    a.main.serve('notifications.show', () => 'a');
    b.main.serve('notifications.show', () => 'b');
    const ask = (): Promise<unknown> => processActor.run('c1', () => h.core.request('notifications.show', { severity: 'info', message: 'hi', actions: [] }));
    expect(await ask()).toBe('a');
    a.lose();
    expect(await ask()).toBe('b');
    b.lose();
    expect(await ask()).toBeUndefined();
  });
});

describe('the actor of core\'s work', () => {
  it('routes an acting-client event to the client whose work core emitted it from, not the client that acted last', async () => {
    const h = setUp();
    const a = h.client('c1');
    const b = h.client('c2');
    const seen: string[] = [];
    a.main.onEvent('window.toggleTerminal', () => seen.push('a'));
    b.main.onEvent('window.toggleTerminal', () => seen.push('b'));
    processActor.run('c1', () => h.core.emit('window.toggleTerminal', {}));
    h.core.emit('window.toggleTerminal', {});
    await flush();
    expect(seen).toEqual(['a', 'b']);
  });

  it('reloads core outside the actor of the client whose request asked for it', async () => {
    const h = setUp();
    h.client('c1');
    let actor: string | undefined = 'unset';
    h.reload.mockImplementation(() => {
      actor = processActor.current();
    });
    await processActor.run('c1', () => h.core.request('lifecycle.reload', {}));
    await flush();
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(actor).toBeUndefined();
  });

  it('keeps core\'s secrets in the namespace of the client whose work stores them, not the acting client\'s', async () => {
    const h = setUp();
    const a = h.client('c1', 'host-a');
    const b = h.client('c2', 'host-b');
    const stored: string[] = [];
    a.main.serve('secrets.store', ({ key }) => { stored.push(`a:${key}`); });
    b.main.serve('secrets.store', ({ key }) => { stored.push(`b:${key}`); });
    await processActor.run('c1', () => h.core.request('secrets.store', { key: 'mcp.token', value: 'v' }));
    expect(stored).toEqual(['a:remote/host-a/mcp.token']);
  });
});

describe('a device that attaches again', () => {
  it('is served user.credentials on its new connection, never by another device, and keeps its values when its old connection closes late', async () => {
    const h = setUp();
    const auth: unknown[] = [];
    h.core.onMirror('clientAuth', (patch) => auth.push(patch));
    const old = h.client('connection-1', 'h1', () => Promise.resolve(), 'device-a');
    old.main.serve('user.credentials', () => ({ type: 'api_key' as const, key: 'from-old' }));
    const other = h.client('connection-2', 'h1', () => Promise.resolve(), 'device-b');
    other.main.serve('user.credentials', () => ({ type: 'api_key' as const, key: 'from-b' }));
    const fresh = h.client('connection-3', 'h1', () => Promise.resolve(), 'device-a');
    fresh.main.serve('user.credentials', () => ({ type: 'api_key' as const, key: 'from-new' }));
    expect(await h.core.request('user.credentials', { provider: 'anthropic', clientId: 'device-a' })).toEqual({ type: 'api_key', key: 'from-new' });
    auth.length = 0;
    // the replaced connection's late close leaves the newer one's values alone
    old.detach();
    expect(auth).toEqual([]);
    fresh.detach();
    await expect(h.core.request('user.credentials', { provider: 'anthropic', clientId: 'device-a' })).rejects.toThrow('credential-client-absent');
    expect(auth).toEqual([{ clientId: 'device-a' }]);
  });

  it('makes a credential ask whose client went away while it answered fail as the client being absent', async () => {
    const h = setUp();
    const client = h.client('connection-1', 'h1', () => Promise.resolve(), 'device-a');
    let asked!: () => void;
    const pending = new Promise<void>((resolve) => (asked = resolve));
    client.main.serve('user.credentials', async () => {
      asked();
      return new Promise<never>(() => undefined);
    });
    const answer = h.core.request('user.credentials', { provider: 'anthropic', clientId: 'device-a' });
    await pending;
    client.detach();
    await expect(answer).rejects.toThrow('credential-client-absent');
  });
});
