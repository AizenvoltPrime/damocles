/*
 * OAuth sign-in and connection auth for remote MCP servers on pi-mcp (`@earendil-works/pi-mcp/oauth`).
 * Connections never open a browser: they send the stored token, refresh it after a 401, and otherwise
 * fail with pi-mcp's `McpOAuthAuthorizationRequiredError` (needs-auth). The panel's Authenticate action
 * runs `authenticateMcpServer`: `authorizeMcp` with PKCE, dynamic client registration and the RFC 9207
 * `iss` check, against Damocles' own loopback callback server (`mcp-callback-server.ts`).
 */
import type { AuthProvider } from '@earendil-works/pi-mcp';
import type { McpOAuthProvider, OAuthChallenge, OAuthClientProvider, OAuthDiscoveryState, OAuthFlowOptions } from '@earendil-works/pi-mcp/oauth';
import type { McpOAuthConfig } from '../../../shared/types/mcp';
import type { McpServerDefinition } from './types';
import type { McpOAuthModule } from './mcp-client-loader';
import {
  applyClientAuthentication,
  createAuthorizationCodeProvider,
  createClientCredentialsAuthProvider,
  createOAuthFetch,
  discoverAuthorizationServer,
  isSecureEndpoint,
  knownClient,
  mergeScopes,
  requestClientCredentialsToken,
  stepUpScope,
} from './mcp-oauth-provider';
import { flattenServerText } from './utils';
import { failureForLog } from './connect-failure';
import {
  ensureCallbackServer,
  waitForCallback,
  cancelPendingCallback,
  stopCallbackServer,
  getConfiguredOAuthCallbackPort,
  getOAuthCallbackPort,
} from './mcp-callback-server';
import {
  createOAuthStateStore,
  getAuthEntry,
  isTokenExpired,
  hasStoredTokens,
  clearAllCredentials,
  clearSignInState,
  getOAuthState,
  type McpAuthIdentity,
} from './mcp-auth';
import { log } from '../../logger';
import { platform } from '../../platform-host';

export type { McpOAuthModule } from './mcp-client-loader';

/** Auth status for a server. */
export type AuthStatus = 'authenticated' | 'expired' | 'not_authenticated';

/** Result of an interactive authenticate attempt. */
export interface McpAuthenticateResult {
  ok: boolean;
  error?: string;
}

const DEFAULT_CALLBACK_HOST = '127.0.0.1';
const DEFAULT_CALLBACK_PATH = '/callback';
/** The redirect URI a connection's provider carries; a refresh never redirects, so it is never sent to a browser. */
const FALLBACK_REDIRECT_URL = `http://${DEFAULT_CALLBACK_HOST}${DEFAULT_CALLBACK_PATH}`;
const REVOCATION_TIMEOUT_MS = 10_000;

/** Keyed by `flowKey`: same-named servers at different URLs are separate flows. */
const pendingAuthentications = new Map<string, Promise<void>>();
/** The CSRF state of each sign-in waiting for its browser redirect, so sign-out and shutdown can cancel it. */
const activeSignIns = new Map<string, string>();
/** The last WWW-Authenticate challenge a connection received per identity; sign-in uses its scope and metadata URL. */
const challenges = new Map<string, OAuthChallenge>();

function flowKey(id: McpAuthIdentity): string {
  return JSON.stringify([id.serverName, id.serverUrl]);
}

/** A cryptographically secure random CSRF state parameter. */
function generateState(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Reject an authorization URL that is not https or loopback http before handing it to `openExternal`.
 * The URL is derived from the auth server's discovered `authorization_endpoint`, so a malicious server
 * could otherwise return a custom scheme that launches a local application, or a plain-http page.
 */
function assertSafeAuthorizationUrl(oauth: McpOAuthModule, url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new Error('OAuth authorization URL is invalid', { cause: error });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Refusing to open OAuth authorization URL with unsupported scheme "${parsed.protocol}"`);
  }
  if (!isSecureEndpoint(parsed)) throw new oauth.OAuthInsecureEndpointError(parsed.origin);
}

/** The OAuth settings of a server definition; the values were validated and expanded on the way in. */
export function extractOAuthConfig(definition: McpServerDefinition): McpOAuthConfig {
  return definition.oauth ? { ...definition.oauth } : {};
}

/**
 * Whether a server uses OAuth: it has a URL, OAuth is not disabled, and it either asks for it or sets no
 * other auth. A static `Authorization` header counts as other auth (pi's `usesOAuth`), so a rejected
 * header token is a failed row, not a sign-in prompt.
 */
export function supportsOAuth(definition: McpServerDefinition): definition is McpServerDefinition & { url: string } {
  if (!definition.url) return false;
  if (definition.auth === false) return false;
  if (definition.oauth === false) return false;
  if (definition.auth === 'oauth') return true;
  if (definition.auth !== undefined) return false;
  return !Object.keys(definition.headers ?? {}).some((header) => header.toLowerCase() === 'authorization');
}

/** Whether the server's last challenge asked for more scope than the stored grant has (step-up). */
export function hasScopeChallenge(serverName: string, serverUrl: string): boolean {
  return challenges.get(flowKey({ serverName, serverUrl }))?.error === 'insufficient_scope';
}

/** How the loopback callback server binds for a sign-in, and the redirect URI it serves. */
interface CallbackPlan {
  strictPort: boolean;
  /** The port to bind when strict. */
  port: number | undefined;
  /** The address to listen on. */
  host: string;
  path: string;
  /** The redirect URI with its port left to the bind, when the port is not fixed. */
  template: URL;
  /** The exact redirect URI when the port is fixed. */
  fixedRedirectUrl: string | undefined;
}

/**
 * Map `oauth.callbackUrl` / `oauth.callbackPort` onto the callback server (pi's `callbackSettings`,
 * `pi-coding-agent/src/extensions/mcp/oauth.ts`). A callbackUrl with a port is sent exactly as written,
 * because servers compare redirect URIs as strings. With neither, a pre-registered client keeps the
 * strict configured port and a dynamically registered one binds a free port.
 */
function callbackPlan(config: McpOAuthConfig): CallbackPlan {
  const template = new URL(config.callbackUrl ?? `http://${DEFAULT_CALLBACK_HOST}${DEFAULT_CALLBACK_PATH}`);
  const address = template.hostname.replace(/^\[|\]$/g, '');
  // `localhost` is served on 127.0.0.1; browsers fall back to it when ::1 refuses.
  const host = address === 'localhost' ? DEFAULT_CALLBACK_HOST : address;
  const path = template.pathname;
  if (config.callbackUrl !== undefined && template.port) {
    return { strictPort: true, port: Number(template.port), host, path, template, fixedRedirectUrl: config.callbackUrl };
  }
  if (config.callbackPort !== undefined) {
    const fixed = new URL(template.href);
    fixed.port = String(config.callbackPort);
    return { strictPort: true, port: config.callbackPort, host, path, template, fixedRedirectUrl: fixed.href };
  }
  if (config.callbackUrl === undefined && config.clientId !== undefined) {
    const port = getConfiguredOAuthCallbackPort();
    const fixed = new URL(template.href);
    fixed.port = String(port);
    return { strictPort: true, port, host, path, template, fixedRedirectUrl: fixed.href };
  }
  return { strictPort: false, port: undefined, host, path, template, fixedRedirectUrl: undefined };
}

/** The port of a stored client's registered redirect URI when it matches this plan's host and path. */
function registeredPort(plan: CallbackPlan, redirectUris: string[] | undefined): number | undefined {
  const registered = redirectUris?.[0];
  if (!registered || !URL.canParse(registered)) return undefined;
  const url = new URL(registered);
  if (url.hostname !== plan.template.hostname || url.pathname !== plan.path || !url.port) return undefined;
  return Number(url.port);
}

/** `provider` with some of its methods replaced; pi-mcp's flow sees only this object. */
function withOverrides(provider: McpOAuthProvider, overrides: Partial<OAuthClientProvider>): OAuthClientProvider {
  return {
    redirectUrl: provider.redirectUrl,
    clientMetadata: provider.clientMetadata,
    state: () => provider.state(),
    clientInformation: () => provider.clientInformation(),
    saveClientInformation: (information) => provider.saveClientInformation(information),
    tokens: () => provider.tokens(),
    saveTokens: (tokens) => provider.saveTokens(tokens),
    redirectToAuthorization: (url) => provider.redirectToAuthorization(url),
    saveCodeVerifier: (verifier) => provider.saveCodeVerifier(verifier),
    codeVerifier: () => provider.codeVerifier(),
    invalidateCredentials: (kind) => provider.invalidateCredentials(kind),
    saveDiscoveryState: (state) => provider.saveDiscoveryState(state),
    discoveryState: () => provider.discoveryState(),
    ...overrides,
  };
}

/** `provider` with its discovery pinned, so the code exchange reaches the authorization server the `iss` check accepted. */
function withDiscovery(provider: McpOAuthProvider, discovery: OAuthDiscoveryState): OAuthClientProvider {
  return withOverrides(provider, { discoveryState: () => discovery });
}

/** The authorization_code sign-in: refresh when that suffices, else the browser flow on the loopback callback. */
async function signInWithBrowser(oauth: McpOAuthModule, id: McpAuthIdentity, config: McpOAuthConfig): Promise<void> {
  const key = flowKey(id);
  const challenge = challenges.get(key);
  const stepUp = challenge?.error === 'insufficient_scope';
  const store = createOAuthStateStore(id, { interactive: true });
  const stored = await store.load();
  const plan = callbackPlan(config);
  const oauthState = generateState();
  const registeredUris =
    stored.clientInformation && 'redirect_uris' in stored.clientInformation ? stored.clientInformation.redirect_uris : undefined;
  const preferredPort = plan.strictPort ? undefined : registeredPort(plan, registeredUris);

  await ensureCallbackServer({
    strictPort: plan.strictPort,
    ...(plan.port !== undefined ? { port: plan.port } : {}),
    callbackHost: plan.host,
    callbackPath: plan.path,
    oauthState,
    reserveState: true,
    ...(preferredPort !== undefined ? { preferredPort } : {}),
  });
  activeSignIns.set(key, oauthState);
  try {
    let redirectUrl = plan.fixedRedirectUrl;
    if (redirectUrl === undefined) {
      const bound = new URL(plan.template.href);
      bound.port = String(getOAuthCallbackPort());
      redirectUrl = bound.href;
    }

    // Every sign-in gets a fresh state and verifier. A registered client cannot use another redirect URI, and its tokens belong to it.
    const next = { ...stored, oauthState };
    delete next.codeVerifier;
    // pi-mcp's flow uses cached discovery instead of discovering, which is how a configured metadata document applies.
    if (config.authServerMetadataUrl !== undefined) next.discovery = await discoverAuthorizationServer(oauth, id.serverUrl, config);
    if (config.clientId === undefined && !(registeredUris ?? []).includes(redirectUrl)) {
      delete next.clientInformation;
      delete next.tokens;
      delete next.tokensExpireAt;
    }
    await store.save(next);

    let authorizationUrl: URL | undefined;
    const provider = createAuthorizationCodeProvider(oauth, {
      serverUrl: id.serverUrl,
      config,
      redirectUrl,
      store,
      onRedirect: (url) => {
        authorizationUrl = url;
      },
    });
    // A server asking for more scope gets it on top of the configured scope and the scope granted so far.
    const scope = mergeScopes(config.scope, stepUp ? stepUpScope(stored.tokens?.scope, challenge?.scope) : challenge?.scope);
    const flow: OAuthFlowOptions = {
      serverUrl: id.serverUrl,
      fetch: createOAuthFetch(oauth),
      ...(challenge?.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl } : {}),
      ...(scope !== undefined ? { scope } : {}),
    };
    // A refresh keeps the granted scope, so a step-up goes straight to the browser.
    if ((await oauth.authorizeMcp(provider, { ...flow, skipRefresh: stepUp })) === 'AUTHORIZED') return;
    // The authorization server this redirect was built for; the callback wait can outlive the stored copy.
    const discovery = await provider.discoveryState();
    if (!discovery) throw new Error('OAuth discovery state was lost before the browser redirect');
    if (!authorizationUrl) throw new Error('OAuth flow did not produce an authorization URL');
    const url = authorizationUrl.href;
    assertSafeAuthorizationUrl(oauth, url);

    const callback = waitForCallback(oauthState);
    // Not awaited: the callback can settle (an error redirect) before the handoff resolves, and it must be awaited first.
    void platform().shell.openExternal(url).then(
      (opened) => {
        if (!opened) log('[McpAuthFlow] Browser handoff for %s reported failure; awaiting callback', id.serverName);
      },
      (error: unknown) => log('[McpAuthFlow] Failed to open browser for %s: %O', id.serverName, error),
    );
    const { code, iss } = await callback;

    // The CSRF gate is the callback server's state-keyed lookup. This guards a different failure: a
    // concurrent sign-in for the same identity replacing the stored state and verifier mid-flow.
    if ((await getOAuthState(id)) !== oauthState) {
      throw new Error('OAuth flow superseded by a concurrent authentication for the same server');
    }
    // RFC 9207. pi-mcp 0.99.2's authorizeMcp does not check `iss`; the exchange below uses the same captured discovery.
    const metadata = discovery.authorizationServerMetadata;
    if (metadata && (iss !== undefined || metadata['authorization_response_iss_parameter_supported'] === true) && iss !== metadata.issuer) {
      throw new oauth.OAuthIssuerMismatchError(metadata.issuer, iss ?? 'none');
    }
    await oauth.authorizeMcp(withDiscovery(provider, discovery), { ...flow, authorizationCode: code });
  } finally {
    if (activeSignIns.get(key) === oauthState) activeSignIns.delete(key);
    cancelPendingCallback(oauthState);
    await clearSignInState(id, oauthState);
  }
}

/** Run one sign-in for a server identity; concurrent calls for the same identity share it. */
function signIn(oauth: McpOAuthModule, id: McpAuthIdentity, config: McpOAuthConfig): Promise<void> {
  const key = flowKey(id);
  const inFlight = pendingAuthentications.get(key);
  if (inFlight) return inFlight;
  const operation = (async () => {
    if (config.grantType === 'client_credentials') {
      const challenge = challenges.get(key);
      await requestClientCredentialsToken(oauth, id, config, mergeScopes(config.scope, challenge?.scope));
    } else {
      await signInWithBrowser(oauth, id, config);
    }
    challenges.delete(key);
  })().finally(() => {
    if (pendingAuthentications.get(key) === operation) pendingAuthentications.delete(key);
  });
  pendingAuthentications.set(key, operation);
  return operation;
}

/** The current authentication status for a server identity. */
export async function getAuthStatus(serverName: string, serverUrl: string): Promise<AuthStatus> {
  const id: McpAuthIdentity = { serverName, serverUrl };
  const hasTokens = await hasStoredTokens(id);
  if (!hasTokens) return 'not_authenticated';
  const expired = await isTokenExpired(id);
  return expired ? 'expired' : 'authenticated';
}

/** Remove all OAuth credentials and cancel any in-flight sign-in for a server identity. */
export async function removeAuth(serverName: string, serverUrl: string): Promise<void> {
  const id: McpAuthIdentity = { serverName, serverUrl };
  const key = flowKey(id);
  const oauthState = activeSignIns.get(key);
  if (oauthState) cancelPendingCallback(oauthState);
  challenges.delete(key);
  await clearAllCredentials(id);
  log('[McpAuthFlow] Removed credentials for %s', serverName);
}

/**
 * Best-effort RFC 7009 token revocation at the authorization server, then ALWAYS clear local creds.
 * Revoke must run before `removeAuth` (which deletes the tokens it needs). A revocation failure (network,
 * no `revocation_endpoint`, no discovery) is logged and sign-out continues locally.
 */
export async function revokeAndRemoveAuth(
  oauth: McpOAuthModule | null,
  serverName: string,
  definition: McpServerDefinition & { url: string },
): Promise<void> {
  if (oauth && supportsOAuth(definition)) {
    try {
      await revokeTokens(oauth, serverName, definition);
    } catch (error) {
      log('[McpAuthFlow] Token revocation failed for %s (continuing with local sign-out): %s', serverName, failureForLog(error));
    }
  }
  await removeAuth(serverName, definition.url);
}

async function revokeTokens(
  oauth: McpOAuthModule,
  serverName: string,
  definition: McpServerDefinition & { url: string },
): Promise<void> {
  const id: McpAuthIdentity = { serverName, serverUrl: definition.url };
  const tokens = (await getAuthEntry(id))?.tokens;
  if (!tokens?.accessToken) return;
  const config = extractOAuthConfig(definition);
  const info = await discoverAuthorizationServer(oauth, definition.url, config);
  const metadata = info.authorizationServerMetadata;
  const endpoint = metadata?.['revocation_endpoint'];
  if (typeof endpoint !== 'string') return;
  const client = await knownClient(id, config);
  if (!client) return;
  const oauthFetch = createOAuthFetch(oauth);
  const revoke = async (token: string, hint: 'access_token' | 'refresh_token'): Promise<void> => {
    const headers = new Headers({ 'Content-Type': 'application/x-www-form-urlencoded' });
    const params = new URLSearchParams({ token, token_type_hint: hint });
    applyClientAuthentication(headers, params, client, metadata);
    const res = await oauthFetch(endpoint, { method: 'POST', headers, body: params, signal: AbortSignal.timeout(REVOCATION_TIMEOUT_MS) });
    // The body carries nothing sign-out needs; cancelling it releases the connection.
    await res.body?.cancel();
    // RFC 7009: 200 covers a revoked token and an already-invalid one; any other status is logged, and sign-out proceeds.
    if (!res.ok) log('[McpAuthFlow] Revocation endpoint returned %d for %s token', res.status, hint);
  };
  if (tokens.refreshToken) await revoke(tokens.refreshToken, 'refresh_token');
  await revoke(tokens.accessToken, 'access_token');
}

/** Stop the OAuth subsystem: cancel pending sign-ins and stop the callback server. */
export async function shutdownOAuth(): Promise<void> {
  for (const oauthState of activeSignIns.values()) cancelPendingCallback(oauthState);
  activeSignIns.clear();
  pendingAuthentications.clear();
  await stopCallbackServer();
}

/**
 * Build the `authProvider` for a server's `StreamableHttpTransport`, or undefined when it does not use
 * OAuth. `definition` carries expanded values. A connection never starts a browser flow: without a
 * refresh token, or on an `insufficient_scope` challenge (a refresh keeps the granted scope), it throws
 * `McpOAuthAuthorizationRequiredError`; otherwise pi-mcp's `adaptOAuthProvider` refreshes after a 401.
 */
export function createMcpAuthProviderFactory(
  oauth: McpOAuthModule,
): (serverName: string, url: string, definition: McpServerDefinition) => AuthProvider | undefined {
  return (serverName, url, definition) => {
    if (!supportsOAuth(definition)) return undefined;
    const config = extractOAuthConfig(definition);
    const id: McpAuthIdentity = { serverName, serverUrl: url };
    const key = flowKey(id);
    const onChallenge = (challenge: OAuthChallenge): void => {
      challenges.set(key, challenge);
    };
    if (config.grantType === 'client_credentials') return createClientCredentialsAuthProvider(oauth, id, config, onChallenge);

    const store = createOAuthStateStore(id, { interactive: false });
    const provider = createAuthorizationCodeProvider(oauth, {
      serverUrl: url,
      config,
      redirectUrl: callbackPlan(config).fixedRedirectUrl ?? FALLBACK_REDIRECT_URL,
      store,
      onRedirect: () => {},
    });
    // A connection never registers a client (it would be orphaned): pi-mcp's flow asks for the client right
    // before it registers one, on the first run and on its invalid_client retry alike.
    const adapted = oauth.adaptOAuthProvider(
      withOverrides(provider, {
        clientInformation: async () => {
          const client = await provider.clientInformation();
          if (!client) throw new oauth.McpOAuthAuthorizationRequiredError();
          return client;
        },
      }),
    );
    const oauthFetch = createOAuthFetch(oauth);
    return {
      token: () => adapted.token(),
      onUnauthorized: async (context) => {
        const challenge = oauth.parseWwwAuthenticate(context.response.headers.get('www-authenticate'));
        onChallenge(challenge);
        if (challenge.error === 'insufficient_scope') throw new oauth.McpOAuthAuthorizationRequiredError();
        const tokens = await provider.tokens();
        // Another request already replaced the rejected token: retry with it.
        if (tokens?.access_token !== undefined && context.token !== undefined && tokens.access_token !== context.token) return;
        if (!tokens?.refresh_token) throw new oauth.McpOAuthAuthorizationRequiredError();
        // A refresh token without its client (absent, or its secret expired) would make pi-mcp register a new one.
        if (config.clientId === undefined && !(await provider.clientInformation())) throw new oauth.McpOAuthAuthorizationRequiredError();
        if (config.authServerMetadataUrl !== undefined && !(await provider.discoveryState())) {
          await store.save({ ...(await store.load()), discovery: await discoverAuthorizationServer(oauth, url, config) });
        }
        await adapted.onUnauthorized?.({ ...context, fetch: oauthFetch });
      },
    };
  };
}

/** An auth failure as one capped line: server-supplied text reaches this message, the log and the panel. */
function describeAuthError(error: unknown): string {
  return flattenServerText(error instanceof Error ? error.message : String(error));
}

/**
 * Interactive authenticate entrypoint for the panel's Authenticate action: the authorization_code flow
 * through the browser, or a client_credentials token. `definition` carries expanded values. Returns
 * success or failure and never throws; the caller force-reconnects on success.
 */
export async function authenticateMcpServer(
  oauth: McpOAuthModule,
  serverName: string,
  definition: McpServerDefinition,
): Promise<McpAuthenticateResult> {
  if (!supportsOAuth(definition)) {
    return { ok: false, error: `MCP server "${serverName}" does not support OAuth` };
  }
  try {
    await signIn(oauth, { serverName, serverUrl: definition.url }, extractOAuthConfig(definition));
    return { ok: true };
  } catch (error) {
    const message = describeAuthError(error);
    log('[McpAuthFlow] Authentication failed for %s: %s', serverName, failureForLog(error));
    return { ok: false, error: message };
  }
}
