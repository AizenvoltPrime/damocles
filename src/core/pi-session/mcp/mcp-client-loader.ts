import { log } from '../../logger';

/**
 * `@earendil-works/pi-mcp` is pure ESM and esbuild-external, so the CJS extension bundle reaches it
 * only through dynamic `import()`. Loaded once and cached, mirroring `pi-loader.ts`; a load failure
 * resolves to `null` so MCP degrades to "no MCP" instead of crashing (FR-10).
 */
export type McpModule = typeof import('@earendil-works/pi-mcp');
export type McpOAuthModule = typeof import('@earendil-works/pi-mcp/oauth');

export interface McpClientBundle {
  mcp: McpModule;
  oauth: McpOAuthModule;
}

let cachedBundle: McpClientBundle | null = null;
let loadingPromise: Promise<McpClientBundle | null> | null = null;
let failureLogged = false;

/** Concurrent callers share one import; a failure clears the in-flight promise so a later call retries. */
export function loadMcpClient(): Promise<McpClientBundle | null> {
  if (cachedBundle) return Promise.resolve(cachedBundle);
  if (loadingPromise) return loadingPromise;

  loadingPromise = Promise.all([import('@earendil-works/pi-mcp'), import('@earendil-works/pi-mcp/oauth')])
    .then(([mcp, oauth]): McpClientBundle => {
      cachedBundle = { mcp, oauth };
      log('[McpClientLoader] @earendil-works/pi-mcp loaded');
      return cachedBundle;
    })
    .catch((err): null => {
      if (!failureLogged) {
        failureLogged = true;
        log('[McpClientLoader] Failed to load @earendil-works/pi-mcp: %O', err);
      }
      loadingPromise = null;
      return null;
    });
  return loadingPromise;
}
