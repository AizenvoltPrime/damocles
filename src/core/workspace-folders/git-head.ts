import * as fs from "fs/promises";
import * as path from "path";
import { log } from "../logger";
import type { Disposable } from "../../platform/disposable";
import type { FileWatcher, FileWatcherFactory } from "../../platform/file-watcher";

// A valid HEAD is one short line; a `.git` file holds one `gitdir:` line, which on Windows may be a long path.
const HEAD_READ_LIMIT = 1024;
const GIT_FILE_READ_LIMIT = 4096;
const MAX_BRANCH_LENGTH = 255;
const SHORT_ID_LENGTH = 7;

// Control characters, and the bidirectional embedding, override and isolate characters that would reorder the header text.
const UNSAFE_NAME_CHARS = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/u;
// The characters and sequences `git check-ref-format` refuses anywhere in a ref name; UNSAFE_NAME_CHARS covers its control characters.
const REF_FORBIDDEN = /[ ~^:?*[\\]|\.\.|@\{/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// O_NONBLOCK keeps opening a FIFO from blocking a thread-pool thread; Windows defines no such flag.
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);

/** Reads a regular file of at most `limit` bytes; anything else (a FIFO, a device, a directory) reads as nothing. */
async function readBounded(file: string, limit: number): Promise<string | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, OPEN_FLAGS);
    if (!(await handle.stat()).isFile()) return undefined;
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead > limit ? undefined : buffer.toString("utf8", 0, bytesRead);
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** The git dir for `folder`: the first `.git` from the folder upward, as git discovers it. A `.git` file (worktree, submodule) names it with `gitdir:`. */
export async function findGitDir(folder: string): Promise<string | undefined> {
  let dir = path.resolve(folder);
  for (;;) {
    const candidate = path.join(dir, ".git");
    const stat = await fs.stat(candidate).catch(() => undefined);
    if (stat?.isDirectory()) return candidate;
    if (stat?.isFile()) {
      const text = await readBounded(candidate, GIT_FILE_READ_LIMIT);
      const match = text === undefined ? null : /^gitdir:\s*(.+?)\s*$/m.exec(text);
      // git stops at an unreadable or malformed `.git` file too, rather than looking further up.
      if (!match?.[1]) return undefined;
      const gitDir = path.resolve(dir, match[1]);
      return reachesAnotherHost(gitDir, dir) ? undefined : gitDir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Whether `gitDir` is a Windows UNC or device path (`\\server\share`, `\\?\`, `\\.\`) outside the folder's own root.
 * Opening one named by an untrusted `.git` file would connect over SMB and send the user's NTLM credentials.
 */
function reachesAnotherHost(gitDir: string, folder: string): boolean {
  const root = path.parse(gitDir).root;
  return /^[\\/]{2}/.test(root) && root.toLowerCase() !== path.parse(folder).root.toLowerCase();
}

/** `git check-ref-format` for the part of a ref after `refs/heads/`, plus the characters that would garble the header. */
function isDisplayableBranch(name: string): boolean {
  if (name.length === 0 || name.length > MAX_BRANCH_LENGTH || UNSAFE_NAME_CHARS.test(name) || REF_FORBIDDEN.test(name)) return false;
  if (name === "@" || name.endsWith(".")) return false;
  // The reftable backend leaves `refs/heads/.invalid` in HEAD, which names no branch.
  return name.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}

/** The branch a HEAD file names, a detached HEAD's short id, or undefined for anything else. */
export function parseHead(text: string): string | undefined {
  const line = text.replace(/\r?\n$/, "");
  if (line.includes("\n")) return undefined;
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(line);
  if (ref) return isDisplayableBranch(ref[1]!) ? ref[1] : undefined;
  return OBJECT_ID.test(line) ? line.slice(0, SHORT_ID_LENGTH) : undefined;
}

export async function readHead(gitDir: string): Promise<string | undefined> {
  const text = await readBounded(path.join(gitDir, "HEAD"), HEAD_READ_LIMIT);
  return text === undefined ? undefined : parseHead(text);
}

interface TrackedFolder {
  branch: string | undefined;
  watcher: FileWatcher | undefined;
  /** Bumped per read, so a slow read never overwrites a newer one. */
  reads: number;
  disposed: boolean;
}

/** The branch of each tracked folder, re-read whenever its HEAD file changes. Reads git's files only, so it runs no repository code. */
export class BranchTracker implements Disposable {
  private readonly folders = new Map<string, TrackedFolder>();
  private readonly watchers: FileWatcherFactory;
  private readonly onDidChange: () => void;

  constructor(watchers: FileWatcherFactory, onDidChange: () => void) {
    this.watchers = watchers;
    this.onDidChange = onDidChange;
  }

  branchOf(folder: string): string | undefined {
    return this.folders.get(folder)?.branch;
  }

  setFolders(folders: readonly string[]): void {
    const wanted = new Set(folders);
    for (const [folder, tracked] of this.folders) {
      if (wanted.has(folder)) continue;
      this.release(tracked);
      this.folders.delete(folder);
    }
    for (const folder of wanted) {
      if (this.folders.has(folder)) continue;
      const tracked: TrackedFolder = { branch: undefined, watcher: undefined, reads: 0, disposed: false };
      this.folders.set(folder, tracked);
      this.start(folder, tracked).catch((err: unknown) => log("[BranchTracker] reading the branch of %s failed: %O", folder, err));
    }
  }

  dispose(): void {
    for (const tracked of this.folders.values()) this.release(tracked);
    this.folders.clear();
  }

  private async start(folder: string, tracked: TrackedFolder): Promise<void> {
    const gitDir = await findGitDir(folder);
    if (tracked.disposed || gitDir === undefined) return;
    const watcher = this.watchers.watch(gitDir, "HEAD");
    tracked.watcher = watcher;
    // git replaces HEAD through HEAD.lock and a rename, which a watcher reports as a create or a change.
    const reread = () => { void this.read(gitDir, tracked); };
    watcher.onDidCreate(reread);
    watcher.onDidChange(reread);
    watcher.onDidDelete(reread);
    await this.read(gitDir, tracked);
  }

  private async read(gitDir: string, tracked: TrackedFolder): Promise<void> {
    const read = ++tracked.reads;
    const branch = await readHead(gitDir);
    if (tracked.disposed || read !== tracked.reads || branch === tracked.branch) return;
    tracked.branch = branch;
    this.onDidChange();
  }

  private release(tracked: TrackedFolder): void {
    tracked.disposed = true;
    tracked.watcher?.dispose();
  }
}
