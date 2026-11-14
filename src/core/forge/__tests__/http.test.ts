import { afterEach, describe, expect, it, vi } from 'vitest';
import { FetchRefusedError } from '../../pi-session/web-access/safe-fetch';
import { createForgeHttp, GITHUB_API_VERSION, MAX_REDIRECTS, MAX_TRANSIENT_RETRIES, REQUEST_TIMEOUT_MS, type ForgeTail } from '../http';
import { githubGraphql } from '../providers/github/graphql';
import { assignableUsers } from '../providers/github/history';
import { githubBranchProtection } from '../providers/github/protection';
import { githubVersion } from '../providers/github/user';
import { decodeTail, MAX_JOB_LOG_BYTES } from '../tools/api';
import { ForgeHttpError, type ForgeServer, type ServerRecord } from '../types';

// http.ts against a recorded fetch: the own-origin rule, manual redirects, the SSRF guard for other origins, the error kinds,
// the rate limits, and GitHub's GraphQL errors.

function server(record: Partial<ServerRecord> & Pick<ServerRecord, 'kind'>, webUrl: string, apiUrl: string): ForgeServer {
  const full: ServerRecord = { id: new URL(webUrl).host, flavor: record.kind === 'github' ? 'ghes' : 'gitlab', gitHosts: [], addedAt: 0, ...record };
  return { record: full, id: full.id, kind: full.kind, flavor: full.flavor, builtIn: false, webUrl, apiUrl, origins: new Set([new URL(webUrl).origin, new URL(apiUrl).origin]) };
}

const GITHUB = server({ kind: 'github', flavor: 'github.com', id: 'github.com' }, 'https://github.com', 'https://api.github.com');
const GITLAB = server({ kind: 'gitlab' }, 'https://10.1.2.3', 'https://10.1.2.3/api/v4');

interface Sent {
  readonly url: string;
  readonly headers: Record<string, string>;
}

function recorder(answers: ((url: string) => Response)[]) {
  const sent: Sent[] = [];
  const fetch = vi.fn((url: string, init?: RequestInit) => {
    sent.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    const answer = answers.shift();
    if (!answer) throw new Error(`unexpected request to ${url}`);
    return Promise.resolve(answer(url));
  });
  return { sent, fetch: fetch as unknown as typeof globalThis.fetch };
}

const jsonAnswer = (status: number, body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const redirect = (location: string) => () => new Response(null, { status: 302, headers: { location } });

describe('forge http', () => {
  it('sends the token, User-Agent and pinned API version to the server\'s own API origin, and logs no token, query or body', async () => {
    const log = vi.fn();
    const { sent, fetch } = recorder([jsonAnswer(200, { login: 'astefanopoulos' })]);
    const publicFetch = vi.fn((url: string, init: RequestInit) => fetch(url, init));
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/9.9.9', log, publicFetch });
    const response = await http.request({ server: GITHUB, url: '/user?secret_query=1', template: '/user', credential: { bearer: 'gho_secretToken0001' } });
    expect(response.body).toEqual({ login: 'astefanopoulos' });
    expect(sent[0]!.headers['Authorization']).toBe('Bearer gho_secretToken0001');
    expect(sent[0]!.headers['User-Agent']).toBe('Damocles/9.9.9');
    expect(sent[0]!.headers['X-GitHub-Api-Version']).toBe(GITHUB_API_VERSION);
    expect(sent[0]!.headers['Accept']).toBe('application/vnd.github+json, application/json');
    expect(publicFetch).not.toHaveBeenCalled();
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain('GET github.com /user 200');
    expect(logged).not.toContain('gho_secretToken0001');
    expect(logged).not.toContain('secret_query');
  });

  it('refuses to send a credential to an origin that is not the server\'s', async () => {
    const { fetch } = recorder([]);
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log: () => undefined });
    await expect(http.request({ server: GITHUB, url: 'https://evil.example/user', template: '/user', credential: { bearer: 'gho_x' } })).rejects.toThrow(/another origin/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('drops Authorization on a cross-origin redirect and reaches that hop through the SSRF guard\'s fetch', async () => {
    const { sent, fetch } = recorder([redirect('https://objects.example.net/blob'), jsonAnswer(200, { ok: true })]);
    const publicFetch = vi.fn((url: string, init: RequestInit) => fetch(url, init));
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log: () => undefined, publicFetch });
    await http.request({ server: GITHUB, url: '/repos/a/b', template: '/repos/{owner}/{repo}', credential: { bearer: 'gho_secretToken0002' } });
    expect(sent[0]!.headers['Authorization']).toBe('Bearer gho_secretToken0002');
    expect(sent[1]!.url).toBe('https://objects.example.net/blob');
    expect(sent[1]!.headers['Authorization']).toBeUndefined();
    expect(sent[1]!.headers['X-GitHub-Api-Version']).toBeUndefined();
    expect(publicFetch.mock.calls.map(([url]) => url)).toEqual(['https://objects.example.net/blob']);
  });

  it('keeps the credential on a redirect between the server\'s own origins', async () => {
    const { sent, fetch } = recorder([redirect('https://github.com/login'), jsonAnswer(200, {})]);
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log: () => undefined });
    await http.request({ server: GITHUB, url: '/x', template: '/x', credential: { bearer: 'gho_t' } });
    expect(sent[1]!.headers['Authorization']).toBe('Bearer gho_t');
  });

  it('sends neither the credential nor the API version again once a redirect left the server, even back on its own origin', async () => {
    const { sent, fetch } = recorder([redirect('https://objects.example.net/hop'), redirect('https://api.github.com/chosen-by-the-third-party'), jsonAnswer(200, {})]);
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log: () => undefined, publicFetch: fetch });
    await http.request({ server: GITHUB, url: '/repos/a/b/actions/jobs/1/logs', template: '/logs', credential: { bearer: 'gho_secretToken0003' } });
    expect(sent.map((item) => item.url)).toEqual(['https://api.github.com/repos/a/b/actions/jobs/1/logs', 'https://objects.example.net/hop', 'https://api.github.com/chosen-by-the-third-party']);
    expect(sent.map((item) => item.headers['Authorization'])).toEqual(['Bearer gho_secretToken0003', undefined, undefined]);
    expect(sent.map((item) => item.headers['X-GitHub-Api-Version'])).toEqual([GITHUB_API_VERSION, undefined, undefined]);
  });

  it('follows at most MAX_REDIRECTS redirects, and cancels the body of each one it leaves', async () => {
    let cancelled = 0;
    const loop = () => new Response(new ReadableStream({ cancel: () => { cancelled++; } }), { status: 302, headers: { location: 'https://github.com/loop' } });
    const { fetch } = recorder(Array.from({ length: MAX_REDIRECTS + 2 }, () => loop));
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log: () => undefined });
    await expect(http.request({ server: GITHUB, url: 'https://github.com/start', template: '/start' })).rejects.toMatchObject({ kind: 'server', status: 302 });
    expect(fetch).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
    expect(cancelled).toBe(MAX_REDIRECTS + 1);
  });

  it('allows a private address for a registered server, and the SSRF guard refuses it for any other origin', async () => {
    const { fetch } = recorder([jsonAnswer(200, {})]);
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log: () => undefined });
    await http.request({ server: GITLAB, url: '/user', template: '/user', credential: { bearer: 'glpat-x' } });
    const refused = await http.request({ server: GITLAB, url: 'https://10.9.9.9/avatar.png', template: '/avatar', as: 'bytes' }).catch((err: unknown) => err);
    expect(refused).toMatchObject({ kind: 'network' });
    expect((refused as Error).cause).toBeInstanceOf(FetchRefusedError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('follows no redirect of a POST and refuses a non-https hop', async () => {
    const { fetch } = recorder([redirect('https://github.com/elsewhere'), redirect('http://github.com/plain')]);
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log: () => undefined });
    await expect(http.request({ server: GITHUB, method: 'POST', url: 'https://github.com/login/oauth/access_token', template: '/login/oauth/access_token', form: { a: 'b' } })).rejects.toMatchObject({ kind: 'server', status: 302 });
    await expect(http.request({ server: GITHUB, url: '/x', template: '/x' })).rejects.toMatchObject({ kind: 'server' });
  });

  it('classifies SAML SSO and OAuth app restrictions from GitHub\'s 403s', async () => {
    const { fetch } = recorder([
      jsonAnswer(403, { message: 'Resource protected by organization SAML enforcement.' }, { 'x-github-sso': 'required; url=https://github.com/orgs/indigital/sso?authorization_request=abc' }),
      jsonAnswer(403, { message: 'Although you appear to have the correct authorization credentials, the `legacy-corp` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited.' }),
      jsonAnswer(403, { message: 'Must have admin rights' }),
    ]);
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log: () => undefined });
    const request = () => http.request({ server: GITHUB, url: '/orgs/x/members', template: '/orgs/{org}/members', credential: { bearer: 'gho_t' } });
    await expect(request()).rejects.toMatchObject({ kind: 'ssoRequired', ssoUrl: 'https://github.com/orgs/indigital/sso?authorization_request=abc' });
    await expect(request()).rejects.toMatchObject({ kind: 'appNotApproved' });
    await expect(request()).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('classifies 401, 404, 5xx, TLS and network failures', async () => {
    const tlsError = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('unable to verify'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }) });
    const netError = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
    const refused = () => { throw netError; };
    const answers: (() => Response | never)[] = [jsonAnswer(401, {}), jsonAnswer(404, {}), jsonAnswer(503, {}), () => { throw tlsError; }, ...Array.from({ length: MAX_TRANSIENT_RETRIES + 1 }, () => refused)];
    const http = createForgeHttp({ fetch: (async () => answers.shift()!()) as unknown as typeof fetch, userAgent: 'Damocles/test', log: () => undefined, random: () => 0 });
    const request = () => http.request({ server: GITLAB, url: '/user', template: '/user' });
    for (const kind of ['unauthorized', 'notFound', 'server', 'tls', 'network']) await expect(request()).rejects.toMatchObject({ kind });
    expect(answers).toEqual([]);
  });

  it('cancels the body of an error answer it does not read, and of a redirect without a Location', async () => {
    let cancelled = 0;
    const unread = (status: number, headers: Record<string, string> = {}) => () => new Response(new ReadableStream({ cancel: () => { cancelled++; } }), { status, headers });
    const { fetch } = recorder([unread(401), unread(404), unread(503), unread(429, { 'retry-after': '5' }), unread(302)]);
    let now = 1_000_000;
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log: () => undefined, now: () => (now += 10_000) });
    for (const template of ['/a', '/b', '/c', '/d', '/e']) await expect(http.request({ server: GITLAB, url: template, template })).rejects.toBeInstanceOf(ForgeHttpError);
    expect(cancelled).toBe(5);
  });

  it('answers a 400, 409 or 422 as refused with the server\'s reason, which neither its message nor the log carries', async () => {
    const log = vi.fn();
    const { fetch } = recorder([
      jsonAnswer(422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: 'A pull request already exists for a:b.' }] }),
      jsonAnswer(400, { message: { name: ['has already been taken'], path: ['has already been taken'] } }),
      jsonAnswer(409, { message: 'Branch already exists' }),
    ]);
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log });
    const request = () => http.request({ server: GITHUB, method: 'POST', url: '/repos/a/b/pulls', template: '/repos/{owner}/{repo}/pulls', json: {} }).then(() => { throw new Error('answered'); }, (err: unknown) => err as ForgeHttpError);
    const pull = await request();
    expect(pull).toMatchObject({ kind: 'refused', status: 422, serverText: 'Validation Failed; A pull request already exists for a:b.' });
    expect(pull.message).not.toContain('already exists');
    expect(await request()).toMatchObject({ kind: 'refused', status: 400, serverText: 'name has already been taken; path has already been taken' });
    expect(await request()).toMatchObject({ kind: 'refused', status: 409, serverText: 'Branch already exists' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('already');
  });

  it('rethrows the caller\'s abort during the body read instead of calling it a server failure', async () => {
    const controller = new AbortController();
    const reason = new Error('the caller stopped');
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode('{"a":'));
        controller.signal.addEventListener('abort', () => stream.error(reason));
      },
    });
    const { fetch } = recorder([() => new Response(body, { status: 200 })]);
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log: () => undefined });
    const pending = http.request({ server: GITLAB, url: '/slow', template: '/slow', signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBe(reason);
  });

  it('asks the web origin\'s OAuth endpoints for exactly application/json, and limits them apart from the API', async () => {
    const { sent, fetch } = recorder([jsonAnswer(429, {}, { 'retry-after': '30' }), jsonAnswer(200, {})]);
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log: () => undefined });
    const token = () => http.request({ server: GITHUB, method: 'POST', url: 'https://github.com/login/oauth/access_token', template: '/login/oauth/access_token', form: { a: 'b' }, acceptStatuses: [400] });
    await expect(token()).rejects.toMatchObject({ kind: 'rateLimited' });
    expect(sent[0]!.headers['Accept']).toBe('application/json');
    await expect(token()).rejects.toMatchObject({ kind: 'rateLimited' });
    await expect(http.request({ server: GITHUB, url: '/user', template: '/user' })).resolves.toMatchObject({ status: 200 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('sends a GHES server no API version until one is recorded, then the recorded one', async () => {
    const unrecorded = server({ kind: 'github' }, 'https://ghe.example', 'https://ghe.example/api/v3');
    const recorded = server({ kind: 'github', apiVersion: '2022-11-28' }, 'https://ghe.example', 'https://ghe.example/api/v3');
    const { sent, fetch } = recorder([jsonAnswer(200, {}), jsonAnswer(200, {})]);
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log: () => undefined });
    await http.request({ server: unrecorded, url: '/user', template: '/user' });
    await http.request({ server: recorded, url: '/user', template: '/user' });
    expect(sent.map((item) => item.headers['X-GitHub-Api-Version'])).toEqual([undefined, '2022-11-28']);
  });

  it('records 2022-11-28 for a GHES server whose /versions lists none of the versions Damocles speaks', async () => {
    const ghes = server({ kind: 'github' }, 'https://ghe.example', 'https://ghe.example/api/v3');
    const { fetch } = recorder([jsonAnswer(200, { installed_version: '3.20.0' }), jsonAnswer(200, ['2099-01-01'])]);
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log: () => undefined });
    expect(await githubVersion(http, ghes, 'ghp_t')).toEqual({ version: '3.20.0', apiVersion: '2022-11-28' });
  });

  it('backs off a rate-limited server until its reset, without asking it again', async () => {
    let now = 1_000_000;
    const { fetch } = recorder([jsonAnswer(429, {}, { 'retry-after': '30' }), jsonAnswer(200, {})]);
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log: () => undefined, now: () => now });
    const request = () => http.request({ server: GITLAB, url: '/user', template: '/user' });
    await expect(request()).rejects.toMatchObject({ kind: 'rateLimited', retryAt: now + 30_000 });
    await expect(request()).rejects.toBeInstanceOf(ForgeHttpError);
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 31_000;
    await expect(request()).resolves.toMatchObject({ status: 200 });
  });

  it('backs off only the rate limit GitHub named: a limited search leaves the core API reachable', async () => {
    const { fetch } = recorder([jsonAnswer(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-resource': 'search', 'retry-after': '60' }), jsonAnswer(200, {})]);
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log: () => undefined });
    const search = () => http.request({ server: GITHUB, url: '/search/repositories?q=x', template: '/search/repositories' });
    await expect(search()).rejects.toMatchObject({ kind: 'rateLimited' });
    await expect(search()).rejects.toMatchObject({ kind: 'rateLimited' });
    await expect(http.request({ server: GITHUB, url: '/user/repos', template: '/user/repos' })).resolves.toMatchObject({ status: 200 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reads x-ratelimit-reset against the server\'s Date, so this computer\'s clock skew drops out, and bounds the wait', async () => {
    const now = Date.parse('2026-11-12T10:00:00Z');
    // the server's clock is 10 minutes behind this computer's; its reset is 30 s after its own now
    const serverNow = now - 10 * 60_000;
    // each answer names its own resource, so one answer's backoff refuses none of the later requests
    const limited = (resource: string, headers: Record<string, string>) => jsonAnswer(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-resource': resource, ...headers });
    const date = new Date(serverNow).toUTCString();
    const { fetch } = recorder([
      limited('one', { date, 'x-ratelimit-reset': String(serverNow / 1000 + 30) }),
      // a reset already past, as with a clock ahead of the server's and no Date header
      limited('two', { 'x-ratelimit-reset': String(now / 1000 - 300) }),
      // a reset this small is seconds from now
      limited('three', { 'x-ratelimit-reset': '90' }),
      limited('four', { 'x-ratelimit-reset': '99999999999' }),
      jsonAnswer(429, {}, { 'retry-after': '999999', 'x-ratelimit-resource': 'five' }),
    ]);
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log: () => undefined, now: () => now });
    const waits: number[] = [];
    for (let index = 0; index < 5; index++) {
      const err = await http.request({ server: GITHUB, url: '/user', template: '/user', credential: { bearer: 'gho_t' } }).then(() => { throw new Error('answered'); }, (caught: unknown) => caught as ForgeHttpError);
      waits.push(err.retryAt! - now);
    }
    expect(waits).toEqual([30_000, 1_000, 90_000, 3_600_000, 3_600_000]);
  });

  it('runs the rate-limit and SSO checks on an accepted 403, and records its backoff', async () => {
    let now = 1_000_000;
    const { fetch } = recorder([
      jsonAnswer(403, { message: 'You have exceeded a secondary rate limit.' }, { 'retry-after': '120' }),
      jsonAnswer(403, { message: 'Resource protected by organization SAML enforcement.' }, { 'x-github-sso': 'required; url=https://github.com/orgs/indigital/sso?authorization_request=abc' }),
      jsonAnswer(403, { message: 'the `legacy-corp` organization has enabled OAuth App access restrictions' }),
      jsonAnswer(403, { message: 'Repository creation failed.' }),
    ]);
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log: () => undefined, now: () => now });
    const create = () => http.request({ server: GITHUB, method: 'POST', url: '/orgs/indigital/repos', template: '/orgs/{org}/repos', credential: { bearer: 'gho_t' }, json: {}, acceptStatuses: [403, 422] });
    await expect(create()).rejects.toMatchObject({ kind: 'rateLimited', retryAt: now + 120_000 });
    await expect(create()).rejects.toMatchObject({ kind: 'rateLimited' });
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 121_000;
    await expect(create()).rejects.toMatchObject({ kind: 'ssoRequired', ssoUrl: 'https://github.com/orgs/indigital/sso?authorization_request=abc' });
    await expect(create()).rejects.toMatchObject({ kind: 'appNotApproved' });
    await expect(create()).resolves.toMatchObject({ status: 403, body: { message: 'Repository creation failed.' } });
  });

  it('sends If-None-Match and reports a 304 as not modified', async () => {
    const { sent, fetch } = recorder([() => new Response(null, { status: 304 })]);
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log: () => undefined });
    const response = await http.request({ server: GITLAB, url: '/projects/1/pipelines', template: '/projects/{id}/pipelines', etag: 'W/"abc"' });
    expect(sent[0]!.headers['If-None-Match']).toBe('W/"abc"');
    expect(response).toMatchObject({ status: 304, notModified: true, etag: 'W/"abc"' });
  });

  it('bounds a JSON answer', async () => {
    const { fetch } = recorder([() => new Response('x'.repeat(2048), { status: 200 })]);
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log: () => undefined });
    await expect(http.request({ server: GITLAB, url: '/big', template: '/big', maxBytes: 1024 })).rejects.toMatchObject({ kind: 'server' });
  });
});

describe('GitHub GraphQL errors', () => {
  const signal = new AbortController().signal;

  it('backs off the graphql limit on an answer of type RATE_LIMITED, and leaves the REST API reachable', async () => {
    const now = Date.parse('2026-11-12T10:00:00Z');
    const { fetch } = recorder([
      jsonAnswer(200, { data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }, { 'x-ratelimit-resource': 'graphql', 'x-ratelimit-reset': String(now / 1000 + 600) }),
      jsonAnswer(200, {}),
    ]);
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log: () => undefined, now: () => now });
    const query = () => githubGraphql(http, GITHUB, 'gho_t', 'assignableUsers', 'query assignableUsers { viewer { login } }', {}, signal);
    await expect(query()).rejects.toMatchObject({ kind: 'rateLimited', retryAt: now + 600_000 });
    await expect(query()).rejects.toMatchObject({ kind: 'rateLimited' });
    await expect(http.request({ server: GITHUB, url: '/user', template: '/user' })).resolves.toMatchObject({ status: 200 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reads NOT_FOUND as notFound and any other error as server, and an answer whose data is null as having none', async () => {
    const { fetch } = recorder([
      jsonAnswer(200, { data: { repository: null }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a Repository' }] }),
      jsonAnswer(200, { data: null, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible' }] }),
      jsonAnswer(200, { data: null, errors: [{ message: 'Something went wrong' }] }),
    ]);
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log: () => undefined });
    const ctx = { http, server: GITHUB, token: 'gho_t', repoPath: 'a/b', signal };
    await expect(assignableUsers(ctx)).rejects.toMatchObject({ kind: 'notFound' });
    await expect(assignableUsers(ctx)).rejects.toMatchObject({ kind: 'server' });
    // not read as a repository without rules, which the cache would keep
    await expect(githubBranchProtection(http, GITHUB, 'gho_t', 'a/b', signal)).rejects.toMatchObject({ kind: 'server' });
  });
});

describe('a job log\'s tail', () => {
  /** A body streamed in chunks of chunkBytes, chunk i filled with the byte i % 251. */
  function streamed(totalBytes: number, chunkBytes: number): Response {
    let sent = 0;
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= totalBytes) return controller.close();
        const size = Math.min(chunkBytes, totalBytes - sent);
        controller.enqueue(new Uint8Array(size).fill(index++ % 251));
        sent += size;
      },
    });
    return new Response(body, { status: 200 });
  }

  it('keeps the last MAX_JOB_LOG_BYTES of a longer log instead of failing, and says it was cut', async () => {
    const total = MAX_JOB_LOG_BYTES + 3 * 1024 * 1024 + 17;
    const chunk = 1024 * 1024 + 3;
    const { fetch } = recorder([() => streamed(total, chunk)]);
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log: () => undefined });
    const response = await http.request({ server: GITLAB, url: '/projects/1/jobs/2/trace', template: '/trace', as: 'tail', maxBytes: MAX_JOB_LOG_BYTES });
    const tail = response.body as ForgeTail;
    expect(tail.totalBytes).toBe(total);
    expect(tail.bytes.byteLength).toBe(MAX_JOB_LOG_BYTES);
    const lastChunk = Math.floor((total - 1) / chunk);
    expect(tail.bytes.at(-1)).toBe(lastChunk % 251);
    // the tail's first byte is the one at total - MAX_JOB_LOG_BYTES
    expect(tail.bytes[0]).toBe(Math.floor((total - MAX_JOB_LOG_BYTES) / chunk) % 251);
    expect(decodeTail(tail).truncated).toBe(true);
  });

  it('keeps a shorter log whole', async () => {
    const { fetch } = recorder([() => new Response('line 1\nline 2\n', { status: 200 })]);
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log: () => undefined });
    const tail = (await http.request({ server: GITLAB, url: '/t', template: '/t', as: 'tail', maxBytes: MAX_JOB_LOG_BYTES })).body as ForgeTail;
    expect(decodeTail(tail)).toEqual({ text: 'line 1\nline 2\n', truncated: false });
  });

  it('starts a cut tail at a whole character', () => {
    const bytes = new TextEncoder().encode('✓ ok');
    expect(decodeTail({ bytes: bytes.subarray(1), totalBytes: 100 })).toEqual({ text: ' ok', truncated: true });
  });
});

describe('transient connection failures', () => {
  const coded = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
  const failure = (code: string) => () => {
    throw coded(code);
  };
  const random = () => 0;

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends a GET again after a dropped connection with the same headers, and logs the retry', async () => {
    const log = vi.fn();
    const { sent, fetch } = recorder([failure('UND_ERR_SOCKET'), jsonAnswer(200, { ok: true })]);
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log, random });
    const response = await http.request({ server: GITHUB, url: '/repos/a/b/commits/c/check-runs', template: '/check-runs', credential: { bearer: 'gho_t' } });
    expect(response.body).toEqual({ ok: true });
    expect(sent.map((item) => item.headers['Authorization'])).toEqual(['Bearer gho_t', 'Bearer gho_t']);
    expect(sent.map((item) => item.headers['X-GitHub-Api-Version'])).toEqual([GITHUB_API_VERSION, GITHUB_API_VERSION]);
    expect(JSON.stringify(log.mock.calls)).toMatch(new RegExp(`GET github\\.com /check-runs failed: network \\(UND_ERR_SOCKET\\) after \\d+ ms, retry 1 of ${MAX_TRANSIENT_RETRIES} in 0 ms`));
  });

  it("sends a GET again after DNS's try-again answer and after Windows' aborted connection", async () => {
    for (const code of ['EAI_AGAIN', 'ECONNABORTED']) {
      const { fetch } = recorder([failure(code), jsonAnswer(200, { ok: true })]);
      const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log: () => undefined, random });
      expect((await http.request({ server: GITHUB, url: '/x', template: '/x' })).body).toEqual({ ok: true });
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  });

  it('retries only the hop that failed, a TLS message that did not parse at the log storage included, still without the credential', async () => {
    const { sent, fetch } = recorder([redirect('https://objects.example.net/blob'), failure('ERR_SSL_DECODE_ERROR'), jsonAnswer(200, { ok: true })]);
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log: () => undefined, publicFetch: fetch, random });
    await http.request({ server: GITHUB, url: '/repos/a/b/actions/jobs/1/logs', template: '/logs', credential: { bearer: 'gho_t' } });
    expect(sent.map((item) => item.url)).toEqual(['https://api.github.com/repos/a/b/actions/jobs/1/logs', 'https://objects.example.net/blob', 'https://objects.example.net/blob']);
    expect(sent.map((item) => item.headers['Authorization'])).toEqual(['Bearer gho_t', undefined, undefined]);
  });

  it(`gives up after ${MAX_TRANSIENT_RETRIES} retries and names the host that failed when it is not the server's`, async () => {
    const log = vi.fn();
    const { fetch } = recorder([redirect('https://objects.example.net/blob'), ...Array.from({ length: MAX_TRANSIENT_RETRIES + 1 }, () => failure('ECONNRESET'))]);
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log, publicFetch: fetch, random });
    const failed = await http.request({ server: GITHUB, url: '/logs', template: '/logs' }).catch((err: unknown) => err);
    expect(failed).toBeInstanceOf(ForgeHttpError);
    expect(failed).toMatchObject({ kind: 'network', foreignHost: 'objects.example.net' });
    expect((failed as ForgeHttpError).privateAddress).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(MAX_TRANSIENT_RETRIES + 2);
    expect(JSON.stringify(log.mock.calls.at(-1))).toContain('GET github.com /logs failed at objects.example.net: network (ECONNRESET)');
    // a failure at the server's own origin names no other host
    const own = recorder([...Array.from({ length: MAX_TRANSIENT_RETRIES + 1 }, () => failure('ECONNRESET'))]);
    const ownFailure = await createForgeHttp({ fetch: own.fetch, userAgent: 'Damocles/test', log: () => undefined, random }).request({ server: GITHUB, url: '/user', template: '/user' }).catch((err: unknown) => err);
    expect(ownFailure).toMatchObject({ kind: 'network' });
    expect((ownFailure as ForgeHttpError).foreignHost).toBeUndefined();
  });

  it("never retries a POST, a DELETE, a certificate error, undici's connect timeout or an error that is not transient", async () => {
    for (const [method, answer] of [['POST', failure('ECONNRESET')], ['DELETE', failure('ECONNRESET')], ['GET', failure('CERT_HAS_EXPIRED')], ['GET', failure('UND_ERR_CONNECT_TIMEOUT')], ['GET', failure('ERR_INVALID_URL')]] as const) {
      const { fetch } = recorder([answer]);
      const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log: () => undefined, random });
      await expect(http.request({ server: GITHUB, method, url: '/x', template: '/x' })).rejects.toBeInstanceOf(ForgeHttpError);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("never retries the SSRF guard's refusal, and marks a foreign host it refused as a private address", async () => {
    const { fetch } = recorder([redirect('https://objects.example.net/blob')]);
    const publicFetch = vi.fn(() => Promise.reject(new FetchRefusedError('Blocked private address: objects.example.net → 10.0.0.5')));
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log: () => undefined, publicFetch, random });
    const failed = await http.request({ server: GITHUB, url: '/logs', template: '/logs' }).catch((err: unknown) => err);
    expect(failed).toMatchObject({ kind: 'network', foreignHost: 'objects.example.net', privateAddress: true });
    expect(publicFetch).toHaveBeenCalledTimes(1);
  });

  it('ends a retry whose wait outlives the request timeout as a network failure, without another send', async () => {
    vi.useFakeTimers();
    // Node's AbortSignal.timeout keeps its own timer, which fake timers do not reach
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('The operation timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
    const fetch = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, REQUEST_TIMEOUT_MS - 100));
      throw coded('ECONNRESET');
    });
    const http = createForgeHttp({ fetch: fetch as unknown as typeof globalThis.fetch, userAgent: 'Damocles/test', log: () => undefined, random: () => 0.99 });
    const pending = http.request({ server: GITHUB, url: '/x', template: '/x' }).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1_000);
    expect(await pending).toMatchObject({ kind: 'network' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a caller's abort during the wait ends the request with the caller's reason, logs the failure last, and sends nothing more", async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const controller = new AbortController();
    const reason = new DOMException('stopped', 'AbortError');
    const { fetch } = recorder([failure('ECONNRESET')]);
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log, random: () => 0.99 });
    const pending = http.request({ server: GITHUB, url: '/x', template: '/x', signal: controller.signal }).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort(reason);
    expect(await pending).toBe(reason);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(log.mock.lastCall?.[0]).toMatch(/GET github\.com \/x failed: network \(ECONNRESET\) after \d+ ms$/);
  });

  it("a caller's abort that a send fails with ends the request with the caller's reason", async () => {
    const controller = new AbortController();
    const reason = new DOMException('stopped', 'AbortError');
    const fetch = vi.fn(() => {
      controller.abort(reason);
      return Promise.reject(coded('ECONNRESET'));
    });
    const http = createForgeHttp({ fetch: fetch as unknown as typeof globalThis.fetch, userAgent: 'Damocles/test', log: () => undefined, random });
    expect(await http.request({ server: GITHUB, url: '/x', template: '/x', signal: controller.signal }).catch((err: unknown) => err)).toBe(reason);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('failures at a host that is not the server', () => {
  const brokenBody = () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
      controller.error(new Error('reset'));
    },
  }), { status: 200 });

  it('names the host of an error status or a body that broke off there, and never the server for its own failures', async () => {
    const { fetch } = recorder([
      redirect('https://objects.example.net/blob'), jsonAnswer(404, {}),
      redirect('https://objects.example.net/blob'), jsonAnswer(503, {}),
      redirect('https://objects.example.net/blob'), brokenBody,
      jsonAnswer(404, {}),
    ]);
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log: () => undefined, publicFetch: fetch });
    const read = (as?: 'tail') => http.request({ server: GITHUB, url: '/logs', template: '/logs', ...(as !== undefined ? { as } : {}) }).catch((err: unknown) => err);
    expect(await read()).toMatchObject({ kind: 'notFound', foreignHost: 'objects.example.net' });
    expect(await read()).toMatchObject({ kind: 'server', status: 503, foreignHost: 'objects.example.net' });
    expect(await read('tail')).toMatchObject({ kind: 'server', foreignHost: 'objects.example.net' });
    const own = await read();
    expect(own).toMatchObject({ kind: 'notFound' });
    expect((own as ForgeHttpError).foreignHost).toBeUndefined();
  });

  // the host got no token, so no answer of it may mark the account refused or hold back the server's own requests
  it('reads a foreign error status by the status alone: no credential refusal, rate limit, SSO or app policy', async () => {
    const limit = { 'retry-after': '600', 'x-ratelimit-remaining': '0' };
    const { fetch } = recorder([
      redirect('https://objects.example.net/blob'), jsonAnswer(401, {}),
      redirect('https://objects.example.net/blob'), jsonAnswer(403, { message: 'OAuth App access restrictions' }, { 'x-github-sso': 'required; url=https://github.com/orgs/acme/sso' }),
      redirect('https://objects.example.net/blob'), jsonAnswer(429, {}, limit),
      redirect('https://objects.example.net/blob'), jsonAnswer(403, {}, limit),
      jsonAnswer(200, { ok: true }),
    ]);
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log: () => undefined, publicFetch: fetch });
    const read = () => http.request({ server: GITHUB, url: '/logs', template: '/logs', credential: { bearer: 'gho_token' } }).catch((err: unknown) => err);
    expect(await read()).toMatchObject({ kind: 'forbidden', status: 401, foreignHost: 'objects.example.net' });
    expect(await read()).toMatchObject({ kind: 'forbidden', status: 403, foreignHost: 'objects.example.net' });
    expect(await read()).toMatchObject({ kind: 'server', status: 429, foreignHost: 'objects.example.net' });
    expect(await read()).toMatchObject({ kind: 'forbidden', status: 403, foreignHost: 'objects.example.net' });
    expect(await read()).toMatchObject({ status: 200, body: { ok: true } });
  });

  it('names at most 253 characters of a foreign host, and its port', async () => {
    const hostname = `${'a'.repeat(300)}.example.net`;
    const { fetch } = recorder([redirect(`https://${hostname}:8443/blob`), jsonAnswer(503, {})]);
    const http = createForgeHttp({ fetch, userAgent: 'Damocles/test', log: () => undefined, publicFetch: fetch });
    const failed = await http.request({ server: GITHUB, url: '/logs', template: '/logs' }).catch((err: unknown) => err);
    expect((failed as ForgeHttpError).foreignHost).toBe(`${'a'.repeat(253)}:8443`);
  });
});
