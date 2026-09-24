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
import type { AuthorizationServerMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
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
  getAuthEntry,
  isTokenExpired,
  hasStoredTokens,
  clearAllCredentials,
  clearClientInfo,
  clearTokens,
  clearCodeVerifier,
  updateOAuthState,
  getOAuthState,
  clearOAuthState,
  type McpAuthIdentity,
} from './mcp-auth';
import { log } from '../../logger';

/** Auth status for a server. */
export type AuthStatus = 'authenticated' | 'expired' | 'not_authenticated';

/** Result of an interactive authenticate attempt. */
export interface McpAuthenticateResult {
  ok: boolean;
  error?: string;
}

/** An authorization_code flow waiting for its browser callback. */
interface PendingFlow {
  id: McpAuthIdentity;
  transport: StreamableHTTPClientTransport;
  oauthState: string;
  cleanupTimer: ReturnType<typeof setTimeout>;
}

/** Both maps are keyed by `flowKey`: same-named servers at different URLs are separate flows. */
const pendingFlows = new Map<string, PendingFlow>();
const pendingAuthentications = new Map<string, Promise<AuthStatus>>();

function flowKey(id: McpAuthIdentity): string {
  return JSON.stringify([id.serverName, id.serverUrl]);
}

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
export function supportsOAuth(definition: McpServerDefinition): definition is McpServerDefinition & { url: string } {
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
  const id: McpAuthIdentity = { serverName, serverUrl };

  if (config.grantType === 'client_credentials') {
    const storedAuth = await getAuthEntry(id);
    if (storedAuth?.clientInfo && !storedAuth.tokens && !config.clientId) {
      await clearClientInfo(id);
      await clearCodeVerifier(id);
      await clearOAuthState(id);
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
    await clearOAuthState(id);
    throw error;
  }

  let capturedUrl: URL | undefined;
  const authProvider = new McpOAuthProvider(sdk, serverName, serverUrl, config, {
    onRedirect: async (url) => {
      capturedUrl = url;
    },
  });

  try {
    const storedAuth = await getAuthEntry(id);
    if (storedAuth?.clientInfo && !config.clientId) {
      if (!storedAuth.tokens) {
        await clearClientInfo(id);
        await clearCodeVerifier(id);
        await clearOAuthState(id);
      } else {
        const redirectUris = storedAuth.clientInfo.redirectUris;
        if (!Array.isArray(redirectUris) || !redirectUris.includes(authProvider.redirectUrl ?? '')) {
          await clearClientInfo(id);
          await clearTokens(id);
          await clearCodeVerifier(id);
          await clearOAuthState(id);
        }
      }
    }

    await updateOAuthState(id, oauthState);

    const result = await sdk.auth.auth(authProvider, { serverUrl });
    if (result === 'AUTHORIZED') {
      releaseCallbackServer(oauthState);
      await clearOAuthState(id);
      return { authorizationUrl: '' };
    }
    if (!capturedUrl) {
      throw new sdk.auth.UnauthorizedError('OAuth authorization URL was not provided');
    }
    const pendingTransport = new sdk.http.StreamableHTTPClientTransport(new URL(serverUrl), { authProvider });
    setPendingTransport(id, pendingTransport, oauthState);
    return { authorizationUrl: capturedUrl.toString() };
  } catch (error) {
    await clearPendingAuth(id, oauthState);
    throw error;
  }
}

function setPendingTransport(
  id: McpAuthIdentity,
  transport: StreamableHTTPClientTransport,
  oauthState: string,
): void {
  void clearPendingAuth(id);
  const cleanupTimer = setTimeout(() => {
    void clearPendingAuth(id, oauthState);
  }, MANUAL_AUTH_TIMEOUT_MS);
  cleanupTimer.unref?.();
  pendingFlows.set(flowKey(id), { id, transport, oauthState, cleanupTimer });
}

async function clearPendingAuth(id: McpAuthIdentity, oauthState?: string): Promise<void> {
  const key = flowKey(id);
  const flow = pendingFlows.get(key);
  if (oauthState && flow && flow.oauthState !== oauthState) return;

  if (flow) {
    clearTimeout(flow.cleanupTimer);
    pendingFlows.delete(key);
  }
  const stateToRelease = flow?.oauthState ?? oauthState;
  if (stateToRelease) {
    releaseCallbackServer(stateToRelease);
    const storedState = await getOAuthState(id);
    if (storedState === stateToRelease) {
      await clearOAuthState(id);
    }
  }
  if (flow) {
    await flow.transport.close().catch(() => {});
  }
}

/** Complete OAuth using the captured authorization code via the pending transport. */
export async function completeAuth(serverName: string, serverUrl: string, authorizationCode: string): Promise<AuthStatus> {
  const id: McpAuthIdentity = { serverName, serverUrl };
  const flow = pendingFlows.get(flowKey(id));
  if (!flow) {
    throw new Error(`No pending OAuth flow for server: ${serverName}`);
  }

  const oauthState = await getOAuthState(id);

  try {
    await flow.transport.finishAuth(authorizationCode);
    return 'authenticated';
  } finally {
    await clearPendingAuth(id, oauthState);
  }
}

/**
 * Run the full OAuth flow for a server: client_credentials non-interactively, or
 * authorization_code via the localhost callback + browser. Concurrent calls per server identity
 * (name + URL) are deduplicated. Opens the browser through VS Code (`vscode.env.openExternal`).
 */
export async function authenticate(
  sdk: McpSdkBundle,
  serverName: string,
  serverUrl: string,
  definition?: McpServerDefinition,
): Promise<AuthStatus> {
  const id: McpAuthIdentity = { serverName, serverUrl };
  const key = flowKey(id);
  const inFlight = pendingAuthentications.get(key);
  if (inFlight) {
    return inFlight;
  }

  const operation = (async (): Promise<AuthStatus> => {
    const { authorizationUrl } = await startAuth(sdk, serverName, serverUrl, definition);

    if (!authorizationUrl) {
      return 'authenticated';
    }

    const oauthState = await getOAuthState(id);
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
      // the SAME server identity overwriting the persisted state mid-flow (which would make completeAuth
      // read a stale verifier). It is not itself the CSRF defense.
      const storedState = await getOAuthState(id);
      if (storedState !== oauthState) {
        await clearOAuthState(id);
        throw new Error('OAuth flow superseded by a concurrent authentication for the same server');
      }
      await clearOAuthState(id);

      return await completeAuth(serverName, serverUrl, code);
    } catch (error) {
      cancelPendingCallback(oauthState);
      await clearPendingAuth(id, oauthState);
      throw error;
    }
  })();

  pendingAuthentications.set(key, operation);

  try {
    return await operation;
  } finally {
    if (pendingAuthentications.get(key) === operation) {
      pendingAuthentications.delete(key);
    }
  }
}

/** The current authentication status for a server identity. */
export async function getAuthStatus(serverName: string, serverUrl: string): Promise<AuthStatus> {
  const id: McpAuthIdentity = { serverName, serverUrl };
  const hasTokens = await hasStoredTokens(id);
  if (!hasTokens) return 'not_authenticated';
  const expired = await isTokenExpired(id);
  return expired ? 'expired' : 'authenticated';
}

/** Remove all OAuth credentials and cancel any in-flight flow for a server identity. */
export async function removeAuth(serverName: string, serverUrl: string): Promise<void> {
  const id: McpAuthIdentity = { serverName, serverUrl };
  const oauthState = await getOAuthState(id);
  if (oauthState) {
    cancelPendingCallback(oauthState);
  }
  await clearPendingAuth(id, oauthState);
  await clearAllCredentials(id);
  log('[McpAuthFlow] Removed credentials for %s', serverName);
}

/**
 * Best-effort RFC 7009 token revocation at the authorization server, then ALWAYS clear local creds.
 * Revoke must run before `removeAuth` (which deletes the tokens it needs); revocation itself can never
 * throw — a network failure, a missing `revocation_endpoint`, or a server without RFC 9728 discovery all
 * degrade silently to a local forget.
 */
export async function revokeAndRemoveAuth(
  sdk: McpSdkBundle | null,
  serverName: string,
  definition: McpServerDefinition & { url: string },
): Promise<void> {
  await revokeTokens(sdk, serverName, definition);
  await removeAuth(serverName, definition.url);
}

/** Best-effort revoke the stored access + refresh tokens at the auth server. Never throws. */
async function revokeTokens(
  sdk: McpSdkBundle | null,
  serverName: string,
  definition: McpServerDefinition & { url: string },
): Promise<void> {
  if (!sdk) return;
  if (!supportsOAuth(definition)) return;
  try {
    const entry = await getAuthEntry({ serverName, serverUrl: definition.url });
    if (!entry?.tokens?.accessToken) return;

    const info = await sdk.auth.discoverOAuthServerInfo(definition.url);
    const metadata = info.authorizationServerMetadata;
    // `revocation_endpoint` is on the OAuth arm of the SDK's metadata union but not the OpenID arm's
    // zod schema, so the union doesn't expose it directly; read it through a narrow accessor.
    if (!metadata || !revocationEndpointOf(metadata)) return;

    const config = extractOAuthConfig(definition);
    const provider = new McpOAuthProvider(sdk, serverName, definition.url, config, { onRedirect: async () => {} });

    if (entry.tokens.refreshToken) {
      await postRevocation(provider, metadata, entry.tokens.refreshToken, 'refresh_token');
    }
    await postRevocation(provider, metadata, entry.tokens.accessToken, 'access_token');
  } catch (error) {
    log('[McpAuthFlow] Token revocation failed for %s (continuing with local sign-out): %O', serverName, error);
  }
}

/** Read the optional RFC 7009 `revocation_endpoint`, which the SDK metadata union only types on its OAuth arm. */
function revocationEndpointOf(metadata: AuthorizationServerMetadata): string | undefined {
  return (metadata as { revocation_endpoint?: string }).revocation_endpoint;
}

/** POST a single RFC 7009 revocation request with negotiated client auth applied by the provider. */
async function postRevocation(
  provider: McpOAuthProvider,
  metadata: AuthorizationServerMetadata,
  token: string,
  tokenTypeHint: 'access_token' | 'refresh_token',
): Promise<void> {
  const revocationEndpoint = revocationEndpointOf(metadata)!;
  assertSafeAuthorizationUrl(revocationEndpoint);
  const headers = new Headers({ 'Content-Type': 'application/x-www-form-urlencoded' });
  const params = new URLSearchParams({ token, token_type_hint: tokenTypeHint });
  await provider.addClientAuthentication(headers, params, revocationEndpoint, metadata);
  const res = await fetch(revocationEndpoint, {
    method: 'POST',
    headers,
    body: params,
    signal: AbortSignal.timeout(10_000),
  });
  // RFC 7009: a 200 is returned for a successful revocation AND for an already-invalid token; treat any
  // 2xx as success. A non-2xx is logged but not thrown (sign-out proceeds regardless).
  if (!res.ok) {
    log('[McpAuthFlow] Revocation endpoint returned %d for %s token', res.status, tokenTypeHint);
  }
}

/** Stop the OAuth subsystem: cancel pending flows and stop the callback server. */
export async function shutdownOAuth(): Promise<void> {
  // Reject every in-flight interactive auth's callback waiter so the awaiting authenticate() promise
  // settles deterministically on deactivation, then drop the dedup map (M5).
  const flows = Array.from(pendingFlows.values());
  for (const flow of flows) {
    cancelPendingCallback(flow.oauthState);
  }
  for (const flow of flows) {
    await clearPendingAuth(flow.id);
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
