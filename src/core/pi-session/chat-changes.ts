/**
 * chat-changes.ts — What a chat changed (D60, docs/invariants.md "Chat review"): the file set, each file's baseline, its
 * counts and its outside-edit mark, and the review message core composes from its own diff.
 *
 * A project-folder chat's set comes from its tool records only (Edit, Write and GenerateImage results on its branch, plus
 * its subagents' and teams' agent files), never from git status, so shell commands and other chats are never counted. A
 * worktree chat's set is every change in its worktree against its base commit (`worktreeChanges`).
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { applyPatch, diffLines, parsePatch, reversePatch, structuredPatch, type StructuredPatchHunk } from 'diff';
import { TOOL_EDIT, TOOL_GENERATE_IMAGE, TOOL_WRITE } from '../../shared/tool-names';
import { folderKey } from '../workspace-folders/folder-key';
import type { PersistedAgentMessage } from './agent-records';
import { normalized } from './tools/file-patch';
import { resolveToCwd } from './tools/search-tools';

// pi records its write under its own lowercase name, which the transcript shows as Write.
const PI_WRITE = 'write';
// Inserted plus deleted lines above which no line diff is computed (jsdiff's cost grows with the square of it).
const MAX_DIFF_EDIT_LENGTH = 20_000;
// Equals MAX_DIFF_BYTES in scm/repository.ts, the most of one file's diff source control sends the shell.
export const MAX_PATCH_BYTES: number = 5 * 1024 * 1024;
// The context lines of the review's unified diff, which the tab shows and comments name.
const DIFF_CONTEXT = 3;

export type ChatScope = 'chat' | 'turn';

/** One file change a tool record made. */
export interface ChangeRecord {
  // the user entry id of the turn on the chat's branch it belongs to
  readonly turn: string;
  // the working folder the record was made in (absolute, native)
  readonly folder: string;
  // the file, absolute and native
  readonly file: string;
  // the change's unified patch, LF line endings, real line numbers
  readonly patch?: string;
  // a Write that created the file, with every line it wrote
  readonly created?: { readonly content: string };
  // a generated image, or a change whose old content was binary
  readonly binary?: true;
  // GenerateImage, which only creates new files
  readonly generated?: true;
}

/** A hand-off (D61): from this branch entry on, the chat works in folder. */
export interface HandOff {
  readonly entryId: string;
  readonly folder: string;
}

export interface RecordsInput {
  readonly branch: readonly SessionEntry[];
  // the chat's working folder before any hand-off
  readonly folder: string;
  readonly handOffs: readonly HandOff[];
  // each agent invocation's messages, by the parent's tool call id that launched or resumed it (subagents and team members)
  readonly agentMessages: ReadonlyMap<string, readonly PersistedAgentMessage[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The record a successful Edit, Write or GenerateImage result makes, from its call's arguments and its details. Each path
// resolves as its tool resolved it: pi's write through resolveToCwd, Edit and GenerateImage's details against the folder.
function recordOf(toolName: string, args: Record<string, unknown> | undefined, details: unknown, turn: string, folder: string): ChangeRecord | undefined {
  const named = (key: string): string | undefined => (typeof args?.[key] === 'string' ? (args[key] as string) : undefined);
  const resolve = (file: string | undefined): string | undefined => (file === undefined || file === '' ? undefined : path.resolve(folder, file));
  if (toolName === TOOL_GENERATE_IMAGE) {
    const file = resolve(isRecord(details) && typeof details['filePath'] === 'string' ? details['filePath'] : named('file_path'));
    return file === undefined ? undefined : { turn, folder, file, binary: true, generated: true };
  }
  if (toolName === TOOL_EDIT) {
    const file = resolve(named('file_path'));
    if (file === undefined) return undefined;
    const patch = isRecord(details) && typeof details['patch'] === 'string' ? details['patch'] : undefined;
    return { turn, folder, file, ...(patch !== undefined ? { patch } : {}) };
  }
  if (toolName === PI_WRITE || toolName === TOOL_WRITE) {
    const written = named('path') ?? named('file_path');
    if (written === undefined || written === '') return undefined;
    const file = resolveToCwd(written, folder);
    if (isRecord(details) && details['created'] === true) return { turn, folder, file, created: { content: named('content') ?? '' } };
    if (isRecord(details) && typeof details['patch'] === 'string') return { turn, folder, file, patch: details['patch'] };
    if (isRecord(details) && details['patchOmitted'] === 'binary') return { turn, folder, file, binary: true };
    return { turn, folder, file };
  }
  return undefined;
}

/** Tool calls' arguments by call id and the records of the successful file results, read message by message. */
class RecordReader {
  private readonly args = new Map<string, Record<string, unknown>>();

  // The records message makes; an assistant message's tool calls only register their arguments.
  read(message: unknown, turn: string, folder: string): ChangeRecord[] {
    if (!isRecord(message)) return [];
    if (message['role'] === 'assistant' && Array.isArray(message['content'])) {
      for (const block of message['content']) {
        if (isRecord(block) && block['type'] === 'toolCall' && typeof block['id'] === 'string' && isRecord(block['arguments'])) this.args.set(block['id'], block['arguments']);
      }
      return [];
    }
    if (message['role'] !== 'toolResult' || message['isError'] === true || typeof message['toolName'] !== 'string') return [];
    const callId = typeof message['toolCallId'] === 'string' ? message['toolCallId'] : '';
    const record = recordOf(message['toolName'], this.args.get(callId), message['details'], turn, folder);
    return record ? [record] : [];
  }
}

function recordsOfMessages(messages: readonly unknown[], turn: string, folder: string): ChangeRecord[] {
  const reader = new RecordReader();
  return messages.flatMap((message) => reader.read(message, turn, folder));
}

/**
 * The chat's file change records in branch order. A result belongs to the turn of the last user message before it; an agent
 * invocation's records to the turn of the call that launched or resumed it, in its folder, at that call's place.
 */
export function collectRecords(input: RecordsInput): ChangeRecord[] {
  const handOffs = new Map(input.handOffs.map((handOff) => [handOff.entryId, handOff.folder]));
  const out: ChangeRecord[] = [];
  let folder = input.folder;
  let turn: string | undefined;
  let reader = new RecordReader();
  for (const entry of input.branch) {
    folder = handOffs.get(entry.id) ?? folder;
    if (entry.type !== 'message') continue;
    const message: unknown = entry.message;
    if (!isRecord(message)) continue;
    if (message['role'] === 'user') {
      turn = entry.id;
      reader = new RecordReader();
      continue;
    }
    if (turn === undefined) continue;
    out.push(...reader.read(message, turn, folder));
    if (message['role'] !== 'assistant' || !Array.isArray(message['content'])) continue;
    for (const block of message['content']) {
      const agent = isRecord(block) && block['type'] === 'toolCall' && typeof block['id'] === 'string' ? input.agentMessages.get(block['id']) : undefined;
      if (agent) out.push(...recordsOfMessages(agent, turn, folder));
    }
  }
  return out;
}

/** The turns of a branch, oldest first: each user message entry's id. */
export function turnsOnBranch(branch: readonly SessionEntry[]): string[] {
  return branch.flatMap((entry) => {
    const message: unknown = entry.type === 'message' ? entry.message : undefined;
    return isRecord(message) && message['role'] === 'user' ? [entry.id] : [];
  });
}

/** A side of a file: its text, missing, binary (digest: sha1 of its bytes, when they were read), or unknown (nothing holds it). */
export type FileText =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'binary'; readonly digest?: string }
  | { readonly kind: 'unavailable' };

/** The file on disk: its side, past the review's size bound, or a read that failed (locked, denied). */
export type DiskRead = FileText | { readonly kind: 'tooLarge' } | { readonly kind: 'unreadable' };

export interface ChatChangesIo {
  /**
   * The file in the checkpoint taken before (or after) a turn, from the checkpoint repo of the folder the turn ran in;
   * relativePath is '/' relative to that folder. unavailable when no checkpoint holds it (a home-folder chat, a turn that is
   * not rewindable, a checkpoint removed by retention, a running turn whose baseline is not taken); tooLarge past the bound
   * a checkpoint blob is read to.
   */
  checkpoint(turn: string, relativePath: string, side: 'before' | 'after'): Promise<FileText | { readonly kind: 'tooLarge' }>;
  // the file on disk now; an unsaved buffer is not now
  disk(absolute: string): Promise<DiskRead>;
}

/** How a changed file's diff is shown. */
export type ChatFileDiff =
  | { readonly kind: 'texts'; readonly before: string; readonly after: string }
  // the recorded patches, when no baseline could be rebuilt
  | { readonly kind: 'patches'; readonly patch: string }
  | { readonly kind: 'binary' }
  | { readonly kind: 'tooLarge' }
  | { readonly kind: 'unreadable' };

export interface ChatChangeFile {
  // '/' relative to the chat's working folder, or absolute (native) outside it
  readonly path: string;
  readonly absolute: string;
  readonly status: 'A' | 'M' | 'D';
  readonly added: number;
  readonly removed: number;
  readonly binary: boolean;
  readonly outsideEdits: boolean;
  readonly diff: ChatFileDiff;
  // changes whenever what the diff shows changes, counts unchanged included
  readonly revision: string;
}

function isInsideFolder(folder: string, file: string): boolean {
  const relative = path.relative(folder, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Where a record's file is now: the same path relative to the chat's current folder (D61), or the file itself outside it. */
export function nowPath(record: ChangeRecord, currentFolder: string): string {
  return isInsideFolder(record.folder, record.file) ? path.join(currentFolder, path.relative(record.folder, record.file)) : record.file;
}

function displayPath(absolute: string, currentFolder: string): string {
  return isInsideFolder(currentFolder, absolute) ? path.relative(currentFolder, absolute).split(path.sep).join('/') : absolute;
}

function lineCounts(before: string, after: string): { added: number; removed: number } | undefined {
  const changes = diffLines(before, after, { maxEditLength: MAX_DIFF_EDIT_LENGTH });
  if (!changes) return undefined;
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    if (change.added) added += change.count;
    else if (change.removed) removed += change.count;
  }
  return { added, removed };
}

function revisionOf(diff: ChatFileDiff): string {
  const hash = createHash('sha1').update(diff.kind);
  if (diff.kind === 'texts') hash.update('\0').update(diff.before).update('\0').update(diff.after);
  else if (diff.kind === 'patches') hash.update('\0').update(diff.patch);
  return hash.digest('hex').slice(0, 16);
}

// Applies the records forward onto base (undefined: absent); undefined when one does not apply or carries no patch.
function applyRecords(base: string | undefined, records: readonly ChangeRecord[]): string | undefined {
  let text = base ?? '';
  for (const record of records) {
    if (record.created) {
      text = normalized(record.created.content);
      continue;
    }
    if (record.patch === undefined) return undefined;
    const applied = applyPatch(text, record.patch);
    if (applied === false) return undefined;
    text = applied;
  }
  return text;
}

// The baseline rebuilt from now by undoing the records newest first; undefined when one does not undo.
function undoRecords(now: string, records: readonly ChangeRecord[]): string | undefined {
  let text = now;
  for (const record of [...records].reverse()) {
    if (record.patch === undefined) return undefined;
    const parsed = parsePatch(record.patch);
    if (parsed.length !== 1) return undefined;
    const undone = applyPatch(text, reversePatch(parsed[0]!));
    if (undone === false) return undefined;
    text = undone;
  }
  return text;
}

// One file's unified diff as git prints it: the two names, then each hunk with its real line numbers, where an empty side
// names the line before it (`@@ -0,0 +1,2 @@` for a new file), as jsdiff's own formatPatch and parsePatch read it.
function formatPatch(from: string, to: string, hunks: readonly StructuredPatchHunk[]): string {
  const body = hunks.flatMap((hunk) => [
    `@@ -${hunk.oldLines === 0 ? hunk.oldStart - 1 : hunk.oldStart},${hunk.oldLines} +${hunk.newLines === 0 ? hunk.newStart - 1 : hunk.newStart},${hunk.newLines} @@`,
    ...hunk.lines,
  ]);
  return [`--- ${from}`, `+++ ${to}`, ...body, ''].join('\n');
}

// The recorded patches joined under one file header, and their line counts.
function joinedPatches(records: readonly ChangeRecord[], shown: string): { patch: string; added: number; removed: number } {
  const hunks = records.flatMap((record) => (record.patch === undefined ? [] : parsePatch(record.patch).flatMap((parsed) => parsed.hunks)));
  const lines = hunks.flatMap((hunk) => hunk.lines);
  return { patch: formatPatch(`a/${shown}`, `b/${shown}`, hunks), added: lines.filter((line) => line.startsWith('+')).length, removed: lines.filter((line) => line.startsWith('-')).length };
}

type FileFields = Omit<ChatChangeFile, 'revision'>;

const withRevision = (file: FileFields): ChatChangeFile => ({ ...file, revision: revisionOf(file.diff) });

/**
 * The changed files of a project-folder chat in a scope: the whole chat, or only latestTurn's records against the
 * checkpoint before it. Each file compares its baseline (the checkpoint before the first turn that changed it, else rebuilt
 * from the records) with the file on disk now; a file back at its baseline drops out. currentFolder: the chat's working
 * folder now.
 */
export async function projectChatChanges(records: readonly ChangeRecord[], scope: ChatScope, latestTurn: string | undefined, currentFolder: string, io: ChatChangesIo): Promise<ChatChangeFile[]> {
  const scoped = scope === 'turn' ? records.filter((record) => record.turn === latestTurn) : records;
  const byFile = new Map<string, ChangeRecord[]>();
  for (const record of scoped) {
    const key = folderKey(nowPath(record, currentFolder));
    const held = byFile.get(key);
    if (held) held.push(record);
    else byFile.set(key, [record]);
  }
  const out: ChatChangeFile[] = [];
  for (const fileRecords of byFile.values()) {
    const changed = await fileChange(fileRecords, currentFolder, io);
    if (changed) out.push(withRevision(changed));
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

async function fileChange(records: readonly ChangeRecord[], currentFolder: string, io: ChatChangesIo): Promise<FileFields | undefined> {
  const first = records[0]!;
  const last = records[records.length - 1]!;
  const absolute = nowPath(last, currentFolder);
  const shown = displayPath(absolute, currentFolder);
  const relative = (record: ChangeRecord): string | undefined => (isInsideFolder(record.folder, record.file) ? path.relative(record.folder, record.file).split(path.sep).join('/') : undefined);
  const firstRelative = relative(first);
  const creates = first.created !== undefined || first.generated === true;
  const base = { path: shown, absolute, added: 0, removed: 0, binary: false, outsideEdits: false };
  // Disk first: a file past the bound or unreadable lists with no diff, and no checkpoint blob is read for it.
  const now = await io.disk(absolute);
  if (now.kind === 'tooLarge' || now.kind === 'unreadable') return { ...base, status: creates ? 'A' : 'M', diff: { kind: now.kind } };
  let before = firstRelative === undefined ? ({ kind: 'unavailable' } as const) : await io.checkpoint(first.turn, firstRelative, 'before');
  if (before.kind === 'tooLarge') return { ...base, status: creates ? 'A' : 'M', diff: { kind: 'tooLarge' } };
  // a checkpoint that lacks a file the chat's first change edited skipped it (size, category, LFS, an exclude)
  if (before.kind === 'absent' && !creates) before = { kind: 'unavailable' };
  if (before.kind === 'binary' || now.kind === 'binary' || records.some((record) => record.binary)) {
    const existedBefore = before.kind === 'unavailable' ? !creates : before.kind !== 'absent';
    if (!existedBefore && now.kind === 'absent') return undefined;
    if (before.kind === 'binary' && now.kind === 'binary' && before.digest !== undefined && before.digest === now.digest) return undefined;
    const status = !existedBefore ? 'A' : now.kind === 'absent' ? 'D' : 'M';
    return { ...base, status, binary: true, diff: { kind: 'binary' } };
  }
  const nowText = now.kind === 'text' ? normalized(now.text) : undefined;
  let baseline: string | undefined;
  let fromCheckpoint = false;
  if (before.kind === 'text') {
    baseline = normalized(before.text);
    fromCheckpoint = true;
  } else if (before.kind === 'absent' || creates) {
    baseline = undefined;
    fromCheckpoint = true;
  } else {
    const undone = nowText === undefined ? undefined : undoRecords(nowText, records);
    // the records apply forward onto the file as it is: it was put back to the baseline by hand
    if (undone === undefined && nowText !== undefined && applyRecords(nowText, records) !== undefined) return undefined;
    if (undone === undefined) {
      const joined = joinedPatches(records, shown);
      return { ...base, status: now.kind === 'absent' ? 'D' : 'M', added: joined.added, removed: joined.removed, outsideEdits: true, diff: { kind: 'patches', patch: joined.patch } };
    }
    baseline = undone;
  }
  if (baseline === nowText) return undefined;
  let outsideEdits = false;
  if (fromCheckpoint) {
    let result = applyRecords(baseline, records);
    if (result === undefined) {
      const lastRelative = relative(last);
      const after = lastRelative === undefined ? { kind: 'unavailable' as const } : await io.checkpoint(last.turn, lastRelative, 'after');
      result = after.kind === 'text' ? normalized(after.text) : after.kind === 'absent' ? '' : undefined;
    }
    outsideEdits = result !== undefined && result !== (nowText ?? '');
  }
  const counts = lineCounts(baseline ?? '', nowText ?? '');
  const status = baseline === undefined ? 'A' : nowText === undefined ? 'D' : 'M';
  if (!counts) return { ...base, status, outsideEdits, diff: { kind: 'tooLarge' } };
  return { ...base, status, ...counts, outsideEdits, diff: { kind: 'texts', before: baseline ?? '', after: nowText ?? '' } };
}

/** Reads of a worktree chat's repository (D60's worktree rule). */
export interface WorktreeGit {
  // `git diff --name-status -z --no-renames <baseCommit>` of the worktree: committed and uncommitted changes
  changedSinceBase(baseCommit: string): Promise<ReadonlyArray<{ readonly status: 'A' | 'M' | 'D'; readonly path: string }>>;
  // untracked files that are not ignored, '/' relative to the worktree
  untracked(): Promise<readonly string[]>;
  // a file at baseCommit
  atBase(baseCommit: string, relativePath: string): Promise<FileText>;
}

/**
 * A worktree chat's changes: every change in its worktree against its base commit, committed or not, untracked files
 * included. Nothing else writes there (D62), so the set is exact and needs no outside-edit mark.
 */
export async function worktreeChanges(folder: string, baseCommit: string, git: WorktreeGit, disk: ChatChangesIo['disk']): Promise<ChatChangeFile[]> {
  const listed = new Map<string, 'A' | 'M' | 'D'>();
  for (const entry of await git.changedSinceBase(baseCommit)) listed.set(entry.path, entry.status);
  for (const file of await git.untracked()) if (!listed.has(file)) listed.set(file, 'A');
  const out: ChatChangeFile[] = [];
  for (const [relative, status] of listed) {
    const absolute = path.join(folder, ...relative.split('/'));
    const base = { path: relative, absolute, status, added: 0, removed: 0, binary: false, outsideEdits: false };
    const now = status === 'D' ? ({ kind: 'absent' } as const) : await disk(absolute);
    if (now.kind === 'tooLarge' || now.kind === 'unreadable') {
      out.push(withRevision({ ...base, diff: { kind: now.kind } }));
      continue;
    }
    const before = status === 'A' ? ({ kind: 'absent' } as const) : await git.atBase(baseCommit, relative);
    if (before.kind === 'binary' || now.kind === 'binary' || before.kind === 'unavailable') {
      out.push(withRevision({ ...base, binary: true, diff: { kind: 'binary' } }));
      continue;
    }
    const beforeText = before.kind === 'text' ? normalized(before.text) : '';
    const nowText = now.kind === 'text' ? normalized(now.text) : '';
    const counts = lineCounts(beforeText, nowText);
    out.push(withRevision(counts ? { ...base, ...counts, diff: { kind: 'texts', before: beforeText, after: nowText } } : { ...base, diff: { kind: 'tooLarge' } }));
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** The counter's totals over the files. */
export function changeTotals(files: readonly ChatChangeFile[]): { added: number; removed: number; files: number } {
  return { added: files.reduce((sum, file) => sum + file.added, 0), removed: files.reduce((sum, file) => sum + file.removed, 0), files: files.length };
}

// Each file's hunks of its texts, computed once per file of a snapshot.
const hunksByFile = new WeakMap<ChatChangeFile, readonly StructuredPatchHunk[] | null>();

function hunksOf(file: ChatChangeFile): readonly StructuredPatchHunk[] | null {
  if (file.diff.kind !== 'texts') return null;
  if (!hunksByFile.has(file)) {
    const made = structuredPatch('', '', file.diff.before, file.diff.after, undefined, undefined, { context: DIFF_CONTEXT, maxEditLength: MAX_DIFF_EDIT_LENGTH });
    hunksByFile.set(file, made ? made.hunks : null);
  }
  return hunksByFile.get(file)!;
}

/** Whether the tab offers line comments on a file: only a diff of two rebuilt texts names lines core can check at send. */
export function isCommentable(file: ChatChangeFile): boolean {
  return file.diff.kind === 'texts';
}

/** A changed file's unified diff, as git prints one file (ScmFileDiffResult's patch); past MAX_PATCH_BYTES it is tooLarge. */
export function unifiedDiff(file: ChatChangeFile): { readonly kind: 'patch'; readonly patch: string } | { readonly kind: 'binary' | 'tooLarge' | 'unreadable' } {
  if (file.diff.kind === 'binary' || file.diff.kind === 'tooLarge' || file.diff.kind === 'unreadable') return { kind: file.diff.kind };
  let patch: string;
  if (file.diff.kind === 'patches') patch = file.diff.patch;
  else {
    const from = file.status === 'A' ? '/dev/null' : `a/${file.path}`;
    const to = file.status === 'D' ? '/dev/null' : `b/${file.path}`;
    const hunks = hunksOf(file);
    if (!hunks) return { kind: 'tooLarge' };
    patch = formatPatch(from, to, hunks);
  }
  return Buffer.byteLength(patch) > MAX_PATCH_BYTES ? { kind: 'tooLarge' } : { kind: 'patch', patch };
}

/**
 * A line of a file's diff by side, only when one of its hunks shows it: the old file's line for a removed one, the new
 * file's for an added or context one. undefined for a file whose diff is not two texts.
 */
export function diffLine(file: ChatChangeFile, side: 'added' | 'removed' | 'context', line: number): string | undefined {
  const hunks = hunksOf(file);
  for (const hunk of hunks ?? []) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const text of hunk.lines) {
      const mark = text[0];
      if (mark === '-') {
        if (side === 'removed' && oldLine === line) return text.slice(1);
        oldLine++;
      } else if (mark === '+') {
        if (side === 'added' && newLine === line) return text.slice(1);
        newLine++;
      } else if (mark === ' ') {
        if (side === 'context' && newLine === line) return text.slice(1);
        oldLine++;
        newLine++;
      }
    }
  }
  return undefined;
}

/**
 * What a comment is checked against at send: its line with the lines either side of it on that side, while a hunk shows the
 * line. A chat edit that moves or changes the line, or the code beside it, changes the anchor.
 */
export function lineAnchor(file: ChatChangeFile, side: 'added' | 'removed' | 'context', line: number): string | undefined {
  const text = diffLine(file, side, line);
  if (text === undefined || file.diff.kind !== 'texts') return undefined;
  const lines = (side === 'removed' ? file.diff.before : file.diff.after).split('\n');
  return [lines[line - 2] ?? '', text, lines[line] ?? ''].join('\n');
}

export interface ReviewComment {
  readonly path: string;
  readonly line: number;
  readonly removed: boolean;
  // the line itself, from core's own diff
  readonly quoted: string;
  // the user's comment, the only text the renderer supplies
  readonly text: string;
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return longest;
}

/**
 * One user message listing each comment as `path:line` (`path:line (removed)` on a removed line), the quoted line fenced as
 * data with a fence longer than any backtick run inside it, then the comment text.
 */
export function composeReviewMessage(comments: readonly ReviewComment[]): string {
  return comments
    .map((comment) => {
      const fence = '`'.repeat(Math.max(3, longestBacktickRun(comment.quoted) + 1));
      return [`${comment.path}:${comment.line}${comment.removed ? ' (removed)' : ''}`, `${fence}text`, comment.quoted, fence, comment.text.trim()].join('\n');
    })
    .join('\n\n');
}
