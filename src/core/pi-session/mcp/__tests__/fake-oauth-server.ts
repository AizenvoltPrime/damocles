import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface FakeOAuthServerOptions {
  /** `issuer` in the authorization server metadata; default the server origin. */
  issuer?: (origin: string) => string;
  /** `iss` the authorization endpoint appends to the redirect; default the metadata issuer, `null` omits it. */
  callbackIss?: (origin: string) => string | null;
  /** `scopes_supported` in the protected resource metadata. */
  scopesSupported?: string[];
  /** A scope the MCP endpoint requires; tokens without it get a 403 `insufficient_scope` challenge. */
  requiredScope?: string;
  /**
   * When false, neither well-known metadata document exists, so only a configured
   * authorization server metadata URL (served at `/custom/as-metadata`) can find the endpoints.
   */
  discoverable?: boolean;
  /** Client credentials the token endpoint accepts for `client_credentials`. */
  clientCredentials?: { clientId: string; clientSecret: string };
  /** Access token lifetime in seconds; unset omits `expires_in`. */
  expiresIn?: number | null;
  /** `authorization_response_iss_parameter_supported` in the metadata; default true. */
  issParameterSupported?: boolean;
  /** `authorization_endpoint` in the metadata; default `<origin>/authorize`. */
  authorizationEndpoint?: (origin: string) => string;
  /** `registration_endpoint` in the metadata; default `<origin>/register`. */
  registrationEndpoint?: (origin: string) => string;
  /** `authorization_servers` in the protected resource metadata; default the server origin. */
  authorizationServers?: (origin: string) => string[];
  /** A refresh answers `invalid_client`, as a server does for a client it no longer knows. */
  invalidClientOnRefresh?: boolean;
  /** A refresh token works once: a refresh revokes it, as a server with rotating refresh tokens does. */
  rotateRefreshTokens?: boolean;
  /** Milliseconds to wait before answering a metadata document request for `path`. */
  metadataDelayMs?: (path: string) => number;
  /** Paths whose requests are held open and never answered, like a stalled server. */
  stalledPaths?: string[];
  /** The revocation endpoint answers with a body that never ends. */
  endlessRevocationBody?: boolean;
}

export interface IssuedToken {
  accessToken: string;
  scope: string;
}

export interface FakeOAuthServer {
  origin: string;
  mcpUrl: string;
  customMetadataUrl: string;
  registrations: Array<Record<string, unknown>>;
  authorizeRequests: URL[];
  tokenRequests: Array<{ path: string; params: URLSearchParams; authorization: string | undefined }>;
  /** Paths of every GET to a metadata document, in order. */
  metadataRequests: string[];
  /** Every revocation request: its path and form parameters. */
  revocations: Array<{ path: string; params: URLSearchParams }>;
  /** Paths of every request the server received, in order. */
  requestPaths: string[];
  /** Resolves once the client went away from an endless revocation body. */
  revocationBodyClosed: Promise<void>;
  /** Bearer tokens the MCP endpoint saw, in order. */
  mcpBearers: Array<string | undefined>;
  issued: IssuedToken[];
  /** Invalidate every access token issued so far; refresh tokens stay valid. */
  revokeAccessTokens(): void;
  /** Follow the authorization URL like a consenting browser and return the redirect it answers with. */
  approve(authorizationUrl: string | URL): Promise<URL>;
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

/**
 * A loopback OAuth 2.1 authorization server plus a streamable-HTTP MCP endpoint (`/mcp`) it protects:
 * RFC 9728 protected resource metadata, RFC 8414 metadata, dynamic client registration, PKCE
 * authorization codes with an RFC 9207 `iss`, refresh tokens and `client_credentials`.
 */
export async function startFakeOAuthServer(options: FakeOAuthServerOptions = {}): Promise<FakeOAuthServer> {
  const discoverable = options.discoverable ?? true;
  const codes = new Map<string, { challenge: string; scope: string; redirectUri: string }>();
  const refreshTokens = new Map<string, string>();
  let counter = 0;
  /** Access tokens before this index in `issued` are revoked. */
  let revoked = 0;
  let origin = '';

  let revocationBodyClosed!: () => void;
  const state: Omit<FakeOAuthServer, 'origin' | 'mcpUrl' | 'customMetadataUrl' | 'approve' | 'revokeAccessTokens' | 'close'> = {
    registrations: [],
    authorizeRequests: [],
    tokenRequests: [],
    metadataRequests: [],
    revocations: [],
    requestPaths: [],
    revocationBodyClosed: new Promise<void>((resolve) => (revocationBodyClosed = resolve)),
    mcpBearers: [],
    issued: [],
  };

  /** The well-known document names the root endpoints; the configured one names `/custom/...`, so a test can tell which applied. */
  const metadata = (prefix = '') => ({
    issuer: options.issuer ? options.issuer(origin) : origin,
    authorization_endpoint: options.authorizationEndpoint ? options.authorizationEndpoint(origin) : `${origin}${prefix}/authorize`,
    token_endpoint: `${origin}${prefix}/token`,
    registration_endpoint: options.registrationEndpoint ? options.registrationEndpoint(origin) : `${origin}${prefix}/register`,
    revocation_endpoint: `${origin}${prefix}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: options.issParameterSupported ?? true,
  });

  const issue = (scope: string): Record<string, unknown> => {
    counter += 1;
    const accessToken = `access-${counter}`;
    const refreshToken = `refresh-${counter}`;
    refreshTokens.set(refreshToken, scope);
    state.issued.push({ accessToken, scope });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      refresh_token: refreshToken,
      scope,
      ...(options.expiresIn !== undefined ? { expires_in: options.expiresIn } : {}),
    };
  };

  const handleToken = async (path: string, request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const params = new URLSearchParams(await readBody(request));
    const authorization = request.headers.authorization;
    state.tokenRequests.push({ path, params, authorization });
    const grant = params.get('grant_type');
    if (grant === 'authorization_code') {
      const entry = codes.get(params.get('code') ?? '');
      const challenge = createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url');
      if (!entry || entry.challenge !== challenge || entry.redirectUri !== params.get('redirect_uri')) {
        json(response, 400, { error: 'invalid_grant' });
        return;
      }
      codes.delete(params.get('code') ?? '');
      json(response, 200, issue(entry.scope));
      return;
    }
    if (grant === 'refresh_token') {
      if (options.invalidClientOnRefresh) {
        json(response, 401, { error: 'invalid_client' });
        return;
      }
      const scope = refreshTokens.get(params.get('refresh_token') ?? '');
      if (scope === undefined) {
        json(response, 400, { error: 'invalid_grant' });
        return;
      }
      if (options.rotateRefreshTokens) refreshTokens.delete(params.get('refresh_token') ?? '');
      json(response, 200, issue(scope));
      return;
    }
    if (grant === 'client_credentials') {
      const expected = options.clientCredentials;
      const basic = authorization?.startsWith('Basic ')
        ? Buffer.from(authorization.slice(6), 'base64').toString('utf8').split(':')
        : undefined;
      const clientId = basic?.[0] ?? params.get('client_id');
      const clientSecret = basic?.[1] ?? params.get('client_secret');
      if (!expected || clientId !== expected.clientId || clientSecret !== expected.clientSecret) {
        json(response, 401, { error: 'invalid_client' });
        return;
      }
      json(response, 200, issue(params.get('scope') ?? ''));
      return;
    }
    json(response, 400, { error: 'unsupported_grant_type' });
  };

  const handleMcp = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== 'POST') {
      response.writeHead(request.method === 'DELETE' ? 200 : 405).end();
      return;
    }
    const body = await readBody(request);
    const bearer = request.headers.authorization?.replace(/^Bearer /, '');
    state.mcpBearers.push(bearer);
    const token = state.issued.slice(revoked).find((t) => t.accessToken === bearer);
    const resourceMetadata = `${origin}/.well-known/oauth-protected-resource/mcp`;
    if (!token) {
      response.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${resourceMetadata}"` });
      response.end('Unauthorized');
      return;
    }
    if (options.requiredScope && !token.scope.split(/\s+/).includes(options.requiredScope)) {
      response.writeHead(403, {
        'www-authenticate': `Bearer error="insufficient_scope", scope="${options.requiredScope}", resource_metadata="${resourceMetadata}"`,
      });
      response.end('Forbidden');
      return;
    }
    const message = JSON.parse(body) as { id?: string | number; method?: string };
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const result =
      message.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'oauth-fake', version: '1.0.0' } }
        : message.method === 'tools/list'
          ? { tools: [{ name: 'whoami', inputSchema: { type: 'object' } }] }
          : {};
    json(response, 200, { jsonrpc: '2.0', id: message.id, result });
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', origin);
    state.requestPaths.push(url.pathname);
    if (options.stalledPaths?.includes(url.pathname)) return;
    if (url.pathname.startsWith('/.well-known/') || url.pathname === '/custom/as-metadata') {
      state.metadataRequests.push(url.pathname);
      const delay = options.metadataDelayMs?.(url.pathname) ?? 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      if (url.pathname === '/custom/as-metadata') {
        json(response, 200, metadata('/custom'));
        return;
      }
      if (!discoverable) {
        response.writeHead(404).end();
        return;
      }
      if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
        json(response, 200, {
          resource: `${origin}/mcp`,
          authorization_servers: options.authorizationServers ? options.authorizationServers(origin) : [origin],
          ...(options.scopesSupported ? { scopes_supported: options.scopesSupported } : {}),
        });
        return;
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        json(response, 200, metadata());
        return;
      }
      response.writeHead(404).end();
      return;
    }
    const endpoint = url.pathname.replace(/^\/custom(?=\/)/, '');
    if (endpoint === '/register' && request.method === 'POST') {
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      state.registrations.push(body);
      json(response, 201, { ...body, client_id: `dcr-client-${state.registrations.length}` });
      return;
    }
    if (endpoint === '/revoke' && request.method === 'POST') {
      state.revocations.push({ path: url.pathname, params: new URLSearchParams(await readBody(request)) });
      if (options.endlessRevocationBody) {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.write('revoked');
        response.once('close', () => revocationBodyClosed());
        return;
      }
      response.writeHead(200).end();
      return;
    }
    if (endpoint === '/authorize') {
      state.authorizeRequests.push(url);
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      counter += 1;
      const code = `code-${counter}`;
      codes.set(code, {
        challenge: url.searchParams.get('code_challenge') ?? '',
        scope: url.searchParams.get('scope') ?? '',
        redirectUri,
      });
      const redirect = new URL(redirectUri);
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', url.searchParams.get('state') ?? '');
      const iss = options.callbackIss ? options.callbackIss(origin) : metadata().issuer;
      if (iss !== null) redirect.searchParams.set('iss', iss);
      response.writeHead(302, { location: redirect.href }).end();
      return;
    }
    if (endpoint === '/token' && request.method === 'POST') {
      await handleToken(url.pathname, request, response);
      return;
    }
    if (url.pathname === '/mcp') {
      await handleMcp(request, response);
      return;
    }
    response.writeHead(404).end();
  };

  const server: Server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      response.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake OAuth server did not bind to TCP');
  origin = `http://127.0.0.1:${address.port}`;

  return {
    ...state,
    origin,
    mcpUrl: `${origin}/mcp`,
    customMetadataUrl: `${origin}/custom/as-metadata`,
    revokeAccessTokens: () => {
      revoked = state.issued.length;
    },
    approve: async (authorizationUrl) => {
      const answer = await fetch(authorizationUrl, { redirect: 'manual' });
      const location = answer.headers.get('location');
      if (answer.status !== 302 || !location) throw new Error(`authorize answered ${answer.status}`);
      return new URL(location);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
