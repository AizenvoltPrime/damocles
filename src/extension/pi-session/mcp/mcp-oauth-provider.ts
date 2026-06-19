/*
 * Adapted from pi-mcp-adapter (MIT). Copyright (c) 2026 Nico Bailon. See THIRD-PARTY-NOTICES.md.
 * Implementation of the MCP SDK `OAuthClientProvider` interface: dynamic-registration metadata,
 * token/client-info/PKCE/state persistence, and authorization redirection. SDK value classes
 * (`UnauthorizedError`) are obtained from the dynamically-imported bundle (the SDK is esbuild-external).
 */
import type {
  AddClientAuthentication,
  OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientMetadata,
  OAuthTokens,
  OAuthClientInformation,
  OAuthClientInformationFull,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { McpOAuthConfig } from '../../../shared/types/mcp';
import type { McpSdkBundle } from './mcp-sdk-loader';
import { getOAuthCallbackPath, getOAuthCallbackPort } from './mcp-callback-server';
import {
  getAuthForUrl,
  updateTokens,
  updateClientInfo,
  updateCodeVerifier,
  updateOAuthState,
  clearAllCredentials,
  clearClientInfo,
  clearTokens,
  type StoredTokens,
  type StoredClientInfo,
} from './mcp-auth';

const DEFAULT_CLIENT_NAME = 'Damocles';
const DEFAULT_CLIENT_URI = 'https://github.com/AizenvoltPrime/damocles';

/** Callbacks for OAuth flow interactions (browser redirect handoff). */
export interface McpOAuthCallbacks {
  onRedirect: (url: URL) => void | Promise<void>;
}

/**
 * OAuth provider for a single MCP server, implementing the MCP SDK `OAuthClientProvider` interface.
 * Constructed per server URL; the SDK drives it through `auth()` / transport `finishAuth()`.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  private readonly sdk: McpSdkBundle;
  private readonly serverName: string;
  private readonly serverUrl: string;
  private readonly config: McpOAuthConfig;
  private readonly callbacks: McpOAuthCallbacks;
  private readonly redirectUrlSnapshot: string | undefined;

  constructor(
    sdk: McpSdkBundle,
    serverName: string,
    serverUrl: string,
    config: McpOAuthConfig,
    callbacks: McpOAuthCallbacks,
  ) {
    this.sdk = sdk;
    this.serverName = serverName;
    this.serverUrl = serverUrl;
    this.config = config;
    this.callbacks = callbacks;
    this.redirectUrlSnapshot =
      config.grantType === 'client_credentials'
        ? undefined
        : (config.redirectUri ?? `http://127.0.0.1:${getOAuthCallbackPort()}${getOAuthCallbackPath()}`);
  }

  private get usesClientCredentials(): boolean {
    return this.config.grantType === 'client_credentials';
  }

  /** The redirect URL for OAuth callbacks; must match the redirect_uri in client metadata. */
  get redirectUrl(): string | undefined {
    return this.redirectUrlSnapshot;
  }

  /** Client metadata for dynamic registration (describes this client to the auth server). */
  get clientMetadata(): OAuthClientMetadata {
    if (this.usesClientCredentials) {
      return {
        client_name: this.config.clientName ?? DEFAULT_CLIENT_NAME,
        client_uri: this.config.clientUri ?? DEFAULT_CLIENT_URI,
        redirect_uris: [],
        grant_types: ['client_credentials'],
        token_endpoint_auth_method: this.config.clientSecret ? 'client_secret_post' : 'none',
      };
    }

    const redirectUrl = this.redirectUrl;
    if (!redirectUrl) {
      throw new Error('redirectUrl is required for authorization_code flow');
    }

    const metadata: OAuthClientMetadata = {
      redirect_uris: [redirectUrl],
      client_name: this.config.clientName ?? DEFAULT_CLIENT_NAME,
      client_uri: this.config.clientUri ?? DEFAULT_CLIENT_URI,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.config.clientSecret ? 'client_secret_post' : 'none',
    };
    if (this.config.scope !== undefined) metadata.scope = this.config.scope;
    return metadata;
  }

  /** Pre-registered (config) or dynamically registered client info; undefined triggers registration. */
  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    if (this.config.clientId) {
      const info: OAuthClientInformation = { client_id: this.config.clientId };
      if (this.config.clientSecret !== undefined) info.client_secret = this.config.clientSecret;
      return info;
    }

    const entry = await getAuthForUrl(this.serverName, this.serverUrl);
    if (entry?.clientInfo) {
      if (
        entry.clientInfo.clientSecretExpiresAt &&
        entry.clientInfo.clientSecretExpiresAt < Date.now() / 1000
      ) {
        return undefined;
      }
      const info: OAuthClientInformation = { client_id: entry.clientInfo.clientId };
      if (entry.clientInfo.clientSecret !== undefined) info.client_secret = entry.clientInfo.clientSecret;
      return info;
    }

    return undefined;
  }

  /** Persist client info from dynamic registration. */
  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    const redirectUris = info.redirect_uris ?? (this.redirectUrl ? [this.redirectUrl] : undefined);
    const clientInfo: StoredClientInfo = { clientId: info.client_id };
    if (info.client_secret !== undefined) clientInfo.clientSecret = info.client_secret;
    if (info.client_id_issued_at !== undefined) clientInfo.clientIdIssuedAt = info.client_id_issued_at;
    if (info.client_secret_expires_at !== undefined) {
      clientInfo.clientSecretExpiresAt = info.client_secret_expires_at;
    }
    if (redirectUris !== undefined) clientInfo.redirectUris = redirectUris;
    await updateClientInfo(this.serverName, clientInfo, this.serverUrl);
  }

  /** Stored OAuth tokens for the current server URL, or undefined when none/URL changed. */
  async tokens(): Promise<OAuthTokens | undefined> {
    const entry = await getAuthForUrl(this.serverName, this.serverUrl);
    if (!entry?.tokens) return undefined;

    const result: OAuthTokens = {
      access_token: entry.tokens.accessToken,
      token_type: 'Bearer',
    };
    if (entry.tokens.refreshToken !== undefined) result.refresh_token = entry.tokens.refreshToken;
    if (entry.tokens.expiresAt !== undefined) {
      result.expires_in = Math.max(0, Math.floor(entry.tokens.expiresAt - Date.now() / 1000));
    }
    if (entry.tokens.scope !== undefined) result.scope = entry.tokens.scope;
    return result;
  }

  /** Persist OAuth tokens (converting `expires_in` to an absolute expiry). */
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const storedTokens: StoredTokens = { accessToken: tokens.access_token };
    if (tokens.refresh_token !== undefined) storedTokens.refreshToken = tokens.refresh_token;
    if (tokens.expires_in !== undefined) storedTokens.expiresAt = Date.now() / 1000 + tokens.expires_in;
    if (tokens.scope !== undefined) storedTokens.scope = tokens.scope;
    await updateTokens(this.serverName, storedTokens, this.serverUrl);
  }

  /**
   * Redirect the user to the authorization URL (hands the URL to `onRedirect`). Throws
   * `UnauthorizedError` when called with no saved state — the post-refresh authorize fallback
   * a library host cannot complete in-process.
   */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (this.usesClientCredentials) {
      throw new Error('redirectToAuthorization is not used for client_credentials flow');
    }
    const entry = await getAuthForUrl(this.serverName, this.serverUrl);
    if (!entry?.oauthState) {
      throw new this.sdk.auth.UnauthorizedError(
        `Re-authentication required for MCP server: ${this.serverName}`,
      );
    }
    await this.callbacks.onRedirect(authorizationUrl);
  }

  /** Persist the PKCE code verifier. */
  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await updateCodeVerifier(this.serverName, codeVerifier, this.serverUrl);
  }

  /** The stored PKCE code verifier (throws when absent). */
  async codeVerifier(): Promise<string> {
    if (this.usesClientCredentials) {
      throw new Error('codeVerifier is not used for client_credentials flow');
    }
    const entry = await getAuthForUrl(this.serverName, this.serverUrl);
    if (!entry?.codeVerifier) {
      throw new Error(`No code verifier saved for MCP server: ${this.serverName}`);
    }
    return entry.codeVerifier;
  }

  /** Persist the CSRF state parameter. */
  async saveState(state: string): Promise<void> {
    await updateOAuthState(this.serverName, state, this.serverUrl);
  }

  /** The stored CSRF state (throws `UnauthorizedError` when no flow is in progress). */
  async state(): Promise<string> {
    if (this.usesClientCredentials) {
      throw new Error('state is not used for client_credentials flow');
    }
    const entry = await getAuthForUrl(this.serverName, this.serverUrl);
    if (!entry?.oauthState) {
      throw new this.sdk.auth.UnauthorizedError(
        `Re-authentication required for MCP server: ${this.serverName}`,
      );
    }
    return entry.oauthState;
  }

  /** Invalidate credentials when authentication fails. */
  async invalidateCredentials(type: 'all' | 'client' | 'tokens'): Promise<void> {
    switch (type) {
      case 'all':
        await clearAllCredentials(this.serverName);
        break;
      case 'client':
        await clearClientInfo(this.serverName);
        break;
      case 'tokens':
        await clearTokens(this.serverName);
        break;
    }
  }

  /** Apply the configured scope and the negotiated token-endpoint auth method to token requests. */
  addClientAuthentication: AddClientAuthentication = async (headers, params, _url, metadata) => {
    if (params.get('grant_type') === 'authorization_code' && !params.has('scope') && this.config.scope) {
      params.set('scope', this.config.scope);
    }

    const clientInfo = await this.clientInformation();
    if (!clientInfo) {
      return;
    }

    const supportedMethods = metadata?.token_endpoint_auth_methods_supported ?? [];
    const hasClientSecret = clientInfo.client_secret !== undefined;
    let authMethod: 'client_secret_basic' | 'client_secret_post' | 'none';

    if (supportedMethods.length === 0) {
      authMethod = hasClientSecret ? 'client_secret_post' : 'none';
    } else if (hasClientSecret && supportedMethods.includes('client_secret_basic')) {
      authMethod = 'client_secret_basic';
    } else if (hasClientSecret && supportedMethods.includes('client_secret_post')) {
      authMethod = 'client_secret_post';
    } else if (supportedMethods.includes('none')) {
      authMethod = 'none';
    } else {
      authMethod = hasClientSecret ? 'client_secret_post' : 'none';
    }

    if (authMethod === 'client_secret_basic') {
      if (!clientInfo.client_secret) {
        throw new Error('client_secret_basic authentication requires a client_secret');
      }
      // RFC 6749 §2.3.1: client_id and client_secret are form-urlencoded before the colon-join + base64,
      // so a secret containing ':' or non-ASCII does not malform the Basic credentials.
      const basic = Buffer.from(
        `${encodeURIComponent(clientInfo.client_id)}:${encodeURIComponent(clientInfo.client_secret)}`,
      ).toString('base64');
      headers.set('Authorization', `Basic ${basic}`);
      return;
    }

    if (!params.has('client_id')) {
      params.set('client_id', clientInfo.client_id);
    }
    if (authMethod === 'client_secret_post' && clientInfo.client_secret && !params.has('client_secret')) {
      params.set('client_secret', clientInfo.client_secret);
    }
  };

  /** Build the token request body for the client_credentials grant (undefined for other grants). */
  prepareTokenRequest(scope?: string): URLSearchParams | undefined {
    if (!this.usesClientCredentials) {
      return undefined;
    }

    const params = new URLSearchParams({ grant_type: 'client_credentials' });
    const requestedScope = scope ?? this.config.scope;
    if (requestedScope) {
      params.set('scope', requestedScope);
    }
    return params;
  }
}
