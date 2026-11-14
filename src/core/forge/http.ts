import { FetchRefusedError, guardedFetch, readBodyCapped, type GuardedFetch } from '../pi-session/web-access/safe-fetch';
import { FORGE_AVATAR_MAX_BYTES } from '../../shared/forge/accounts';
import { ForgeHttpError, type ForgeServer } from './types';

// The forge HTTP client (docs/invariants.md "GitHub and GitLab accounts", network rules). It uses core's global fetch, which
// carries the proxy dispatcher and the OS CA store. A credential goes only to the server's own origins; any other origin
// is reached without one, through the SSRF guard's fetch. Logs carry the method, server id, path template, status and duration,
// and the host of a failed hop that is not the server's.

/** The REST API version the code is tested against (GitHub's "API versions" page, checked 2026-11-09). */
export const GITHUB_API_VERSION = '2026-03-10';
/** The version GitHub answers a request without X-GitHub-Api-Version as, and the only one a GHES before 3.9 speaks. */
export const GITHUB_DEFAULT_API_VERSION = '2022-11-28';
/** Every version Damocles speaks, newest first; a GHES server uses the newest it also lists in GET /versions. */
export const GITHUB_API_VERSIONS: readonly string[] = [GITHUB_API_VERSION, GITHUB_DEFAULT_API_VERSION];

export const REQUEST_TIMEOUT_MS: number = 25_000;
export const MAX_JSON_BYTES: number = 8 * 1024 * 1024;
export const MAX_AVATAR_BYTES: number = FORGE_AVATAR_MAX_BYTES;
export const MAX_REDIRECTS = 5;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const DEFAULT_RETRY_MS = 60_000;
const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60 * 60_000;
// a reset value at or above this is epoch seconds (September 2001), below it seconds from now
const EPOCH_RESET_MIN = 1e9;
const SSO_HEADER = /^required;\s*url=(\S+)/i;
// GitHub's 403 body for an org with OAuth app access restrictions
const APP_RESTRICTED = /OAuth App access restrictions/i;
// statuses whose body says why the server refused the request (a validation failure, a conflict)
const REFUSAL_STATUSES: ReadonlySet<number> = new Set([400, 409, 422]);
// the web origin's OAuth endpoints: GitHub's /login/oauth and /login/device, GitLab's /oauth (under its path prefix)
const OAUTH_PATHS: readonly string[] = ['/login/oauth/', '/login/device/', '/oauth/'];
const TLS_CODES: ReadonlySet<string> = new Set([
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_SIGNATURE_FAILURE', 'CERT_REVOKED',
]);
// failures before any answer that a new connection may not meet again: undici's RetryHandler defaults (lib/handler/retry-handler.js),
// a socket timeout (a connect or a stale keep-alive), DNS's try-again, Windows' aborted connection, and a TLS message that did not parse
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ENETDOWN', 'ENETUNREACH', 'EHOSTDOWN', 'EHOSTUNREACH', 'EPIPE', 'UND_ERR_SOCKET',
  'ETIMEDOUT', 'EAI_AGAIN', 'ECONNABORTED', 'ERR_SSL_DECODE_ERROR', 'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
]);
/** Retries of a GET hop that failed with a TRANSIENT_CODES error, all within the request's REQUEST_TIMEOUT_MS. */
export const MAX_TRANSIENT_RETRIES = 2;
// retry n waits a random time below RETRY_BASE_MS * 2^(n-1) ("full jitter")
const RETRY_BASE_MS = 500;
// the longest DNS name in text form (RFC 1035); a foreignHost is cut to it, plus its port
const MAX_HOST_CHARS = 253;

export interface ForgeHttpDeps {
  readonly fetch: typeof fetch;
  /** "Damocles/<version>"; GitHub refuses a request without a User-Agent. */
  readonly userAgent: string;
  readonly log: (line: string) => void;
  /** Reaches any origin but the server's own; safe-fetch.ts's guardedFetch, which connects only to public addresses, by default. */
  readonly publicFetch?: GuardedFetch;
  readonly now?: () => number;
  /** The retry wait's random source, in [0, 1); Math.random by default. */
  readonly random?: () => number;
}

export type ForgeCredential = { readonly bearer: string } | { readonly basic: { readonly user: string; readonly password: string } };

export interface ForgeRequest {
  readonly server: ForgeServer;
  readonly method?: 'GET' | 'POST' | 'DELETE';
  /** An absolute URL, or a path below the server's API base. */
  readonly url: string;
  /** What the log names instead of the URL, such as "/user" or "/orgs/{org}/members". */
  readonly template: string;
  readonly credential?: ForgeCredential;
  readonly form?: Readonly<Record<string, string>>;
  readonly json?: unknown;
  readonly etag?: string;
  /** tail: the body's last maxBytes bytes and its whole length (ForgeTail), read without holding more. */
  readonly as?: 'json' | 'bytes' | 'tail' | 'none';
  readonly maxBytes?: number;
  /**
   * Statuses answered with their body instead of an error, such as an OAuth endpoint's 400. A 403 among them still throws
   * when it is a rate limit, an SSO refusal or an OAuth app restriction.
   */
  readonly acceptStatuses?: readonly number[];
  readonly signal?: AbortSignal;
}

export interface ForgeResponse {
  readonly status: number;
  readonly headers: Headers;
  /** The parsed JSON, the bytes for `as: 'bytes'`, a ForgeTail for `as: 'tail'`; undefined for a 304 or `as: 'none'`. */
  readonly body: unknown;
  readonly etag?: string;
  readonly notModified: boolean;
}

/** A body read as its tail: at most maxBytes of its end, and how long it was. */
export interface ForgeTail {
  readonly bytes: Uint8Array;
  readonly totalBytes: number;
}

export interface ForgeHttp {
  request(request: ForgeRequest): Promise<ForgeResponse>;
  /**
   * Backs off the request's rate limit after an answer that reported one with a success status (GitHub GraphQL's
   * RATE_LIMITED error), as a 429 would; answers when a retry may go (epoch ms).
   */
  noteRateLimit(server: ForgeServer, template: string, headers: Headers): number;
}

function clampedRetryAt(now: number, waitMs: number): number {
  return now + Math.min(Math.max(waitMs, MIN_RETRY_MS), MAX_RETRY_MS);
}

function retryAtOf(headers: Headers, now: number): number | undefined {
  const retryAfter = headers.get('retry-after')?.trim();
  if (retryAfter !== undefined && /^\d{1,9}$/.test(retryAfter)) return clampedRetryAt(now, Number(retryAfter) * 1000);
  // an epoch reset is read against the server's own clock, so this computer's clock skew drops out
  const date = Date.parse(headers.get('date') ?? '');
  const serverNow = Number.isFinite(date) ? date : now;
  for (const name of ['x-ratelimit-reset', 'ratelimit-reset']) {
    const reset = headers.get(name)?.trim();
    if (reset !== undefined && /^\d{1,12}$/.test(reset)) {
      const value = Number(reset);
      return clampedRetryAt(now, value >= EPOCH_RESET_MIN ? value * 1000 - serverNow : value * 1000);
    }
  }
  return undefined;
}

function rateLimited(status: number, headers: Headers): boolean {
  if (status === 429) return true;
  return status === 403 && (headers.get('x-ratelimit-remaining') === '0' || headers.get('retry-after') !== null);
}

function errorCodeOf(err: unknown): string | undefined {
  for (let current: unknown = err, depth = 0; current instanceof Error && depth < 4; current = current.cause, depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** Whether the SSRF guard refused the connection: its refusal anywhere in the cause chain. */
function refusedByGuard(err: unknown): boolean {
  for (let current: unknown = err, depth = 0; current instanceof Error && depth < 4; current = current.cause, depth++) {
    if (current instanceof FetchRefusedError) return true;
  }
  return false;
}

/** The host and port of url as a foreignHost names them. */
function hostOf(url: URL): string {
  return `${url.hostname.slice(0, MAX_HOST_CHARS)}${url.port !== '' ? `:${url.port}` : ''}`;
}

/**
 * The rate limit a request counts against: GitHub keeps search and GraphQL apart from its core limit (x-ratelimit-resource),
 * so a limited search refuses only searches, and the web origin's OAuth endpoints are limited apart from the API.
 */
function limitOf(server: ForgeServer, template: string, oauth: boolean, headers?: Headers): string {
  if (oauth) return `${server.id}|oauth`;
  const named = headers?.get('x-ratelimit-resource');
  const resource = named !== null && named !== undefined && /^[a-z_]{1,40}$/.test(named) ? named : template.startsWith('/search/') ? 'search' : template.startsWith('/api/graphql') ? 'graphql' : 'core';
  return `${server.id}|${resource}`;
}

/** The same origin, as the server's own origins are written. */
function originOf(url: URL): string {
  return url.origin;
}

function isOAuthEndpoint(server: ForgeServer, url: URL): boolean {
  return OAUTH_PATHS.some((path) => url.href.startsWith(`${server.webUrl}${path}`));
}

/** The X-GitHub-Api-Version a GitHub server's API origin gets; none for a GHES server before its version is recorded. */
function githubApiVersion(server: ForgeServer): string | undefined {
  return server.flavor === 'ghes' ? server.record.apiVersion : GITHUB_API_VERSION;
}

/** Waits ms; false when signal aborts first. */
function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const settle = (waited: boolean): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      resolve(waited);
    };
    const aborted = (): void => settle(false);
    const timer = setTimeout(() => settle(true), ms);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

/** Ends an unread body, which otherwise holds its connection until it is collected; a cancel that fails leaves nothing to end. */
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** An error answer's body as text, at most MAX_ERROR_BODY_BYTES; empty when it is longer or breaks off. */
async function errorBodyText(response: Response): Promise<string> {
  return new TextDecoder().decode(await readBodyCapped(response, MAX_ERROR_BODY_BYTES).catch(() => new Uint8Array(0)));
}

/** The JSON value of text, or undefined for text that is not JSON. */
function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Why a server refused a request: GitHub's message and each errors[].message, GitLab's message as text or per field. */
function refusalText(body: unknown): string | undefined {
  const parts: string[] = [];
  const message = field(body, 'message');
  if (typeof message === 'string') parts.push(message);
  else if (typeof message === 'object' && message !== null && !Array.isArray(message)) {
    for (const [key, value] of Object.entries(message as Record<string, unknown>)) {
      const words = (Array.isArray(value) ? value : [value]).filter((word): word is string => typeof word === 'string');
      if (words.length > 0) parts.push(`${key} ${words.join(', ')}`);
    }
  }
  const errors = field(body, 'errors');
  for (const item of Array.isArray(errors) ? errors : []) {
    const text = typeof item === 'string' ? item : stringField(item, 'message');
    if (text !== undefined && text !== '') parts.push(text);
  }
  return parts.length > 0 ? parts.join('; ') : undefined;
}

/** The host a failure names when the hop that failed is not one of the server's origins; empty for the server's own. */
type Where = { readonly foreignHost?: string };

export function createForgeHttp(deps: ForgeHttpDeps): ForgeHttp {
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const publicFetch = deps.publicFetch ?? guardedFetch;
  // per server and rate limit (limitOf): no request goes before this epoch ms, after a rate-limited answer
  const backoff = new Map<string, number>();

  function noteLimit(server: ForgeServer, template: string, oauth: boolean, headers: Headers): number {
    const retryAt = retryAtOf(headers, now()) ?? now() + DEFAULT_RETRY_MS;
    backoff.set(limitOf(server, template, oauth, headers), retryAt);
    return retryAt;
  }

  /** The refusal the headers alone decide: a rate limit, which starts its backoff, or GitHub's SAML SSO. */
  function headerRefusal(server: ForgeServer, template: string, oauth: boolean, status: number, headers: Headers): ForgeHttpError | undefined {
    if (rateLimited(status, headers)) {
      return new ForgeHttpError('rateLimited', 'The server rate-limited Damocles', { status, retryAt: noteLimit(server, template, oauth, headers) });
    }
    const sso = status === 403 ? SSO_HEADER.exec(headers.get('x-github-sso') ?? '') : null;
    return sso ? new ForgeHttpError('ssoRequired', 'The organization requires SAML SSO authorization', { status, ssoUrl: sso[1]! }) : undefined;
  }

  /** An error answer from one of the server's own origins: its credential, rate limit, SSO and app-policy answers. */
  async function classify(server: ForgeServer, template: string, oauth: boolean, status: number, headers: Headers, response: Response): Promise<ForgeHttpError> {
    const early = status === 401 ? new ForgeHttpError('unauthorized', 'The server refused the credential', { status }) : headerRefusal(server, template, oauth, status, headers);
    if (early) {
      await discard(response);
      return early;
    }
    if (status === 403) {
      if (APP_RESTRICTED.test(await errorBodyText(response))) return new ForgeHttpError('appNotApproved', 'The organization has not approved the OAuth app', { status });
      return new ForgeHttpError('forbidden', 'The server refused the request', { status });
    }
    if (REFUSAL_STATUSES.has(status)) {
      const serverText = refusalText(parsedJson(await errorBodyText(response)));
      return new ForgeHttpError('refused', `The server refused the request (HTTP ${status})`, { status, ...(serverText !== undefined ? { serverText } : {}) });
    }
    await discard(response);
    if (status === 404) return new ForgeHttpError('notFound', 'The server has no such resource', { status });
    return new ForgeHttpError('server', `The server answered HTTP ${status}`, { status });
  }

  /**
   * An error answer from a host that is not the server's, which got no credential: no status of it says anything about the
   * account or the server's own rate limit, so 401 and 403 are forbidden, 404 notFound, and every other status server.
   */
  async function classifyForeign(status: number, response: Response, where: Where): Promise<ForgeHttpError> {
    await discard(response);
    if (status === 401 || status === 403) return new ForgeHttpError('forbidden', `The host refused the request (HTTP ${status})`, { status, ...where });
    if (status === 404) return new ForgeHttpError('notFound', 'The host has no such resource', { status, ...where });
    return new ForgeHttpError('server', `The host answered HTTP ${status}`, { status, ...where });
  }

  async function request(req: ForgeRequest): Promise<ForgeResponse> {
    const { server } = req;
    const method = req.method ?? 'GET';
    const start = now();
    let url = new URL(/^https:\/\//i.test(req.url) ? req.url : `${server.apiUrl}${req.url}`);
    const oauth = isOAuthEndpoint(server, url);
    const blockedUntil = backoff.get(limitOf(server, req.template, oauth));
    if (blockedUntil !== undefined && blockedUntil > start) {
      throw new ForgeHttpError('rateLimited', 'The server rate-limited Damocles', { retryAt: blockedUntil });
    }
    if (req.credential && !server.origins.has(originOf(url))) {
      throw new Error(`Refused to send a ${server.id} credential to another origin`);
    }
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    let body: string | undefined;
    const baseHeaders: Record<string, string> = { 'User-Agent': deps.userAgent };
    if (req.form) {
      body = new URLSearchParams(req.form).toString();
      baseHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (req.json !== undefined) {
      body = JSON.stringify(req.json);
      baseHeaders['Content-Type'] = 'application/json';
    }
    // GitHub's OAuth endpoints answer JSON only for exactly application/json
    if (req.as !== 'bytes' && req.as !== 'tail') baseHeaders['Accept'] = server.kind === 'github' && !oauth ? 'application/vnd.github+json, application/json' : 'application/json';
    if (req.etag !== undefined) baseHeaders['If-None-Match'] = req.etag;
    const apiVersion = server.kind === 'github' ? githubApiVersion(server) : undefined;
    const apiOrigin = originOf(new URL(server.apiUrl));
    let response: Response;
    // once a hop leaves the server's origins, no later hop of the chain gets the credential, even back on them
    let trusted = true;
    let where: Where = {};
    for (let hop = 0; ; hop++) {
      const own = server.origins.has(originOf(url));
      trusted &&= own;
      where = own ? {} : { foreignHost: hostOf(url) };
      const headers: Record<string, string> = { ...baseHeaders };
      if (trusted && req.credential) {
        headers['Authorization'] = 'bearer' in req.credential
          ? `Bearer ${req.credential.bearer}`
          : `Basic ${Buffer.from(`${req.credential.basic.user}:${req.credential.basic.password}`).toString('base64')}`;
      }
      if (trusted && apiVersion !== undefined && originOf(url) === apiOrigin) headers['X-GitHub-Api-Version'] = apiVersion;
      const send: GuardedFetch = own ? deps.fetch : publicFetch;
      const at = where.foreignHost !== undefined ? ` at ${where.foreignHost}` : '';
      for (let attempt = 1; ; attempt++) {
        try {
          response = await send(url.href, { method, headers, ...(body !== undefined ? { body } : {}), redirect: 'manual', signal });
          break;
        } catch (err) {
          const code = errorCodeOf(err);
          const kind = code !== undefined && TLS_CODES.has(code) ? 'tls' : 'network';
          // only a safe method is retried (RFC 9110 9.2.1), since a request that failed before its answer may still have reached the server
          if (method === 'GET' && attempt <= MAX_TRANSIENT_RETRIES && code !== undefined && TRANSIENT_CODES.has(code) && !signal.aborted) {
            const wait = Math.floor(random() * RETRY_BASE_MS * 2 ** (attempt - 1));
            deps.log(`[forge] ${method} ${server.id} ${req.template} failed${at}: ${kind} (${code}) after ${now() - start} ms, retry ${attempt} of ${MAX_TRANSIENT_RETRIES} in ${wait} ms`);
            if (await pause(wait, signal)) continue;
          }
          deps.log(`[forge] ${method} ${server.id} ${req.template} failed${at}: ${kind}${code !== undefined ? ` (${code})` : ''} after ${now() - start} ms`);
          if (req.signal?.aborted) throw req.signal.reason;
          throw new ForgeHttpError(kind, kind === 'tls' ? 'The server certificate was refused' : 'Could not reach the server', { cause: err, ...where, ...(!own && refusedByGuard(err) ? { privateAddress: true as const } : {}) });
        }
      }
      const location = response.headers.get('location');
      if (response.status < 300 || response.status >= 400 || location === null || response.status === 304) break;
      await discard(response);
      if (method !== 'GET' || hop >= MAX_REDIRECTS || !URL.canParse(location, url.href)) {
        deps.log(`[forge] ${method} ${server.id} ${req.template} ${response.status}: redirect not followed`);
        throw new ForgeHttpError('server', `The server answered HTTP ${response.status}`, { status: response.status, ...where });
      }
      const next = new URL(location, url);
      if (next.protocol !== 'https:') throw new ForgeHttpError('server', 'The server redirected to a non-https address', { status: response.status, ...where });
      url = next;
    }
    const { status, headers } = response;
    deps.log(`[forge] ${method} ${server.id} ${req.template} ${status} ${now() - start} ms`);
    if (status === 304) return { status, headers, body: undefined, notModified: true, ...(req.etag !== undefined ? { etag: req.etag } : {}) };
    const foreign = where.foreignHost !== undefined;
    if (status >= 400 && !(req.acceptStatuses ?? []).includes(status)) throw foreign ? await classifyForeign(status, response, where) : await classify(server, req.template, oauth, status, headers, response);
    const accepted403 = status === 403 && !foreign ? headerRefusal(server, req.template, oauth, status, headers) : undefined;
    if (accepted403) {
      await discard(response);
      throw accepted403;
    }
    if (status >= 300 && status < 400) {
      await discard(response);
      throw new ForgeHttpError('server', `The server answered HTTP ${status}`, { status, ...where });
    }
    const etag = headers.get('etag') ?? undefined;
    const base = { status, headers, notModified: false, ...(etag !== undefined ? { etag } : {}) };
    if (req.as === 'none') {
      await discard(response);
      return { ...base, body: undefined };
    }
    if (req.as === 'tail') {
      try {
        return { ...base, body: await readTail(response, req.maxBytes ?? MAX_JSON_BYTES) };
      } catch (err) {
        if (req.signal?.aborted) throw err;
        throw new ForgeHttpError('server', 'The server answer broke off', { status, cause: err, ...where });
      }
    }
    let bytes: Uint8Array;
    try {
      bytes = await readBodyCapped(response, req.maxBytes ?? (req.as === 'bytes' ? MAX_AVATAR_BYTES : MAX_JSON_BYTES));
    } catch (err) {
      if (req.signal?.aborted) throw err;
      throw new ForgeHttpError('server', 'The server answer was too large or broke off', { status, cause: err, ...where });
    }
    if (status === 403 && !foreign && APP_RESTRICTED.test(new TextDecoder().decode(bytes))) throw new ForgeHttpError('appNotApproved', 'The organization has not approved the OAuth app', { status });
    if (req.as === 'bytes') return { ...base, body: bytes };
    if (bytes.byteLength === 0) return { ...base, body: undefined };
    try {
      return { ...base, body: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
    } catch (err) {
      throw new ForgeHttpError('server', 'The server answer was not JSON', { status, cause: err, ...where });
    }
  }

  return {
    request,
    noteRateLimit: (server, template, headers) => noteLimit(server, template, false, headers),
  };
}

/** The last maxBytes bytes of a body of any length; memory stays within maxBytes plus one chunk. */
export async function readTail(response: Response, maxBytes: number): Promise<ForgeTail> {
  const body = response.body;
  if (!body) return { bytes: new Uint8Array(0), totalBytes: 0 };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    total += value.byteLength;
    chunks.push(value);
    kept += value.byteLength;
    while (kept - chunks[0]!.byteLength >= maxBytes) kept -= chunks.shift()!.byteLength;
  }
  const bytes = new Uint8Array(Math.min(kept, maxBytes));
  let at = bytes.byteLength;
  for (let index = chunks.length - 1; index >= 0 && at > 0; index--) {
    const chunk = chunks[index]!;
    const take = Math.min(chunk.byteLength, at);
    bytes.set(chunk.subarray(chunk.byteLength - take), at - take);
    at -= take;
  }
  return { bytes, totalBytes: total };
}

/** A field of a JSON object answer, or undefined. */
export function field(body: unknown, name: string): unknown {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>)[name] : undefined;
}

export function stringField(body: unknown, name: string): string | undefined {
  const value = field(body, name);
  return typeof value === 'string' ? value : undefined;
}

export function numberField(body: unknown, name: string): number | undefined {
  const value = field(body, name);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
