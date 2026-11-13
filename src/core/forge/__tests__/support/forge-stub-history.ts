import { createHash } from 'node:crypto';
import * as https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

// The stub's history details (forge-stub.ts calls these): GitLab GET /avatar?email=, GitHub's assignableUsers and aliased
// commitAuthors GraphQL, each commit's merge requests or pull requests, and the pictures they name. The authors:
// one picture on the server's own origin, one on a third-party host (a Gravatar stand-in on its own listener, which must see
// no credential and which the SSRF guard refuses on 127.0.0.1), an SVG, an oversized body, an HTML body and an author with none.

export type StubPicture = 'own' | 'thirdParty' | 'svg' | 'oversized' | 'notImage' | 'none';

export const HISTORY_FIXTURES = {
  authors: {
    alexios: { name: 'Alexios Stefanopoulos', email: 'a.stefanopoulos@indigital.gr', picture: 'own' },
    maria: { name: 'Maria K.', email: 'maria.k@indigital.gr', picture: 'thirdParty' },
    nikos: { name: 'Nikos P.', email: 'nikos.p@indigital.gr', picture: 'svg' },
    ciBot: { name: 'ci-bot', email: 'ci-bot@indigital.gr', picture: 'none' },
    big: { name: 'Big Picture', email: 'big.picture@indigital.gr', picture: 'oversized' },
    notImage: { name: 'Not An Image', email: 'not.an.image@indigital.gr', picture: 'notImage' },
  },
  /** Every commit's default merge requests (GitLab) and pull requests (GitHub): an open one, then the merged one. */
  openChange: 44,
  mergedChange: 45,
  issue: 123,
  crossProject: { path: 'owner/repo', number: 12 },
} as const satisfies Record<string, unknown>;

/** Bytes past the 512 KiB avatar bound, starting with the PNG signature so only the bound refuses them. */
export const OVERSIZED_PICTURE_BYTES = 600 * 1024;

// 1x1 transparent PNG
export const STUB_PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>alert(1)</script></svg>';

const pictureOfEmail = (email: string): StubPicture | undefined =>
  Object.values(HISTORY_FIXTURES.authors).find((author) => author.email === email.toLowerCase())?.picture;

/** A change containing a commit, as the merge requests and pulls endpoints list it. */
export interface StubChange {
  readonly number: number;
  readonly state: 'opened' | 'merged' | 'closed';
}

/** One stub server's history answers, which a test may steer. */
export class HistoryUi {
  /** Per sha: the changes containing it; a sha not listed answers [!44 opened, !45 merged]. */
  readonly containing = new Map<string, readonly StubChange[]>();
  /** GitHub: each commit's author email, which commitAuthors answers with that author's picture; an unknown sha answers null. */
  readonly commits = new Map<string, string>();
  /** Shas the server does not have: their pulls answer 422 on GitHub and their merge requests 404 on GitLab. */
  readonly unknownCommits = new Set<string>();
  /** GitLab: emails whose GET /avatar answers 500. */
  readonly failingAvatars = new Set<string>();
  /** GitLab: the avatar_url GET /avatar names for an email, in place of the fixture's. */
  readonly avatarUrls = new Map<string, string>();
  /** GitLab: called with each GET /avatar's email before it is answered. */
  onAvatar: ((email: string) => void) | undefined;
  /** GitHub: awaited before an assignableUsers query is answered. */
  holdUsers: (() => Promise<void>) | undefined;
  /** Requests of a commit's merge requests or pulls. */
  containingRequests = 0;

  changesOf(sha: string): readonly StubChange[] {
    return this.containing.get(sha) ?? [{ number: HISTORY_FIXTURES.openChange, state: 'opened' }, { number: HISTORY_FIXTURES.mergedChange, state: 'merged' }];
  }
}

/** The picture address the stub names for an author: on webUrl, on the third-party picturesUrl, or none. */
export function stubPictureUrl(kind: 'github' | 'gitlab', webUrl: string, picturesUrl: string, email: string): string | null {
  const picture = pictureOfEmail(email);
  const md5 = createHash('md5').update(email.trim().toLowerCase()).digest('hex');
  const own = (gitlabId: number, githubName: string, extension = 'png'): string =>
    kind === 'gitlab' ? `${webUrl}/uploads/-/system/user/avatar/${gitlabId}/avatar.${extension}` : `${webUrl}/avatars/${githubName}.${extension}`;
  switch (picture) {
    case 'own': return own(32, 'astefanopoulos');
    case 'thirdParty': return `${picturesUrl}/avatar/${md5}?s=80&d=identicon`;
    case 'svg': return own(41, 'nikos-p', 'svg');
    case 'oversized': return own(42, 'big-picture');
    case 'notImage': return own(43, 'not-an-image');
    default: return null;
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/** The special pictures (SVG, oversized, HTML) at their own-origin paths; false for any other path. */
export function answerSpecialPicture(kind: 'github' | 'gitlab', path: string, response: ServerResponse): boolean {
  const special = kind === 'gitlab' ? /^\/uploads\/-\/system\/user\/avatar\/(41|42|43)\/avatar\.(?:png|svg)$/.exec(path)?.[1] : /^\/avatars\/(nikos-p|big-picture|not-an-image)\.(?:png|svg)$/.exec(path)?.[1];
  if (special === undefined) return false;
  if (special === '41' || special === 'nikos-p') {
    response.writeHead(200, { 'content-type': 'image/svg+xml' });
    response.end(SVG);
  } else if (special === '42' || special === 'big-picture') {
    const body = Buffer.alloc(OVERSIZED_PICTURE_BYTES);
    STUB_PNG.copy(body);
    response.writeHead(200, { 'content-type': 'image/png' });
    response.end(body);
  } else {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>not a picture</title>');
  }
  return true;
}

export interface HistoryApiRequest {
  readonly kind: 'github' | 'gitlab';
  readonly webUrl: string;
  readonly picturesUrl: string;
  readonly method: string;
  /** Below the API prefix. */
  readonly path: string;
  readonly url: URL;
  readonly response: ServerResponse;
  /** The login's access level to a repository path, undefined for none. */
  readonly level: (repoPath: string) => number | undefined;
  readonly ui: HistoryUi;
}

/** GitLab GET /avatar and the commit merge requests, GitHub the commit pulls; false when the path is none of them. */
export function answerHistory(request: HistoryApiRequest): boolean {
  const { kind, method, path, url, response, ui } = request;
  if (method !== 'GET') return false;
  if (kind === 'gitlab' && path === '/avatar') {
    const email = url.searchParams.get('email') ?? '';
    ui.onAvatar?.(email);
    if (ui.failingAvatars.has(email)) json(response, 500, { message: '500 Internal Server Error' });
    else json(response, 200, { avatar_url: ui.avatarUrls.get(email) ?? stubPictureUrl(kind, request.webUrl, request.picturesUrl, email) });
    return true;
  }
  const gitlab = kind === 'gitlab' ? /^\/projects\/([^/]+)\/repository\/commits\/([0-9a-f]{40,64})\/merge_requests$/.exec(path) : null;
  const github = kind === 'github' ? /^\/repos\/([^/]+\/[^/]+)\/commits\/([0-9a-f]{40,64})\/pulls$/.exec(path) : null;
  const match = gitlab ?? github;
  if (!match) return false;
  ui.containingRequests += 1;
  const repoPath = decodeURIComponent(match[1]!);
  if (request.level(repoPath) === undefined) {
    json(response, 404, { message: kind === 'gitlab' ? '404 Project Not Found' : 'Not Found' });
    return true;
  }
  if (ui.unknownCommits.has(match[2]!)) {
    if (kind === 'github') json(response, 422, { message: `No commit found for SHA: ${match[2]!}` });
    else json(response, 404, { message: '404 Commit Not Found' });
    return true;
  }
  const mergedAt = '2026-11-08T21:04:00Z';
  const changes = ui.changesOf(match[2]!);
  json(response, 200, kind === 'gitlab'
    ? changes.map((change) => ({ id: 9000 + change.number, iid: change.number, state: change.state, merged_at: change.state === 'merged' ? mergedAt : null, web_url: `${request.webUrl}/${repoPath}/-/merge_requests/${change.number}` }))
    : changes.map((change) => ({ id: 9000 + change.number, number: change.number, state: change.state === 'opened' ? 'open' : 'closed', merged_at: change.state === 'merged' ? mergedAt : null, html_url: `${request.webUrl}/${repoPath}/pull/${change.number}` })));
  return true;
}

/** GitHub GraphQL assignableUsers and commitAuthors for a repository the login can see; undefined for any other query. */
export function answerGithubHistoryGraphql(query: string, variables: Readonly<Record<string, unknown>>, webUrl: string, picturesUrl: string, ui: HistoryUi): unknown {
  if (query.includes('assignableUsers(')) {
    const { alexios } = HISTORY_FIXTURES.authors;
    return {
      data: {
        repository: {
          assignableUsers: {
            nodes: [
              { login: 'astefanopoulos', name: alexios.name, email: alexios.email, avatarUrl: stubPictureUrl('github', webUrl, picturesUrl, alexios.email) },
              { login: 'astef-admin', name: 'Alexios (admin)', email: '', avatarUrl: `${webUrl}/avatars/astef-admin.png` },
            ],
          },
        },
      },
    };
  }
  if (!/query\s+commitAuthors\b/.test(query)) return undefined;
  const repository: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(variables)) {
    if (!/^c\d+$/.test(name) || typeof value !== 'string') continue;
    const email = ui.commits.get(value);
    const avatarUrl = email !== undefined ? stubPictureUrl('github', webUrl, picturesUrl, email) : null;
    repository[name] = email === undefined ? null : { author: { user: avatarUrl !== null ? { avatarUrl } : null } };
  }
  return { data: { repository } };
}

/** The third-party picture host: another origin, which records whether a credential came. */
export interface StubPictures {
  /** https://127.0.0.1:<port> */
  readonly url: string;
  readonly requests: { readonly path: string; readonly authorized: boolean }[];
}

export async function startPictures(options: { readonly cert: string; readonly key: string; readonly listenAddress?: string; readonly publicHost?: string }): Promise<StubPictures & { close(): Promise<void> }> {
  const requests: { readonly path: string; readonly authorized: boolean }[] = [];
  const sockets = new Set<Duplex>();
  const listener = https.createServer({ cert: options.cert, key: options.key }, (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'https://pictures.invalid');
    requests.push({ path: url.pathname, authorized: request.headers.authorization !== undefined });
    if (request.method === 'GET' && /^\/avatar\/[0-9a-f]{32}$/.test(url.pathname)) {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(STUB_PNG);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  listener.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, options.listenAddress ?? '127.0.0.1', () => resolve());
  });
  return {
    url: `https://${options.publicHost ?? '127.0.0.1'}:${(listener.address() as AddressInfo).port}`,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    },
  };
}
