import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { PiRuntime, type LiveSessionMutator } from '../pi-runtime';
import { FolderRuntime } from '../folder-runtime';
import { McpClientManager } from '../mcp/mcp-client-manager';
import { initPiLoader, nodeSupportsPi, PI_MIN_NODE_MAJOR, type PiCodingAgentModule } from '../pi-loader';
import type { SecretResolver } from '../custom-providers';
import { LEGACY_SUBSCRIPTION_REPOS, SUBSCRIPTION_SOURCE, classifySubscriptionSource } from '../subscription';

/**
 * Capture what `logger.ts` ACTUALLY writes, not the format-string arguments — the credential leak this
 * guards was invisible at the argument level. Installed file-wide because `logger.ts` memoizes the
 * channel on its first `log()` call, whichever describe block that happens to be in.
 */
const logLines: string[] = [];
beforeAll(() => {
  vi.spyOn(vscode.window, 'createOutputChannel').mockReturnValue({
    appendLine: (line: string) => void logLines.push(line),
    show: () => {},
    dispose: () => {},
  } as unknown as vscode.LogOutputChannel);
});

describe('PiRuntime singleton (B1)', () => {
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  it('returns one shared instance regardless of get() arguments', () => {
    const a = PiRuntime.get('/tmp/agent-a');
    const b = PiRuntime.get('/tmp/agent-b');
    expect(a).toBe(b);
    expect(a.agentDir).toBe('/tmp/agent-a');
    expect(PiRuntime.exists).toBe(true);
  });

  it('disposeInstance clears the singleton so a fresh instance can be created', async () => {
    const a = PiRuntime.get();
    await PiRuntime.disposeInstance();
    expect(PiRuntime.exists).toBe(false);
    const c = PiRuntime.get();
    expect(c).not.toBe(a);
  });

  it("a late unregister from a session's previous mutator leaves the new owner's entry", () => {
    // Two panels can hold one session id, on different folders; the mutator registry is process-wide.
    const runtime = PiRuntime.get();
    const older = {} as LiveSessionMutator;
    const newer = {} as LiveSessionMutator;
    runtime.registerSessionMutator('sess-x', older);
    runtime.registerSessionMutator('sess-x', newer);

    runtime.unregisterSessionMutator('sess-x', older);
    expect(runtime.getSessionMutator('sess-x')).toBe(newer);

    runtime.unregisterSessionMutator('sess-x', newer);
    expect(runtime.getSessionMutator('sess-x')).toBeUndefined();
  });
});

/**
 * The subscription plugin switch, across every folder loader. Every case asserts the invariant that
 * settings list a subscription plugin only if that plugin registered `anthropic`, plus the order of
 * settings writes, reloads and provider resets that keeps it true across a failure at any step.
 *
 * The fake keeps pi's split between in-memory and on-disk settings: `flush` writes the user settings'
 * memory to disk (or records a write error), `reload` re-reads the disk, and each folder loader's
 * `reload` re-reads the disk before loading, as pi's resource loader does. Two folder loaders share one
 * `ModelRuntime`, whose `registerProvider` merges over the previous registration, as pi's does.
 */
describe('subscription plugin migration', () => {
  // Folder creation needs the loaded pi module; the cold import takes seconds, so it is paid once here.
  beforeAll(async () => {
    if (!(await initPiLoader())) throw new Error('pi failed to load');
  }, 60_000);

  const CURRENT = SUBSCRIPTION_SOURCE;
  const LEGACY = 'https://github.com/AizenvoltPrime/pi-anthropic-oauth@8f82a2d207e12bfd313092d78333c594554f26fb';
  const LEGACY_REPO = LEGACY_SUBSCRIPTION_REPOS[0]!;
  type LoadBehavior = 'register' | 'none' | 'error';
  type Entry = string | { source: string; extensions?: string[] };
  type Pending = { name: string; config: Record<string, unknown>; extensionPath: string };

  interface Harness {
    runtime: PiRuntime;
    calls: string[];
    /** In-memory user packages. */
    memory: Entry[];
    /** User packages as written to settings.json. */
    disk: Entry[];
    providers: Map<string, Record<string, unknown>>;
    cloneDir(source: string): string;
    behavior: { current: LoadBehavior; legacy: LoadBehavior };
    startupErrors: { path: string; error: string }[];
    failInstall: boolean;
    failLegacyRemove: boolean;
    failNextFlush: boolean;
    failNextReload: boolean;
    /** Resolves when the install may proceed; lets a case act while a swap is in flight. */
    installGate: Promise<void>;
    folders: FolderRuntime[];
    /** Create a folder runtime whose loader follows the harness, labelled by the last path segment. */
    addFolder(label: string): FolderRuntime;
  }

  const tmpRoots: string[] = [];
  const spies: Array<{ mockRestore(): void }> = [];
  const restoreSpies = (): void => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  };
  afterEach(async () => {
    restoreSpies();
    await PiRuntime.disposeInstance();
    for (const dir of tmpRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const sourceOf = (e: Entry): string => (typeof e === 'string' ? e : e.source);
  const identity = (source: string): string => source.replace(/[@#].*$/, '');
  const diskSources = (h: Harness): string[] => h.disk.map(sourceOf);

  function writeClone(dir: string): void {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), '');
  }

  function setup(opts: { packages: Entry[]; clones: string[]; folders?: string[] }): Harness {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-sub-mig-'));
    tmpRoots.push(root);
    const calls: string[] = [];
    const runtime = PiRuntime.get(root);
    const writeErrors: { scope: string; error: Error }[] = [];

    const modelRuntime = {
      registerProvider: (name: string, config: Record<string, unknown>) => {
        calls.push(`register:${name}:${String(config['tag'])}`);
        h.providers.set(name, { ...h.providers.get(name), ...config });
      },
      unregisterProvider: (name: string) => {
        calls.push(`unregister:${name}`);
        h.providers.delete(name);
      },
      getRegisteredProviderConfig: (name: string) => h.providers.get(name),
      refresh: async () => {
        calls.push('refresh');
        return { aborted: false, errors: new Map() };
      },
    };

    /** What a loader reading the current disk registers: one `anthropic` per listed subscription plugin. */
    function load(): { pending: Pending[]; errors: { path: string; error: string }[] } {
      const pending: Pending[] = [];
      const errors: { path: string; error: string }[] = [];
      for (const entry of h.disk) {
        const source = sourceOf(entry);
        const kind = classifySubscriptionSource(source);
        if (kind !== 'current' && kind !== 'legacy') continue;
        const behavior = h.behavior[kind];
        if (behavior === 'none') continue;
        const extensionPath = path.join(h.cloneDir(source), 'src', 'index.ts');
        const config = kind === 'legacy' ? { tag: kind, oauth: true } : { tag: kind };
        pending.push({ name: 'anthropic', config, extensionPath });
        if (behavior === 'error') errors.push({ path: extensionPath, error: 'boom' });
      }
      return { pending, errors };
    }

    function attachLoader(folder: FolderRuntime, label: string): void {
      const runtimeState = { pendingProviderRegistrations: [] as Pending[] };
      let reloadErrors: { path: string; error: string }[] | null = null;
      (folder as unknown as { _services: unknown })._services = {
        settingsManager: { isProjectTrusted: () => true },
        resourceLoader: {
          reload: async () => {
            calls.push(`reload:${label}`);
            if (h.failNextReload) {
              h.failNextReload = false;
              throw new Error('git clone failed');
            }
            const loaded = load();
            runtimeState.pendingProviderRegistrations.push(...loaded.pending);
            reloadErrors = loaded.errors;
          },
          extendResources: () => undefined,
          getExtensions: () => ({ runtime: runtimeState, errors: reloadErrors ?? h.startupErrors }),
        },
      };
    }

    const h: Harness = {
      runtime,
      calls,
      memory: [...opts.packages],
      disk: [...opts.packages],
      providers: new Map(),
      // pi keys a clone by host and full repo path, so two owners' repos of the same name never share a directory.
      cloneDir: (source) => {
        const url = new URL(identity(source));
        return path.join(root, 'git', url.host, ...url.pathname.split('/').filter(Boolean));
      },
      behavior: { current: 'register', legacy: 'register' },
      startupErrors: [],
      failInstall: false,
      failLegacyRemove: false,
      failNextFlush: false,
      failNextReload: false,
      installGate: Promise.resolve(),
      folders: [],
      addFolder: (label) => {
        const folder = new FolderRuntime({
          pi: {} as PiCodingAgentModule,
          cwd: path.join(root, 'ws', label),
          agentDir: root,
          modelRuntime: modelRuntime as unknown as ModelRuntime,
          userMcp: new McpClientManager(),
          createFolderMcp: (reservedPrefixes) => new McpClientManager({ reservedPrefixes }),
          renameSession: async () => undefined,
        });
        attachLoader(folder, label);
        h.folders.push(folder);
        return folder;
      },
    };
    for (const source of opts.clones) writeClone(h.cloneDir(source));

    const userSettings = {
      getGlobalSettings: () => ({ packages: [...h.memory] }),
      setPackages: (packages: Entry[]) => {
        calls.push('setPackages');
        h.memory = [...packages];
      },
      flush: async () => {
        calls.push('flush');
        if (h.failNextFlush) {
          h.failNextFlush = false;
          writeErrors.push({ scope: 'global', error: new Error('settings.json is locked') });
          return;
        }
        h.disk = [...h.memory];
      },
      drainErrors: () => writeErrors.splice(0),
      reload: async () => {
        h.memory = [...h.disk];
      },
    };

    const fakePm = {
      getInstalledPath: (source: string) => {
        const dir = h.cloneDir(source);
        return fs.existsSync(dir) ? dir : undefined;
      },
      addSourceToSettings: (source: string) => {
        calls.push(`addSettings:${source}`);
        const i = h.memory.findIndex((p) => identity(sourceOf(p)) === identity(source));
        if (i === -1) h.memory.push(source);
        else h.memory[i] = source;
        return true;
      },
      removeSourceFromSettings: (source: string) => {
        calls.push(`removeSettings:${identity(source)}`);
        const before = h.memory.length;
        h.memory = h.memory.filter((p) => identity(sourceOf(p)) !== identity(source));
        return h.memory.length !== before;
      },
      install: async (source: string) => {
        calls.push(`install:${source}`);
        await h.installGate;
        if (h.failInstall) throw new Error('network down');
        writeClone(h.cloneDir(source));
      },
      remove: async (source: string) => {
        calls.push(`remove:${identity(source)}`);
        if (h.failLegacyRemove && identity(source) === LEGACY_REPO) throw new Error('EPERM');
        fs.rmSync(h.cloneDir(source), { recursive: true, force: true });
      },
    };

    const internals = runtime as unknown as {
      _modelRuntime: unknown;
      _userSettings: unknown;
      _userMcp: unknown;
      _initPromise: Promise<void>;
    };
    internals._modelRuntime = modelRuntime;
    internals._userSettings = userSettings;
    internals._userMcp = { onToolsChanged: () => () => undefined, dispose: async () => undefined };
    internals._initPromise = Promise.resolve();
    spies.push(vi.spyOn(runtime as unknown as { _packageManager(): unknown }, '_packageManager').mockReturnValue(fakePm));

    // A folder created through `folder()` gets a harness loader, and pi's services creation flushes that
    // loader's registrations into the shared model runtime, as `createAgentSessionServices` does.
    spies.push(vi.spyOn(FolderRuntime.prototype, 'createServices').mockImplementation(async function (this: FolderRuntime) {
      const label = path.basename(this.cwd);
      calls.push(`create:${label}`);
      attachLoader(this, label);
      h.folders.push(this);
      await this.reloadBare();
      const ext = this.services.resourceLoader.getExtensions();
      for (const { name, config } of ext.runtime.pendingProviderRegistrations) modelRuntime.registerProvider(name, config as Record<string, unknown>);
      ext.runtime.pendingProviderRegistrations = [];
    }));

    const registered = runtime as unknown as { _folders: Map<string, FolderRuntime>; _folderPromises: Map<string, Promise<FolderRuntime>> };
    for (const label of opts.folders ?? ['A', 'B']) {
      const folder = h.addFolder(label);
      registered._folders.set(folder.key, folder);
      registered._folderPromises.set(folder.key, Promise.resolve(folder));
    }
    return h;
  }

  type Ops = {
    _reconcileSubscriptionPin(pi: unknown, folders: readonly FolderRuntime[], created: FolderRuntime): Promise<void>;
    _setPluginInstalled(pi: unknown, installed: boolean): Promise<void>;
  };
  const reconcile = (h: Harness): Promise<void> => (h.runtime as unknown as Ops)._reconcileSubscriptionPin({}, h.folders, h.folders[0]!);
  const toggle = (h: Harness, allowance: boolean): Promise<void> => (h.runtime as unknown as Ops)._setPluginInstalled({}, allowance);

  /** Each step appears after the one before it. */
  function expectOrder(calls: string[], steps: string[]): void {
    let from = 0;
    for (const step of steps) {
      const at = calls.indexOf(step, from);
      expect(at, `${step} after index ${from} in ${calls.join(', ')}`).toBeGreaterThanOrEqual(0);
      from = at + 1;
    }
  }

  const reloads = (h: Harness): string[] => h.calls.filter((c) => c.startsWith('reload:'));

  /** A legacy-only install whose legacy plugin is registered, as at startup. */
  function legacyInstall(): Harness {
    const h = setup({ packages: [LEGACY], clones: [LEGACY] });
    h.providers.set('anthropic', { tag: 'legacy', oauth: true });
    return h;
  }

  it('(a) migrates a legacy-only install: acquire, swap, verify, then delete the legacy clone', async () => {
    const h = legacyInstall();

    await reconcile(h);

    expectOrder(h.calls, [
      `install:${CURRENT}`,
      `removeSettings:${LEGACY_REPO}`,
      'flush',
      'reload:A',
      'reload:B',
      'unregister:anthropic',
      'register:anthropic:current',
      'refresh',
    ]);
    expect(diskSources(h)).toEqual([CURRENT]);
    // Without the unregister, pi's merge would keep the legacy registration's `oauth`.
    expect(h.providers.get('anthropic')).toEqual({ tag: 'current' });
    expect(fs.existsSync(h.cloneDir(LEGACY))).toBe(false);
  });

  it('(a2) the provider reset and flush cover every folder loader, with no gap between them', async () => {
    const h = legacyInstall();

    await reconcile(h);

    // One reset of the shared runtime, then each loader's registration, back to back: no await between
    // the unregister and the registers, or the built-in provider would serve a request in between.
    const unregister = h.calls.indexOf('unregister:anthropic');
    expect(h.calls.filter((c) => c === 'unregister:anthropic')).toHaveLength(1);
    expect(h.calls.slice(unregister, unregister + 3)).toEqual(['unregister:anthropic', 'register:anthropic:current', 'register:anthropic:current']);
    expect(h.calls.filter((c) => c === 'refresh')).toHaveLength(1);
    for (const folder of h.folders) {
      expect(folder.services.resourceLoader.getExtensions().runtime.pendingProviderRegistrations).toEqual([]);
    }
  });

  it('(b) leaves the working legacy plugin alone when the install fails', async () => {
    const h = legacyInstall();
    h.failInstall = true;

    await expect(reconcile(h)).resolves.toBeUndefined();

    expect(h.calls.filter((c) => c.startsWith('removeSettings') || c.startsWith('reload:') || c.startsWith('unregister'))).toEqual([]);
    expect(diskSources(h)).toEqual([LEGACY]);
    expect(fs.existsSync(h.cloneDir(LEGACY))).toBe(true);
  });

  it.each([
    ['registers no anthropic provider', 'none' as const, 'registered no anthropic provider'],
    ['reports a load error in its clone', 'error' as const, 'boom'],
  ])('(c/d) rolls back to the legacy plugin when the new one %s', async (_label, behavior, reason) => {
    for (const via of ['reconcile', 'toggle'] as const) {
      const h = legacyInstall();
      h.behavior.current = behavior;

      if (via === 'reconcile') {
        const logged = logLines.length;
        await expect(reconcile(h)).resolves.toBeUndefined();
        expect(logLines.slice(logged).join('\n')).toContain('subscription reconcile failed');
      } else {
        await expect(toggle(h, true)).rejects.toThrow(`subscription plugin failed to load: ${reason}`);
      }

      expect(diskSources(h)).toEqual([LEGACY]);
      expect(fs.existsSync(h.cloneDir(LEGACY))).toBe(true);
      // The verify pass and the rollback each reload both loaders.
      expect(reloads(h)).toEqual(['reload:A', 'reload:B', 'reload:A', 'reload:B']);
      expect(h.calls.lastIndexOf('register:anthropic:legacy')).toBeGreaterThan(h.calls.lastIndexOf('reload:B'));
      expect(h.providers.get('anthropic')).toEqual({ tag: 'legacy', oauth: true });
      restoreSpies();
      await PiRuntime.disposeInstance();
    }
  });

  it('(e) unlists the new plugin and falls back to the built-in provider when there is no legacy', async () => {
    const h = setup({ packages: [], clones: [] });
    h.behavior.current = 'none';

    await expect(toggle(h, true)).rejects.toThrow('registered no anthropic provider');

    expect(diskSources(h)).toEqual([]);
    expect(h.providers.has('anthropic')).toBe(false);
    expectOrder(h.calls, ['reload:A', 'reload:B', `removeSettings:${identity(CURRENT)}`, 'flush', 'reload:A', 'reload:B', 'unregister:anthropic', 'refresh']);
  });

  it('(f) with a healthy pin and a listed legacy entry, swaps without reinstalling', async () => {
    const h = setup({ packages: [CURRENT, LEGACY], clones: [CURRENT, LEGACY] });

    await toggle(h, true);

    expect(h.calls.some((c) => c.startsWith('install:'))).toBe(false);
    expect(diskSources(h)).toEqual([CURRENT]);
    expect(h.providers.get('anthropic')).toEqual({ tag: 'current' });
    expect(fs.existsSync(h.cloneDir(LEGACY))).toBe(false);
  });

  it('(g) does nothing for a healthy, registered pin with no legacy', async () => {
    const h = setup({ packages: [CURRENT], clones: [CURRENT] });
    h.providers.set('anthropic', { tag: 'current' });

    await toggle(h, true);
    await reconcile(h);

    expect(h.calls).toEqual([]);
  });

  it.each([
    ['legacy only', [LEGACY]],
    ['both listed', [CURRENT, LEGACY]],
  ])('(h) switching to extra usage removes every subscription entry (%s)', async (_label, packages) => {
    const h = setup({ packages, clones: packages });
    h.providers.set('anthropic', { tag: 'legacy', oauth: true });

    await toggle(h, false);

    expect(diskSources(h)).toEqual([]);
    expect(fs.existsSync(h.cloneDir(LEGACY))).toBe(false);
    expect(fs.existsSync(h.cloneDir(CURRENT))).toBe(false);
    // Every loader reloads before the reset, or one still holding the plugin re-flushes it at its next bind.
    expectOrder(h.calls, [`removeSettings:${LEGACY_REPO}`, 'flush', 'reload:A', 'reload:B', 'unregister:anthropic', 'refresh']);
    expect(h.providers.has('anthropic')).toBe(false);
  });

  it('(i) a failed legacy clone delete after a successful swap keeps the settings correct', async () => {
    const h = legacyInstall();
    h.failLegacyRemove = true;

    await expect(reconcile(h)).resolves.toBeUndefined();

    expect(diskSources(h)).toEqual([CURRENT]);
    expect(h.providers.get('anthropic')).toEqual({ tag: 'current' });
  });

  it('(j) unlists a current plugin that failed to load at startup', async () => {
    const h = setup({ packages: [CURRENT], clones: [CURRENT] });
    h.providers.set('anthropic', { tag: 'current' });
    h.startupErrors.push({ path: path.join(h.cloneDir(CURRENT), 'src', 'index.ts'), error: 'SyntaxError' });
    const logged = logLines.length;

    await reconcile(h);

    expect(diskSources(h)).toEqual([]);
    expectOrder(h.calls, [`removeSettings:${identity(CURRENT)}`, 'flush', 'reload:A', 'reload:B', 'unregister:anthropic', 'refresh']);
    expect(h.providers.has('anthropic')).toBe(false);
    expect(logLines.slice(logged).join('\n')).toContain('subscription plugin failed to load');
  });

  it('(j2) unlists a current plugin that loaded but registered no anthropic provider at startup', async () => {
    const h = setup({ packages: [CURRENT], clones: [CURRENT] });

    await reconcile(h);

    expect(diskSources(h)).toEqual([]);
    expect(h.calls).toContain('unregister:anthropic');
  });

  it('(k) deletes an orphan legacy clone with no provider change', async () => {
    const h = setup({ packages: [], clones: [LEGACY] });

    await reconcile(h);

    expect(fs.existsSync(h.cloneDir(LEGACY))).toBe(false);
    expect(h.calls).toEqual([`remove:${LEGACY_REPO}`]);
  });

  it('(l) a settings write that fails at the swap aborts before any reload or delete', async () => {
    const h = legacyInstall();
    h.failNextFlush = true;

    await expect(toggle(h, true)).rejects.toThrow('settings write failed');

    expect(reloads(h)).toEqual([]);
    expect(diskSources(h)).toEqual([LEGACY]);
    expect(fs.existsSync(h.cloneDir(LEGACY))).toBe(true);
    expect(h.providers.get('anthropic')).toEqual({ tag: 'legacy', oauth: true });
  });

  it('(m) a verify reload that throws rolls back to the legacy plugin', async () => {
    const h = legacyInstall();
    h.failNextReload = true;

    await expect(toggle(h, true)).rejects.toThrow('subscription plugin failed to load: git clone failed');

    expect(diskSources(h)).toEqual([LEGACY]);
    expect(h.providers.get('anthropic')).toEqual({ tag: 'legacy', oauth: true });
    expect(fs.existsSync(h.cloneDir(LEGACY))).toBe(true);
  });

  it('(n) a failed repair of a listed plugin whose clone is gone unlists it', async () => {
    const h = setup({ packages: [CURRENT], clones: [] });
    h.providers.set('anthropic', { tag: 'current' });
    h.failInstall = true;

    await expect(toggle(h, true)).rejects.toThrow('network down');

    expect(diskSources(h)).toEqual([]);
    expect(h.providers.has('anthropic')).toBe(false);
  });

  it('(o) rollback does not relist a legacy entry whose clone another window deleted', async () => {
    const h = legacyInstall();
    h.behavior.current = 'none';
    const realRemove = fs.rmSync;
    // The legacy clone disappears between the swap and the rollback.
    h.calls.push = function (this: string[], ...items: string[]) {
      if (items.some((i) => i.startsWith('reload:')) && !this.some((c) => c.startsWith('reload:'))) {
        realRemove(h.cloneDir(LEGACY), { recursive: true, force: true });
      }
      return Array.prototype.push.apply(this, items);
    };

    await expect(toggle(h, true)).rejects.toThrow('registered no anthropic provider');

    expect(diskSources(h)).toEqual([]);
    expect(h.providers.has('anthropic')).toBe(false);
  });

  it('(p) rollback restores a legacy object entry with its filters', async () => {
    const entry = { source: LEGACY, extensions: ['src/index.ts'] };
    const h = setup({ packages: [entry], clones: [LEGACY] });
    h.providers.set('anthropic', { tag: 'legacy', oauth: true });
    h.behavior.current = 'none';

    await expect(toggle(h, true)).rejects.toThrow();

    expect(h.disk).toEqual([entry]);
  });

  it('(q) a later folder whose loader fails to load the plugin unlists it across every folder', async () => {
    const h = setup({ packages: [CURRENT], clones: [CURRENT], folders: ['A'] });
    h.providers.set('anthropic', { tag: 'current' });
    (h.runtime as unknown as { _pinReconciled: boolean })._pinReconciled = true;
    h.behavior.current = 'error';

    const b = await h.runtime.folder(path.join(path.dirname(h.folders[0]!.cwd), 'B'));

    expect(diskSources(h)).toEqual([]);
    expectOrder(h.calls, ['create:B', `removeSettings:${identity(CURRENT)}`, 'flush', 'reload:A', 'reload:B', 'unregister:anthropic', 'refresh']);
    expect(h.providers.has('anthropic')).toBe(false);
    expect(h.runtime.folders()).toEqual([h.folders[0], b]);
  });

  /** A promise and the function that settles it, so a case can hold one step open. */
  function deferred(): { promise: Promise<void>; release: () => void } {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }

  it.each([
    ['commits', 'register' as const, [CURRENT], { tag: 'current' }],
    ['rolls back', 'none' as const, [LEGACY], { tag: 'legacy', oauth: true }],
  ])('a folder requested mid-reconcile is created only after the reconcile %s', async (_label, behavior, listed, provider) => {
    const h = setup({ packages: [LEGACY], clones: [LEGACY], folders: [] });
    h.providers.set('anthropic', { tag: 'legacy', oauth: true });
    h.behavior.current = behavior;
    const install = deferred();
    h.installGate = install.promise;
    const ws = path.join(path.dirname(h.cloneDir(LEGACY)), 'ws');

    const first = h.runtime.folder(path.join(ws, 'A'));
    await vi.waitFor(() => expect(h.calls).toContain(`install:${CURRENT}`));
    const second = h.runtime.folder(path.join(ws, 'B'));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.calls).not.toContain('create:B');
    install.release();
    await Promise.all([first, second]);

    // The swap's last step (evicting the legacy clone, or the rollback's provider reset) precedes B.
    const swapEnd = behavior === 'register' ? h.calls.indexOf(`remove:${LEGACY_REPO}`) : h.calls.lastIndexOf('refresh');
    expect(swapEnd).toBeGreaterThanOrEqual(0);
    expect(h.calls.indexOf('create:B')).toBeGreaterThan(swapEnd);
    expect(diskSources(h)).toEqual(listed);
    // B flushed from settings already swapped, so no stale `oauth` merged back over the reset provider.
    expect(h.providers.get('anthropic')).toEqual(provider);
  });

  it('an allowance toggle issued while a folder is being created downloads at once, then swaps after it and reloads it too', async () => {
    const h = setup({ packages: [LEGACY], clones: [LEGACY], folders: ['A'] });
    h.providers.set('anthropic', { tag: 'legacy', oauth: true });
    (h.runtime as unknown as { _pinReconciled: boolean })._pinReconciled = true;
    const creating = deferred();
    const create = FolderRuntime.prototype.createServices as unknown as { getMockImplementation(): (this: FolderRuntime) => Promise<void> };
    const flushOnCreate = create.getMockImplementation();
    vi.spyOn(FolderRuntime.prototype, 'createServices').mockImplementation(async function (this: FolderRuntime) {
      await creating.promise;
      await flushOnCreate.call(this);
    });
    const a = h.folders[0]!;

    const b = h.runtime.folder(path.join(path.dirname(a.cwd), 'B'));
    await new Promise((r) => setTimeout(r, 0));
    const billing = h.runtime.setSubscriptionBilling(a.cwd, true);
    await vi.waitFor(() => expect(h.calls).toContain(`install:${CURRENT}`));
    expect(h.calls).not.toContain('flush');
    creating.release();
    await Promise.all([b, billing]);

    expectOrder(h.calls, [`install:${CURRENT}`, 'create:B', 'flush', 'reload:A', 'reload:B', 'unregister:anthropic', 'refresh']);
    expect(diskSources(h)).toEqual([CURRENT]);
    expect(h.providers.get('anthropic')).toEqual({ tag: 'current' });
  });

  it('a folder requested while the plugin downloads is created without waiting for the download', async () => {
    const h = setup({ packages: [LEGACY], clones: [LEGACY], folders: ['A'] });
    h.providers.set('anthropic', { tag: 'legacy', oauth: true });
    (h.runtime as unknown as { _pinReconciled: boolean })._pinReconciled = true;
    const install = deferred();
    h.installGate = install.promise;
    const a = h.folders[0]!;

    const billing = h.runtime.setSubscriptionBilling(a.cwd, true);
    await vi.waitFor(() => expect(h.calls).toContain(`install:${CURRENT}`));
    const created = await Promise.race([
      h.runtime.folder(path.join(path.dirname(a.cwd), 'B')),
      new Promise<'blocked'>((r) => setTimeout(() => r('blocked'), 1000)),
    ]);
    expect(created).not.toBe('blocked');
    expect(h.runtime.folders()).toContain(created);
    install.release();
    await billing;

    expectOrder(h.calls, [`install:${CURRENT}`, 'create:B', 'flush', 'reload:A', 'reload:B', 'unregister:anthropic', 'refresh']);
    expect(diskSources(h)).toEqual([CURRENT]);
    expect(h.providers.get('anthropic')).toEqual({ tag: 'current' });
  });

  it('two concurrent allowance toggles download the plugin once, never side by side', async () => {
    const h = setup({ packages: [], clones: [], folders: ['A'] });
    (h.runtime as unknown as { _pinReconciled: boolean })._pinReconciled = true;
    const install = deferred();
    h.installGate = install.promise;
    const a = h.folders[0]!;

    const first = h.runtime.setSubscriptionBilling(a.cwd, true);
    const second = h.runtime.setSubscriptionBilling(a.cwd, true);
    await vi.waitFor(() => expect(h.calls).toContain(`install:${CURRENT}`));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.calls.filter((c) => c.startsWith('install:'))).toHaveLength(1);
    install.release();
    await Promise.all([first, second]);

    expect(h.calls.filter((c) => c.startsWith('install:'))).toHaveLength(1);
    expect(diskSources(h)).toEqual([CURRENT]);
  });

  it('a toggle to extra usage issued during a download applies after the allowance switch it follows', async () => {
    const h = setup({ packages: [], clones: [], folders: ['A'] });
    (h.runtime as unknown as { _pinReconciled: boolean })._pinReconciled = true;
    const install = deferred();
    h.installGate = install.promise;
    const a = h.folders[0]!;

    const on = h.runtime.setSubscriptionBilling(a.cwd, true);
    await vi.waitFor(() => expect(h.calls).toContain(`install:${CURRENT}`));
    const off = h.runtime.setSubscriptionBilling(a.cwd, false);
    await new Promise((r) => setTimeout(r, 0));
    install.release();
    await Promise.all([on, off]);

    expect(diskSources(h)).toEqual([]);
    expect(fs.existsSync(h.cloneDir(CURRENT))).toBe(false);
    expect(h.providers.has('anthropic')).toBe(false);
  });
});

describe('nodeSupportsPi (B5)', () => {
  it('reflects the running Node major against the pi minimum', () => {
    const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
    expect(nodeSupportsPi()).toBe(major >= PI_MIN_NODE_MAJOR);
  });
});

/**
 * A5/A7 — `PiRuntime.syncCustomProviders` had no tests at all. `timedOut` is the single value deciding
 * between warning the user that their model was silently downgraded and saying nothing, and the outer
 * catch used to hardcode it to `false`. Everything here drives the real `custom-providers` sync against
 * an injected `ModelRuntime`, so the contract WORKSTREAM B consumes is asserted end to end.
 */
describe('PiRuntime.syncCustomProviders', () => {
  const STEPFUN_SECRET = 'damocles.explore.apiKey.stepfun';
  const DEEPSEEK_SECRET = 'damocles.deepseek.apiKey';
  const SENTINEL = 'sk-SENTINEL-MUST-NEVER-BE-LOGGED';

  beforeEach(() => {
    logLines.length = 0;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await PiRuntime.disposeInstance();
  });

  type FakeRuntime = Record<string, unknown>;

  function fakeModelRuntime(overrides: FakeRuntime = {}) {
    return {
      registerProvider: vi.fn(),
      unregisterProvider: vi.fn(),
      setRuntimeApiKey: vi.fn(async () => {}),
      removeRuntimeApiKey: vi.fn(async () => {}),
      logout: vi.fn(async () => {}),
      getProviderAuthStatus: vi.fn(() => ({ configured: false })),
      ...overrides,
    };
  }

  /** The only private reach-through: `_modelRuntime` is built by `init()`, which boots pi. */
  function attach(runtime: PiRuntime, modelRuntime: FakeRuntime): void {
    (runtime as unknown as { _modelRuntime: ModelRuntime })._modelRuntime = modelRuntime as unknown as ModelRuntime;
  }

  const secrets =
    (map: Record<string, string | undefined>): SecretResolver =>
    (key) =>
      Promise.resolve(map[key]);

  /** Replace the 3s deadline with a signal the test fires, so the timeout leg is exercised without
   *  waiting on it and no real timer is left behind. */
  function stubTimeout(signal: AbortSignal) {
    return vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);
  }

  /** A `setRuntimeApiKey` that never settles until the forwarded signal aborts — pi's credential
   *  operations take the cross-process auth.json lock, and a contended lock is what this bounds. */
  function hangingApply() {
    let started!: () => void;
    const applyStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const setRuntimeApiKey = vi.fn(
      (_provider: string, _key: string, options: { signal?: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => {
          started();
          options.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')), { once: true });
        }),
    );
    return { applyStarted, setRuntimeApiKey };
  }

  it('returns empty lists and no timeout before the runtime is initialized', async () => {
    const runtime = PiRuntime.get();
    const getSecret = vi.fn(async () => 'k');

    expect(await runtime.syncCustomProviders(getSecret)).toEqual({ wired: [], notWired: [], timedOut: false });
    expect(getSecret).not.toHaveBeenCalled();
  });

  it('returns empty lists and no timeout once disposed', async () => {
    const runtime = PiRuntime.get();
    attach(runtime, fakeModelRuntime());
    (runtime as unknown as { _disposed: boolean })._disposed = true;
    const getSecret = vi.fn(async () => 'k');

    expect(await runtime.syncCustomProviders(getSecret)).toEqual({ wired: [], notWired: [], timedOut: false });
    expect(getSecret).not.toHaveBeenCalled();
  });

  it('reports every wired provider, an empty notWired, and no timeout on the happy path', async () => {
    const runtime = PiRuntime.get();
    attach(runtime, fakeModelRuntime());
    const timeoutSpy = stubTimeout(new AbortController().signal);

    const result = await runtime.syncCustomProviders(secrets({ [STEPFUN_SECRET]: 'sf', [DEEPSEEK_SECRET]: 'ds' }));

    expect(result).toEqual({ wired: ['stepfun', 'deepseek'], notWired: [], timedOut: false });
    expect(timeoutSpy).toHaveBeenCalledWith(3000); // the bound the docstring and CHANGELOG name
  });

  it('reports timedOut when a hanging credential operation is cut short by the deadline', async () => {
    const runtime = PiRuntime.get();
    const timeout = new AbortController();
    stubTimeout(timeout.signal);
    const { applyStarted, setRuntimeApiKey } = hangingApply();
    attach(runtime, fakeModelRuntime({ setRuntimeApiKey }));

    const pending = runtime.syncCustomProviders(secrets({ [STEPFUN_SECRET]: 'sf' }));
    await applyStarted;
    timeout.abort();

    // stepfun's secret was read, so it is known-configured despite never applying — B4 needs exactly
    // this to name the right provider in the fallback warning.
    expect(await pending).toEqual({ wired: [], notWired: ['stepfun'], timedOut: true });
    expect(logLines.join('\n')).toContain('custom provider sync timed out after 3000ms; not wired: stepfun');
  });

  it('does NOT report timedOut when the same cut-short sync was aborted by dispose()', async () => {
    // The `!` in `aborted && !this._syncAbort.signal.aborted` is the whole difference between telling
    // the user their model was downgraded and telling a closing window nothing. Inverting or dropping
    // it flips exactly this test against the previous one.
    const runtime = PiRuntime.get();
    stubTimeout(new AbortController().signal);
    const { applyStarted, setRuntimeApiKey } = hangingApply();
    attach(runtime, fakeModelRuntime({ setRuntimeApiKey }));

    const pending = runtime.syncCustomProviders(secrets({ [STEPFUN_SECRET]: 'sf' }));
    await applyStarted;
    await runtime.dispose();

    expect(await pending).toEqual({ wired: [], notWired: ['stepfun'], timedOut: false });
  });

  it('derives timedOut in the outer catch instead of hardcoding false', async () => {
    // Hardcoding `false` here told the caller "did not time out" on the one path where it certainly
    // had, so `PiSession.start` skipped the fallback warning — the exact silent downgrade this
    // release removes.
    const runtime = PiRuntime.get();
    stubTimeout(AbortSignal.abort());
    attach(
      runtime,
      fakeModelRuntime({
        getProviderAuthStatus: vi.fn(() => {
          throw new DOMException('This operation was aborted', 'AbortError');
        }),
      }),
    );

    expect(await runtime.syncCustomProviders(secrets({}))).toEqual({ wired: [], notWired: [], timedOut: true });
  });

  it('does not claim a timeout when the outer catch saw a plain failure', async () => {
    const runtime = PiRuntime.get();
    stubTimeout(AbortSignal.abort());
    attach(
      runtime,
      fakeModelRuntime({
        getProviderAuthStatus: vi.fn(() => {
          throw new Error('provider table is corrupt');
        }),
      }),
    );

    expect(await runtime.syncCustomProviders(secrets({}))).toEqual({ wired: [], notWired: [], timedOut: false });
  });

  it('never writes a credential carried by the failure the outer catch logs (A1)', async () => {
    const runtime = PiRuntime.get();
    stubTimeout(AbortSignal.abort());
    attach(
      runtime,
      fakeModelRuntime({
        getProviderAuthStatus: vi.fn(() => {
          throw Object.assign(new Error('failed to synchronize credential state'), {
            name: 'CredentialSynchronizationError',
            credential: { type: 'api_key', key: SENTINEL },
          });
        }),
      }),
    );

    await runtime.syncCustomProviders(secrets({}));

    const output = logLines.join('\n');
    expect(output).toContain('syncCustomProviders failed (non-fatal): CredentialSynchronizationError');
    expect(output).not.toContain(SENTINEL);
    expect(output).not.toContain('api_key');
  });
});

