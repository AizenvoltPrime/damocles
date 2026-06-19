/*
 * Adapted from pi-mcp-adapter (MIT). Copyright (c) 2026 Nico Bailon. See THIRD-PARTY-NOTICES.md.
 * High-level OAuth flow management on top of the MCP SDK's built-in `auth()`. Drives the
 * interactive authorization_code (PKCE + localhost callback + browser) and non-interactive
 * client_credentials grants, persists tokens, and refreshes expired access tokens. SDK value
 * classes come from the dynamically-imported bundle (the SDK is esbuild-external).
 */
import * as vscode from 'vscode';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { McpOAuthConfig } from '../../../shared/types/mcp';
import type { McpServerDefinition } from './types';
import type { McpSdkBundle } from './mcp-sdk-loader';
import { McpOAuthProvider } from './mcp-oauth-provider';
import {
  ensureCallbackServer,
  waitForCallback,
  cancelPendingCallback,
  stopCallbackServer,
  releaseCallbackServer,
} from './mcp-callback-server';
import {
  getAuthForUrl,
  isTokenExpired,
  hasStoredTokens,
  clearAllCredentials,
  clearClientInfo,
  clearTokens,
  clearCodeVerifier,
  updateOAuthState,
  getOAuthState,
  clearOAuthState,
} from './mcp-auth';
import { log } from '../../logger';

/** Auth status for a server. */
export type AuthStatus = 'authenticated' | 'expired' | 'not_authenticated';

/** Result of an interactive authenticate attempt. */
export interface McpAuthenticateResult {
  ok: boolean;
  error?: string;
}

const pendingTransports = new Map<string, StreamableHTTPClientTransport>();
const pendingAuthStates = new Map<string, string>();
const pendingAuthCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingAuthentications = new Map<string, Promise<AuthStatus>>();

/** Timeout for manual auth completion (5 minutes). */
const MANUAL_AUTH_TIMEOUT_MS = 5 * 60 * 1000;

/** A cryptographically secure random CSRF state parameter. */
function generateState(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Reject an authorization URL whose scheme is not http(s) before handing it to `openExternal`. The URL
 * is derived from the auth server's discovered `authorization_endpoint`, so a malicious/compromised
 * server could otherwise return a custom scheme that launches a local application.
 */
function assertSafeAuthorizationUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new Error('OAuth authorization URL is invalid', { cause: error });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Refusing to open OAuth authorization URL with unsupported scheme "${parsed.protocol}"`);
  }
}

/** Extract OAuth configuration from a server definition, validating string/URI fields. */
export function extractOAuthConfig(definition: McpServerDefinition): McpOAuthConfig {
  if (definition.oauth === false) {
    return {};
  }

  const config: McpOAuthConfig = {};
  const oauth = definition.oauth;
  if (!oauth) return config;

  if (oauth.grantType !== undefined) config.grantType = oauth.grantType;
  if (oauth.clientId !== undefined) config.clientId = oauth.clientId;
  if (oauth.clientSecret !== undefined) config.clientSecret = oauth.clientSecret;
  if (oauth.scope !== undefined) config.scope = oauth.scope;
  if (oauth.redirectUri !== undefined) {
    if (typeof oauth.redirectUri !== 'string') {
      throw new Error('OAuth redirectUri must be a string');
    }
    const redirectUri = oauth.redirectUri.trim();
    if (!redirectUri) {
      throw new Error('OAuth redirectUri must not be empty');
    }
    config.redirectUri = redirectUri;
  }
  if (oauth.clientName !== undefined) {
    if (typeof oauth.clientName !== 'string') {
      throw new Error('OAuth clientName must be a string');
    }
    const clientName = oauth.clientName.trim();
    if (!clientName) {
      throw new Error('OAuth clientName must not be empty');
    }
    config.clientName = clientName;
  }
  if (oauth.clientUri !== undefined) {
    if (typeof oauth.clientUri !== 'string') {
      throw new Error('OAuth clientUri must be a string');
    }
    const clientUri = oauth.clientUri.trim();
    if (!clientUri) {
      throw new Error('OAuth clientUri must not be empty');
    }
    config.clientUri = clientUri;
  }
  return config;
}

/** Whether OAuth is supported for a server: requires a URL and is not explicitly disabled. */
export function supportsOAuth(definition: McpServerDefinition): boolean {
  if (!definition.url) return false;
  if (definition.auth === false) return false;
  if (definition.oauth === false) return false;
  return definition.auth === 'oauth' || definition.auth === undefined;
}

interface ParsedRedirectUri {
  port: number;
  callbackHost: string;
  callbackPath: string;
}

function parseOAuthRedirectUri(redirectUri: string): ParsedRedirectUri {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch (error) {
    throw new Error(`Invalid OAuth redirectUri: ${redirectUri}`, { cause: error });
  }

  const hostname = url.hostname.toLowerCase();
  const isLocalhost =
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
  if (url.protocol !== 'http:' || !isLocalhost) {
    throw new Error('OAuth redirectUri must be an http:// localhost or loopback URI');
  }
  if (url.username || url.password) {
    throw new Error('OAuth redirectUri must not include username or password');
  }
  if (url.hash) {
    throw new Error('OAuth redirectUri must not include a fragment');
  }
  if (!url.port) {
    throw new Error('OAuth redirectUri must include an explicit numeric port');
  }
  const port = Number.parseInt(url.port, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('OAuth redirectUri must include an explicit numeric port');
  }
  const callbackHost = hostname === '[::1]' ? '::1' : hostname;
  return { port, callbackHost, callbackPath: url.pathname };
}

/**
 * Start the OAuth flow for a server. Returns `{ authorizationUrl: '' }` when authorization
 * completes immediately (client_credentials, or a valid refresh); otherwise the browser URL
 * the user must visit, with a pending transport registered for the callback to finish.
 */
export async function startAuth(
  sdk: McpSdkBundle,
  serverName: string,
  serverUrl: string,
  definition?: McpServerDefinition,
): Promise<{ authorizationUrl: string }> {
  const config = definition ? extractOAuthConfig(definition) : {};

  if (config.grantType === 'client_credentials') {
    const storedAuth = await getAuthForUrl(serverName, serverUrl);
    if (storedAuth?.clientInfo && !storedAuth.tokens && !config.clientId) {
      await clearClientInfo(serverName);
      await clearCodeVerifier(serverName);
      await clearOAuthState(serverName);
    }

    const authProvider = new McpOAuthProvider(sdk, serverName, serverUrl, config, {
      onRedirect: async () => {
        throw new Error('Browser redirect is not used for client_credentials flow');
      },
    });
    const result = await sdk.auth.auth(authProvider, { serverUrl });
    if (result !== 'AUTHORIZED') {
      throw new sdk.auth.UnauthorizedError('Failed to authorize');
    }
    return { authorizationUrl: '' };
  }

  const redirectCallback = config.redirectUri !== undefined ? parseOAuthRedirectUri(config.redirectUri) : undefined;
  const oauthState = generateState();

  try {
    const ensureOptions: Parameters<typeof ensureCallbackServer>[0] = {
      strictPort: Boolean(config.clientId) || config.redirectUri !== undefined,
      oauthState,
      reserveState: true,
    };
    if (redirectCallback) {
      ensureOptions.port = redirectCallback.port;
      ensureOptions.callbackHost = redirectCallback.callbackHost;
      ensureOptions.callbackPath = redirectCallback.callbackPath;
    }
    await ensureCallbackServer(ensureOptions);
  } catch (error) {
    await clearOAuthState(serverName);
    throw error;
  }

  let capturedUrl: URL | undefined;
  const authProvider = new McpOAuthProvider(sdk, serverName, serverUrl, config, {
    onRedirect: async (url) => {
      capturedUrl = url;
    },
  });

  try {
    const storedAuth = await getAuthForUrl(serverName, serverUrl);
    if (storedAuth?.clientInfo && !config.clientId) {
      if (!storedAuth.tokens) {
        await clearClientInfo(serverName);
        await clearCodeVerifier(serverName);
        await clearOAuthState(serverName);
      } else {
        const redirectUris = storedAuth.clientInfo.redirectUris;
        if (!Array.isArray(redirectUris) || !redirectUris.includes(authProvider.redirectUrl ?? '')) {
          await clearClientInfo(serverName);
          await clearTokens(serverName);
          await clearCodeVerifier(serverName);
          await clearOAuthState(serverName);
        }
      }
    }

    await updateOAuthState(serverName, oauthState, serverUrl);

    const result = await sdk.auth.auth(authProvider, { serverUrl });
    if (result === 'AUTHORIZED') {
      releaseCallbackServer(oauthState);
      await clearOAuthState(serverName);
      return { authorizationUrl: '' };
    }
    if (!capturedUrl) {
      throw new sdk.auth.UnauthorizedError('OAuth authorization URL was not provided');
    }
    const pendingTransport = new sdk.http.StreamableHTTPClientTransport(new URL(serverUrl), { authProvider });
    setPendingTransport(serverName, pendingTransport, oauthState);
    return { authorizationUrl: capturedUrl.toString() };
  } catch (error) {
    await clearPendingAuth(serverName, oauthState);
    throw error;
  }
}

function setPendingTransport(
  serverName: string,
  transport: StreamableHTTPClientTransport,
  oauthState: string,
): void {
  void clearPendingAuth(serverName);
  pendingTransports.set(serverName, transport);
  pendingAuthStates.set(serverName, oauthState);
  const cleanupTimer = setTimeout(() => {
    void clearPendingAuth(serverName, oauthState);
  }, MANUAL_AUTH_TIMEOUT_MS);
  cleanupTimer.unref?.();
  pendingAuthCleanupTimers.set(serverName, cleanupTimer);
}

async function clearPendingAuth(serverName: string, oauthState?: string): Promise<void> {
  const pendingState = pendingAuthStates.get(serverName);
  if (oauthState && pendingState && pendingState !== oauthState) return;

  const timer = pendingAuthCleanupTimers.get(serverName);
  if (timer) {
    clearTimeout(timer);
    pendingAuthCleanupTimers.delete(serverName);
  }

  const transport = pendingTransports.get(serverName);
  pendingTransports.delete(serverName);
  pendingAuthStates.delete(serverName);
  const stateToRelease = pendingState ?? oauthState;
  if (stateToRelease) {
    releaseCallbackServer(stateToRelease);
    const storedState = await getOAuthState(serverName);
    if (storedState === stateToRelease) {
      await clearOAuthState(serverName);
    }
  }
  if (transport) {
    await transport.close().catch(() => {});
  }
}

/** Complete OAuth using the captured authorization code via the pending transport. */
export async function completeAuth(serverName: string, authorizationCode: string): Promise<AuthStatus> {
  const transport = pendingTransports.get(serverName);
  if (!transport) {
    throw new Error(`No pending OAuth flow for server: ${serverName}`);
  }

  const oauthState = await getOAuthState(serverName);

  try {
    await transport.finishAuth(authorizationCode);
    return 'authenticated';
  } finally {
    await clearPendingAuth(serverName, oauthState);
  }
}

/**
 * Run the full OAuth flow for a server: client_credentials non-interactively, or
 * authorization_code via the localhost callback + browser. Concurrent calls per server are
 * deduplicated. Opens the browser through VS Code (`vscode.env.openExternal`).
 */
export async function authenticate(
  sdk: McpSdkBundle,
  serverName: string,
  serverUrl: string,
  definition?: McpServerDefinition,
): Promise<AuthStatus> {
  const inFlight = pendingAuthentications.get(serverName);
  if (inFlight) {
    return inFlight;
  }

  const operation = (async (): Promise<AuthStatus> => {
    const { authorizationUrl } = await startAuth(sdk, serverName, serverUrl, definition);

    if (!authorizationUrl) {
      return 'authenticated';
    }

    const oauthState = await getOAuthState(serverName);
    if (!oauthState) {
      throw new Error('OAuth state not found - this should not happen');
    }

    const callbackPromise = waitForCallback(oauthState);

    try {
      assertSafeAuthorizationUrl(authorizationUrl);
      let opened = false;
      try {
        opened = await vscode.env.openExternal(vscode.Uri.parse(authorizationUrl));
      } catch (error) {
        log('[McpAuthFlow] Failed to open browser for %s: %O', serverName, error);
      }
      if (!opened) {
        log('[McpAuthFlow] Browser handoff for %s reported failure; awaiting callback', serverName);
      }

      const code = await callbackPromise;

      // The authoritative CSRF gate is the callback server's state-keyed lookup: `waitForCallback`
      // only resolves for the exact `oauthState` registered above, so the code we hold matches this
      // flow's state. This secondary check guards a different failure: a concurrent authenticate() for
      // the SAME server overwriting the persisted state mid-flow (which would make completeAuth read a
      // stale verifier). It is not itself the CSRF defense.
      const storedState = await getOAuthState(serverName);
      if (storedState !== oauthState) {
        await clearOAuthState(serverName);
        throw new Error('OAuth flow superseded by a concurrent authentication for the same server');
      }
      await clearOAuthState(serverName);

      return await completeAuth(serverName, code);
    } catch (error) {
      cancelPendingCallback(oauthState);
      await clearPendingAuth(serverName, oauthState);
      throw error;
    }
  })();

  pendingAuthentications.set(serverName, operation);

  try {
    return await operation;
  } finally {
    if (pendingAuthentications.get(serverName) === operation) {
      pendingAuthentications.delete(serverName);
    }
  }
}

/** The current authentication status for a server. */
export async function getAuthStatus(serverName: string): Promise<AuthStatus> {
  const hasTokens = await hasStoredTokens(serverName);
  if (!hasTokens) return 'not_authenticated';
  const expired = await isTokenExpired(serverName);
  return expired ? 'expired' : 'authenticated';
}

/** Remove all OAuth credentials and cancel any in-flight flow for a server. */
export async function removeAuth(serverName: string): Promise<void> {
  const oauthState = await getOAuthState(serverName);
  if (oauthState) {
    cancelPendingCallback(oauthState);
  }
  await clearPendingAuth(serverName, oauthState);
  await clearAllCredentials(serverName);
  await clearOAuthState(serverName);
  log('[McpAuthFlow] Removed credentials for %s', serverName);
}

/** Stop the OAuth subsystem: cancel pending flows and stop the callback server. */
export async function shutdownOAuth(): Promise<void> {
  // Reject every in-flight interactive auth's callback waiter so the awaiting authenticate() promise
  // settles deterministically on deactivation, then drop the dedup map (M5).
  for (const state of Array.from(pendingAuthStates.values())) {
    cancelPendingCallback(state);
  }
  for (const serverName of Array.from(pendingTransports.keys())) {
    await clearPendingAuth(serverName);
  }
  pendingAuthentications.clear();
  await stopCallbackServer();
}

/**
 * Build an `AuthProviderFactory` (the shape `server-manager.ts` expects). Returns a provider
 * only when the definition supports OAuth; the SDK transport drives it on connect, and an
 * `UnauthorizedError` surfaces to the manager as `needs-auth`.
 */
export function createMcpAuthProviderFactory(
  sdk: McpSdkBundle,
): (serverName: string, url: string, definition: McpServerDefinition) => OAuthClientProvider | undefined {
  return (serverName, url, definition) => {
    if (!supportsOAuth(definition)) return undefined;
    const config = extractOAuthConfig(definition);
    return new McpOAuthProvider(sdk, serverName, url, config, {
      onRedirect: async (authorizationUrl) => {
        const url = authorizationUrl.toString();
        assertSafeAuthorizationUrl(url);
        await vscode.env.openExternal(vscode.Uri.parse(url));
      },
    });
  };
}

/**
 * Interactive authenticate entrypoint for the webview "Authenticate" button. Runs the
 * localhost-callback authorization_code/PKCE or client_credentials flow, persists tokens, and
 * returns success/failure (never throws). The caller force-reconnects on success.
 */
export async function authenticateMcpServer(
  sdk: McpSdkBundle,
  serverName: string,
  definition: McpServerDefinition,
): Promise<McpAuthenticateResult> {
  if (!supportsOAuth(definition) || !definition.url) {
    return { ok: false, error: `MCP server "${serverName}" does not support OAuth` };
  }
  try {
    const status = await authenticate(sdk, serverName, definition.url, definition);
    return { ok: status === 'authenticated' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('[McpAuthFlow] Authentication failed for %s: %s', serverName, message);
    return { ok: false, error: message };
  }
}
