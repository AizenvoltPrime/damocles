import { log } from '../logger';

/**
 * The pi coding-agent harness is pure ESM and uses `import.meta`/`import.meta.resolve`.
 * It is marked `external` in esbuild (blocker B2) and ships as real node_modules, so the
 * CJS extension bundle can only reach it through a dynamic `import()`. This module performs
 * that import exactly once and caches the namespace, mirroring `shared/sdk-loader.ts`.
 *
 * pi-ai value imports are not needed at runtime — `Model`/`ModelRegistry` flow through the
 * coding-agent surface — so only the coding-agent package is loaded here.
 */
export type PiCodingAgentModule = typeof import('@earendil-works/pi-coding-agent');

/**
 * The pi-ai compat namespace (the inference layer: `complete`, model/context types).
 * The old global `complete`/`stream` API moved to `@earendil-works/pi-ai/compat` in pi 0.80.0;
 * the pi-ai root is core-only as of that release, so the value `complete` lives here.
 */
export type PiAiModule = typeof import('@earendil-works/pi-ai/compat');

/**
 * pi's dependency tree (undici 8.3.0) hard-requires Node ≥ 22 — it calls
 * `worker_threads.markAsUncloneable` unconditionally, which is absent on Node 20 and crashes
 * the module's top-level eval. The VS Code extension host satisfies this (e.g. VS Code 1.124 /
 * Electron 42 runs Node 22.x), but guarding here turns a cryptic crash into a clear log on an
 * older host. This is blocker B5 (not captured in the original plan's source-only NODE-RISK note).
 */
export const PI_MIN_NODE_MAJOR = 22;

/** Whether the current runtime meets pi's minimum Node version. */
export function nodeSupportsPi(): boolean {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  return major >= PI_MIN_NODE_MAJOR;
}

let cachedModule: PiCodingAgentModule | null = null;
let loadingPromise: Promise<PiCodingAgentModule | null> | null = null;
let nodeUnsupportedLogged = false;

/**
 * Load the pi coding-agent ESM module once. Safe to call repeatedly — concurrent
 * callers share one in-flight import, and a failure clears the cache so a later
 * call can retry. Resolves to `null` on failure (logged) so callers can degrade.
 */
export function initPiLoader(): Promise<PiCodingAgentModule | null> {
  if (cachedModule) return Promise.resolve(cachedModule);
  if (loadingPromise) return loadingPromise;

  if (!nodeSupportsPi()) {
    // Node version is fixed for the process lifetime — decide and log once, never retry.
    if (!nodeUnsupportedLogged) {
      nodeUnsupportedLogged = true;
      log('[PiLoader] pi requires Node >=%d; host runs Node %s — pi harness unavailable (B5)', PI_MIN_NODE_MAJOR, process.versions.node);
    }
    return Promise.resolve(null);
  }

  loadingPromise = import('@earendil-works/pi-coding-agent')
    .then((mod) => {
      cachedModule = mod;
      log('[PiLoader] pi coding-agent loaded (version %s)', mod.VERSION);
      return mod;
    })
    .catch((err) => {
      log('[PiLoader] Failed to load pi coding-agent: %O', err);
      loadingPromise = null;
      return null;
    });
  return loadingPromise;
}

/** The cached pi module, or `null` if `initPiLoader()` has not resolved successfully yet. */
export function getPiCodingAgent(): PiCodingAgentModule | null {
  if (!cachedModule) {
    log('[PiLoader] getPiCodingAgent called before initPiLoader resolved');
    return null;
  }
  return cachedModule;
}

let cachedPiAi: PiAiModule | null = null;
let piAiLoadingPromise: Promise<PiAiModule | null> | null = null;

/**
 * Load the pi-ai ESM module once (the inference layer used by internal LLM sub-calls — US-006b).
 * Resolves the `@earendil-works/pi-ai/compat` entrypoint: the global `complete`/`stream` API moved
 * there in pi 0.80.0 (the pi-ai root is now core-only). compat shares the coding-agent's
 * provider/model registry, so the `complete` call here sees the same registered providers.
 * Same external-ESM + dynamic-import contract as the coding-agent loader; shares the Node-version
 * guard and resolves to `null` on failure so callers degrade gracefully.
 */
export function initPiAiLoader(): Promise<PiAiModule | null> {
  if (cachedPiAi) return Promise.resolve(cachedPiAi);
  if (piAiLoadingPromise) return piAiLoadingPromise;
  if (!nodeSupportsPi()) return Promise.resolve(null);

  piAiLoadingPromise = import('@earendil-works/pi-ai/compat')
    .then((mod) => {
      cachedPiAi = mod;
      return mod;
    })
    .catch((err) => {
      log('[PiLoader] Failed to load pi-ai: %O', err);
      piAiLoadingPromise = null;
      return null;
    });
  return piAiLoadingPromise;
}

/** Whether the pi module is loaded and ready for synchronous access. */
export function isPiLoaded(): boolean {
  return cachedModule !== null;
}
