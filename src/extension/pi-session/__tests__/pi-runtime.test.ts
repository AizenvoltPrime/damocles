import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { PiRuntime } from '../pi-runtime';
import { nodeSupportsPi, PI_MIN_NODE_MAJOR } from '../pi-loader';
import type { SecretResolver } from '../custom-providers';

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
    const a = PiRuntime.get('/tmp/workspace-a');
    const b = PiRuntime.get('/tmp/workspace-b');
    expect(a).toBe(b);
    expect(PiRuntime.exists).toBe(true);
  });

  it('disposeInstance clears the singleton so a fresh instance can be created', async () => {
    const a = PiRuntime.get('/tmp/workspace-a');
    await PiRuntime.disposeInstance();
    expect(PiRuntime.exists).toBe(false);
    const c = PiRuntime.get('/tmp/workspace-a');
    expect(c).not.toBe(a);
  });
});

describe('ToolSearch republishers', () => {
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  /** Register through the PUBLIC seam an extension instance actually uses, keeping its disposer. */
  const publish = (runtime: PiRuntime, fn: () => void): (() => void) => runtime.registerToolSearchRepublisher(fn);

  /**
   * The only private reach-through here, and only for SIZE — growth is invisible from the public
   * surface, since a disposed closure that no longer fires looks identical to one still held. All
   * behaviour is asserted through the public seam.
   */
  const registeredCount = (runtime: PiRuntime): number =>
    (runtime as unknown as { _toolSearchRepublishers: Set<() => void> })._toolSearchRepublishers.size;

  it('fires EVERY registered extension instance, not just the newest', () => {
    // `prepareSessionExtensions` reloads the resource loader per session, so each panel's session binds
    // its own extension instance while earlier panels keep theirs. A single-slot field held only the
    // last one, leaving every earlier panel's ToolSearch description frozen for the session's life —
    // silently, because that instance is live rather than stale.
    const runtime = PiRuntime.get('/tmp/ws');
    const fired: string[] = [];
    publish(runtime, () => fired.push('panelA'));
    publish(runtime, () => fired.push('panelB'));

    runtime.republishToolSearch();

    expect(fired).toEqual(['panelA', 'panelB']);
  });

  it('the returned disposer removes exactly its own entry and leaves peers firing', () => {
    // "Exactly its own" is the load-bearing half: a disposer that cleared the set, or keyed off anything
    // but closure identity, would silently freeze every live panel's menu.
    const runtime = PiRuntime.get('/tmp/ws');
    const fired: string[] = [];
    const disposeA = publish(runtime, () => fired.push('panelA'));
    publish(runtime, () => fired.push('panelB'));
    publish(runtime, () => fired.push('panelC'));

    disposeA();
    runtime.republishToolSearch();

    expect(fired).toEqual(['panelB', 'panelC']);
    expect(registeredCount(runtime)).toBe(2);

    // Double-disposal is a real path (shutdown then teardown) and must not disturb peers.
    disposeA();
    fired.length = 0;
    runtime.republishToolSearch();
    expect(fired).toEqual(['panelB', 'panelC']);
    expect(registeredCount(runtime)).toBe(2);
  });

  it('a throwing republisher is NOT retired: it stays registered, retries next time, and never aborts its peers', () => {
    // Guards the old design's worst failure: a LIVE panel whose `registerTool` failed for any unrelated
    // reason was dropped permanently, freezing its menu with no further error. A throw now means only
    // "unexpected" — the entry survives, and the catch still stops one failure aborting its peers.
    const runtime = PiRuntime.get('/tmp/ws');
    const fired: string[] = [];
    let attempts = 0;
    let failing = true;
    publish(runtime, () => {
      attempts++;
      if (failing) throw new Error('extension context is no longer active');
      fired.push('recovered');
    });
    publish(runtime, () => fired.push('live'));

    runtime.republishToolSearch();
    expect(attempts).toBe(1);
    expect(fired).toEqual(['live']); // the throw did not abort its peer
    expect(registeredCount(runtime)).toBe(2); // and did not retire the thrower

    runtime.republishToolSearch();
    expect(attempts).toBe(2); // still registered, so it is invoked again
    expect(fired).toEqual(['live', 'live']);

    // Once the transient condition clears it republishes normally — what delete-on-throw made impossible.
    failing = false;
    fired.length = 0;
    runtime.republishToolSearch();
    expect(fired).toEqual(['recovered', 'live']);
    expect(registeredCount(runtime)).toBe(2);
  });

  it('does not grow across repeated teardowns — the count tracks live instances, not lifetime registrations', () => {
    // Opening/closing/resetting panels re-runs the factory each time; with no deterministic removal the
    // set only grew. After N cycles the count must equal the number of LIVE instances.
    const runtime = PiRuntime.get('/tmp/ws');
    const fired: string[] = [];
    publish(runtime, () => fired.push('survivor'));
    // Baseline for the loop below. Asserting the disposer is a function would pin nothing (the return
    // type says so); this fails if registration itself regresses.
    expect(registeredCount(runtime)).toBe(1);

    for (let i = 0; i < 20; i++) {
      const dispose = publish(runtime, () => fired.push(`transient-${i}`));
      expect(registeredCount(runtime)).toBe(2);
      dispose();
      expect(registeredCount(runtime)).toBe(1);
    }

    expect(registeredCount(runtime)).toBe(1);
    runtime.republishToolSearch();
    expect(fired).toEqual(['survivor']);
  });

  it('dispose() clears the republisher registry, not just the active-tool refreshers', async () => {
    // Both are per-live-instance registries. Clearing only one is harmless while the singleton is nulled
    // right after, but it reads as "republishers outlive teardown" — the inference that made the orphan.
    const runtime = PiRuntime.get('/tmp/ws');
    const fired: string[] = [];
    const dispose = publish(runtime, () => fired.push('gone'));

    await runtime.dispose();

    expect(registeredCount(runtime)).toBe(0);
    runtime.republishToolSearch();
    expect(fired).toEqual([]);
    // A shutdown in flight when the runtime went down disposes afterwards; `Set.delete` on a cleared set
    // is inert, so this must not throw.
    expect(() => dispose()).not.toThrow();
  });
});

/**
 * B1: the lifetime of an extension instance NO session ever binds. Only a bound instance receives
 * `session_shutdown`, so only it can retire itself. The three bare reload paths (compat watcher,
 * `_hotReloadExtensions`, `_removeSubscriptionPlugin`) and the instance minted at init are unbound, so
 * the runtime retires them — and must never do so to one that HAS gone live.
 */
describe('unbound extension instances (B1)', () => {
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  const registeredCount = (runtime: PiRuntime): number =>
    (runtime as unknown as { _toolSearchRepublishers: Set<() => void> })._toolSearchRepublishers.size;

  interface FakeLoader {
    /** Republisher calls, in order, labelled by the instance that owns them. */
    fired: string[];
    failNextReload: () => void;
  }

  /**
   * Stands in for `AgentSessionServices` so the reload paths are drivable without booting pi. Faithful
   * in the two respects the fix depends on: factories run INSIDE `reload()` (so a reload can identify
   * the instance it just minted), and the reload keeps awaiting afterwards, so overlapping reloads
   * interleave — an atomic fake would make the serialization test vacuous. The `init` instance goes
   * through the same seam `_doInit` uses, adoption included.
   */
  function attachFakeServices(runtime: PiRuntime): FakeLoader {
    const fired: string[] = [];
    let failNext = false;
    let seq = 0;
    const services = {
      resourceLoader: {
        reload: async (): Promise<void> => {
          await Promise.resolve();
          if (failNext) {
            failNext = false;
            throw new Error('packageManager.resolve failed');
          }
          const id = `instance-${++seq}`;
          runtime.registerToolSearchRepublisher(() => fired.push(id));
          await Promise.resolve();
        },
        extendResources: () => undefined,
        getExtensions: () => ({ runtime: { pendingProviderRegistrations: [] } }),
      },
      // 0.84's `refresh` resolves a `ModelsRefreshResult`, which `_hotReloadExtensions` now reads.
      modelRuntime: { registerProvider: () => undefined, refresh: async () => ({ aborted: false, errors: new Map() }) },
    };
    const internals = runtime as unknown as {
      _services: unknown;
      _initPromise: Promise<void>;
      _trackCurrentInstanceAsUnbound(): void;
    };
    internals._services = services;
    // `init()` returns an existing `_initPromise` untouched, so this makes every `await this.init()`
    // inside the reload paths a no-op instead of booting pi.
    internals._initPromise = Promise.resolve();
    runtime.registerToolSearchRepublisher(() => fired.push('init'));
    internals._trackCurrentInstanceAsUnbound();
    return { fired, failNextReload: () => { failNext = true; } };
  }

  /** A REAL bare call site (`_installSubscriptionPlugin` reaches it on every allowance install), driven
   *  directly because all three bare sites are private or watcher-timed. Using the call site rather than
   *  `_reloadResources('bare')` means the test also pins that the site passes `'bare'`. */
  const bareReload = (runtime: PiRuntime): Promise<void> =>
    (runtime as unknown as { _hotReloadExtensions(): Promise<void> })._hotReloadExtensions();

  it('two bare reloads leave exactly ONE unbound republisher, not two', async () => {
    // Requirement #1. Each bare reload mints an instance nothing will bind; the previous one is dead the
    // moment it is superseded, so the set must track the loader's CURRENT instance and nothing older.
    const runtime = PiRuntime.get('/tmp/ws');
    const loader = attachFakeServices(runtime);

    await bareReload(runtime);
    await bareReload(runtime);

    runtime.republishToolSearch();
    expect(loader.fired).toEqual(['instance-2']);
    expect(registeredCount(runtime)).toBe(1);

    // ...and it stays at one however long the window lives. Growth is the symptom a user sees as an
    // ever-longer list of dead `registerTool` calls on every skill-file edit.
    loader.fired.length = 0;
    await bareReload(runtime);
    await bareReload(runtime);
    runtime.republishToolSearch();
    expect(loader.fired).toEqual(['instance-4']);
    expect(registeredCount(runtime)).toBe(1);
  });

  it('a session-bound reload retires the previous BARE instance and keeps the one it mints', async () => {
    // Requirement #2. `prepareSessionExtensions` reloads immediately before a bind, so the instance that
    // binds is always the freshest one and any bare instance before it can never bind. The bound
    // instance must NOT be retired at reload time — it has a session to serve.
    const runtime = PiRuntime.get('/tmp/ws');
    const loader = attachFakeServices(runtime);

    await runtime.prepareSessionExtensions(); // first session: binds the init instance, no reload
    await bareReload(runtime); // instance-1, unbound
    await runtime.prepareSessionExtensions(); // second session: reload → instance-2, then binds it

    runtime.republishToolSearch();
    expect(loader.fired).toEqual(['init', 'instance-2']);
    expect(registeredCount(runtime)).toBe(2);
  });

  it('NEVER retires a live session-bound panel’s republisher, however many reloads follow', async () => {
    // Requirement #3, and the regression that would break the whole feature: a live panel whose
    // republisher was retired keeps a ToolSearch description frozen at whatever pi last wrapped, with no
    // error anywhere — precisely the failure v2.18.0 exists to fix.
    const runtime = PiRuntime.get('/tmp/ws');
    const loader = attachFakeServices(runtime);

    await runtime.prepareSessionExtensions(); // panel A binds the init instance
    await runtime.prepareSessionExtensions(); // panel B binds instance-1

    await bareReload(runtime); // instance-2
    await bareReload(runtime); // instance-3
    await bareReload(runtime); // instance-4

    runtime.republishToolSearch();
    expect(loader.fired).toEqual(['init', 'instance-1', 'instance-4']);
    expect(registeredCount(runtime)).toBe(3);
  });

  it('hands the startup instance to the first session instead of retiring it', async () => {
    // The startup ordering that makes "bare" and "about to be bound" the same instance:
    // `_reconcileSubscriptionPin` hot-reloads during `_doInit` — every allowance user hits it on a pin
    // bump — and pi's `_buildRuntime` binds whatever the loader holds, so the first session binds THAT
    // instance. Retiring it on the next reload would freeze the first panel opened in the window.
    const runtime = PiRuntime.get('/tmp/ws');
    const loader = attachFakeServices(runtime);

    await bareReload(runtime); // startup reconcile: instance-1 supersedes the init instance
    await runtime.prepareSessionExtensions(); // first session binds instance-1 without reloading
    await bareReload(runtime); // instance-2 must not touch the now-bound instance-1

    runtime.republishToolSearch();
    expect(loader.fired).toEqual(['instance-1', 'instance-2']);
    expect(registeredCount(runtime)).toBe(2);
  });

  it('a failed session-bound reload releases the instance the session binds instead of retiring it', async () => {
    // `prepareSessionExtensions` swallows a reload failure and the session binds the runtime the loader
    // still holds — the instance a previous bare reload minted. It is bound now, so the runtime must
    // drop its claim on it rather than retire it when the next reload lands.
    const runtime = PiRuntime.get('/tmp/ws');
    const loader = attachFakeServices(runtime);

    await runtime.prepareSessionExtensions(); // first session binds the init instance
    await bareReload(runtime); // instance-1, unbound
    loader.failNextReload();
    await runtime.prepareSessionExtensions(); // reload throws → the session binds instance-1
    await bareReload(runtime); // instance-2

    runtime.republishToolSearch();
    expect(loader.fired).toEqual(['init', 'instance-1', 'instance-2']);
  });

  it('a failed BARE reload keeps its claim on the instance still in place', async () => {
    // The mirror case: nothing was superseded, so the tracked instance is still the loader's and still
    // unbound. Dropping the claim here would strand it for the life of the window.
    const runtime = PiRuntime.get('/tmp/ws');
    const loader = attachFakeServices(runtime);

    await bareReload(runtime); // instance-1
    loader.failNextReload();
    await expect(bareReload(runtime)).rejects.toThrow('packageManager.resolve failed');
    await bareReload(runtime); // instance-2 supersedes instance-1, which must still be retired

    runtime.republishToolSearch();
    expect(loader.fired).toEqual(['instance-2']);
    expect(registeredCount(runtime)).toBe(1);
  });

  it('overlapping reloads serialize, so neither adopts the other’s instance', async () => {
    // Requirement #5. A billing toggle (bare, not queued by its caller) and a panel starting
    // (session-bound) can be issued in the same tick. `_reloadResources` queues both on `_reloadSync`;
    // without that, each reload would read "the instance I just minted" from a slot the other had
    // already overwritten — and adopting a SESSION-BOUND instance as unbound retires a live panel.
    const runtime = PiRuntime.get('/tmp/ws');
    const loader = attachFakeServices(runtime);

    await runtime.prepareSessionExtensions(); // panel A binds the init instance

    const bare = bareReload(runtime);
    const bound = runtime.prepareSessionExtensions();
    await Promise.all([bare, bound]);

    runtime.republishToolSearch();
    // The bare instance minted first is retired by the session-bound reload that follows it; panel A and
    // the newly bound instance both survive.
    expect(loader.fired).toEqual(['init', 'instance-2']);
    expect(registeredCount(runtime)).toBe(2);
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

  /** The only private reach-through: `_services` is built by `init()`, which boots pi. */
  function attach(runtime: PiRuntime, modelRuntime: FakeRuntime): void {
    (runtime as unknown as { _services: unknown })._services = { modelRuntime: modelRuntime as unknown as ModelRuntime };
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
    const runtime = PiRuntime.get('/tmp/ws');
    const getSecret = vi.fn(async () => 'k');

    expect(await runtime.syncCustomProviders(getSecret)).toEqual({ wired: [], notWired: [], timedOut: false });
    expect(getSecret).not.toHaveBeenCalled();
  });

  it('returns empty lists and no timeout once disposed', async () => {
    const runtime = PiRuntime.get('/tmp/ws');
    attach(runtime, fakeModelRuntime());
    (runtime as unknown as { _disposed: boolean })._disposed = true;
    const getSecret = vi.fn(async () => 'k');

    expect(await runtime.syncCustomProviders(getSecret)).toEqual({ wired: [], notWired: [], timedOut: false });
    expect(getSecret).not.toHaveBeenCalled();
  });

  it('reports every wired provider, an empty notWired, and no timeout on the happy path', async () => {
    const runtime = PiRuntime.get('/tmp/ws');
    attach(runtime, fakeModelRuntime());
    const timeoutSpy = stubTimeout(new AbortController().signal);

    const result = await runtime.syncCustomProviders(secrets({ [STEPFUN_SECRET]: 'sf', [DEEPSEEK_SECRET]: 'ds' }));

    expect(result).toEqual({ wired: ['stepfun', 'deepseek'], notWired: [], timedOut: false });
    expect(timeoutSpy).toHaveBeenCalledWith(3000); // the bound the docstring and CHANGELOG name
  });

  it('reports timedOut when a hanging credential operation is cut short by the deadline', async () => {
    const runtime = PiRuntime.get('/tmp/ws');
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
    const runtime = PiRuntime.get('/tmp/ws');
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
    const runtime = PiRuntime.get('/tmp/ws');
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
    const runtime = PiRuntime.get('/tmp/ws');
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
    const runtime = PiRuntime.get('/tmp/ws');
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
