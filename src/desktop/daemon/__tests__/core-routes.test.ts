import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitError } from '../../../core/scm/errors';
import { createCoreEndpoint, createLoopback, createMainEndpoint, type MainEndpoint } from '../../core-protocol';
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
  client(id: string, hostId?: string): { readonly main: MainEndpoint; readonly close: ReturnType<typeof vi.fn>; readonly raw: { post(message: unknown): void }; detach(): void };
}

let current: Harness | undefined;

function setUp(options: { e2eHooks?: boolean } = {}): Harness {
  const coreLoop = createLoopback();
  const daemonMain = createMainEndpoint(coreLoop.main, quiet);
  const core = createCoreEndpoint(coreLoop.core, quiet);
  const state = memoryState();
  const registry = createRunRegistry();
  const reload = vi.fn();
  const secrets = new Map<string, string | undefined>();
  const router = createCoreRouter({ core: daemonMain, state, registry, mirrors: createClientMirrors(), secrets, e2eHooks: options.e2eHooks ?? false, reload, log: quiet });
  const harness: Harness = {
    core,
    router,
    state,
    registry,
    reload,
    secrets,
    client: (id, hostId = 'h1') => {
      const loop = createLoopback();
      const close = vi.fn();
      const main = createMainEndpoint(loop.main, quiet, (error) => { throw error; });
      const attached = router.attach({ id, hostId, transport: loop.core, mirrors: emptyMirrors, close });
      return { main, close, raw: loop.main, detach: () => attached.dispose() };
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
    h.router.attach({ id: 'c2', hostId: 'h2', transport: loop.core, mirrors: emptyMirrors, close });
    expect(seen.map(([topic]) => topic)).toEqual(['folderTargets', 'worktrees', 'scm', 'scm', 'scm', 'scm']);
    expect(close).not.toHaveBeenCalled();

    // a reattach under the same id starts with no views, so it gets no chats until it joins them
    const chats: unknown[] = [];
    const third = createLoopback();
    const thirdMain = createMainEndpoint(third.main, quiet);
    thirdMain.onMirror('chats', (patch) => chats.push(patch));
    const attached = h.router.attach({ id: 'c1', hostId: 'h1', transport: third.core, mirrors: emptyMirrors, close: vi.fn() });
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
      const attached = h.router.attach({ id: 'gone', hostId: 'h1', transport: loop.core, mirrors: emptyMirrors, close: () => undefined });
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

  it('keep a detached panel while its turn runs and dispose it once the turn settles', async () => {
    const h = setUp();
    const client = h.client('c1');
    const disposed: unknown[] = [];
    h.core.onPanel((viewId, envelope) => disposed.push([viewId, envelope.op, envelope.payload]));
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
    h.core.onPanel((viewId, envelope) => ops.push([viewId, envelope.op, envelope.payload]));
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
    expect(joins).toEqual([{ viewId: 'view-1', viewKey: 'token-1' }]);
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
    h.router.attach({ id, hostId: 'h1', transport, mirrors: emptyMirrors, close });
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
