import { log } from '../logger';

export type SdkQuery = typeof import('@anthropic-ai/claude-agent-sdk').query;
export type SdkStartup = typeof import('@anthropic-ai/claude-agent-sdk').startup;

type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk');

let cachedModule: SdkModule | null = null;
let loadingPromise: Promise<SdkModule | null> | null = null;

/**
 * Preload the SDK's ESM module once at extension activation. This eliminates the
 * `ERR_INTERNAL_ASSERTION` race where a synchronous `require()` collides with a
 * concurrent `await import()` of the same ESM file. After this promise resolves,
 * `loadSdkQuery()` / `loadSdkStartup()` return from the cache without touching
 * Node's ESM loader.
 */
export function initSdkLoader(): Promise<SdkModule | null> {
  if (cachedModule) return Promise.resolve(cachedModule);
  if (loadingPromise) return loadingPromise;

  loadingPromise = import('@anthropic-ai/claude-agent-sdk')
    .then((mod) => {
      cachedModule = mod;
      return mod;
    })
    .catch((err) => {
      log('[SdkLoader] Failed to preload SDK module: %O', err);
      loadingPromise = null;
      return null;
    });
  return loadingPromise;
}

export function loadSdkQuery(): SdkQuery | null {
  if (!cachedModule) {
    log('[SdkLoader] loadSdkQuery called before initSdkLoader completed');
    return null;
  }
  return cachedModule.query;
}

export function loadSdkStartup(): SdkStartup | null {
  if (!cachedModule) {
    log('[SdkLoader] loadSdkStartup called before initSdkLoader completed');
    return null;
  }
  if (typeof cachedModule.startup !== 'function') return null;
  return cachedModule.startup;
}
