// The merge editor's inputs and git's own merge of them, after VS Code's git.openMergeEditor and git.runGitMerge
// (extensions/git/src/commands.ts, git.ts mergeFile).
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gitAtLeast } from './git-runner';
import { checkRepoPath, MAX_SHOW_BYTES, type Operation, type Repository } from './repository';
import { decodeBlob, isBinary, readBlob, type TextCodec } from './staging';
import { englishText, type LocalizedText } from '../../shared/localized-text';

export type MergeOperation = 'merge' | 'rebase' | 'cherryPick' | 'stash' | 'worktreeApply';

export interface MergeLabel {
  readonly title: LocalizedText;
  // what this input's conflict markers say, in Compute Conflicts With Git and in Reset Result alike (markerName)
  readonly marker: string;
  // the commit's short hash
  readonly description?: string;
  // the commit's ref names, HEAD's arrow dropped
  readonly detail?: string;
}

export interface MergeLabels {
  readonly current: MergeLabel;
  readonly incoming: MergeLabel;
  readonly base: MergeLabel;
}

export interface MergeTitles {
  readonly current: LocalizedText;
  readonly incoming: LocalizedText;
  readonly base: LocalizedText;
  readonly stash: LocalizedText;
  // slice 12a's Apply: "{branch} (worktree)"
  readonly worktree: (branch: string) => LocalizedText;
}

// The commit each operation brings in (VS Code reads MERGE_HEAD, or REBASE_HEAD while rebasing).
const INCOMING_HEAD: Readonly<Record<'merge' | 'rebase' | 'cherryPick', string>> = { merge: 'MERGE_HEAD', rebase: 'REBASE_HEAD', cherryPick: 'CHERRY_PICK_HEAD' };

/**
 * git stash apply's conflict markers name the stash's side "Stashed changes" (VS Code's isStashConflict check); a marker is
 * seven characters or the longer conflict-marker-size of the path's attributes.
 */
export function isStashConflict(fileText: string): boolean {
  const match = /^>{7,} (.*)$/m.exec(fileText);
  return match?.[1]?.trimEnd() === 'Stashed changes';
}

/** Which operation a conflict comes from: the repository's operation in progress, else a stash apply's markers. */
export function mergeOperationOf(operation: Operation | null, fileText: string): MergeOperation {
  if (operation !== null) return operation;
  return isStashConflict(fileText) ? 'stash' : 'merge';
}

/** The titles of the two inputs: Current and Incoming, Incoming named "Stashed Changes" for a stash or "{branch} (worktree)" for a worktree's Apply. */
export function mergeTitles(operation: MergeOperation, titles: MergeTitles, worktreeBranch?: string): { readonly current: LocalizedText; readonly incoming: LocalizedText; readonly base: LocalizedText } {
  const incoming = operation === 'stash' ? titles.stash : operation === 'worktreeApply' && worktreeBranch !== undefined ? titles.worktree(worktreeBranch) : titles.incoming;
  return { current: titles.current, incoming, base: titles.base };
}

/** %D's ref names as VS Code's merge editor details them: "HEAD -> " dropped, a bare HEAD left out. */
export function refNames(decoration: string): string {
  return decoration
    .split(',')
    .map((name) => name.trim().replace(/^HEAD -> /, ''))
    .filter((name) => name !== '' && name !== 'HEAD')
    .join(', ');
}

interface Stages {
  readonly base?: string;
  readonly current: string;
  readonly incoming: string;
}

export type MergeRefusal = 'notConflicted' | 'binary' | 'tooLarge' | 'encoding';

// The unmerged stages' blobs: base (1, absent for AA), current (2) and incoming (3); notConflicted without both 2 and 3.
async function stagesOf(repo: Repository, relativePath: string): Promise<Stages | undefined> {
  const listed = (await repo.read(['ls-files', '-u', '-z', '--', relativePath], { literalPathspecs: true })).stdout.toString('utf8');
  const oids = new Map<string, string>();
  for (const record of listed.split('\0')) {
    const match = /^\d{6} ([0-9a-f]{40}|[0-9a-f]{64}) ([123])\t(.*)$/s.exec(record);
    if (match && match[3] === relativePath) oids.set(match[2]!, match[1]!);
  }
  const current = oids.get('2');
  const incoming = oids.get('3');
  if (current === undefined || incoming === undefined) return undefined;
  const base = oids.get('1');
  return { ...(base !== undefined ? { base } : {}), current, incoming };
}

export type MergeInputs =
  | { readonly ok: true; readonly base: string; readonly current: string; readonly incoming: string; readonly labels: MergeLabels; readonly operation: MergeOperation }
  | { readonly ok: false; readonly reason: MergeRefusal };

/**
 * show :1:, :2: and :3: decoded with the document's codec, with the operation's labels. During a rebase Current is the
 * branch being rebased onto (HEAD, :2:) and Incoming REBASE_HEAD (:3:); the merge editor then shows Current first, as VS Code
 * swaps its inputs. fileText: the conflicted file's text, whose markers tell a stash apply.
 */
export async function readMergeInputs(repo: Repository, relativePath: string, codec: TextCodec, fileText: string, titles: MergeTitles, worktreeBranch?: string): Promise<MergeInputs> {
  checkRepoPath(relativePath);
  const stages = await stagesOf(repo, relativePath);
  if (!stages) return { ok: false, reason: 'notConflicted' };
  const texts: string[] = [];
  for (const oid of [stages.base, stages.current, stages.incoming]) {
    if (oid === undefined) {
      texts.push('');
      continue;
    }
    const bytes = await readBlob(repo, oid);
    if (bytes === 'tooLarge') return { ok: false, reason: 'tooLarge' };
    if (isBinary(bytes, codec)) return { ok: false, reason: 'binary' };
    const text = decodeBlob(bytes, codec);
    if (text === undefined) return { ok: false, reason: 'encoding' };
    texts.push(text);
  }
  const operation = mergeOperationIn(repo, fileText, worktreeBranch);
  return { ok: true, base: texts[0]!, current: texts[1]!, incoming: texts[2]!, labels: await mergeLabels(repo, operation, titles, worktreeBranch), operation };
}

/** The operation a conflict of the repository comes from; a worktree Apply's has no MERGE_HEAD, so the caller names its branch. */
export function mergeOperationIn(repo: Repository, fileText: string, worktreeBranch?: string): MergeOperation {
  return worktreeBranch !== undefined ? 'worktreeApply' : mergeOperationOf(repo.lastStatus?.operation ?? null, fileText);
}

/** The inputs' labels: the operation's titles, each side with its short hash and ref names, and each input's marker name. */
export async function mergeLabels(repo: Repository, operation: MergeOperation, titles: MergeTitles, worktreeBranch?: string): Promise<MergeLabels> {
  const named = mergeTitles(operation, titles, worktreeBranch);
  const incomingHead = operation === 'merge' || operation === 'rebase' || operation === 'cherryPick' ? INCOMING_HEAD[operation] : undefined;
  const [head, incoming] = await Promise.all([commitLabel(repo, 'HEAD'), incomingHead === undefined ? Promise.resolve({}) : commitLabel(repo, incomingHead)]);
  // a rebase that replayed commits already has HEAD past the branch it rebases onto, so the branch is read from git's onto
  const current = operation === 'rebase' && head.detail === undefined ? { ...head, ...(await ontoBranches(repo)) } : head;
  const label = (title: LocalizedText, commit: Pick<MergeLabel, 'description' | 'detail'>): MergeLabel => ({ title, marker: markerName(title, commit), ...commit });
  return { current: label(named.current, current), incoming: label(named.incoming, incoming), base: label(named.base, {}) };
}

// An input's conflict marker name: its ref names, else its short hash, else its title in English, whatever language the view shows.
function markerName(title: LocalizedText, commit: Pick<MergeLabel, 'description' | 'detail'>): string {
  return commit.detail || commit.description || englishText(title);
}

// The branches at a rebase's onto commit (rebase-merge/onto, or rebase-apply/onto for an apply rebase), as a label detail.
async function ontoBranches(repo: Repository): Promise<Pick<MergeLabel, 'detail'>> {
  for (const folder of ['rebase-merge', 'rebase-apply']) {
    const onto = (await fs.readFile(path.join(repo.info.gitDir, folder, 'onto'), 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return undefined;
      throw err;
    }))?.trim();
    if (onto === undefined || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(onto)) continue;
    const listed = await repo.read(['for-each-ref', '--format=%(refname:short)', `--points-at=${onto}`, 'refs/heads', 'refs/remotes']);
    const names = listed.stdout.toString('utf8').split('\n').filter((name) => name !== '');
    return names.length > 0 ? { detail: names.join(', ') } : {};
  }
  return {};
}

// A commit's short hash and ref names; nothing when the ref does not resolve (MERGE_HEAD gone meanwhile).
async function commitLabel(repo: Repository, ref: string): Promise<Pick<MergeLabel, 'description' | 'detail'>> {
  const result = await repo.read(['log', '-1', '--no-walk', '--no-show-signature', '--format=%H%x00%D', ref, '--'], { allowFailure: true });
  if (result.exitCode !== 0) return {};
  const [hash, decoration] = result.stdout.toString('utf8').trim().split('\0');
  if (hash === undefined || hash === '') return {};
  const detail = refNames(decoration ?? '');
  return { description: hash.slice(0, 7), ...(detail !== '' ? { detail } : {}) };
}

export type MergeFileResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: MergeRefusal | 'failed' };

/**
 * git merge-file -p of current, base and incoming (diff3 adds the base section), its markers named by each label's marker and
 * as long as the path's conflict-marker-size attribute makes git's own merge write them. On git 2.43 or later it
 * reads the blobs by --object-id; otherwise, or with no base (AA), it runs on three files in a fresh folder under the OS temp
 * folder, which is always removed.
 */
export async function mergeFile(repo: Repository, relativePath: string, codec: TextCodec, diff3: boolean, labels: MergeLabels): Promise<MergeFileResult> {
  checkRepoPath(relativePath);
  const stages = await stagesOf(repo, relativePath);
  if (!stages) return { ok: false, reason: 'notConflicted' };
  const style = diff3 ? '--diff3' : '--no-diff3';
  const named = ['-L', labels.current.marker, '-L', labels.base.marker, '-L', labels.incoming.marker];
  // check-attr -z: path, attribute and value, NUL-separated
  const sizeValue = (await repo.read(['check-attr', '-z', 'conflict-marker-size', '--', relativePath], { literalPathspecs: true })).stdout.toString('utf8').split('\0')[2];
  const markerSize = sizeValue !== undefined && /^[1-9]\d{0,3}$/.test(sizeValue) ? [`--marker-size=${sizeValue}`] : [];
  const run = (inputs: readonly string[], objectId: boolean): ReturnType<Repository['read']> =>
    repo.read(['merge-file', '-p', style, ...markerSize, ...(objectId ? ['--object-id'] : []), ...named, '--', ...inputs], { allowFailure: true, maxOutputBytes: MAX_SHOW_BYTES * 3 });
  let result: Awaited<ReturnType<Repository['read']>>;
  if (gitAtLeast(repo.gitVersion, 2, 43) && stages.base !== undefined) {
    result = await run([stages.current, stages.base, stages.incoming], true);
  } else {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'damocles-merge-'));
    try {
      const files: string[] = [];
      for (const [name, oid] of [['current', stages.current], ['base', stages.base], ['incoming', stages.incoming]] as const) {
        const bytes = oid === undefined ? Buffer.alloc(0) : await readBlob(repo, oid);
        if (bytes === 'tooLarge') return { ok: false, reason: 'tooLarge' };
        const file = path.join(folder, name);
        await fs.writeFile(file, bytes);
        files.push(file);
      }
      result = await run(files, false);
    } finally {
      await fs.rm(folder, { recursive: true, force: true });
    }
  }
  // the exit code is the number of conflicts, at most 127; a negative one (255) is git's refusal, a binary file included
  if (result.exitCode > 127) return { ok: false, reason: /binary/i.test(result.stderr) ? 'binary' : 'failed' };
  const text = decodeBlob(result.stdout, codec);
  return text === undefined ? { ok: false, reason: 'encoding' } : { ok: true, text };
}
