// The Graph's history (plan slice 13): a load resolves the ref choice to commits once, and every page of it logs from those
// commits, so later pages read the same snapshot. The log, the base ref and the merge base follow VS Code's
// extensions/git/src/git.ts log, getMergeBase and repository.ts getBranchBase, read only: the base ref's config key is never
// written, unlike VS Code.
import { isObjectName } from '../../shared/git-object-name';
import { diffRefs } from './artifacts';
import { gitAtLeast, GitQueueDisposedError, isSafeRevision, revision } from './git-runner';
import { GitUntrustedError } from './errors';
import { isRemoteName } from './remotes';
import { MAX_MESSAGE_CHARS, MAX_SHOW_BYTES, type Repository } from './repository';

// VS Code's scm.graph.pageSize default (SCM_HISTORY_PAGE in scm-channels.ts must equal it).
export const HISTORY_PAGE = 50;
export const HISTORY_FORMAT = '%H%x00%P%x00%aN%x00%aE%x00%at%x00%D%x00%s';
const HISTORY_FIELDS = 7;
// Files a commit's details list (MAX_SCM_COMMIT_FILES in scm-channels.ts must equal it).
export const MAX_DETAIL_FILES = 10_000;
// Distinct commits a load may resolve to, which its cursor carries (MAX_SCM_HISTORY_TIPS in scm-channels.ts must equal it).
export const MAX_HISTORY_TIPS = 100_000;

export type HistoryRefKind = 'head' | 'branch' | 'remote' | 'tag' | 'base';

export interface HistoryRef {
  // a full refname, or 'HEAD' for a detached HEAD
  readonly id: string;
  readonly name: string;
  readonly kind: HistoryRefKind;
  // HEAD's branch, or the detached HEAD
  readonly current: boolean;
}

export interface HistoryCommit {
  readonly hash: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly email: string;
  // ms since the epoch
  readonly authorDate: number;
  readonly subject: string;
  readonly refs: readonly HistoryRef[];
}

/**
 * One commit's `%D` with --decorate=full, as VS Code's _resolveHistoryItemRefs reads it: `HEAD -> refs/heads/x` is HEAD's
 * branch, a lone `HEAD` the detached HEAD, `tag: refs/tags/x` a tag. A remote's HEAD, the stash, `grafted` (a shallow clone's
 * boundary) and `replaced` are left out. baseRef: the base ref's refname, a remote branch shown as the base.
 */
export function parseDecorations(decorations: string, baseRef?: string): HistoryRef[] {
  const refs: HistoryRef[] = [];
  for (const entry of decorations.split(', ')) {
    if (entry === 'HEAD') refs.push({ id: 'HEAD', name: 'HEAD', kind: 'head', current: true });
    else if (entry.startsWith('HEAD -> refs/heads/')) {
      const id = entry.slice('HEAD -> '.length);
      refs.push({ id, name: id.slice('refs/heads/'.length), kind: 'branch', current: true });
    } else if (entry.startsWith('refs/heads/')) refs.push({ id: entry, name: entry.slice('refs/heads/'.length), kind: 'branch', current: false });
    else if (entry.startsWith('refs/remotes/')) {
      if (entry.endsWith('/HEAD')) continue;
      refs.push({ id: entry, name: entry.slice('refs/remotes/'.length), kind: entry === baseRef ? 'base' : 'remote', current: false });
    } else if (entry.startsWith('tag: refs/tags/')) {
      const id = entry.slice('tag: '.length);
      refs.push({ id, name: id.slice('refs/tags/'.length), kind: 'tag', current: false });
    }
  }
  return refs;
}

/**
 * `log -z --format=HISTORY_FORMAT`: seven NUL-separated fields per commit, and a NUL between commits. A record whose hash, a
 * parent or time is malformed throws, since nothing after it lines up and git never prints one.
 */
export function parseHistory(output: string, baseRef?: string): HistoryCommit[] {
  const tokens = output.split('\0');
  const commits: HistoryCommit[] = [];
  for (let at = 0; at + HISTORY_FIELDS <= tokens.length; at += HISTORY_FIELDS) {
    const [hash, parentList, author, email, time, decorations, subject] = tokens.slice(at, at + HISTORY_FIELDS) as [string, string, string, string, string, string, string];
    // git ends the output with a newline after the last record
    const record = hash.replace(/^\n/, '');
    const parents = parentList === '' ? [] : parentList.split(' ');
    if (!isObjectName(record) || !parents.every(isObjectName) || !/^\d+$/.test(time)) throw new Error('git log printed a commit record that does not line up');
    commits.push({ hash: record, parents, author, email, authorDate: Number(time) * 1000, subject: subject.replace(/\n$/, ''), refs: parseDecorations(decorations, baseRef) });
  }
  return commits;
}

export interface HeadRef {
  readonly id: string;
  readonly name: string;
  readonly revision: string;
}

export interface HeadRefs {
  readonly head: HeadRef;
  readonly upstream?: HeadRef;
  readonly base?: HeadRef;
}

// for-each-ref's line per ref: the refname, its object and type, and an annotated tag's peeled object and type
const TIP_FORMAT = '%(refname)%00%(objecttype)%00%(objectname)%00%(*objecttype)%00%(*objectname)';

interface RefTip {
  readonly ref: string;
  readonly commit: string;
}

/** The refs under patterns (prefixes, as for-each-ref matches them) that name a commit, directly or through a tag, in git's order. */
async function refTips(repo: Repository, patterns: readonly string[]): Promise<RefTip[]> {
  const result = await repo.read(['for-each-ref', `--format=${TIP_FORMAT}`, ...repo.endOfOptions(), ...patterns.map(revision)], { maxOutputBytes: 64 * 1024 * 1024 });
  const tips: RefTip[] = [];
  for (const line of result.stdout.toString('utf8').split('\n')) {
    const [ref, type, object, peeledType, peeled] = line.split('\0');
    if (ref === undefined || !ref.startsWith('refs/')) continue;
    const commit = type === 'commit' ? object : type === 'tag' && peeledType === 'commit' ? peeled : undefined;
    if (commit !== undefined && isObjectName(commit)) tips.push({ ref, commit });
  }
  return tips;
}

async function tipOf(repo: Repository, ref: string): Promise<string | undefined> {
  return (await refTips(repo, [ref])).find((tip) => tip.ref === ref)?.commit;
}

const shortName = (ref: string): string => ref.replace(/^refs\/(heads|remotes|tags)\//, '');

/**
 * A branch named the way the reflog or the config names it ('main', 'origin/main' or a full refname): the remote branch it
 * is, or a local branch's upstream when that is a remote branch; undefined otherwise or when it no longer exists.
 */
async function remoteBranchOf(repo: Repository, name: string, viaUpstream: boolean): Promise<string | undefined> {
  const candidates = name.startsWith('refs/') ? [name] : [`refs/heads/${name}`, `refs/remotes/${name}`];
  for (const ref of candidates) {
    if (!isSafeRevision(ref) || (await tipOf(repo, ref)) === undefined) continue;
    if (ref.startsWith('refs/remotes/')) return ref;
    if (ref.startsWith('refs/heads/') && viaUpstream) {
      const upstream = await upstreamRef(repo, ref);
      return upstream?.startsWith('refs/remotes/') ? upstream : undefined;
    }
    return undefined;
  }
  return undefined;
}

// %(upstream) of a local branch: a full refname, or undefined when it has none
async function upstreamRef(repo: Repository, branchRef: string): Promise<string | undefined> {
  const result = await repo.read(['for-each-ref', '--format=%(refname)%00%(upstream)', ...repo.endOfOptions(), revision(branchRef)]);
  for (const line of result.stdout.toString('utf8').split('\n')) {
    const [ref, upstream] = line.split('\0');
    if (ref === branchRef && upstream !== undefined && upstream !== '' && isSafeRevision(upstream)) return upstream;
  }
  return undefined;
}

// The newest-first reflog messages of a ref; none when it has no reflog.
async function reflog(repo: Repository, ref: string): Promise<string[]> {
  const result = await repo.read(['log', '-g', '--no-color', '--format=%gs', ...repo.endOfOptions(), revision(ref), '--'], { maxOutputBytes: 16 * 1024 * 1024 });
  return result.stdout.toString('utf8').split('\n').filter((line) => line !== '');
}

/**
 * The branch a local branch was created from, as VS Code's getBranchBaseFromReflog reads it: its one "branch: Created from X"
 * entry; from HEAD, the branch HEAD's oldest "checkout: moving from X to <branch>" entry names.
 */
export async function createdFrom(repo: Repository, branch: string): Promise<string | undefined> {
  const created = (await reflog(repo, `refs/heads/${branch}`)).filter((line) => line.startsWith('branch: Created from '));
  if (created.length !== 1) return undefined;
  const name = created[0]!.slice('branch: Created from '.length);
  if (name !== 'HEAD') return name;
  const moves = (await reflog(repo, 'HEAD')).flatMap((line) => {
    const match = /^checkout: moving from (\S+) to (.+)$/.exec(line);
    return match && match[2] === branch ? [match[1]!] : [];
  });
  return moves.at(-1);
}

// VS Code's getDefaultRemote: origin, else the first remote; the upstream's remote first when there is one.
async function defaultRemote(repo: Repository, upstream: string | undefined): Promise<string | undefined> {
  const names = (await repo.read(['remote'])).stdout.toString('utf8').split(/\r?\n/).filter((name) => name !== '' && isRemoteName(name));
  const upstreamRemote = upstream?.startsWith('refs/remotes/') ? names.find((name) => upstream.startsWith(`refs/remotes/${name}/`)) : undefined;
  return upstreamRemote ?? (names.includes('origin') ? 'origin' : names[0]);
}

// What refs/remotes/<remote>/HEAD points to, when it is a symbolic ref to a branch of that remote.
async function remoteHead(repo: Repository, remote: string): Promise<string | undefined> {
  const ref = `refs/remotes/${remote}/HEAD`;
  const result = await repo.read(['for-each-ref', '--format=%(refname)%00%(symref)', ...repo.endOfOptions(), revision(ref)]);
  for (const line of result.stdout.toString('utf8').split('\n')) {
    const [name, target] = line.split('\0');
    if (name === ref && target !== undefined && target.startsWith(`refs/remotes/${remote}/`) && isSafeRevision(target)) return target;
  }
  return undefined;
}

/**
 * The base ref of a local branch, as VS Code's getBranchBase resolves it, read only: `branch.<name>.vscode-merge-base` when it
 * names an existing remote branch; else the branch the reflog says it was created from (a remote branch, or a local branch's
 * upstream); else what refs/remotes/<remote>/HEAD points to, for the upstream's remote (VS Code's default remote without one).
 */
export async function resolveBaseRef(repo: Repository, branch: string, upstream: string | undefined): Promise<string | undefined> {
  const config = await repo.read(['config', '--get', `branch.${branch}.vscode-merge-base`], { allowFailure: true });
  const configured = config.exitCode === 0 ? config.stdout.toString('utf8').trim() : '';
  if (configured !== '') {
    const fromConfig = await remoteBranchOf(repo, configured, false);
    if (fromConfig) return fromConfig;
  }
  const from = await createdFrom(repo, branch);
  const fromReflog = from === undefined ? undefined : await remoteBranchOf(repo, from, true);
  if (fromReflog) return fromReflog;
  const remote = await defaultRemote(repo, upstream);
  if (remote === undefined) return undefined;
  const target = await remoteHead(repo, remote);
  return target !== undefined && (await tipOf(repo, target)) !== undefined ? target : undefined;
}

/**
 * HEAD, its upstream and its base ref with their commits; undefined while HEAD is unborn. The base is left out when it is the
 * upstream, and a detached HEAD has neither. A base that cannot be read (an oversized or corrupt reflog) is logged and left
 * out, as VS Code's getBranchBase does, so it costs the badge and never the history.
 */
export async function readHeadRefs(repo: Repository, log: (line: string) => void): Promise<HeadRefs | undefined> {
  const commit = await repo.read(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { allowFailure: true });
  if (commit.exitCode !== 0) return undefined;
  const revisionOfHead = commit.stdout.toString('utf8').trim();
  const symbolic = await repo.read(['symbolic-ref', '-q', 'HEAD'], { allowFailure: true });
  const branchRef = symbolic.exitCode === 0 ? symbolic.stdout.toString('utf8').trim() : undefined;
  if (branchRef === undefined || !branchRef.startsWith('refs/heads/') || !isSafeRevision(branchRef)) {
    return { head: { id: 'HEAD', name: revisionOfHead.slice(0, 7), revision: revisionOfHead } };
  }
  const head = { id: branchRef, name: shortName(branchRef), revision: revisionOfHead };
  const upstreamName = await upstreamRef(repo, branchRef);
  const upstreamTip = upstreamName === undefined ? undefined : await tipOf(repo, upstreamName);
  const upstream = upstreamName !== undefined && upstreamTip !== undefined ? { id: upstreamName, name: shortName(upstreamName), revision: upstreamTip } : undefined;
  const baseName = await resolveBaseRef(repo, head.name, upstream?.id).catch((err: unknown) => {
    if (err instanceof GitUntrustedError || err instanceof GitQueueDisposedError) throw err;
    log(`[scm] the base ref of ${head.name} could not be read: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  });
  const baseTip = baseName === undefined || baseName === upstream?.id ? undefined : await tipOf(repo, baseName);
  const base = baseName !== undefined && baseTip !== undefined ? { id: baseName, name: shortName(baseName), revision: baseTip } : undefined;
  return { head, ...(upstream ? { upstream } : {}), ...(base ? { base } : {}) };
}

/** `rev-list --left-right --count a...b`: the commits only a has, and only b has. */
export async function aheadBehind(repo: Repository, a: string, b: string): Promise<{ readonly ahead: number; readonly behind: number }> {
  const result = await repo.read(['rev-list', '--left-right', '--count', ...repo.endOfOptions(), `${revision(a)}...${revision(b)}`]);
  const [ahead, behind] = result.stdout.toString('utf8').trim().split(/\s+/).map(Number);
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) throw new Error('git rev-list printed no counts');
  return { ahead: ahead!, behind: behind! };
}

/** merge-base of two commits; undefined when they share none (exit 1: unrelated histories, or a shallow clone's cut). */
export async function mergeBase(repo: Repository, a: string, b: string): Promise<string | undefined> {
  const result = await repo.read(['merge-base', ...repo.endOfOptions(), revision(a), revision(b)], { allowFailure: true });
  if (result.exitCode === 1) return undefined;
  if (result.exitCode !== 0) throw new Error(`git merge-base exited with ${result.exitCode}: ${result.stderr.trim()}`);
  const base = result.stdout.toString('utf8').trim();
  return isObjectName(base) ? base : undefined;
}

export type HistoryChoice = 'auto' | 'all' | readonly string[];

export interface HistoryLoad {
  readonly headRefs: HeadRefs;
  readonly mergeBase?: string;
  readonly ahead: number;
  readonly behind: number;
  readonly resolvedRefs: readonly string[];
  // the distinct commits the refs resolved to, which every page logs from
  readonly tips: readonly string[];
}

// auto: HEAD's ref, its upstream and its base, with their commits
function autoRefs(headRefs: HeadRefs): RefTip[] {
  return [headRefs.head, headRefs.upstream, headRefs.base].flatMap((ref) => (ref ? [{ ref: ref.id, commit: ref.revision }] : []));
}

/**
 * Resolves a ref choice once (VS Code's _resolveHistoryItemFilter): auto, all (every local branch, remote branch but a
 * remote's HEAD, and tag, and a detached HEAD, as git's --all includes HEAD), or the refs picked that still exist, auto when
 * none does; the picked names are matched against one listing, so none reaches git's argv. Undefined while HEAD is unborn. A
 * choice past MAX_HISTORY_TIPS distinct commits throws.
 */
export async function loadHistory(repo: Repository, choice: HistoryChoice, log: (line: string) => void): Promise<HistoryLoad | undefined> {
  const headRefs = await readHeadRefs(repo, log);
  if (!headRefs) return undefined;
  let refs: RefTip[];
  if (choice === 'auto') refs = autoRefs(headRefs);
  else {
    const listed = (await refTips(repo, ['refs/heads', 'refs/remotes', 'refs/tags'])).filter((tip) => !(tip.ref.startsWith('refs/remotes/') && tip.ref.endsWith('/HEAD')));
    if (choice === 'all') refs = headRefs.head.id === 'HEAD' ? [{ ref: 'HEAD', commit: headRefs.head.revision }, ...listed] : listed;
    else {
      const byRef = new Map(listed.map((tip) => [tip.ref, tip]));
      refs = choice.flatMap((ref) => byRef.get(ref) ?? []);
      if (refs.length === 0) refs = autoRefs(headRefs);
    }
  }
  const tips = [...new Set(refs.map((tip) => tip.commit))];
  if (tips.length > MAX_HISTORY_TIPS) throw new Error(`The refs chosen name ${tips.length} commits, more than the Graph loads (${MAX_HISTORY_TIPS})`);
  const upstream = headRefs.upstream;
  const counts = upstream ? await aheadBehind(repo, headRefs.head.revision, upstream.revision) : { ahead: 0, behind: 0 };
  const base = upstream ? await mergeBase(repo, headRefs.head.revision, upstream.revision) : undefined;
  return { headRefs, ...(base !== undefined ? { mergeBase: base } : {}), ...counts, resolvedRefs: refs.map((tip) => tip.ref), tips };
}

/**
 * One page: the commits reachable from tips, in topological order, after skip of them. The tips go in on stdin, since All
 * can pass more than a command line holds. baseRef marks the base ref's badge.
 */
export async function readHistoryPage(repo: Repository, tips: readonly string[], skip: number, baseRef?: string): Promise<HistoryCommit[]> {
  if (!Number.isInteger(skip) || skip < 0) throw new Error('A history page skips a whole number of commits');
  for (const tip of tips) if (!isObjectName(tip)) throw new Error('A history page logs from full object names');
  // git log with nothing on stdin logs HEAD
  if (tips.length === 0) return [];
  const args = ['-c', 'i18n.logOutputEncoding=UTF-8', 'log', `--format=${HISTORY_FORMAT}`, '-z', '--topo-order', '--decorate=full', '--no-show-signature', '--no-color', `--skip=${skip}`, `-n${HISTORY_PAGE}`, '--stdin'];
  const result = await repo.read(args, { input: `${tips.join('\n')}\n`, maxOutputBytes: 64 * 1024 * 1024 });
  return parseHistory(result.stdout.toString('utf8'), baseRef);
}

/** Whether hash is a full object name of a commit of this repository (`cat-file -t`). */
export async function isCommit(repo: Repository, hash: string): Promise<boolean> {
  if (!isObjectName(hash)) return false;
  const result = await repo.read(['cat-file', '-t', revision(hash)], { allowFailure: true });
  return result.exitCode === 0 && result.stdout.toString('utf8').trim() === 'commit';
}

/**
 * A commit the user typed (Cherry Pick... from the palette), verified with `rev-parse --verify <rev>^{commit}`: its full
 * hash, or undefined when it names no commit. Text with a leading '-', whitespace or a control character is refused.
 */
export async function resolveTypedCommit(repo: Repository, typed: string): Promise<string | undefined> {
  // eslint-disable-next-line no-control-regex
  if (typed === '' || typed.length > 1024 || typed.startsWith('-') || /[\s\u0000-\u001f\u007f]/.test(typed)) return undefined;
  const result = await repo.read(['rev-parse', '-q', '--verify', ...(gitAtLeast(repo.gitVersion, 2, 30) ? ['--end-of-options'] : []), `${typed}^{commit}`], { allowFailure: true });
  const hash = result.stdout.toString('utf8').trim();
  return result.exitCode === 0 && isObjectName(hash) ? hash : undefined;
}

/** The full message of a commit, `log -1 --format=%B` in UTF-8, without its final newlines. */
export async function commitMessage(repo: Repository, hash: string): Promise<string> {
  const result = await repo.read(['-c', 'i18n.logOutputEncoding=UTF-8', 'log', '-1', '--no-color', '--no-show-signature', '--format=%B', ...repo.endOfOptions(), revision(hash), '--'], { maxOutputBytes: MAX_SHOW_BYTES });
  return result.stdout.toString('utf8').replace(/\n+$/, '');
}

export interface CommitFile {
  readonly path: string;
  readonly oldPath?: string;
  readonly status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T';
}

export interface CommitDetails {
  readonly hash: string;
  readonly parents: readonly string[];
  readonly message: string;
  readonly messageTruncated: boolean;
  readonly author: string;
  readonly email: string;
  readonly authorDate: number;
  readonly stat?: { readonly files: number; readonly insertions: number; readonly deletions: number };
  readonly files: readonly CommitFile[];
  readonly filesTruncated: boolean;
}

/** `--shortstat`'s line; an empty commit prints none, which is no change. */
export function parseShortStat(output: string): { readonly files: number; readonly insertions: number; readonly deletions: number } {
  const match = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(output);
  return match ? { files: Number(match[1]), insertions: Number(match[2] ?? 0), deletions: Number(match[3] ?? 0) } : { files: 0, insertions: 0, deletions: 0 };
}

export type CommitFields = Pick<CommitDetails, 'hash' | 'parents' | 'message' | 'messageTruncated' | 'author' | 'email' | 'authorDate'>;

/** A commit's parents, author, date and message (cut at MAX_MESSAGE_CHARS), read in UTF-8. */
export async function readCommitFields(repo: Repository, hash: string): Promise<CommitFields> {
  const fields = await repo.read(['-c', 'i18n.logOutputEncoding=UTF-8', 'log', '-1', '-z', '--no-color', '--no-show-signature', '--format=%H%x00%P%x00%aN%x00%aE%x00%at%x00%B', ...repo.endOfOptions(), revision(hash), '--'], { maxOutputBytes: MAX_SHOW_BYTES });
  const [shown, parentList, author, email, time, ...body] = fields.stdout.toString('utf8').split('\0');
  const parents = parentList ? parentList.split(' ') : [];
  if (shown !== hash || !parents.every(isObjectName)) throw new Error('git log printed another commit');
  const full = body.join('').replace(/\n+$/, '');
  const message = cutAt(full, MAX_MESSAGE_CHARS);
  return { hash, parents, message, messageTruncated: message.length < full.length, author: author ?? '', email: email ?? '', authorDate: Number(time ?? 0) * 1000 };
}

/** The empty tree's object name in this repository's hash, which a root commit is compared against. */
export async function emptyTreeOf(repo: Repository): Promise<string> {
  return (await repo.read(['hash-object', '-t', 'tree', '--stdin'], { input: '' })).stdout.toString('utf8').trim();
}

/**
 * An expanded commit: its message (cut at MAX_MESSAGE_CHARS), author and date, `--shortstat --diff-merges=first-parent` from
 * git 2.31 (a root commit against the empty tree), and its files against its first parent or the empty tree.
 */
export async function readCommitDetails(repo: Repository, hash: string): Promise<CommitDetails> {
  const fields = await readCommitFields(repo, hash);
  let stat: CommitDetails['stat'];
  if (gitAtLeast(repo.gitVersion, 2, 31)) {
    const shortStat = await repo.read(['log', '-1', '--format=', '--shortstat', '--root', '--diff-merges=first-parent', '--no-color', '--no-show-signature', ...repo.endOfOptions(), revision(hash), '--']);
    stat = parseShortStat(shortStat.stdout.toString('utf8'));
  }
  const left = fields.parents[0] ?? (await emptyTreeOf(repo));
  const diff = await diffRefs(repo, left, hash);
  const files = diff.entries.slice(0, MAX_DETAIL_FILES).map(({ change }) => ({
    path: change.path,
    ...(change.originalPath !== undefined ? { oldPath: change.originalPath } : {}),
    status: change.letter as CommitFile['status'],
  }));
  return {
    ...fields,
    ...(stat ? { stat } : {}),
    files,
    filesTruncated: diff.entries.length > MAX_DETAIL_FILES,
  };
}

// At most max UTF-16 units of text, never ending inside a surrogate pair.
function cutAt(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}
