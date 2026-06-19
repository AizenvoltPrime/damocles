import { log } from '../../logger';

/**
 * The official MCP TypeScript SDK (`@modelcontextprotocol/sdk`) ships as pure ESM
 * (`"type": "module"`) with deep subpath entry points. It is marked `external` in esbuild
 * and ships as real node_modules, so the CJS extension bundle can only reach it through a
 * dynamic `import()`. This module performs those imports exactly once and caches the
 * namespaces, mirroring `pi-loader.ts`. Absence/load failure resolves to `null` so MCP
 * degrades softly (no MCP, no crash) per FR-10.
 */
export type McpClientModule = typeof import('@modelcontextprotocol/sdk/client/index.js');
export type McpStdioModule = typeof import('@modelcontextprotocol/sdk/client/stdio.js');
export type McpStreamableHttpModule = typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js');
export type McpSseModule = typeof import('@modelcontextprotocol/sdk/client/sse.js');
export type McpAuthModule = typeof import('@modelcontextprotocol/sdk/client/auth.js');
export type McpTypesModule = typeof import('@modelcontextprotocol/sdk/types.js');

/** The set of SDK subpath namespaces the MCP client needs. */
export interface McpSdkBundle {
  client: McpClientModule;
  stdio: McpStdioModule;
  http: McpStreamableHttpModule;
  sse: McpSseModule;
  auth: McpAuthModule;
  types: McpTypesModule;
}

let cachedBundle: McpSdkBundle | null = null;
let loadingPromise: Promise<McpSdkBundle | null> | null = null;
let failureLogged = false;

/**
 * Load every MCP SDK subpath once. Safe to call repeatedly — concurrent callers share one
 * in-flight import, and a failure clears the cache so a later call can retry. Resolves to
 * `null` on failure (logged once) so callers can degrade.
 */
export function loadMcpSdk(): Promise<McpSdkBundle | null> {
  if (cachedBundle) return Promise.resolve(cachedBundle);
  if (loadingPromise) return loadingPromise;

  loadingPromise = Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/client/sse.js'),
    import('@modelcontextprotocol/sdk/client/auth.js'),
    import('@modelcontextprotocol/sdk/types.js'),
  ])
    .then(([client, stdio, http, sse, auth, types]): McpSdkBundle => {
      cachedBundle = { client, stdio, http, sse, auth, types };
      log('[McpSdkLoader] @modelcontextprotocol/sdk loaded');
      return cachedBundle;
    })
    .catch((err): null => {
      if (!failureLogged) {
        failureLogged = true;
        log('[McpSdkLoader] Failed to load @modelcontextprotocol/sdk: %O', err);
      }
      loadingPromise = null;
      return null;
    });
  return loadingPromise;
}

/** The cached SDK bundle, or `null` if `loadMcpSdk()` has not resolved successfully yet. */
export function getMcpSdk(): McpSdkBundle | null {
  return cachedBundle;
}

/** Whether the MCP SDK is loaded and ready for synchronous access. */
export function isMcpSdkLoaded(): boolean {
  return cachedBundle !== null;
}
