/*
 * OAuth providers for remote MCP servers on pi-mcp (`@earendil-works/pi-mcp/oauth`): the
 * authorization_code provider (pi-mcp's `McpOAuthProvider` over the keychain store) and the
 * client_credentials `AuthProvider`, which pi-mcp has no grant for.
 */
import type { AuthProvider, McpFetch } from '@earendil-works/pi-mcp';
import type {
  AuthorizationServerMetadata,
  McpOAuthProvider,
  McpOAuthStateStore,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthDiscoveryState,
  OAuthProtectedResourceMetadata,
} from '@earendil-works/pi-mcp/oauth';
import type { McpOAuthConfig } from '../../../shared/types/mcp';
import type { McpOAuthModule } from './mcp-client-loader';
import {
  clearClientInfo,
  getAuthEntry,
  TOKEN_EXPIRY_SKEW_SECONDS,
  updateClientInfo,
  updateTokens,
  type McpAuthIdentity,
} from './mcp-auth';
import { flattenServerText } from './utils';

const DEFAULT_CLIENT_NAME = 'Damocles';
const DEFAULT_CLIENT_URI = 'https://github.com/AizenvoltPrime/damocles';
/** Bounds each OAuth request so a stalled authorization server cannot hold a sign-in, a connect or a sign-out. */
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

/** Dynamic client registration metadata, without the redirect URI the provider adds. */
function registrationMetadata(config: McpOAuthConfig): Omit<OAuthClientMetadata, 'redirect_uris'> {
  return {
    client_name: config.clientName ?? DEFAULT_CLIENT_NAME,
    client_uri: config.clientUri ?? DEFAULT_CLIENT_URI,
    ...(config.scope !== undefined ? { scope: config.scope } : {}),
  };
}

/** The authorization_code provider for one server identity; `redirectUrl` is sent exactly as given. */
export function createAuthorizationCodeProvider(
  oauth: McpOAuthModule,
  options: {
    serverUrl: string;
    config: McpOAuthConfig;
    redirectUrl: string;
    store: McpOAuthStateStore;
    onRedirect: (url: URL) => void;
  },
): McpOAuthProvider {
  const { config } = options;
  return new oauth.McpOAuthProvider({
    serverUrl: options.serverUrl,
    redirectUrl: options.redirectUrl,
    clientMetadata: registrationMetadata(config),
    ...(config.clientId !== undefined ? { clientId: config.clientId } : {}),
    ...(config.clientSecret !== undefined ? { clientSecret: config.clientSecret } : {}),
    store: options.store,
    onRedirect: options.onRedirect,
  });
}

/** Whether a URL is https, or http on a loopback host (pi-mcp's rule for any endpoint that receives a credential). */
export function isSecureEndpoint(url: URL): boolean {
  return url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
}

/** https, or http only on a loopback host (pi-mcp's rule for any endpoint that receives a credential). */
export function assertSecureEndpoint(oauth: McpOAuthModule, value: string | URL): URL {
  const url = new URL(value);
  if (!isSecureEndpoint(url)) throw new oauth.OAuthInsecureEndpointError(url.href);
  return url;
}

/**
 * The fetch every OAuth request goes through (discovery, registration, token, revocation): it refuses
 * an endpoint that is not https or loopback before any byte is sent, never follows a redirect (a 3xx
 * reaches pi-mcp as a failed response), and bounds the request, body included, by
 * `TOKEN_REQUEST_TIMEOUT_MS` on top of the caller's own signal.
 */
export function createOAuthFetch(oauth: McpOAuthModule): McpFetch {
  return async (input, init) => {
    const url = assertSecureEndpoint(oauth, input);
    const timeout = AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
    // A followed 307 would re-send the body (code, client secret) to an endpoint this check never saw.
    return fetch(url, { ...init, redirect: 'manual', signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  };
}

/**
 * Authenticate the client on a token or revocation request with the method the authorization server
 * supports. Basic credentials are form-urlencoded before the colon join (RFC 6749 §2.3.1), so a secret
 * holding ':' or non-ASCII stays intact.
 */
export function applyClientAuthentication(
  headers: Headers,
  params: URLSearchParams,
  client: OAuthClientInformationMixed,
  metadata: AuthorizationServerMetadata | undefined,
): void {
  const supported = metadata?.token_endpoint_auth_methods_supported ?? [];
  const secret = client.client_secret;
  let method: 'client_secret_basic' | 'client_secret_post' | 'none';
  if (secret !== undefined && supported.includes('client_secret_basic')) method = 'client_secret_basic';
  else if (secret !== undefined && supported.includes('client_secret_post')) method = 'client_secret_post';
  else if (supported.includes('none')) method = 'none';
  else method = secret !== undefined ? 'client_secret_post' : 'none';

  if (method === 'client_secret_basic' && secret !== undefined) {
    const basic = Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(secret)}`).toString('base64');
    headers.set('Authorization', `Basic ${basic}`);
    return;
  }
  params.set('client_id', client.client_id);
  if (method === 'client_secret_post' && secret !== undefined) params.set('client_secret', secret);
}

/** Scopes of every list, each once (pi's `mergeScopes`, `pi-coding-agent/src/extensions/mcp/oauth.ts`). */
export function mergeScopes(...scopes: (string | undefined)[]): string | undefined {
  const merged = [...new Set(scopes.flatMap((scope) => scope?.split(/\s+/).filter(Boolean) ?? []))];
  return merged.length > 0 ? merged.join(' ') : undefined;
}

/** Port of `stepUpScope` in pi-mcp/src/oauth/flow.ts: the challenged scopes plus the ones granted so far. */
export function stepUpScope(granted: string | undefined, challenged: string | undefined): string | undefined {
  if (!challenged) return undefined;
  const scopes = [granted, challenged].flatMap((scope) => scope?.split(/\s+/).filter(Boolean) ?? []);
  return [...new Set(scopes)].join(' ');
}

function requiredUrl(value: unknown, name: string): string {
  if (typeof value !== 'string' || !URL.canParse(value)) throw new Error(`Invalid ${name}`);
  if (['javascript:', 'data:', 'vbscript:'].includes(new URL(value).protocol)) throw new Error(`Invalid ${name}`);
  return value;
}

/** The structural checks of pi-mcp's `parseAuthorizationServerMetadata` (src/oauth/types.ts) that the flow relies on. */
function parseAuthorizationServerMetadata(value: unknown): AuthorizationServerMetadata {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid authorization server metadata');
  const input = value as Record<string, unknown>;
  const responseTypes = input['response_types_supported'];
  if (!Array.isArray(responseTypes) || responseTypes.some((item) => typeof item !== 'string')) {
    throw new Error('Invalid response_types_supported');
  }
  return {
    ...input,
    issuer: requiredUrl(input['issuer'], 'authorization server issuer'),
    authorization_endpoint: requiredUrl(input['authorization_endpoint'], 'authorization endpoint'),
    token_endpoint: requiredUrl(input['token_endpoint'], 'token endpoint'),
    response_types_supported: responseTypes as string[],
  };
}

/**
 * Discovery for a server: pi-mcp's RFC 9728 / RFC 8414 discovery, or with `oauth.authServerMetadataUrl`
 * that document, trusted as configured so its issuer is not checked (pi's rule). pi-mcp 0.99.2's
 * `authorizeMcp` has no metadata URL option, so callers prime the provider's discovery state with this.
 */
export async function discoverAuthorizationServer(
  oauth: McpOAuthModule,
  serverUrl: string,
  config: McpOAuthConfig,
): Promise<OAuthDiscoveryState> {
  const oauthFetch = createOAuthFetch(oauth);
  if (config.authServerMetadataUrl === undefined) return oauth.discoverOAuthServerInfo(serverUrl, { fetch: oauthFetch });
  let resourceMetadata: OAuthProtectedResourceMetadata | undefined;
  try {
    resourceMetadata = await oauth.discoverProtectedResourceMetadata(serverUrl, { fetch: oauthFetch });
  } catch (error) {
    // As in pi-mcp's discovery: a server without resource metadata has none; only a network failure aborts.
    if (error instanceof TypeError) throw error;
  }
  const url = new URL(config.authServerMetadataUrl);
  const response = await oauthFetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status} loading authorization server metadata from ${url.href}`);
  const metadata = parseAuthorizationServerMetadata(await response.json());
  return {
    authorizationServerUrl: metadata.issuer,
    authorizationServerMetadata: metadata,
    ...(resourceMetadata ? { resourceMetadata } : {}),
  };
}

/** The configured client, else a stored dynamically registered one whose secret has not expired. */
export async function knownClient(id: McpAuthIdentity, config: McpOAuthConfig): Promise<OAuthClientInformationMixed | undefined> {
  if (config.clientId !== undefined) {
    return { client_id: config.clientId, ...(config.clientSecret !== undefined ? { client_secret: config.clientSecret } : {}) };
  }
  const info = (await getAuthEntry(id))?.clientInfo;
  if (!info) return undefined;
  if (info.clientSecretExpiresAt && info.clientSecretExpiresAt < Date.now() / 1000) return undefined;
  return { client_id: info.clientId, ...(info.clientSecret !== undefined ? { client_secret: info.clientSecret } : {}) };
}

/**
 * Get a client_credentials token: pi-mcp discovery (or `authServerMetadataUrl`), dynamic registration
 * when no client is configured or stored, then a token POST. The token is stored in the keychain entry.
 */
export async function requestClientCredentialsToken(
  oauth: McpOAuthModule,
  id: McpAuthIdentity,
  config: McpOAuthConfig,
  scope: string | undefined,
): Promise<string> {
  const oauthFetch = createOAuthFetch(oauth);
  const info = await discoverAuthorizationServer(oauth, id.serverUrl, config);
  const metadata = info.authorizationServerMetadata;
  const resource = oauth.selectResource(id.serverUrl, info.resourceMetadata);
  const tokenUrl = assertSecureEndpoint(oauth, metadata?.token_endpoint ?? new URL('/token', info.authorizationServerUrl));

  let client = await knownClient(id, config);
  if (!client) {
    const registered = await oauth.registerClient(info.authorizationServerUrl, {
      fetch: oauthFetch,
      ...(metadata ? { metadata } : {}),
      clientMetadata: {
        ...registrationMetadata(config),
        redirect_uris: [],
        grant_types: ['client_credentials'],
        token_endpoint_auth_method: 'client_secret_post',
      },
      ...(scope !== undefined ? { scope } : {}),
    });
    client = registered;
    await updateClientInfo(id, {
      clientId: registered.client_id,
      ...(registered.client_secret !== undefined ? { clientSecret: registered.client_secret } : {}),
      ...(registered.client_id_issued_at !== undefined ? { clientIdIssuedAt: registered.client_id_issued_at } : {}),
      ...(registered.client_secret_expires_at !== undefined ? { clientSecretExpiresAt: registered.client_secret_expires_at } : {}),
    });
  }

  const params = new URLSearchParams({ grant_type: 'client_credentials' });
  if (scope) params.set('scope', scope);
  if (resource) params.set('resource', resource);
  const headers = new Headers({ Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' });
  applyClientAuthentication(headers, params, client, metadata);
  const response = await oauthFetch(tokenUrl, { method: 'POST', headers, body: params });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // A non-JSON body is reported by status alone; its text is never echoed.
    body = undefined;
  }
  const fields = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  if (typeof fields['error'] === 'string') {
    if (fields['error'] === 'invalid_client' && config.clientId === undefined) await clearClientInfo(id);
    const description = typeof fields['error_description'] === 'string' ? fields['error_description'] : fields['error'];
    throw new oauth.OAuthError(fields['error'], flattenServerText(description));
  }
  if (!response.ok) throw new oauth.OAuthError('server_error', `HTTP ${response.status} from the token endpoint`);
  const accessToken = fields['access_token'];
  if (typeof accessToken !== 'string' || accessToken.length === 0) throw new Error('The token endpoint returned no access_token');
  const expiresIn = fields['expires_in'];
  const grantedScope = typeof fields['scope'] === 'string' && fields['scope'] ? fields['scope'] : scope;
  await updateTokens(id, {
    accessToken,
    ...(typeof expiresIn === 'number' && Number.isFinite(expiresIn) ? { expiresAt: Date.now() / 1000 + expiresIn } : {}),
    ...(grantedScope !== undefined ? { scope: grantedScope } : {}),
  });
  return accessToken;
}

/**
 * The client_credentials `AuthProvider`: the stored token while it is valid, else a new one; after a
 * 401 a new one unless another request already replaced the rejected token. A 401 or 403 challenge is
 * handed to `onChallenge` first, and an `insufficient_scope` one throws pi-mcp's
 * `McpOAuthAuthorizationRequiredError`, so the server shows as needing authentication.
 */
export function createClientCredentialsAuthProvider(
  oauth: McpOAuthModule,
  id: McpAuthIdentity,
  config: McpOAuthConfig,
  onChallenge: (challenge: ReturnType<McpOAuthModule['parseWwwAuthenticate']>) => void,
): AuthProvider {
  let inFlight: Promise<string> | undefined;
  const fetchToken = (): Promise<string> => {
    // A step-up grant's scope stays in the next token.
    inFlight ??= getAuthEntry(id)
      .then((entry) => requestClientCredentialsToken(oauth, id, config, mergeScopes(config.scope, entry?.tokens?.scope)))
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
  return {
    token: async () => {
      const tokens = (await getAuthEntry(id))?.tokens;
      const expired = tokens?.expiresAt !== undefined && tokens.expiresAt < Date.now() / 1000 + TOKEN_EXPIRY_SKEW_SECONDS;
      if (tokens && !expired) return tokens.accessToken;
      return fetchToken();
    },
    onUnauthorized: async (context) => {
      const challenge = oauth.parseWwwAuthenticate(context.response.headers.get('www-authenticate'));
      onChallenge(challenge);
      if (challenge.error === 'insufficient_scope') throw new oauth.McpOAuthAuthorizationRequiredError();
      const current = (await getAuthEntry(id))?.tokens?.accessToken;
      if (current !== undefined && current !== context.token) return;
      await fetchToken();
    },
  };
}
