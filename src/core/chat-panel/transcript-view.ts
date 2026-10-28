import * as fs from "fs";
import * as path from "path";
import type { Disposable } from "../../platform/disposable";
import type { PanelHost } from "../../platform/window-service";
import type { ExtensionToWebviewMessage, HostCapabilities } from "../../shared/types/messages";
import type { StoredSession } from "../../shared/types/session";
import { isSafeAgentPathId } from "../../shared/agent-path-id";
import { piSessionIdFromFile } from "../pi-session/session-store/meta-index/protocol";
import { sessionFileMeta } from "../pi-session/session-store/metadata";
import { sessionFileEntries } from "../pi-session/session-store/history-loader";
import { initPiLoader } from "../pi-session/pi-loader";
import { sessionMatchesQuery } from "./storage-manager";
import { log } from "../logger";

// A host id the desktop host store drew: one safe path segment.
const HOST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_SUFFIX = ".jsonl";

/**
 * The mirrored session file a transcript view may read: in one project's folder of `<userData>/remote/<hostId>/mirror/` once
 * links are followed, a safe file name pi gives a session (`<timestamp>_<session id>.jsonl`). Undefined for any other path,
 * a subagent's file deeper in the mirror included, which the caller refuses.
 */
export async function mirroredSessionFile(userDataDir: string, hostId: string, file: string): Promise<{ readonly path: string; readonly sessionId: string } | undefined> {
  const name = path.basename(file);
  const base = name.endsWith(SESSION_SUFFIX) ? name.slice(0, -SESSION_SUFFIX.length) : "";
  const sessionId = piSessionIdFromFile(name);
  if (!HOST_ID.test(hostId) || !path.isAbsolute(file) || !isSafeAgentPathId(base) || !isSafeAgentPathId(sessionId)) return undefined;
  let real: string;
  let root: string;
  try {
    [real, root] = await Promise.all([fs.promises.realpath(file), fs.promises.realpath(path.join(userDataDir, "remote", hostId, "mirror"))]);
  } catch (err) {
    log("[transcript] the mirrored file %s cannot be resolved: %O", file, err);
    return undefined;
  }
  return path.dirname(path.dirname(real)) === root ? { path: real, sessionId } : undefined;
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
  if (!HOST_ID.test(hostId) || !path.isAbsolute(folder)) return undefined;
  const lexicalRoot = path.join(userDataDir, "remote", hostId, "mirror");
  if (path.dirname(path.resolve(folder)) !== lexicalRoot || !isSafeAgentPathId(path.basename(folder))) return undefined;
  const [root, real] = await Promise.all([realOrMissing(lexicalRoot), realOrMissing(folder)]);
  if (root === null || real === null) return null;
  return path.dirname(real) === root ? real : undefined;
}

type PiLoaded = NonNullable<Awaited<ReturnType<typeof initPiLoader>>>;

// A mirrored session file's row of the session list, read into pi's in-memory session so nothing is written.
async function mirroredSession(pi: PiLoaded, file: string): Promise<StoredSession | null> {
  const [text, stat] = await Promise.all([fs.promises.readFile(file, "utf8"), fs.promises.stat(file)]);
  const entries = sessionFileEntries(text) as Parameters<typeof pi.SessionManager.inMemory>[2];
  return sessionFileMeta(pi.SessionManager.inMemory(path.dirname(file), undefined, entries), stat.mtimeMs).stored;
}

/**
 * The chats a project's mirror folder holds, newest first, narrowed to query as the chat list's search narrows: each session
 * file is read here and handed to pi's in-memory session, so no file is repaired, migrated, indexed or otherwise written.
 */
export async function listMirroredSessions(folder: string, query: string): Promise<StoredSession[]> {
  const pi = await initPiLoader();
  if (!pi) throw new Error("pi did not load, so the mirrored chats cannot be read");
  const names = (await fs.promises.readdir(folder, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(SESSION_SUFFIX) && isSafeAgentPathId(entry.name.slice(0, -SESSION_SUFFIX.length)) && isSafeAgentPathId(piSessionIdFromFile(entry.name)))
    .map((entry) => entry.name);
  const rows: StoredSession[] = [];
  // one file in memory at a time, as pi reads a whole session file
  for (const name of names) {
    const file = path.join(folder, name);
    try {
      const stored = await mirroredSession(pi, file);
      if (stored) rows.push(stored);
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
    const session = await mirroredSession(pi, transcript.file);
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
    showTranscript(replaying.signal).catch((err: unknown) => log("[transcript] showing the mirrored transcript failed: %O", err));
  });
  host.onDispose(() => {
    subscription.dispose();
    replaying?.abort();
  });
  host.showPage({ kind: "chat" });
}
