// Reading the session's worktree entry from its file (AD12 Sessions) and D61's file move between a project folder and its chat worktree.
import { createReadStream, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { MAX_CLI_LENGTH, revision, splitInChunks, type GitRunner } from '../scm/git-runner';
import type { FileText, WorktreeGit } from '../pi-session/chat-changes';
import { DAMOCLES_WORKTREE_ENTRY } from '../pi-session/session-store/constants';
import { EDITOR_MAX_DOCUMENT_BYTES } from '../../shared/types/messages';
import type { ChatWorktreeRecord } from './registry';
import { folderContains } from './records';
import { confinedTarget, copyLink, gitMessage, nulList, projectGit, repositoryOf, repositoryPathKey, uncommittedFiles, type WorktreeFile } from './create';
import type { ChangeLetter } from '../scm/repository';
import { worktreeEntryOf, type WorktreeEntryData } from './worktree-entry';

export const WORKTREE_ENTRY: string = DAMOCLES_WORKTREE_ENTRY;
// A session file larger than this is not scanned for its entry; the chat then reads as a project-folder chat.
const MAX_ENTRY_SCAN_BYTES = 256 * 1024 * 1024;
const BINARY_PROBE_LENGTH = 8000;
// Room for `cat-file --batch`'s header line: an object id, the type and the size.
const BATCH_HEADER_BYTES = 128;

/** The latest worktree entry of a session file, read line by line without parsing lines that cannot hold one. */
export async function readLatestWorktreeEntry(sessionFile: string): Promise<WorktreeEntryData | undefined> {
  const stat = await fs.stat(sessionFile);
  if (stat.size > MAX_ENTRY_SCAN_BYTES) return undefined;
  let latest: WorktreeEntryData | undefined;
  const lines = createInterface({ input: createReadStream(sessionFile, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes(WORKTREE_ENTRY)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A torn last line of a file being written holds no complete entry.
      continue;
    }
    latest = worktreeEntryOf(parsed) ?? latest;
  }
  return latest;
}

/** The first worktree entry's project (/stats attributes a session to it, slice 12a rule 9). */
export function firstWorktreeProject(entries: readonly unknown[]): string | undefined {
  for (const entry of entries) {
    const data = worktreeEntryOf(entry);
    if (data) return data.projectPath;
  }
  return undefined;
}

/** D60's worktree reads for a chat worktree, through the runner. */
export function worktreeGitOf(record: ChatWorktreeRecord, runner: GitRunner): WorktreeGit {
  const git = projectGit(runner, record.projectPath);
  return {
    changedSinceBase: async (baseCommit) => {
      const fields = nulList((await git.run(record.worktreeRoot, ['-c', 'diff.autoRefreshIndex=false', 'diff', '--name-status', '-z', '--no-renames', revision(baseCommit), '--'])).stdout);
      const out: Array<{ status: 'A' | 'M' | 'D'; path: string }> = [];
      for (let i = 0; i + 1 < fields.length; i += 2) {
        const letter = fields[i]!.charAt(0);
        out.push({ status: letter === 'A' ? 'A' : letter === 'D' ? 'D' : 'M', path: fields[i + 1]! });
      }
      return out;
    },
    untracked: async () => nulList((await git.run(record.worktreeRoot, ['ls-files', '-z', '--others', '--exclude-standard', '--full-name'])).stdout),
    atBase: async (baseCommit, relativePath): Promise<FileText> => {
      // --batch reads one object name per line and says `missing` itself, so a newline in the path cannot be asked.
      if (relativePath.includes('\n')) return { kind: 'unavailable' };
      const name = `${revision(baseCommit)}:${relativePath}`;
      const out = (await git.run(record.worktreeRoot, ['cat-file', '--batch'], { input: `${name}\n`, maxOutputBytes: EDITOR_MAX_DOCUMENT_BYTES + BATCH_HEADER_BYTES, preview: true })).stdout;
      const headerEnd = out.indexOf(0x0a);
      const header = out.subarray(0, headerEnd < 0 ? out.length : headerEnd).toString('utf8');
      if (header === `${name} missing`) return { kind: 'absent' };
      const match = /^[0-9a-f]+ blob (\d+)$/.exec(header);
      if (!match) return { kind: 'unavailable' };
      const size = Number(match[1]);
      // Over the review's bound the output was cut short, so the base cannot be shown.
      if (size > EDITOR_MAX_DOCUMENT_BYTES) return { kind: 'unavailable' };
      const blob = out.subarray(headerEnd + 1, headerEnd + 1 + size);
      if (blob.subarray(0, BINARY_PROBE_LENGTH).includes(0)) return { kind: 'binary' };
      return { kind: 'text', text: blob.toString('utf8') };
    },
  };
}

export interface MovedFile {
  /** As git names it, '/'-separated, relative to the project folder (and to the working folder). */
  readonly path: string;
  /** The project folder's source control letter for it. */
  readonly letter: ChangeLetter;
  readonly alsoUserEdits: boolean;
}

/**
 * D61 to a worktree: the files the chat changed that have uncommitted changes in the project folder. `changed` is D60's
 * project-folder set as absolute paths with their outside-edit mark.
 */
export async function filesToMove(projectPath: string, runner: GitRunner, changed: ReadonlyArray<{ readonly absolute: string; readonly outsideEdits: boolean }>): Promise<MovedFile[]> {
  const git = projectGit(runner, projectPath);
  // git names a file from the repository's root in its own names, the chat by the project folder's spelling; both meet below it
  const { prefix } = await repositoryOf(git, projectPath);
  const key = await repositoryPathKey(git, projectPath);
  const dirty = new Map<string, WorktreeFile>();
  for (const file of await uncommittedFiles(git, projectPath)) {
    if (!key(file.path).startsWith(key(prefix))) continue;
    const below = file.path.slice(prefix.length);
    dirty.set(key(below), { path: below, letter: file.letter });
  }
  const out: MovedFile[] = [];
  const listed = new Set<string>();
  for (const file of changed) {
    if (!folderContains(projectPath, file.absolute)) continue;
    const found = dirty.get(key(path.relative(projectPath, file.absolute).split(path.sep).join('/')));
    if (found === undefined || listed.has(found.path)) continue;
    listed.add(found.path);
    out.push({ path: found.path, letter: found.letter, alsoUserEdits: file.outsideEdits });
  }
  return out;
}

/** A hand-off move that failed. `sourcesChanged` is false only when no file in the project folder was touched yet. */
export class HandOffMoveError extends Error {
  readonly sourcesChanged: boolean;
  constructor(cause: unknown, sourcesChanged: boolean) {
    super(gitMessage(cause), { cause });
    this.name = 'HandOffMoveError';
    this.sourcesChanged = sourcesChanged;
  }
}

/**
 * D61 to a worktree, after the confirmation: each file's current content is copied into the working folder (a file deleted
 * in the project folder is deleted there), then the project folder's copies git knows are restored to HEAD, and last the
 * untracked ones are removed, so a failure at any step leaves every file in the project folder, the worktree or both.
 * Throws HandOffMoveError.
 */
export async function moveFilesToWorktree(record: ChatWorktreeRecord, runner: GitRunner, files: readonly MovedFile[]): Promise<{ skippedLinks: string[] }> {
  let sourcesChanged = false;
  try {
    const git = projectGit(runner, record.projectPath);
    const { root: projectTop, prefix } = await repositoryOf(git, record.projectPath);
    const skippedLinks: string[] = [];
    const sources = new Map<string, string>();
    for (const file of files) {
      const source = await confinedTarget(record.projectPath, file.path);
      const target = await confinedTarget(record.workingFolder, file.path);
      sources.set(file.path, source);
      const stat = await fs.lstat(source).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return undefined;
        throw err;
      });
      if (stat === undefined) await fs.rm(target, { force: true });
      else if (stat.isSymbolicLink()) {
        await fs.rm(target, { force: true });
        if (!(await copyLink(source, target))) skippedLinks.push(file.path);
      } else if (stat.isFile()) {
        await fs.copyFile(source, target);
        await fs.chmod(target, stat.mode & 0o777);
      } else {
        throw new Error(`${file.path} is not a file`);
      }
    }
    // Read after the copies: a path in HEAD or the index (a staged new file included) is restored, an untracked one removed.
    const key = await repositoryPathKey(git, record.projectPath);
    const listed = new Map((await uncommittedFiles(git, record.projectPath)).map((file) => [key(file.path), file]));
    const known: string[] = [];
    const untracked: string[] = [];
    for (const file of files) {
      // A link that could not be recreated stays in the project folder as it is.
      if (skippedLinks.includes(file.path)) continue;
      const source = sources.get(file.path)!;
      const entry = listed.get(key(`${prefix}${file.path}`));
      // Not listed: the project folder's copy already equals HEAD and the index, so nothing is left to restore.
      if (entry === undefined) continue;
      if (entry.letter === 'U') untracked.push(source);
      else known.push(entry.path);
    }
    // A restore that fails may already have written some files.
    sourcesChanged = known.length > 0 || untracked.length > 0;
    // Restored through git, so filters, line endings, LFS, the exec bit and links come back as HEAD holds them.
    for (const chunk of splitInChunks(known, MAX_CLI_LENGTH)) {
      await git.run(projectTop, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...chunk], { kind: 'mutation', literalPathspecs: true });
    }
    for (const source of untracked) await fs.rm(source, { force: true });
    return { skippedLinks };
  } catch (err) {
    throw new HandOffMoveError(err, sourcesChanged);
  }
}

