import * as net from 'node:net';
import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAskpassServer } from '../../../core/scm/askpass/askpass-server';
import { GitError } from '../../../core/scm/errors';
import { credentialPrompt } from '../../core-host/askpass-prompt';
import { createCoreEndpoint, createLoopback, createMainEndpoint, processActor, type MainEndpoint } from '../../core-protocol';
import { CORE_TO_MAIN, MAIN_TO_CORE, type ChatEntry, type StateScope } from '../../core-protocol/messages';
import { LANGUAGE_PREFERENCE_KEY } from '../../../shared/language-preference';
import {
  CORE_EVENT_ROUTES,
  CORE_MIRROR_ROUTES,
  CORE_PANEL_OP_ROUTES,
  CORE_REQUEST_ROUTES,
  createClientMirrors,
  createCoreRouter,
  MAIN_EVENT_ROUTES,
  MAX_HELD_PANEL_OPS,
  MAIN_PANEL_OP_ROUTES,
  MAIN_REQUEST_ROUTES,
  MIRROR_TOPIC_ROUTES,
  type ClientMirrors,
  type CoreRouter,
} from '../core-routes';
import type { DaemonState } from '../daemon-state';
import { createRunRegistry, type RunRegistry } from '../run-registry';
import { CodecError, decode, encode } from '../../../remote/codec';
import { FEATURES } from '../../../remote/protocol-version';
import { CLIENT_FEATURE_MISSING, CREDENTIAL_CLIENT_ABSENT } from '../../../shared/remote-user';
import { DEFAULT_RENDER_MEDIA, DESIGN_JOURNEY_UPDATE_NEEDED, DESIGN_PREVIEW_CLIENT_ABSENT, DESIGN_RENDER_CLIENT_ABSENT, DESIGN_RENDER_PREDATES } from '../../../shared/design-render';

const quiet = (): void => undefined;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function memoryState(): DaemonState & { readonly writes: Array<[StateScope, string, unknown]> } {
  const writes: Array<[StateScope, string, unknown]> = [];
  return {
    writes,
    snapshot: () => ({}),
    update: async (scope, key, value) => {
      writes.push([scope, key, value]);
    },
    flush: async () => undefined,
  };
}

const emptyMirrors = {
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
  // lose and resume: the connection enters and leaves its reconnection grace
  client(id: string, options?: ClientOptions): { readonly main: MainEndpoint; readonly close: ReturnType<typeof vi.fn>; readonly raw: { post(message: unknown): void }; detach(): void; lose(): void; resume(): void };
}

interface ClientOptions {
  readonly hostId?: string;
  readonly drained?: (() => Promise<void>) | undefined;
  // the hello's; the connection id when absent
  readonly clientId?: string;
  // the names of FEATURES its attach listed; none when absent, as an app that predates core.attachFeatures
  readonly features?: readonly string[] | undefined;
  // runs before the attach, so what the attach delivers (a held intent) finds its handlers
  readonly before?: (main: MainEndpoint) => void;
  // its transport refuses any message carrying this text, as the wire refuses one over its bound
  readonly refuses?: string;
}

// an app that renders designs but predates journeys and design.openPreview
const RENDER_FEATURES = ['design.capture', 'design.probe'];
const DESIGN_FEATURES = ['design.capture', 'design.probe', 'design.journey', 'design.replayJourney', 'design.openPreview', 'design.changed'];

let current: Harness | undefined;

function setUp(options: { e2eHooks?: boolean; clientPolicyChanged?: () => void; log?: (line: string) => void; actorIntentExpiryMs?: number } = {}): Harness {
  const coreLoop = createLoopback();
  const daemonMain = createMainEndpoint(coreLoop.main, quiet, undefined, processActor);
  const core = createCoreEndpoint(coreLoop.core, quiet, undefined, processActor);
  const state = memoryState();
  const registry = createRunRegistry();
  const reload = vi.fn();
  const secrets = new Map<string, string | undefined>();
  const mirrors = createClientMirrors();
  const router = createCoreRouter({ core: daemonMain, state, registry, mirrors, secrets, e2eHooks: options.e2eHooks ?? false, reload, agentShellUrl: () => undefined, clientPolicyChanged: options.clientPolicyChanged ?? (() => undefined), log: options.log ?? quiet, ...(options.actorIntentExpiryMs !== undefined ? { actorIntentExpiryMs: options.actorIntentExpiryMs } : {}) });
  const harness: Harness = {
    core,
    router,
    state,
    registry,
    reload,
    secrets,
    mirrors,
    client: (id, { hostId = 'h1', drained = () => Promise.resolve(), clientId = id, features = [], before, refuses } = {}) => {
      const loop = createLoopback();
      const transport = refuses === undefined ? loop.core : {
        post: (message: unknown): void => {
          if (JSON.stringify(message).includes(refuses)) throw new CodecError('a message over the bound');
          loop.core.post(message);
        },
        onMessage: loop.core.onMessage,
      };
      const close = vi.fn();
      const main = createMainEndpoint(loop.main, quiet, (error) => { throw error; });
      before?.(main);
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
      const attached = router.attach({ id, clientId, hostId, features: new Set(features), transport, mirrors: emptyMirrors, close, drained, lost: () => lost, onLostChange });
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
  it('tells the daemon each time a client\'s clientPolicy changes, once the router holds the new value', async () => {
    const seen: Array<boolean | undefined> = [];
    const h: Harness = setUp({ clientPolicyChanged: () => seen.push(h.mirrors.clientPolicy.get('device-a')?.agentForwarding) });
    const client = h.client('connection-1', { clientId: 'device-a' });
    await vi.waitFor(() => expect(seen).toEqual([undefined]));
    client.main.publish('clientPolicy', { value: { ...emptyMirrors.clientPolicy, agentForwarding: true } });
    await vi.waitFor(() => expect(seen).toEqual([undefined, true]));
    client.main.publish('clientUser', { value: emptyMirrors.clientUser });
    client.main.publish('clientPolicy', { value: emptyMirrors.clientPolicy });
    await vi.waitFor(() => expect(seen).toEqual([undefined, true, undefined]));
  });

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
    const notice = { severity: 'info', message: { message: 'hi' }, actions: [{ message: 'First' }, { message: 'Second' }] } as const;
    expect(await h.core.request('notifications.show', notice)).toBeUndefined();
    expect(await h.core.request('askpass.prompt', { kind: 'password', text: 'pw?' })).toEqual({ cancelled: true });
    await expect(h.core.request('worktrees.runSetup', { worktreeId: 'w', cwd: '/x', commands: [], env: {} })).rejects.toThrow('No client');
    const first = h.client('c1');
    const second = h.client('c2');
    first.main.serve('notifications.show', () => 0);
    second.main.serve('notifications.show', () => 1);
    expect(await h.core.request('notifications.show', notice)).toBe(1);
    // a client's message makes it the acting one
    await first.main.request('catalog.list', { projectKey: '/srv/app', complete: false }).catch(() => undefined);
    expect(await h.core.request('notifications.show', notice)).toBe(0);
  });

  it('send askpass.prompt to the device whose git call registered it, while another device acts', async () => {
    const h = setUp();
    const a = h.client('connection-1', { clientId: 'device-a' });
    const b = h.client('connection-2', { clientId: 'device-b' });
    const asked: string[] = [];
    a.main.serve('askpass.prompt', () => {
      asked.push('device-a');
      return { answer: 'from-a', cancelled: false };
    });
    b.main.serve('askpass.prompt', () => {
      asked.push('device-b');
      return { answer: 'from-b', cancelled: false };
    });
    const askpass = createAskpassServer({
      paths: { askpass: '/srv/dist/askpass/askpass.sh', sshAskpass: '/srv/dist/askpass/ssh-askpass.sh', node: process.execPath, main: '/srv/dist/askpass-main.js' },
      prompt: credentialPrompt((prompt, signal) => h.core.request('askpass.prompt', prompt, signal)),
      log: quiet,
    });
    try {
      // core's server starts listening outside every actor, as the credential relay's listen at core start does
      (await askpass.register('background', 'autofetch')).dispose();
      const push = await processActor.run('device-a', () => askpass.register('interactive', 'push'));
      await b.main.request('catalog.list', { projectKey: '/srv/app', complete: false }).catch(() => undefined);
      expect(h.mirrors.actingClient.clientId).toBe('device-b');
      const reply = await new Promise<string>((resolve) => {
        const helper = net.connect(push.env['DAMOCLES_ASKPASS_HANDLE']!);
        let received = '';
        helper.on('data', (chunk) => (received += chunk.toString('utf8')));
        helper.on('error', () => undefined);
        helper.on('close', () => resolve(received));
        helper.write(`${JSON.stringify({ nonce: push.env['DAMOCLES_ASKPASS_NONCE'], kind: 'askpass', argv: ["Password for 'https://example.com': "] })}\n`);
      });
      expect(reply).toBe(`${JSON.stringify({ answer: 'from-a' })}\n`);
      expect(asked).toEqual(['device-a']);
    } finally {
      await askpass.dispose();
    }
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

  it('send design.openPreview to a client that shows the design chat and lists it, refuse it with the exact text otherwise, and pass design.read and design.info through', async () => {
    const h = setUp();
    const open = { panelId: 'panel-1', designId: 'contacts-1a2b3c4d', relPath: 'screens/S1.html' };
    // no window to open a tab in, and never a browser
    await expect(h.core.request('design.openPreview', open)).rejects.toThrow(DESIGN_PREVIEW_CLIENT_ABSENT);
    h.core.serve('chats.restore', () => undefined);
    const client = h.client('c1', { features: DESIGN_FEATURES });
    const opened: unknown[] = [];
    client.main.serve('design.openPreview', (params) => {
      opened.push(params);
    });
    // the chat is not one this client shows
    await expect(h.core.request('design.openPreview', open)).rejects.toThrow(DESIGN_PREVIEW_CLIENT_ABSENT);
    await client.main.request('chats.restore', { viewId: 'view-1' });
    h.core.publish('chats', { panelId: 'panel-1', entry: entry('panel-1', 'view-1') });
    // an app that predates design.openPreview attached last, so it is the acting client, and is never asked
    const older = h.client('c-old', { features: RENDER_FEATURES });
    older.main.serve('design.openPreview', () => {
      opened.push('older');
    });
    await h.core.request('design.openPreview', open);
    expect(opened).toEqual([open]);
    // the daemon hands core the client's request as it was sent: core alone confines it to a design it holds
    const asked: unknown[] = [];
    h.core.serve('design.read', (params) => {
      asked.push(params);
      return { bytes: new Uint8Array([60, 104, 62]), fidelity: 'static' as const };
    });
    h.core.serve('design.info', (params) => {
      asked.push(params);
      return undefined;
    });
    expect(await client.main.request('design.read', { designId: open.designId, relPath: 'manifest.json' })).toEqual({ bytes: new Uint8Array([60, 104, 62]), fidelity: 'static' });
    expect(await client.main.request('design.info', { designId: open.designId, relPath: 'screens/S1.html' })).toBeUndefined();
    expect(asked).toEqual([{ designId: open.designId, relPath: 'manifest.json' }, { designId: open.designId, relPath: 'screens/S1.html' }]);
    expect(CORE_REQUEST_ROUTES['design.openPreview']).toMatchObject({ to: 'chatClient', needs: 'design.openPreview' });
    expect(MAIN_REQUEST_ROUTES['design.read']).toBe('core');
    expect(MAIN_REQUEST_ROUTES['design.info']).toBe('core');
  });

  it('send design.changed only to the clients whose attach listed it', async () => {
    const h = setUp();
    const older = h.client('c-old', { features: RENDER_FEATURES });
    const client = h.client('c1', { features: DESIGN_FEATURES });
    const changed: Array<[string, unknown]> = [];
    older.main.onEvent('design.changed', (event) => changed.push(['c-old', event]));
    client.main.onEvent('design.changed', (event) => changed.push(['c1', event]));
    h.core.emit('design.changed', { designId: 'contacts-1a2b3c4d', paths: ['screens/S1.html'] });
    await flush();
    expect(changed).toEqual([['c1', { designId: 'contacts-1a2b3c4d', paths: ['screens/S1.html'] }]]);
    expect(older.close).not.toHaveBeenCalled();
  });

  it('name only features the app has in every route\'s needs', () => {
    // a route that reads its needs from the request names one for plain journey steps and one for scroll steps
    const asked = [{ steps: [] }, { steps: [{ action: 'scroll', to: 'end' }] }] as never[];
    const needs = [...Object.values(CORE_REQUEST_ROUTES), ...Object.values(CORE_EVENT_ROUTES)].flatMap((route) => {
      if (typeof route !== 'object' || !('needs' in route) || route.needs === undefined) return [];
      const named = route.needs as string | ((params: never) => string | undefined);
      return typeof named === 'function' ? asked.flatMap((params) => named(params) ?? []) : [named];
    });
    expect(needs.length).toBeGreaterThan(0);
    for (const name of needs) expect(FEATURES).toContain(name);
  });

  it('ask user.memory.list only of the client it names, refusing an absent one and one whose attach did not list it', async () => {
    const h = setUp();
    const request = { clientId: 'device-a', kinds: ['note'] as const, tags: ['work'] };
    await expect(h.core.request('user.memory.list', request)).rejects.toThrow(CREDENTIAL_CLIENT_ABSENT);
    const older = h.client('connection-1', { clientId: 'device-a' });
    const asked: unknown[] = [];
    older.main.serve('user.memory.list', (params) => {
      asked.push(params);
      return { rows: [] };
    });
    await expect(h.core.request('user.memory.list', request)).rejects.toThrow(CLIENT_FEATURE_MISSING);
    older.detach();
    const current = h.client('connection-2', { clientId: 'device-a', features: ['user.memory.list'] });
    current.main.serve('user.memory.list', (params) => {
      asked.push(params);
      return { rows: [] };
    });
    // another device listing the feature is never asked in its place
    h.client('connection-3', { clientId: 'device-b', features: ['user.memory.list'] }).main.serve('user.memory.list', () => {
      asked.push('device-b');
      return { rows: [] };
    });
    expect(await h.core.request('user.memory.list', request)).toEqual({ rows: [] });
    expect(asked).toEqual([{ clientId: 'device-a', kinds: ['note'], tags: ['work'] }]);
    expect(older.close).not.toHaveBeenCalled();
    expect(CORE_REQUEST_ROUTES['user.memory.list']).toEqual({ to: 'pinnedClient', needs: 'user.memory.list' });
    expect(MAIN_REQUEST_ROUTES['user.memory.list']).toBe('refused');
  });

  it('pass design.markup from a client to its core, which writes the markup into its own design folder', async () => {
    const h = setUp();
    const client = h.client('c1');
    const asked: unknown[] = [];
    h.core.serve('design.markup', (params) => {
      asked.push(params);
      return { feedbackId: 'F1' };
    });
    const request = { panelId: 'panel-1', png: 'iVBORw0KGgo=', json: { file: 'screens/S1.html', marks: [] } };
    expect(await client.main.request('design.markup', request)).toEqual({ feedbackId: 'F1' });
    expect(asked).toEqual([request]);
    expect(MAIN_REQUEST_ROUTES['design.markup']).toBe('core');
  });

  it('pass design.tweak from a client to its core, which sends the kept tweak in its own design chat', async () => {
    const h = setUp();
    const client = h.client('c1');
    const asked: unknown[] = [];
    h.core.serve('design.tweak', (params) => {
      asked.push(params);
      return { kept: true as const };
    });
    const request = { panelId: 'panel-1', tweakId: 'radius', value: '--radius-lg' };
    expect(await client.main.request('design.tweak', request)).toEqual({ kept: true });
    expect(asked).toEqual([request]);
    expect(MAIN_REQUEST_ROUTES['design.tweak']).toBe('core');
  });

  it("pass design.previewScreen from a client to its core, which opens the screen's preview in its own design chat", async () => {
    const h = setUp();
    const client = h.client('c1');
    const asked: unknown[] = [];
    h.core.serve('design.previewScreen', (params) => {
      asked.push(params);
      return { opened: true as const };
    });
    const request = { path: '/home/a/.damocles/designs/d-1234/screens/S1.html' };
    expect(await client.main.request('design.previewScreen', request)).toEqual({ opened: true });
    expect(asked).toEqual([request]);
    expect(MAIN_REQUEST_ROUTES['design.previewScreen']).toBe('core');
  });

  it('send design.capture and design.probe to a client that lists them, the acting one or another, refusing with the exact text otherwise', async () => {
    const h = setUp();
    const capture = { designId: 'contacts-1a2b3c4d', relPath: 'screens/S1.html', width: 390, state: null, scale: 2 };
    const probe = { designId: 'contacts-1a2b3c4d', relPath: 'screens/S1.html', widths: [390, 640], state: null, sweepTo: 1536 };
    const refusal = 'No Damocles app is attached to render this design.';
    await expect(h.core.request('design.capture', capture)).rejects.toThrow(refusal);
    await expect(h.core.request('design.probe', probe)).rejects.toThrow(refusal);
    // an app that predates design renders lists neither and is never asked
    const older = h.client('c-old');
    let asked = 0;
    older.main.serve('design.capture', () => {
      asked++;
      throw new Error('asked');
    });
    older.main.serve('design.probe', () => {
      asked++;
      throw new Error('asked');
    });
    await expect(h.core.request('design.capture', capture)).rejects.toThrow(refusal);
    expect(asked).toBe(0);
    const client = h.client('c1', { features: RENDER_FEATURES });
    // the older app acts last; the render still goes to the attached app that can render
    await older.main.request('catalog.list', { projectKey: '/srv/app', complete: false }).catch(() => undefined);
    const png = new Uint8Array([137, 80, 78, 71]);
    const signals: AbortSignal[] = [];
    client.main.serve('design.capture', (params, signal) => {
      signals.push(signal);
      return { png, cssWidth: params.width, cssHeight: 900, contentHeight: 1200, scale: 2 };
    });
    client.main.serve('design.probe', ({ widths, sweepTo }) => ({ widths: widths.map((width) => ({ width, contentHeight: 1200, scrollWidth: width, clientWidth: width, overflow: false, overflowing: [], elements: [] })), consoleErrors: [], sweep: { from: 320, to: sweepTo!, step: 8, overflowAt: [] } }));
    expect(await h.core.request('design.capture', capture)).toEqual({ png, cssWidth: 390, cssHeight: 900, contentHeight: 1200, scale: 2 });
    expect((await h.core.request('design.probe', probe)).widths.map((measured) => measured.width)).toEqual([390, 640]);
    expect(asked).toBe(0);
    expect(CORE_REQUEST_ROUTES['design.capture']).toMatchObject({ to: 'workClient', needs: 'design.capture' });
    expect(CORE_REQUEST_ROUTES['design.probe']).toMatchObject({ to: 'workClient', needs: 'design.probe' });
  });

  it('send a browser call with a served root file only to a viewer that serves root files, refusing with CLIENT_FEATURE_MISSING while a viewer lacks it', async () => {
    const h = setUp();
    h.core.serve('chats.restore', () => undefined);
    const plain = { viewId: 'view-1', scope: 'chat', tool: 'BrowserNavigate', input: { url: 'http://localhost:5173/' } };
    const served = { ...plain, input: { url: 'file:///srv/app/docs/index.html' }, served: { kind: 'project' as const, relPath: 'docs/index.html', displayRoot: '/srv/app' } };
    // no device shows the chat: no app to update, so the plain refusal
    const unshown = h.client('c-unshown', { features: [] });
    await expect(h.core.request('user.browser.tool', served)).rejects.toThrow('No client is attached to run a browser tool');
    unshown.detach();
    // an app that predates served root files would close its connection on the unknown field, so it never gets one
    const older = h.client('c-old', { features: [] });
    const asked: unknown[] = [];
    older.main.serve('user.browser.tool', (params) => {
      asked.push(params);
      return { content: [{ type: 'text' as const, text: 'ran' }] };
    });
    await older.main.request('chats.restore', { viewId: 'view-1' });
    h.core.publish('chats', { panelId: 'panel-1', entry: entry('panel-1', 'view-1') });
    await expect(h.core.request('user.browser.tool', served)).rejects.toThrow(CLIENT_FEATURE_MISSING);
    expect(asked).toEqual([]);
    // a call without one still reaches it
    expect(await h.core.request('user.browser.tool', plain)).toEqual({ content: [{ type: 'text', text: 'ran' }] });
    older.detach();
    const current = h.client('c-new', { features: ['user.browser.servedFiles'] });
    current.main.serve('user.browser.tool', (params) => {
      asked.push(params);
      return { content: [{ type: 'text' as const, text: 'served' }] };
    });
    await current.main.request('chats.restore', { viewId: 'view-1' });
    expect(await h.core.request('user.browser.tool', served)).toEqual({ content: [{ type: 'text', text: 'served' }] });
    expect(asked.at(-1)).toEqual(served);
    await expect(h.core.request('browser.servedFileUrl', { viewId: 'view-1', kind: 'project', relPath: 'docs/index.html' })).rejects.toThrow('not available on this host');
  });

  it('send design.journey to a client that lists it and design.replayJourney to one that also shows the chat, refusing with the render text otherwise', async () => {
    const h = setUp();
    h.core.serve('chats.restore', () => undefined);
    const step = { action: 'click' as const, target: { role: 'button', name: 'Add contact' } };
    const shown = { action: 'assert' as const, target: { role: 'dialog', name: 'New contact' }, expect: { visible: true } };
    const journey = { designId: 'contacts-1a2b3c4d', relPath: 'screens/S1.html', widths: [390, 1280], state: null, steps: [step, shown], outline: false };
    const replay = { panelId: 'panel-1', designId: 'contacts-1a2b3c4d', relPath: 'screens/S1.html', state: null, steps: [step, shown], reducedMotion: true };
    const refusal = 'No Damocles app is attached to render this design.';
    await expect(h.core.request('design.journey', journey)).rejects.toThrow(refusal);
    await expect(h.core.request('design.replayJourney', replay)).rejects.toThrow(refusal);
    // an app that renders designs but predates journeys would close the channel on the request's name, so it is never asked
    const older = h.client('c-old', { features: RENDER_FEATURES });
    let asked = 0;
    older.main.serve('design.journey', () => {
      asked++;
      throw new Error('asked');
    });
    await expect(h.core.request('design.journey', journey)).rejects.toThrow(refusal);
    await expect(h.core.request('design.replayJourney', replay)).rejects.toThrow(refusal);
    expect(asked).toBe(0);
    older.detach();
    const client = h.client('c1', { features: DESIGN_FEATURES });
    const replayed: unknown[] = [];
    client.main.serve('design.journey', ({ widths, steps }) => ({ widths: widths.map((width) => ({ width, passed: true, steps: steps.map(() => ({ ok: true })) })), consoleErrors: [] }));
    client.main.serve('design.replayJourney', (params) => {
      replayed.push(params);
    });
    expect((await h.core.request('design.journey', journey)).widths.map((width) => [width.width, width.passed])).toEqual([[390, true], [1280, true]]);
    // a replay drives the chat's own preview tab, which only a client showing the chat has
    await expect(h.core.request('design.replayJourney', replay)).rejects.toThrow(refusal);
    await client.main.request('chats.restore', { viewId: 'view-1' });
    h.core.publish('chats', { panelId: 'panel-1', entry: entry('panel-1', 'view-1') });
    await h.core.request('design.replayJourney', replay);
    expect(replayed).toEqual([replay]);
    expect(CORE_REQUEST_ROUTES['design.journey']).toMatchObject({ to: 'workClient' });
    expect(CORE_REQUEST_ROUTES['design.replayJourney']).toMatchObject({ to: 'chatClient' });
  });

  it('send a journey with a scroll step or an explicit exact target only to a client that lists design.journeyScroll, naming the update otherwise', async () => {
    const h = setUp();
    const scroll = { action: 'scroll' as const, to: 'end' as const };
    const more = { action: 'assert' as const, target: { text: 'item', exact: false }, expect: { visible: true } };
    const journey = { designId: 'contacts-1a2b3c4d', relPath: 'screens/S1.html', widths: [390], state: null, steps: [scroll, more], outline: false };
    const replay = { panelId: 'panel-1', designId: 'contacts-1a2b3c4d', relPath: 'screens/S1.html', state: null, steps: [scroll, more], reducedMotion: true };
    // with no app attached the refusal names no update
    await expect(h.core.request('design.journey', journey)).rejects.toThrow(DESIGN_RENDER_CLIENT_ABSENT);
    // an app before design.journeyScroll would refuse these steps in its parser and close the channel, so it is never asked
    const older = h.client('c-old', { features: DESIGN_FEATURES });
    let asked = 0;
    older.main.serve('design.journey', () => {
      asked++;
      throw new Error('asked');
    });
    await expect(h.core.request('design.journey', journey)).rejects.toThrow(DESIGN_JOURNEY_UPDATE_NEEDED);
    await expect(h.core.request('design.replayJourney', replay)).rejects.toThrow(DESIGN_JOURNEY_UPDATE_NEEDED);
    expect(asked).toBe(0);
    // that parser refuses any exact key, true included, so the wire's parse drops an exact: true, which means what absent does
    const sent: unknown[] = [];
    older.main.serve('design.journey', ({ widths, steps }) => {
      sent.push(steps);
      return { widths: widths.map((width) => ({ width, passed: true, steps: steps.map(() => ({ ok: true })) })), consoleErrors: [] };
    });
    const exactTrue = { action: 'assert' as const, target: { text: 'item', exact: true }, expect: { visible: true } };
    await h.core.request('design.journey', { ...journey, steps: [{ action: 'click' as const, target: { text: 'item' } }, exactTrue] });
    expect(sent).toEqual([[{ action: 'click', target: { text: 'item' } }, { action: 'assert', target: { text: 'item' }, expect: { visible: true } }]]);
    older.detach();
    const current = h.client('c1', { features: [...DESIGN_FEATURES, 'design.journeyScroll'] });
    current.main.serve('design.journey', ({ widths, steps }) => ({ widths: widths.map((width) => ({ width, passed: true, steps: steps.map(() => ({ ok: true })) })), consoleErrors: [] }));
    expect((await h.core.request('design.journey', journey)).widths.map((width) => width.passed)).toEqual([true]);
  });

  it('send design.render only to a client that lists it, refusing with the predates text when an older app renders so core can take design.capture', async () => {
    const h = setUp();
    const render = { designId: 'contacts-1a2b3c4d', relPath: 'variants/a/S1.html', width: 390, state: null, media: DEFAULT_RENDER_MEDIA, format: 'jpeg' as const, maxSide: 1568, quality: 80 };
    await expect(h.core.request('design.render', render)).rejects.toThrow(DESIGN_RENDER_CLIENT_ABSENT);
    h.client('c-old', { features: RENDER_FEATURES });
    await expect(h.core.request('design.render', render)).rejects.toThrow(DESIGN_RENDER_PREDATES);
    const current = h.client('c1', { features: [...RENDER_FEATURES, 'design.render'] });
    const frame = { image: new Uint8Array([0xff, 0xd8]), mimeType: 'image/jpeg' as const, cssWidth: 390, cssHeight: 900, top: 0 };
    current.main.serve('design.render', () => ({ frames: [frame], contentHeight: 1200, scale: 2, moving: false }));
    expect(await h.core.request('design.render', render)).toEqual({ frames: [frame], contentHeight: 1200, scale: 2, moving: false });
    expect(CORE_REQUEST_ROUTES['design.render']).toMatchObject({ to: 'workClient', needs: 'design.render' });
  });

  it('end the capture of a client when core cancels it, so Stop in the design chat ends a running capture', async () => {
    const h = setUp();
    const client = h.client('c1', { features: RENDER_FEATURES });
    let ended: unknown;
    client.main.serve('design.capture', (_params, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        ended = signal.reason;
        reject(new Error('stopped'));
      });
    }));
    const stop = new AbortController();
    const running = h.core.request('design.capture', { designId: 'contacts-1a2b3c4d', relPath: 'screens/S1.html', width: 390, state: null, scale: 2 }, stop.signal);
    await flush();
    stop.abort();
    await expect(running).rejects.toThrow();
    await vi.waitFor(() => expect(ended).toBeDefined());
  });

  it('read editor.readText with no client only inside an open project', async () => {
    const h = setUp();
    await expect(h.core.request('editor.readText', { path: process.execPath })).rejects.toThrow('outside the open projects');
  });

  // core's key-value state is the daemon's own: a client's language is its clientLanguage, never a state key
  it('store core\'s state writes, and drop every state delta a client publishes', async () => {
    const h = setUp();
    const deltas: unknown[] = [];
    h.core.onMirror('state', (patch) => deltas.push(patch));
    await h.core.request('state.update', { scope: 'global', key: 'damocles.other', value: 1 });
    expect(h.state.writes).toEqual([['global', 'damocles.other', 1]]);
    expect(deltas).toEqual([{ scope: 'global', key: 'damocles.other', value: 1 }]);
    const client = h.client('c1');
    client.main.publish('state', { scope: 'global', key: 'damocles.other', value: 2 });
    client.main.publish('state', { scope: 'global', key: LANGUAGE_PREFERENCE_KEY, value: 'el' });
    expect(deltas).toHaveLength(1);
  });

  it('drop and log a client\'s clientNetwork delta, which only this computer\'s main publishes to its own core', async () => {
    const lines: string[] = [];
    const h = setUp({ log: (line) => lines.push(line) });
    const deltas: unknown[] = [];
    h.core.onMirror('clientNetwork', (patch) => deltas.push(patch));
    h.client('c1').main.publish('clientNetwork', { authority: 'ssh-h1', allowedPorts: [3000], allowLocalNetwork: true });
    await flush();
    expect(deltas).toEqual([]);
    expect(lines).toContain("[core-host] dropped c1's clientNetwork, which the daemon publishes");
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
    h.core.serve('browser.useClientCertificate', served);
    await expect(client.main.request('browser.useClientCertificate', { origin: 'https://a.test:443', filter: { ISSUER: {}, SUBJECT: { CN: 'a' } } })).rejects.toThrow('not available');
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
    const client = h.client('c1', { hostId: 'host-a' });
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

  it('carry a session file write to core with its bytes over the wire\'s codec, and core\'s answer back', async () => {
    const h = setUp();
    const client = h.client('c1');
    const params = { path: '/home/u/.damocles/pi/agent/sessions/--srv-app--/t_s1.jsonl', bytes: new Uint8Array([0x7b, 0x7d, 0x0a]), expectedSha256: 'b'.repeat(64) };
    const crossed = decode(encode(params), { maxBytes: 1024 });
    expect(MAIN_TO_CORE.requests['sessionFiles.write'].params(crossed)).toEqual(params);
    const seen: unknown[] = [];
    h.core.serve('sessionFiles.write', (received) => {
      seen.push(received);
      return { kind: 'refused', reason: 'otherProcess' } as const;
    });

    expect(await client.main.request('sessionFiles.write', params)).toEqual({ kind: 'refused', reason: 'otherProcess' });
    expect(seen).toEqual([params]);
  });

  it('give every client the held memory queues, a fresh one the last list, and take or discard a queue as the asking client', async () => {
    const h = setUp();
    const first = h.client('connection-1', { clientId: 'device-a' });
    const queues = [{ queueId: 'device-old', count: 3, lastSeen: 1_700_000_000_000 }];
    const firstSeen: unknown[] = [];
    first.main.onMirror('heldMemory', (patch) => firstSeen.push(patch));
    h.core.publish('heldMemory', { queues });
    await vi.waitFor(() => expect(firstSeen).toEqual([{ queues }]));

    const later: unknown[] = [];
    const loop = createLoopback();
    const main = createMainEndpoint(loop.main, quiet, (error) => { throw error; });
    main.onMirror('heldMemory', (patch) => later.push(patch));
    h.router.attach({ id: 'connection-2', clientId: 'device-b', hostId: 'h2', transport: loop.core, mirrors: emptyMirrors, close: vi.fn(), drained: () => Promise.resolve(), lost: () => false, onLostChange: () => ({ dispose: () => undefined }) });
    expect(later).toEqual([{ queues }]);

    const asked: Array<[string, string | undefined]> = [];
    h.core.serve('memory.deliverHeld', ({ queueId }) => {
      asked.push([`deliver ${queueId}`, processActor.current()]);
      return true;
    });
    h.core.serve('memory.discardHeld', ({ queueId }) => {
      asked.push([`discard ${queueId}`, processActor.current()]);
      return false;
    });
    expect(await main.request('memory.deliverHeld', { queueId: 'device-old' })).toBe(true);
    expect(await first.main.request('memory.discardHeld', { queueId: 'device-old' })).toBe(false);
    expect(asked).toEqual([['deliver device-old', 'device-b'], ['discard device-old', 'device-a']]);
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

  // each device's views render core's text in that device's own language, whichever device acts or attached last
  it('publish each client\'s language under its id on clientLanguage, and clear it when it detaches', async () => {
    const h = setUp();
    const published: unknown[] = [];
    const language: unknown[] = [];
    h.core.onMirror('clientLanguage', (patch) => published.push(patch));
    h.core.onMirror('language', (patch) => language.push(patch));
    const first = h.client('c1');
    first.main.publish('language', { language: 'el' });
    const second = h.client('c2');
    await first.main.request('catalog.list', { projectKey: '/srv/app', complete: false }).catch(() => undefined);
    second.detach();
    expect(published).toEqual([
      { clientId: 'c1', value: { language: 'en' } },
      { clientId: 'c1', value: { language: 'el' } },
      { clientId: 'c2', value: { language: 'en' } },
      { clientId: 'c2' },
    ]);
    expect(h.mirrors.clientLanguage).toEqual(new Map([['c1', { language: 'el' }]]));
    // a daemon's core never reads the language mirror, which only a local core's one client publishes
    expect(language).toEqual([]);
  });

  it('publish each client\'s editor and terminal patch under its id on clientEditor and clientTerminal, and clear both when it detaches', async () => {
    const h = setUp();
    const published: Array<[string, unknown]> = [];
    for (const topic of ['editor', 'terminal', 'clientEditor', 'clientTerminal'] as const) h.core.onMirror(topic, (patch) => published.push([topic, patch]));
    const a = h.client('device-a');
    const b = h.client('device-b');
    const file = { context: { filePath: '/srv/app/a.ts', selection: { startLine: 1, endLine: 2, text: 'x' } } };
    const toggle = { shown: true, shortcut: 'Ctrl+`' };
    a.main.publish('editor', file);
    b.main.publish('terminal', toggle);
    // only the daemon names a client
    a.main.publish('clientEditor', { clientId: 'device-b', value: file });
    a.main.publish('clientTerminal', { clientId: 'device-b', value: toggle });
    await flush();
    b.detach();
    const none = { shown: false, shortcut: '' };
    expect(published).toEqual([
      ['clientEditor', { clientId: 'device-a', value: {} }],
      ['clientTerminal', { clientId: 'device-a', value: none }],
      ['clientEditor', { clientId: 'device-b', value: {} }],
      ['clientTerminal', { clientId: 'device-b', value: none }],
      ['clientEditor', { clientId: 'device-a', value: file }],
      ['clientTerminal', { clientId: 'device-b', value: toggle }],
      ['clientEditor', { clientId: 'device-b' }],
      ['clientTerminal', { clientId: 'device-b' }],
    ]);
    expect([[...h.mirrors.clientEditor], [...h.mirrors.clientTerminal]]).toEqual([[['device-a', file]], [['device-a', none]]]);
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
    good.main.serve('notifications.show', () => 0);
    expect(() => bad.raw.post({ kind: 'request', id: 'x' })).not.toThrow();
    expect(bad.close).toHaveBeenCalled();
    expect(good.close).not.toHaveBeenCalled();
    expect(await h.core.request('notifications.show', { severity: 'info', message: { message: 'hi' }, actions: [] })).toBe(0);
  });

  it('answer views.drained once the viewing client\'s core channel drained, and at once for a view no client shows', async () => {
    const h = setUp();
    let release!: () => void;
    h.client('c1', { drained: () => new Promise<void>((resolve) => (release = resolve)) });
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

  // core sends chat.activity only at a change, so a client that was away (an app relaunched while a turn ran) learns it here
  it('give an attaching client each open panel\'s latest chat.activity, sent while no client was attached', async () => {
    const h = setUp();
    const running = { state: 'running', pendingKinds: [], pendingPrompts: [], background: false } as const;
    const idle = { state: 'idle', pendingKinds: [], pendingPrompts: [], background: false } as const;
    for (const n of [1, 2, 3]) h.core.publish('chats', { panelId: `panel-${n}`, entry: entry(`panel-${n}`, `view-${n}`) });
    h.core.emit('chat.activity', { panelId: 'panel-1', activity: idle, sessionId: 'S1' });
    h.core.emit('chat.activity', { panelId: 'panel-1', activity: running, sessionId: 'S1' });
    h.core.emit('chat.activity', { panelId: 'panel-2', activity: idle });
    h.core.emit('chat.activity', { panelId: 'panel-3', activity: running });
    h.core.publish('chats', { panelId: 'panel-3' });
    // core's last report of a closed panel follows its entry's removal
    h.core.emit('chat.activity', { panelId: 'panel-3', activity: idle });
    await flush();

    const seen: unknown[] = [];
    h.client('c1', { before: (main) => main.onEvent('chat.activity', (payload) => seen.push(payload)) });
    await flush();
    expect(seen).toEqual([{ panelId: 'panel-1', activity: running, sessionId: 'S1' }, { panelId: 'panel-2', activity: idle }]);
  });

  it('give a run to the client whose work started it, else to the acting client', async () => {
    const h = setUp();
    h.client('connection-1', { clientId: 'device-a' });
    h.client('connection-2', { clientId: 'device-b' });
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

  // main keeps a panel's activity only while it holds the panel's entry, so an activity it got before the join may be gone by then
  it('follow the entry of a panel a client starts showing with the panel\'s latest chat.activity', async () => {
    const h = setUp();
    const running = { state: 'running', pendingKinds: [], pendingPrompts: [], background: false } as const;
    const client = h.client('c1');
    h.core.serve('chats.restore', () => undefined);
    await client.main.request('chats.restore', { viewId: 'view-1' });
    client.main.postPanel('view-1', 'message', { message: { type: 'ready', panelToken: 'token-1' } });
    h.core.publish('chats', { panelId: 'panel-1', entry: entry('panel-1', 'view-1') });
    h.core.emit('chat.activity', { panelId: 'panel-1', activity: running, sessionId: 'S1' });
    client.detach();

    h.core.serve('views.join', () => ({ panelId: 'panel-1' }));
    const seen: unknown[] = [];
    const again = h.client('c1', {
      before: (main) => {
        main.onMirror('chats', (patch) => seen.push(['chats', patch.panelId]));
        main.onEvent('chat.activity', (payload) => seen.push(['activity', payload]));
      },
    });
    await flush();
    seen.length = 0;
    await again.main.request('views.join', { viewId: 'view-2', viewKey: 'token-1' });
    await flush();
    expect(seen).toEqual([['chats', 'panel-1'], ['activity', { panelId: 'panel-1', activity: running, sessionId: 'S1' }]]);
    // a later entry change of a panel it already shows brings none
    seen.length = 0;
    h.core.publish('chats', { panelId: 'panel-1', entry: { ...entry('panel-1', 'view-1'), hasConversation: false } });
    await flush();
    expect(seen).toEqual([['chats', 'panel-1']]);
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
    h.core.emit('chat.turnSettled', { panelId: 'panel-1', outcome: { kind: 'completed' } });
    expect(seen['c2']).toEqual([oversized, next, { panelId: 'panel-1', outcome: { kind: 'completed' } }]);
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
    h.core.emit('chat.turnSettled', { panelId: OVERSIZED, outcome: { kind: 'completed' } });
    expect(events).toEqual([{ panelId: OVERSIZED, outcome: { kind: 'completed' } }]);
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
  async function shared(h: Harness, drainedB?: () => Promise<void>, features?: readonly string[]) {
    h.core.serve('chats.restore', () => undefined);
    const joins: Array<Record<string, unknown>> = [];
    h.core.serve('views.join', (params) => {
      joins.push(params);
      return { panelId: 'panel-1' };
    });
    const a = h.client('connection-1', { clientId: 'device-a', features });
    await a.main.request('chats.restore', { viewId: 'view-1' });
    a.main.postPanel('view-1', 'message', { message: { type: 'ready', panelToken: 'token-1' } });
    h.core.publish('chats', { panelId: 'panel-1', entry: entry('panel-1', 'view-1') });
    const b = h.client('connection-2', { drained: drainedB, clientId: 'device-b', features });
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

  it('send design.openPreview and design.replayJourney to a client that shows the chat, the actor\'s first, never to one that does not', async () => {
    const h = setUp();
    const { a, b } = await shared(h, undefined, DESIGN_FEATURES);
    const other = h.client('connection-3', { clientId: 'device-c', features: DESIGN_FEATURES });
    const asked: string[] = [];
    for (const [name, client] of [['a', a], ['b', b], ['c', other]] as const) {
      client.main.serve('design.openPreview', () => {
        asked.push(`open ${name}`);
      });
      client.main.serve('design.replayJourney', () => {
        asked.push(`replay ${name}`);
      });
    }
    const open = { panelId: 'panel-1', designId: 'contacts-1a2b3c4d', relPath: 'screens/S1.html' };
    const step = { action: 'click' as const, target: { role: 'button', name: 'Add contact' } };
    const shown = { action: 'assert' as const, target: { role: 'dialog', name: 'New contact' }, expect: { visible: true } };
    const replay = { ...open, state: null, steps: [step, shown], reducedMotion: true };
    // device c acts last but shows no view of the chat
    await other.main.request('catalog.list', { projectKey: '/srv/app', complete: false }).catch(() => undefined);
    await h.core.request('design.openPreview', open);
    await h.core.request('design.replayJourney', replay);
    // device b shows it under its own view and acts
    await b.main.request('catalog.list', { projectKey: '/srv/app', complete: false }).catch(() => undefined);
    await h.core.request('design.openPreview', open);
    await h.core.request('design.replayJourney', replay);
    expect(asked).toEqual(['open a', 'replay a', 'open b', 'replay b']);
  });

  it('reveal a panel for a device\'s work on that device alone, which opens the chat by its stored session when it shows no view of it, so the preview core opens next reaches that device', async () => {
    const h = setUp();
    const features = ['chats.showSession', ...DESIGN_FEATURES];
    const { a, b } = await shared(h, undefined, features);
    const c = h.client('connection-3', { clientId: 'device-c', features });
    const reveals: Array<[string, string, unknown]> = [];
    for (const [name, client] of [['a', a], ['b', b], ['c', c]] as const) {
      client.main.onPanel((viewId, envelope) => {
        if (envelope.op === 'reveal') reveals.push([name, viewId, envelope.payload]);
      });
    }
    // device b shows the panel: its view alone is revealed, and device a stays where it is
    expect(await processActor.run('device-b', () => h.core.request('chats.reveal', { viewId: 'view-1', column: 2 }))).toBe(true);
    expect(reveals).toEqual([['b', 'view-b', { column: 2 }]]);

    // device c shows none: its main opens the chat, joining the panel, before the reveal answers
    const shown: string[] = [];
    c.main.serve('chats.showSession', async ({ sessionId }) => {
      expect(await c.main.request('views.join', { viewId: 'view-c', viewKey: 'token-of-c', sessionId })).toEqual({ panelId: 'panel-1' });
      shown.push(sessionId);
    });
    const opened: string[] = [];
    for (const [name, client] of [['a', a], ['b', b], ['c', c]] as const) {
      client.main.serve('design.openPreview', () => {
        opened.push(name);
      });
    }
    await processActor.run('device-c', async () => {
      expect(await h.core.request('chats.reveal', { viewId: 'view-1' })).toBe(true);
      expect(shown).toEqual(['S1']);
      await h.core.request('design.openPreview', { panelId: 'panel-1', designId: 'contacts-1a2b3c4d', relPath: 'screens/S1.html' });
    });
    expect(opened).toEqual(['c']);
    expect(reveals).toEqual([['b', 'view-b', { column: 2 }]]);

    // core's own work reveals every view
    reveals.length = 0;
    expect(await h.core.request('chats.reveal', { viewId: 'view-1' })).toBe(true);
    expect(reveals).toEqual([['a', 'view-1', {}], ['b', 'view-b', {}], ['c', 'view-c', {}]]);
  });

  it('answer a reveal for a device\'s work that cannot show the chat there as not shown, and move no other device\'s view', async () => {
    const h = setUp({ actorIntentExpiryMs: 20 });
    const features = ['chats.showSession', ...DESIGN_FEATURES];
    const { a, b } = await shared(h, undefined, features);
    const reveals: string[] = [];
    for (const [name, client] of [['a', a], ['b', b]] as const) {
      client.main.onPanel((_viewId, envelope) => {
        if (envelope.op === 'reveal') reveals.push(name);
      });
    }
    const reveal = (actor: string): Promise<boolean> => processActor.run(actor, () => h.core.request('chats.reveal', { viewId: 'view-1' }));
    // an app that predates chats.showSession is never asked
    const older = h.client('connection-3', { clientId: 'device-c', features: DESIGN_FEATURES });
    const olderAsked = vi.fn();
    older.main.serve('chats.showSession', olderAsked);
    expect(await reveal('device-c')).toBe(false);
    expect(olderAsked).not.toHaveBeenCalled();
    // an app that could not open the chat, and one that answered without joining its panel
    const refusing = h.client('connection-4', { clientId: 'device-d', features });
    refusing.main.serve('chats.showSession', () => {
      throw new Error('The chat did not open');
    });
    expect(await reveal('device-d')).toBe(false);
    const silent = h.client('connection-5', { clientId: 'device-e', features });
    silent.main.serve('chats.showSession', () => undefined);
    expect(await reveal('device-e')).toBe(false);
    // past the expiry: a device inside its grace, though it shows the panel, and one no longer attached
    b.lose();
    expect(await reveal('device-b')).toBe(false);
    b.resume();
    expect(await reveal('device-gone')).toBe(false);
    // a panel with no stored session cannot be joined
    const { sessionId: _held, ...unsaved } = entry('panel-1', 'view-1');
    h.core.publish('chats', { panelId: 'panel-1', entry: unsaved });
    const unasked = vi.fn();
    const another = h.client('connection-6', { clientId: 'device-f', features });
    another.main.serve('chats.showSession', unasked);
    expect(await reveal('device-f')).toBe(false);
    expect(unasked).not.toHaveBeenCalled();
    expect(reveals).toEqual([]);
  });

  it('hold a reveal for a device\'s work while that device is away, and show the chat there once it is back, on its resumed or fresh connection', async () => {
    const h = setUp();
    const features = ['chats.showSession', ...DESIGN_FEATURES];
    const { a, b } = await shared(h, undefined, features);
    const reveals: string[] = [];
    for (const [name, client] of [['a', a], ['b', b]] as const) {
      client.main.onPanel((viewId, envelope) => {
        if (envelope.op === 'reveal') reveals.push(`${name} ${viewId}`);
      });
    }
    b.lose();
    let shown: unknown = 'pending';
    void processActor.run('device-b', () => h.core.request('chats.reveal', { viewId: 'view-1' })).then((value) => (shown = value));
    await flush();
    expect([shown, reveals]).toEqual(['pending', []]);
    b.resume();
    await vi.waitFor(() => expect(shown).toBe(true));
    expect(reveals).toEqual(['b view-b']);

    // a device that detached opens the chat by its stored session when the same install attaches again
    b.detach();
    shown = 'pending';
    void processActor.run('device-b', () => h.core.request('chats.reveal', { viewId: 'view-1' })).then((value) => (shown = value));
    await flush();
    const again = h.client('connection-3', {
      clientId: 'device-b',
      features,
      before: (main) => main.serve('chats.showSession', async ({ sessionId }) => {
        await main.request('views.join', { viewId: 'view-b2', viewKey: 'token-of-b2', sessionId });
      }),
    });
    await vi.waitFor(() => expect(shown).toBe(true));
    expect(again.close).not.toHaveBeenCalled();
    expect(reveals).toEqual(['b view-b']);
  });

  it('send design.openPreview and design.replayJourney of a device\'s work to that device alone, refusing while it shows no view of the chat, never to another device', async () => {
    const h = setUp();
    const { a, b } = await shared(h, undefined, DESIGN_FEATURES);
    const c = h.client('connection-3', { clientId: 'device-c', features: DESIGN_FEATURES });
    const asked: string[] = [];
    for (const [name, client] of [['a', a], ['b', b], ['c', c]] as const) {
      client.main.serve('design.openPreview', () => {
        asked.push(`open ${name}`);
      });
      client.main.serve('design.replayJourney', () => {
        asked.push(`replay ${name}`);
      });
    }
    const open = { panelId: 'panel-1', designId: 'contacts-1a2b3c4d', relPath: 'screens/S1.html' };
    const step = { action: 'click' as const, target: { role: 'button', name: 'Add contact' } };
    const shown = { action: 'assert' as const, target: { role: 'dialog', name: 'New contact' }, expect: { visible: true } };
    const replay = { ...open, state: null, steps: [step, shown], reducedMotion: true };
    const asActor = <T>(actor: string, work: () => Promise<T>): Promise<T> => processActor.run(actor, work);
    await asActor('device-b', () => h.core.request('design.openPreview', open));
    await asActor('device-b', () => h.core.request('design.replayJourney', replay));
    expect(asked).toEqual(['open b', 'replay b']);
    // device c acts but shows no view of the chat: refused, though devices a and b show it
    await expect(asActor('device-c', () => h.core.request('design.openPreview', open))).rejects.toThrow(DESIGN_PREVIEW_CLIENT_ABSENT);
    await expect(asActor('device-c', () => h.core.request('design.replayJourney', replay))).rejects.toThrow(DESIGN_RENDER_CLIENT_ABSENT);
    // device b inside its grace, and a device no longer attached
    b.lose();
    await expect(asActor('device-b', () => h.core.request('design.openPreview', open))).rejects.toThrow(DESIGN_PREVIEW_CLIENT_ABSENT);
    b.resume();
    await expect(asActor('device-gone', () => h.core.request('design.openPreview', open))).rejects.toThrow(DESIGN_PREVIEW_CLIENT_ABSENT);
    expect(asked).toEqual(['open b', 'replay b']);
  });

  it('name a new panel\'s parent by the view the acting client shows it under, and drop a parent that client does not show', async () => {
    const h = setUp();
    const { a, b } = await shared(h);
    const created: Array<[string, string, unknown]> = [];
    a.main.onPanel((viewId, envelope) => {
      if (envelope.op === 'create') created.push(['a', viewId, envelope.payload]);
    });
    b.main.onPanel((viewId, envelope) => {
      if (envelope.op === 'create') created.push(['b', viewId, envelope.payload]);
    });
    const create = { kind: 'chat' as const, title: 'Design · Contacts', localResourceRoots: [], parent: 'view-1' };
    // device b rejoined the parent chat under its own view id, and its StartDesign opens the design chat
    await b.main.request('catalog.list', { projectKey: '/srv/app', complete: false }).catch(() => undefined);
    h.core.postPanel('view-design-1', 'create', create);
    // a device that does not show the parent acts next
    const c = h.client('connection-3', { clientId: 'device-c' });
    c.main.onPanel((viewId, envelope) => {
      if (envelope.op === 'create') created.push(['c', viewId, envelope.payload]);
    });
    h.core.postPanel('view-design-2', 'create', create);
    await flush();
    expect(created).toEqual([
      ['b', 'view-design-1', { ...create, parent: 'view-b' }],
      ['c', 'view-design-2', { kind: 'chat', title: 'Design · Contacts', localResourceRoots: [] }],
    ]);
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
    const c = h.client('connection-3', { clientId: 'device-c' });
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
    const a = h.client('connection-1', { clientId: 'device-a' });
    a.main.serve('user.credentials', () => ({ type: 'api_key' as const, key: 'from-a' }));
    a.lose();
    await expect(h.core.request('user.credentials', { provider: 'anthropic', clientId: 'device-a' })).rejects.toThrow('credential-client-absent');
    a.resume();
    expect(await h.core.request('user.credentials', { provider: 'anthropic', clientId: 'device-a' })).toEqual({ type: 'api_key', key: 'from-a' });
  });

  it('makes a credential ask it was answering fail as absent the moment it is lost', async () => {
    const h = setUp();
    const a = h.client('connection-1', { clientId: 'device-a' });
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
    const a = h.client('connection-1', { clientId: 'device-a' });
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
      const first = h.client('connection-1', { clientId: 'device-a' });
      await first.main.request('chats.restore', { viewId: 'view-1' });
      first.main.postPanel('view-1', 'message', { message: { type: 'ready', panelToken: 'token-1' } });
      h.core.publish('chats', { panelId: 'panel-1', entry: entry('panel-1', 'view-1') });
      const second = h.client('connection-2', { drained: () => new Promise<void>(() => undefined), clientId: 'device-b' });
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
    const a = h.client('connection-1', { clientId: 'device-a' });
    await a.main.request('chats.restore', { viewId: 'view-1' });
    a.main.postPanel('view-1', 'message', { message: { type: 'ready', panelToken: 'token-1' } });
    h.core.publish('chats', { panelId: 'panel-1', entry: entry('panel-1', 'view-1') });
    const b = h.client('connection-2', { drained: () => new Promise<void>(() => undefined), clientId: 'device-b' });
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
    const b = h.client('connection-2', { clientId: 'device-b' });
    const a = h.client('connection-1', { clientId: 'device-a' });
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

  it('gets no request of work with no actor while it is the acting client: another attached client does, else none', async () => {
    const h = setUp();
    const a = h.client('c1');
    const b = h.client('c2');
    a.main.serve('notifications.show', () => 0);
    b.main.serve('notifications.show', () => 1);
    await a.main.request('catalog.list', { projectKey: '/srv/app', complete: false }).catch(() => undefined);
    const ask = (): Promise<unknown> => h.core.request('notifications.show', { severity: 'info', message: { message: 'hi' }, actions: [] });
    expect(await ask()).toBe(0);
    a.lose();
    expect(await ask()).toBe(1);
    b.lose();
    expect(await ask()).toBeUndefined();
  });
});

describe('the work of a device that is away', () => {
  const notice = { severity: 'info', message: { message: 'hi' }, actions: [] } as const;
  const create = { kind: 'chat' as const, title: 'Contacts', localResourceRoots: [] };
  const AWAY = { error: 'the device that asked is away', reason: 'user' };

  it('holds a request while its device is lost, never asks another device, and sends it on the resume', async () => {
    const h = setUp();
    const a = h.client('c1');
    const b = h.client('c2');
    const asked: string[] = [];
    a.main.serve('notifications.show', () => {
      asked.push('a');
      return 0;
    });
    b.main.serve('notifications.show', () => {
      asked.push('b');
      return 1;
    });
    a.lose();
    let answer: unknown = 'pending';
    void processActor.run('c1', () => h.core.request('notifications.show', notice)).then((value) => (answer = value));
    await flush();
    expect([answer, asked]).toEqual(['pending', []]);
    a.resume();
    await vi.waitFor(() => expect(answer).toBe(0));
    expect(asked).toEqual(['a']);
  });

  it('sends a request held for a detached device to the same install when it attaches again', async () => {
    const h = setUp();
    const a = h.client('connection-1', { clientId: 'device-a' });
    h.client('connection-2', { clientId: 'device-b' }).main.serve('dialogs.pickFolder', () => '/from-b');
    a.detach();
    const picked = processActor.run('device-a', () => h.core.request('dialogs.pickFolder', {}));
    await flush();
    h.client('connection-3', { clientId: 'device-a', before: (main) => main.serve('dialogs.pickFolder', () => '/from-a') });
    expect(await picked).toBe('/from-a');
  });

  it('answers a held request with its no-client answer once the intent expired, and logs it', async () => {
    const lines: string[] = [];
    const h = setUp({ actorIntentExpiryMs: 20, log: (line) => lines.push(line) });
    const a = h.client('c1');
    const b = h.client('c2');
    const asked: string[] = [];
    a.main.serve('shell.openExternal', () => {
      asked.push('a');
      return true;
    });
    b.main.serve('shell.openExternal', () => {
      asked.push('b');
      return true;
    });
    a.lose();
    expect(await processActor.run('c1', () => h.core.request('shell.openExternal', { url: 'https://a.test/' }))).toBe(false);
    expect(lines.some((line) => line.includes('shell.openExternal') && line.includes('c1') && line.includes('20 ms'))).toBe(true);
    a.resume();
    await flush();
    expect(asked).toEqual([]);
  });

  it('ends a held request core cancelled, which its device never gets', async () => {
    const h = setUp();
    const a = h.client('c1');
    const asked = vi.fn();
    a.main.serve('trust.request', asked);
    a.lose();
    const cancel = new AbortController();
    const trusted = processActor.run('c1', () => h.core.request('trust.request', { folderPath: '/srv/app' }, cancel.signal));
    await flush();
    cancel.abort();
    await trusted.catch(() => undefined);
    a.resume();
    await flush();
    expect(asked).not.toHaveBeenCalled();
  });

  it('holds only what surfaces on a device: a request that only returns data is a workClient route', () => {
    const work = Object.entries(CORE_REQUEST_ROUTES).flatMap(([method, route]) => (route.to === 'workClient' ? [method] : []));
    expect(work.sort()).toEqual(['design.capture', 'design.journey', 'design.probe', 'design.render', 'editor.readText']);
  });

  it('serves a data request of its work on another present device that can when its own present device cannot', async () => {
    const h = setUp();
    const older = h.client('c-old');
    const client = h.client('c1', { features: RENDER_FEATURES });
    const asked: string[] = [];
    const shot = { png: new Uint8Array([1]), cssWidth: 390, cssHeight: 900, contentHeight: 900, scale: 1 };
    client.main.serve('design.capture', () => {
      asked.push('c1');
      return shot;
    });
    older.main.serve('design.capture', () => {
      asked.push('c-old');
      return shot;
    });
    const capture = { designId: 'contacts-1a2b3c4d', relPath: 'screens/S1.html', width: 390, state: null, scale: 1 };
    expect(await processActor.run('c-old', () => h.core.request('design.capture', capture))).toEqual(shot);
    expect(asked).toEqual(['c1']);
    // the actor's own device first when it can, though another acted last
    const own = h.client('c2', { features: RENDER_FEATURES });
    own.main.serve('design.capture', () => {
      asked.push('c2');
      return shot;
    });
    await client.main.request('catalog.list', { projectKey: '/srv/app', complete: false }).catch(() => undefined);
    await processActor.run('c2', () => h.core.request('design.capture', capture));
    expect(asked).toEqual(['c1', 'c2']);
  });

  it('never holds a data request while its device is away: another present device serves it, else its no-client answer comes at once', async () => {
    const h = setUp();
    const a = h.client('connection-1', { clientId: 'device-a', features: RENDER_FEATURES });
    const b = h.client('connection-2', { clientId: 'device-b' });
    const read: string[] = [];
    a.main.serve('editor.readText', () => {
      read.push('a');
      return 'from a';
    });
    b.main.serve('editor.readText', () => {
      read.push('b');
      return 'from b';
    });
    a.lose();
    expect(await processActor.run('device-a', () => h.core.request('editor.readText', { path: '/srv/app/a.ts' }))).toBe('from b');
    // no other device renders: refused before the outbox's minute, and not sent on the resume
    const capture = { designId: 'contacts-1a2b3c4d', relPath: 'screens/S1.html', width: 390, state: null, scale: 1 };
    const captured = vi.fn();
    a.main.serve('design.capture', captured);
    await expect(processActor.run('device-a', () => h.core.request('design.capture', capture))).rejects.toThrow(DESIGN_RENDER_CLIENT_ABSENT);
    a.resume();
    await flush();
    expect(captured).not.toHaveBeenCalled();
    expect(read).toEqual(['b']);
  });

  it('holds an acting-client event while its device is lost and emits it there on the resume, or drops and logs it past the expiry', async () => {
    const lines: string[] = [];
    const h = setUp({ actorIntentExpiryMs: 20, log: (line) => lines.push(line) });
    const a = h.client('c1');
    const b = h.client('c2');
    const seen: string[] = [];
    a.main.onEvent('window.openAppSettings', () => seen.push('a'));
    b.main.onEvent('window.openAppSettings', () => seen.push('b'));
    a.lose();
    processActor.run('c1', () => h.core.emit('window.openAppSettings', {}));
    await flush();
    expect(seen).toEqual([]);
    a.resume();
    expect(seen).toEqual(['a']);
    a.lose();
    processActor.run('c1', () => h.core.emit('window.openAppSettings', {}));
    await vi.waitFor(() => expect(lines.some((line) => line.includes('window.openAppSettings') && line.includes('20 ms'))).toBe(true));
    a.resume();
    expect(seen).toEqual(['a']);
  });

  it('creates a new panel of its work on that device alone: held while it is away, created on its resume or fresh attach', async () => {
    const h = setUp();
    const a = h.client('connection-1', { clientId: 'device-a' });
    const b = h.client('connection-2', { clientId: 'device-b' });
    const created: string[] = [];
    const record = (name: string) => (main: MainEndpoint): void => {
      main.onPanel((viewId, envelope) => {
        if (envelope.op === 'create') created.push(`${name} ${viewId}`);
      });
    };
    record('a')(a.main);
    record('b')(b.main);
    const disposed: unknown[] = [];
    h.core.onPanel((viewId, envelope) => {
      if (envelope.op === 'disposed') disposed.push(viewId);
    });
    const opsOfA: string[] = [];
    a.main.onPanel((viewId, envelope) => opsOfA.push(`${envelope.op} ${viewId}`));
    a.lose();
    // core sets the new panel up at once: its page, icon and title wait with it and follow it, in order
    processActor.run('device-a', () => {
      h.core.postPanel('view-1', 'create', create);
      h.core.postPanel('view-1', 'setIcon', { path: '/app/icon.png' });
      h.core.postPanel('view-1', 'setTitle', { title: 'Design · Contacts' });
    });
    await flush();
    expect([created, opsOfA]).toEqual([[], []]);
    a.resume();
    expect(created).toEqual(['a view-1']);
    expect(opsOfA).toEqual(['create view-1', 'setIcon view-1', 'setTitle view-1']);
    // the held panel is the device's view: core's posts reach it
    h.core.postPanel('view-1', 'post', { type: 'x', json: '{}' });
    expect(opsOfA.at(-1)).toBe('post view-1');

    a.detach();
    processActor.run('device-a', () => h.core.postPanel('view-2', 'create', create));
    await flush();
    h.client('connection-3', { clientId: 'device-a', before: record('a again') });
    expect(created).toEqual(['a view-1', 'a again view-2']);
    // view-1 by the panel rule on the detach; the held view-2 never
    expect(disposed).toEqual(['view-1']);
  });

  it('cancels a new panel of its work past the expiry: core is told the device is away, and no device gets it', async () => {
    const lines: string[] = [];
    const h = setUp({ actorIntentExpiryMs: 20, log: (line) => lines.push(line) });
    const a = h.client('connection-1', { clientId: 'device-a' });
    const b = h.client('connection-2', { clientId: 'device-b' });
    const created: string[] = [];
    a.main.onPanel((viewId, envelope) => {
      if (envelope.op === 'create') created.push(`a ${viewId}`);
    });
    b.main.onPanel((viewId, envelope) => {
      if (envelope.op === 'create') created.push(`b ${viewId}`);
    });
    const disposed: unknown[] = [];
    h.core.onPanel((viewId, envelope) => {
      if (envelope.op === 'disposed') disposed.push([viewId, envelope.payload]);
    });
    a.lose();
    processActor.run('device-a', () => h.core.postPanel('view-1', 'create', create));
    await vi.waitFor(() => expect(disposed).toEqual([['view-1', AWAY]]));
    expect(lines.some((line) => line.includes('view-1') && line.includes('device-a'))).toBe(true);
    a.resume();
    expect(created).toEqual([]);
  });

  it('drops a held new panel core closed meanwhile, without telling core it was disposed', async () => {
    const h = setUp();
    const a = h.client('connection-1', { clientId: 'device-a' });
    const created = vi.fn();
    a.main.onPanel((_viewId, envelope) => {
      if (envelope.op === 'create') created();
    });
    const disposed = vi.fn();
    h.core.onPanel((_viewId, envelope) => {
      if (envelope.op === 'disposed') disposed();
    });
    const ops = vi.fn();
    a.main.onPanel(ops);
    a.lose();
    processActor.run('device-a', () => h.core.postPanel('view-1', 'create', create));
    h.core.postPanel('view-1', 'setTitle', { title: 'Contacts' });
    h.core.postPanel('view-1', 'close', {});
    await flush();
    a.resume();
    expect(created).not.toHaveBeenCalled();
    expect(ops).not.toHaveBeenCalled();
    expect(disposed).not.toHaveBeenCalled();
  });

  it('keeps what is still held for the device\'s next session when a delivery closes the session it came back on', async () => {
    const OVERSIZED = 'oversized-marker';
    const h = setUp();
    const a = h.client('connection-1', { clientId: 'device-a', refuses: OVERSIZED });
    const disposed: unknown[] = [];
    h.core.onPanel((viewId, envelope) => {
      if (envelope.op === 'disposed') disposed.push([viewId, envelope.payload]);
    });
    a.lose();
    let answer: unknown = 'pending';
    processActor.run('device-a', () => {
      h.core.postPanel('view-1', 'create', { ...create, title: OVERSIZED });
      h.core.postPanel('view-2', 'create', create);
      void h.core.request('notifications.show', notice).then((value) => (answer = value));
    });
    await flush();
    a.resume();
    expect(a.close).toHaveBeenCalledExactlyOnceWith('a message over the bound');
    // core learns the refused panel is gone, by the panel rule of the detach
    await vi.waitFor(() => expect(disposed).toEqual([['view-1', { reason: 'detach' }]]));
    expect(answer).toBe('pending');
    const created: string[] = [];
    h.client('connection-2', {
      clientId: 'device-a',
      before: (main) => {
        main.onPanel((viewId, envelope) => {
          if (envelope.op === 'create') created.push(viewId);
        });
        main.serve('notifications.show', () => 0);
      },
    });
    await vi.waitFor(() => expect(answer).toBe(0));
    expect(created).toEqual(['view-2']);
    expect(disposed).toHaveLength(1);
  });

  it('cancels a held new panel core sends more updates than the bound for, and tells core the device is away', async () => {
    const h = setUp();
    const a = h.client('connection-1', { clientId: 'device-a' });
    const ops: string[] = [];
    a.main.onPanel((viewId, envelope) => ops.push(`${envelope.op} ${viewId}`));
    const disposed: unknown[] = [];
    h.core.onPanel((viewId, envelope) => {
      if (envelope.op === 'disposed') disposed.push([viewId, envelope.payload]);
    });
    a.lose();
    processActor.run('device-a', () => h.core.postPanel('view-1', 'create', create));
    for (let index = 0; index < MAX_HELD_PANEL_OPS; index++) h.core.postPanel('view-1', 'post', { type: 'partial', json: '{}' });
    await flush();
    expect(disposed).toEqual([]);
    h.core.postPanel('view-1', 'post', { type: 'partial', json: '{}' });
    await vi.waitFor(() => expect(disposed).toEqual([['view-1', AWAY]]));
    a.resume();
    await flush();
    expect(ops).toEqual([]);
  });

  it('answers views.drained for a held new panel only once the panel reached its device, so core folds its partials meanwhile', async () => {
    const h = setUp();
    const a = h.client('connection-1', { clientId: 'device-a' });
    const created = vi.fn();
    a.main.onPanel((_viewId, envelope) => {
      if (envelope.op === 'create') created();
    });
    a.lose();
    processActor.run('device-a', () => h.core.postPanel('view-1', 'create', create));
    let drained = false;
    void h.core.request('views.drained', { viewId: 'view-1' }).then(() => { drained = true; });
    await flush();
    expect(drained).toBe(false);
    a.resume();
    await vi.waitFor(() => expect(drained).toBe(true));
    expect(created).toHaveBeenCalledOnce();
  });

  it('answers views.drained for a held new panel once its hold ends unanswered', async () => {
    const h = setUp();
    const a = h.client('connection-1', { clientId: 'device-a' });
    a.lose();
    processActor.run('device-a', () => h.core.postPanel('view-1', 'create', create));
    let drained = false;
    void h.core.request('views.drained', { viewId: 'view-1' }).then(() => { drained = true; });
    await flush();
    expect(drained).toBe(false);
    h.core.postPanel('view-1', 'close', {});
    await vi.waitFor(() => expect(drained).toBe(true));
  });

  it('sends work with no actor to the acting client: another attached one while it is lost, a lost one when it is the only one for a new panel', async () => {
    const h = setUp();
    const a = h.client('connection-1', { clientId: 'device-a' });
    const b = h.client('connection-2', { clientId: 'device-b' });
    const seen: string[] = [];
    for (const [name, client] of [['a', a], ['b', b]] as const) {
      client.main.serve('notifications.show', () => {
        seen.push(`${name} notice`);
        return undefined;
      });
      client.main.onEvent('window.openAppSettings', () => seen.push(`${name} event`));
      client.main.onPanel((viewId, envelope) => {
        if (envelope.op === 'create') seen.push(`${name} ${viewId}`);
      });
    }
    await a.main.request('catalog.list', { projectKey: '/srv/app', complete: false }).catch(() => undefined);
    a.lose();
    await h.core.request('notifications.show', notice);
    h.core.emit('window.openAppSettings', {});
    h.core.postPanel('view-1', 'create', create);
    b.detach();
    h.core.postPanel('view-2', 'create', create);
    await flush();
    expect(seen).toEqual(['b notice', 'b event', 'b view-1', 'a view-2']);
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
    const a = h.client('c1', { hostId: 'host-a' });
    const b = h.client('c2', { hostId: 'host-b' });
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
    const old = h.client('connection-1', { clientId: 'device-a' });
    old.main.serve('user.credentials', () => ({ type: 'api_key' as const, key: 'from-old' }));
    const other = h.client('connection-2', { clientId: 'device-b' });
    other.main.serve('user.credentials', () => ({ type: 'api_key' as const, key: 'from-b' }));
    const fresh = h.client('connection-3', { clientId: 'device-a' });
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
    const client = h.client('connection-1', { clientId: 'device-a' });
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
