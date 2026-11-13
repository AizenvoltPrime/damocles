import { field, stringField, type ForgeHttp } from '../../http';
import { ForgeHttpError, type ForgeServer } from '../../types';

// GitHub's GraphQL API answers a rate limit and a missing object as HTTP 200 with typed errors, which these read.

/** GitHub's GraphQL endpoint: api.github.com/graphql, a GHES server's /api/graphql. */
export function githubGraphqlUrl(server: ForgeServer): string {
  return server.apiUrl.endsWith('/api/v3') ? `${server.apiUrl.slice(0, -'/v3'.length)}/graphql` : `${server.apiUrl}/graphql`;
}

export interface GraphqlAnswer {
  /** The answer's data; null or undefined when it has none. */
  readonly data: unknown;
  readonly errors: readonly unknown[];
  /** The authorization page an organization's SAML SSO named in the x-github-sso header. */
  readonly ssoUrl?: string;
}

const errorTyped = (errors: readonly unknown[], type: string): boolean => errors.some((error) => stringField(error, 'type') === type);
const SSO_HEADER = /^required;\s*url=(\S+)/i;
// GitHub's FORBIDDEN messages for an organization's SAML SSO and its OAuth app access restrictions
const SAML_ENFORCED = /SAML enforcement/i;
const APP_RESTRICTED = /OAuth App access restrictions/i;

/** POSTs a query; an error of type RATE_LIMITED backs off the server's graphql limit in http.ts and throws rateLimited. */
export async function githubGraphql(http: ForgeHttp, server: ForgeServer, token: string, what: string, query: string, variables: Record<string, unknown>, signal: AbortSignal): Promise<GraphqlAnswer> {
  const template = `/api/graphql ${what}`;
  const response = await http.request({ server, method: 'POST', url: githubGraphqlUrl(server), template, credential: { bearer: token }, json: { query, variables }, signal });
  const errors = field(response.body, 'errors');
  const listed = Array.isArray(errors) ? errors : [];
  if (errorTyped(listed, 'RATE_LIMITED')) {
    throw new ForgeHttpError('rateLimited', 'The server rate-limited Damocles', { status: response.status, retryAt: http.noteRateLimit(server, template, response.headers) });
  }
  const ssoUrl = SSO_HEADER.exec(response.headers.get('x-github-sso') ?? '')?.[1];
  return { data: field(response.body, 'data'), errors: listed, ...(ssoUrl !== undefined ? { ssoUrl } : {}) };
}

/**
 * The error for an answer without the object asked for: an organization's SAML SSO (ssoUrl: the answer's) or OAuth app
 * policy when a FORBIDDEN error says so, notFound when an error is of type NOT_FOUND, else server.
 */
export function graphqlFailure(errors: readonly unknown[], message: string, ssoUrl?: string): ForgeHttpError {
  const forbidden = errors.filter((error) => stringField(error, 'type') === 'FORBIDDEN').map((error) => stringField(error, 'message') ?? '');
  if (ssoUrl !== undefined || forbidden.some((text) => SAML_ENFORCED.test(text))) {
    return new ForgeHttpError('ssoRequired', 'The organization requires SAML SSO authorization', ssoUrl !== undefined ? { ssoUrl } : {});
  }
  if (forbidden.some((text) => APP_RESTRICTED.test(text))) return new ForgeHttpError('appNotApproved', 'The organization has not approved the OAuth app');
  return new ForgeHttpError(errorTyped(errors, 'NOT_FOUND') ? 'notFound' : 'server', message);
}
