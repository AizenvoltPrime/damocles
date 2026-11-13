// File and commit links adapted from VS Code's extensions/github/src/links.ts (encodeURIComponentExceptSlashes, rangeString,
// getCommitLink), Copyright (c) Microsoft Corporation, and GitLab Workflow for VS Code's src/desktop/commands/openers.ts
// (getActiveFile), Copyright (c) 2020-present GitLab Inc. Both licensed under the MIT License (THIRD-PARTY-NOTICES.md).
import type { RemoteEndpoint } from '../../shared/forge/bindings';
import { FULL_SHA, type ForgeLinkTarget } from '../../shared/forge/links';
import { MAX_REFERENCE_NUMBER, type ForgeReference } from '../../shared/forge/references';
import type { ForgeKind } from '../../shared/forge/accounts';
import { repoOnServer, type MatchableServer } from './remote-url';
import { checkedRepoPath } from './tools/api';

// docs/invariants.md "GitHub and GitLab accounts", links: an address is built only from a managed server's web URL, the
// checked repository path, a full commit id, encoded path segments, checked line numbers and checked reference numbers and
// project paths, and only on that web origin.

const MAX_PATH_CHARS = 4096;
const MAX_LINE = 10_000_000;

export interface LinkServer extends MatchableServer {
  readonly kind: ForgeKind;
}

export type LinkOutcome<S extends LinkServer> =
  /** remote: the remote whose repository the link names, so the published check reads only its branches. */
  | { readonly ok: true; readonly url: string; readonly server: S; readonly remote: string }
  /** noServer: no remote on a managed server; repoPath: its path is not one a link may carry; target: a bad sha, path or range. */
  | { readonly ok: false; readonly reason: 'noServer' | 'repoPath' | 'target' };

/** Each '/'-separated segment percent-encoded; undefined for an empty, '.' or '..' segment, which a browser would fold away. */
export function encodedPath(path: string): string | undefined {
  if (path.length === 0 || path.length > MAX_PATH_CHARS) return undefined;
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return undefined;
  try {
    return segments.map((segment) => encodeURIComponent(segment)).join('/');
  } catch (err) {
    // a lone surrogate names no file a server could show
    if (err instanceof URIError) return undefined;
    throw err;
  }
}

const isLine = (value: number): boolean => Number.isSafeInteger(value) && value >= 1 && value <= MAX_LINE;

// The extensions GitHub shows rendered (github/markup's languages and notebooks), where a line anchor works only on the source
// view `?plain=1` opens, as GitHub's own Copy permalink adds it.
const GITHUB_RENDERED = new Set(['markdown', 'mdown', 'mkdn', 'mkd', 'md', 'textile', 'rdoc', 'org', 'creole', 'mediawiki', 'wiki', 'rst', 'asciidoc', 'adoc', 'asc', 'pod', 'ipynb']);
const rendersOnGithub = (path: string): boolean => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 && GITHUB_RENDERED.has(name.slice(dot + 1).toLowerCase());
};

/** GitHub `#L3-L7`, GitLab `#L3-7`, one line `#L3`; undefined for lines that are not 1-based with start <= end. */
export function lineAnchor(kind: ForgeKind, range: { readonly start: number; readonly end: number } | undefined): string | undefined {
  if (!range) return '';
  if (!isLine(range.start) || !isLine(range.end) || range.start > range.end) return undefined;
  if (range.start === range.end) return `#L${range.start}`;
  return kind === 'github' ? `#L${range.start}-L${range.end}` : `#L${range.start}-${range.end}`;
}

/** A reference's page: GitHub `#n` an issue (GitHub redirects a pull request's number), GitLab `#n` an issue and `!n` a merge request. */
function referencePath(kind: ForgeKind, repoPath: string, reference: ForgeReference): string | undefined {
  if (!Number.isSafeInteger(reference.number) || reference.number < 1 || reference.number > MAX_REFERENCE_NUMBER) return undefined;
  if (kind === 'github' && reference.sigil !== '#') return undefined;
  const project = reference.path !== undefined ? checkedRepoPath(kind, reference.path) : repoPath;
  if (project === undefined) return undefined;
  if (kind === 'github') return `${project}/issues/${reference.number}`;
  return `${project}/-/${reference.sigil === '!' ? 'merge_requests' : 'issues'}/${reference.number}`;
}

/** The target's address under the server's web URL, or undefined when any part fails its check. */
export function linkUrl(server: { readonly kind: ForgeKind; readonly webUrl: string }, repoPath: string, target: ForgeLinkTarget): string | undefined {
  let url: string;
  if (target.kind === 'reference') {
    const page = referencePath(server.kind, repoPath, target.reference);
    if (page === undefined) return undefined;
    url = `${server.webUrl}/${page}`;
  } else {
    if (!FULL_SHA.test(target.sha)) return undefined;
    const base = `${server.webUrl}/${repoPath}${server.kind === 'gitlab' ? '/-' : ''}`;
    if (target.kind === 'commit') {
      url = `${base}/commit/${target.sha}`;
    } else {
      const path = encodedPath(target.path);
      const anchor = lineAnchor(server.kind, target.range);
      if (path === undefined || anchor === undefined) return undefined;
      url = `${base}/blob/${target.sha}/${path}${anchor !== '' && server.kind === 'github' && rendersOnGithub(target.path) ? '?plain=1' : ''}${anchor}`;
    }
  }
  const web = new URL(server.webUrl);
  const built = URL.canParse(url) ? new URL(url) : undefined;
  return built && built.protocol === 'https:' && built.origin === web.origin ? url : undefined;
}

/**
 * The link of a repository's target on the managed server one of its remotes points at; servers are the managed ones only.
 * A file or commit is on the tracking remote's repository, a reference on the one history names (remote-url.ts RemoteOrder).
 */
export function buildLink<S extends LinkServer>(servers: readonly S[], repo: { readonly endpoints: readonly RemoteEndpoint[]; readonly pushRemote?: string }, target: ForgeLinkTarget): LinkOutcome<S> {
  const found = repoOnServer(repo, servers, target.kind === 'reference' ? 'upstream' : 'tracking');
  if (!found) return { ok: false, reason: 'noServer' };
  const repoPath = checkedRepoPath(found.server.kind, found.repoPath);
  if (repoPath === undefined) return { ok: false, reason: 'repoPath' };
  const url = linkUrl(found.server, repoPath, target);
  return url !== undefined ? { ok: true, url, server: found.server, remote: found.remote } : { ok: false, reason: 'target' };
}
