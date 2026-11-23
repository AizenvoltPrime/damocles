import * as fs from "fs";
import * as path from "path";
import type { Disposable } from "../../platform/disposable";
import type { PanelHost } from "../../platform/window-service";
import type { ExtensionToWebviewMessage, HostCapabilities } from "../../shared/types/messages";
import type { StoredSession } from "../../shared/types/session";
import { isSafeAgentPathId } from "../../shared/agent-path-id";
import { isHostId } from "../../shared/host-id";
import { isMirrorWorktreeFolder, mirrorWorktreeKind, type MirrorWorktreeKind } from "../../shared/remote-mirror";
import { piSessionIdFromFile } from "../pi-session/session-store/meta-index/protocol";
import { listRow, sessionFileMeta } from "../pi-session/session-store/metadata";
import { piSessionDirName } from "../pi-session/session-store/session-dir";
import { entryTimeOf, worktreeEntryOf } from "../worktrees/worktree-entry";
import { folderKeyOn } from "../workspace-folders/folder-key";
import { readSessionFileEntries } from "../pi-session/session-store/session-file-entries";
import { initPiLoader } from "../pi-session/pi-loader";
import { sessionMatchesQuery } from "./storage-manager";
import { log } from "../logger";

const SESSION_SUFFIX = ".jsonl";

/**
 * The mirrored session file a transcript view may read: in one project's folder of `<userData>/remote/<hostId>/mirror/`, or
 * in a `worktree.<id>` or `adopted.<id>` folder of it, once links are followed, a safe file name pi gives a session
 * (`<timestamp>_<session id>.jsonl`). Undefined for any other path, a subagent's file deeper in the mirror included, which
 * the caller refuses.
 */
export async function mirroredSessionFile(userDataDir: string, hostId: string, file: string): Promise<{ readonly path: string; readonly sessionId: string } | undefined> {
  const name = path.basename(file);
  const base = name.endsWith(SESSION_SUFFIX) ? name.slice(0, -SESSION_SUFFIX.length) : "";
  const sessionId = piSessionIdFromFile(name);
  if (!isHostId(hostId) || !path.isAbsolute(file) || !isSafeAgentPathId(base) || !isSafeAgentPathId(sessionId)) return undefined;
  let real: string;
  let root: string;
  try {
    [real, root] = await Promise.all([fs.promises.realpath(file), fs.promises.realpath(path.join(userDataDir, "remote", hostId, "mirror"))]);
  } catch (err) {
    log("[transcript] the mirrored file %s cannot be resolved: %O", file, err);
    return undefined;
  }
  const folder = path.dirname(real);
  const project = isMirrorWorktreeFolder(path.basename(folder)) && path.dirname(path.dirname(folder)) === root ? path.dirname(folder) : folder;
  return path.dirname(project) === root ? { path: real, sessionId } : undefined;
}

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === "ENOENT";

// The path's realpath, or null when it does not exist.
async function realOrMissing(target: string): Promise<string | null> {
  try {
    return await fs.promises.realpath(target);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/**
 * One project's folder of a host's session mirror, `<userData>/remote/<hostId>/mirror/<one segment>` once links are followed;
 * null when the mirror holds nothing for it yet, undefined for any other path, which the caller refuses.
 */
export async function mirroredProjectFolder(userDataDir: string, hostId: string, folder: string): Promise<string | null | undefined> {
  if (!isHostId(hostId) || !path.isAbsolute(folder)) return undefined;
  const lexicalRoot = path.join(userDataDir, "remote", hostId, "mirror");
  if (path.dirname(path.resolve(folder)) !== lexicalRoot || !isSafeAgentPathId(path.basename(folder))) return undefined;
  const [root, real] = await Promise.all([realOrMissing(lexicalRoot), realOrMissing(folder)]);
  if (root === null || real === null) return null;
  return path.dirname(real) === root ? real : undefined;
}

type PiLoaded = NonNullable<Awaited<ReturnType<typeof initPiLoader>>>;

interface MirroredSession {
  readonly stored: StoredSession | null;
  // whether it has a worktree entry, and whether it belongs to the folder it was created in (its header's): no entry, or its
  // latest names that folder, both mapped through `currentPath`
  readonly entry: boolean;
  readonly createdHere: boolean;
  // the folder its header names, mapped through `currentPath`; undefined when the header names none
  readonly startedIn: string | undefined;
}

// A mirrored session file's entries and its row of the session list, read into pi's in-memory session so nothing is written.
async function mirroredRow(pi: PiLoaded, file: string): Promise<{ readonly entries: readonly unknown[]; readonly stored: StoredSession | null }> {
  const [entries, stat] = await Promise.all([readSessionFileEntries(file), fs.promises.stat(file)]);
  const stored = sessionFileMeta(pi.SessionManager.inMemory(path.dirname(file), undefined, entries as Parameters<typeof pi.SessionManager.inMemory>[2]), stat.mtimeMs).stored;
  return { entries, stored: stored === null ? null : listRow(stored) };
}

// A mirrored session's row and where it belongs, its folders compared by the path rules of the host it was written on.
async function mirroredSession(pi: PiLoaded, file: string, hostOs: NodeJS.Platform, currentPath: MirroredPath): Promise<MirroredSession> {
  const { entries, stored } = await mirroredRow(pi, file);
  let latestIndex = entries.length - 1;
  while (latestIndex >= 0 && worktreeEntryOf(entries[latestIndex]) === undefined) latestIndex--;
  const latest = worktreeEntryOf(entries[latestIndex]);
  const cwd = (entries[0] as { cwd?: unknown } | undefined)?.cwd;
  const startedIn = typeof cwd === "string" ? currentPath(cwd, entryTimeOf(entries[0])) : undefined;
  const createdHere = latest === undefined || (startedIn !== undefined && folderKeyOn(hostOs, currentPath(latest.projectPath, entryTimeOf(entries[latestIndex]))) === folderKeyOn(hostOs, startedIn));
  return { stored, entry: latest !== undefined, createdHere, startedIn };
}

// Where a folder a host's session named at recordedAt (epoch ms on the host's clock) is now.
type MirroredPath = (folder: string, recordedAt: number | undefined) => string;

// The session files directly in a folder, as pi names them.
const sessionFilesIn = (entries: readonly fs.Dirent[]): string[] => entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(SESSION_SUFFIX) && isSafeAgentPathId(entry.name.slice(0, -SESSION_SUFFIX.length)) && isSafeAgentPathId(piSessionIdFromFile(entry.name)))
  .map((entry) => entry.name);

/**
 * Whether a session of a project's mirror folder is the project's (docs/invariants.md "Worktree chats", Ownership): one in its
 * own folder that belongs to the folder it was created in, when that is the project or a folder whose session directory is
 * not the project's (`startedHere`), one in a chat worktree's folder that belongs to another project, which only the worktree's
 * own project can be, and one with no entry in a deleted adopted worktree's (rule 18).
 */
function projectsSession(kind: MirrorWorktreeKind | undefined, session: MirroredSession, startedHere: (folder: string) => boolean): boolean {
  if (kind === undefined) return session.createdHere && (session.startedIn === undefined || startedHere(session.startedIn));
  return kind === "chat" ? !session.createdHere : !session.entry;
}

/**
 * The chats a project's mirror folder holds, its own and its worktree chats' (`worktree.<id>` and `adopted.<id>` folders,
 * `projectsSession`), each session once, its own first, as its live Chats list lists them; newest first, narrowed to query as
 * the chat list's search narrows: each session file is read here and handed to pi's in-memory session, so no file is
 * repaired, migrated, indexed or otherwise written. `currentPath` maps a folder the host's sessions name to where it is now.
 * `project` is the project's folder on the host; without it, from a caller that names none, every session of the folder that
 * belongs to the folder it was created in lists, a colliding folder's included.
 */
export async function listMirroredSessions(folder: string, query: string, hostOs: NodeJS.Platform, currentPath: MirroredPath = (named) => named, project?: string): Promise<StoredSession[]> {
  const dirNameKey = (named: string): string => (hostOs === "win32" ? piSessionDirName(named, hostOs).toLowerCase() : piSessionDirName(named, hostOs));
  // pi's lossy encoding gives a colliding folder the project's session directory, and only a relocation moves a file out of its own
  const startedHere = (startedIn: string): boolean => project === undefined
    || folderKeyOn(hostOs, startedIn) === folderKeyOn(hostOs, project)
    || dirNameKey(startedIn) !== dirNameKey(project);
  const pi = await initPiLoader();
  if (!pi) throw new Error("pi did not load, so the mirrored chats cannot be read");
  const entries = await fs.promises.readdir(folder, { withFileTypes: true });
  const files: Array<{ readonly file: string; readonly kind?: MirrorWorktreeKind }> = sessionFilesIn(entries).map((name) => ({ file: path.join(folder, name) }));
  for (const worktree of entries.filter((entry) => entry.isDirectory() && isMirrorWorktreeFolder(entry.name))) {
    const inside = path.join(folder, worktree.name);
    const kind = mirrorWorktreeKind(worktree.name);
    let names: string[];
    try {
      names = sessionFilesIn(await fs.promises.readdir(inside, { withFileTypes: true }));
    } catch (err) {
      // a folder the next sync drops or replaces mid-list; the rest still list
      log("[transcript] the mirrored worktree folder %s could not be read: %O", inside, err);
      continue;
    }
    files.push(...names.map((name) => ({ file: path.join(inside, name), ...(kind ? { kind } : {}) })));
  }
  const rows: StoredSession[] = [];
  const listed = new Set<string>();
  // one file in memory at a time, as pi reads a whole session file
  for (const { file, kind } of files) {
    try {
      const session = await mirroredSession(pi, file, hostOs, currentPath);
      const stored = session.stored;
      if (stored && !listed.has(stored.id) && projectsSession(kind, session, startedHere)) {
        listed.add(stored.id);
        rows.push(stored);
      }
    } catch (err) {
      // a file the next sync drops or replaces mid-read; the rest still list
      log("[transcript] the mirrored session %s could not be read: %O", file, err);
    }
  }
  const normalized = query.trim().toLowerCase();
  return rows.filter((row) => normalized === "" || sessionMatchesQuery(row, normalized, false)).sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Shows a remote chat's mirrored transcript on host, read-only: the chat page replays the file on each ready and nothing else
 * the page sends is acted on, so no session, lease, checkpoint or index is made and nothing is written. As a live chat's
 * ready does, the host's capabilities and the language go first and the session list's row, which names the chat in the
 * header, after the replay. A ready aborts the replay of the one before it, so a reloaded page gets one replay.
 */
export function openTranscriptView(host: PanelHost, transcript: {
  readonly file: string;
  readonly capabilities: HostCapabilities;
  readonly locale: () => string;
  readonly replay: (post: (message: ExtensionToWebviewMessage) => void, signal: AbortSignal) => Promise<boolean>;
}): void {
  if (!host.showPage) throw new Error("A transcript view needs a host that builds its own page");
  const post = (message: ExtensionToWebviewMessage): void => void host.postMessage(message);
  let replaying: AbortController | undefined;
  const showTranscript = async (signal: AbortSignal): Promise<void> => {
    post({ type: "hostCapabilities", capabilities: transcript.capabilities });
    post({ type: "languageChange", locale: transcript.locale() });
    if (!(await transcript.replay(post, signal))) {
      log("[transcript] the mirrored transcript could not be read");
      return;
    }
    if (signal.aborted) return;
    const pi = await initPiLoader();
    if (!pi) throw new Error("pi did not load, so the mirrored chat cannot be named");
    const session = (await mirroredRow(pi, transcript.file)).stored;
    if (!session) throw new Error("the mirrored file names no session");
    if (!signal.aborted) post({ type: "storedSessions", sessions: [session], hasMore: false, nextOffset: 1, isFirstPage: true });
  };
  const subscription: Disposable = host.onMessage((message) => {
    const type = typeof message === "object" && message !== null && typeof (message as { type?: unknown }).type === "string" ? (message as { type: string }).type : undefined;
    if (type !== "ready") {
      log("[transcript] refused %s on a read-only transcript", type ?? "a malformed message");
      return;
    }
    replaying?.abort();
    replaying = new AbortController();
    const { signal } = replaying;
    showTranscript(signal).catch((err: unknown) => {
      // a later ready or the page's close took over before the file was read
      if (!signal.aborted) log("[transcript] showing the mirrored transcript failed: %O", err);
    });
  });
  host.onDispose(() => {
    subscription.dispose();
    replaying?.abort();
  });
  host.showPage({ kind: "chat" });
}
