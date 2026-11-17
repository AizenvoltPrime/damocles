import type { Disposable } from "../../platform/disposable";
import type { FileWatcher, FileWatcherFactory } from "../../platform/file-watcher";
import * as path from "path";
import * as fs from "fs";
import type { StoredSession } from "../../shared/types/session";
import {
  ensurePiSessionDir,
  piSessionDir,
  listPiSessions,
  getPiSessionMetadata,
  getPiSessionMetadataByFile,
  currentCachedRow,
  readLiveSessionMetadata,
  forgetSessionMetadata,
  piSessionIdFromFile,
  extractPiPromptHistory,
  resolvePiSessionFile,
  type LiveSessionMetaSource,
  type SessionMetaIndex,
} from "../pi-session/session-store";
import { listRow, type IndexedSession } from "../pi-session/session-store/metadata";
import { pruneOrphanCheckpointRepos, getCheckpointsBaseDir, getWorkspaceCheckpointDir } from "../pi-session/checkpoints";
import { folderPresent } from "../pi-session/folder-presence";
import { currentRelocations, isRelocationPending } from "../project-relocation/current";
import { currentPathOf } from "../project-relocation/aliases";
import type { ExtensionToWebviewMessage } from "../../shared/types/messages";
import { SESSIONS_PAGE_SIZE, type HostInstance } from "./types";
import type { PanelHost } from "../../platform/window-service";
import type { FolderTarget } from "../workspace-folders/folder-registry";
import { log } from "../logger";
import { perfSpan } from "../perf";
import { folderKey } from "../workspace-folders/folder-key";
import { listedWorktreeRecords, worktreeProjectById } from "../worktrees/personal-config";
import type { WorktreeRegistry } from "../worktrees/registry";
import { readDesignLink } from "../design/design-state";
import { designStateDirOf } from "../design/design-paths";

const CHANGE_DEBOUNCE_MS = 300;
const PARSED_ROWS_PUSH_MS = 250;
/** Upserts run after every write during a turn, so only the slow ones log. */
const UPSERT_LOG_MIN_MS = 20;

/**
 * A pi session JSONL — excluding `agent-*.jsonl`, which (mirroring the SDK store) are sub-agent
 * transcripts, not user sessions, and must never be surfaced in the picker as standalone sessions.
 */
function isPiSessionFile(fsPath: string): boolean {
  const base = path.basename(fsPath);
  return base.endsWith(".jsonl") && !base.startsWith("agent-");
}

export interface StorageManagerConfig {
  /** Every open folder; the history lists the sessions of all of them. */
  folders: () => readonly FolderTarget[];
  isMultiRoot: () => boolean;
  postMessage: (host: PanelHost, message: ExtensionToWebviewMessage) => void;
  getPanels: () => Map<string, HostInstance>;
  /** The live session holding `sessionId` in this window, or undefined; must never start pi to answer. */
  liveSession: (sessionId: string) => LiveSessionMetaSource | undefined;
  fileWatchers: FileWatcherFactory;
  /** Owned: closed by `dispose`. */
  metaIndex: SessionMetaIndex;
}

const newestFirst = (a: StoredSession, b: StoredSession): number => b.timestamp - a.timestamp;

/**
 * One session directory a Chats list reads (AD12 Listing): an open project's own, a registry record's of an open project, or
 * both for a chat worktree open as a project itself.
 */
interface ListedDir {
  /** folderKey of the directory. */
  readonly key: string;
  /** The first listed folder whose session directory it is. */
  readonly folder: string;
  /** Every listed folder whose session directory it is, by folderKey; pi's lossy encoding can give two folders one directory. */
  readonly folders: ReadonlyMap<string, string>;
  /** Every open project whose own directory it is, in folder order. */
  readonly own: readonly FolderTarget[];
  /** The open project whose registry record's directory it is, with that record's kind and working folder. */
  readonly record?: { readonly project: FolderTarget; readonly kind: "chat" | "adopted"; readonly workingFolder: string };
}

/** Where a session lists: the open project it belongs to, and the folder its directory is when not that project's own. */
interface Listing {
  readonly folder: FolderTarget;
  readonly listedFrom?: string;
}

/** A change to the stored sessions that a list of them shows; no key when every folder's list reloaded. */
export interface StoredSessionsChange {
  readonly projectKey?: string;
}

/** Whether the fields a session list shows are equal; the timestamp moves on every write, so it is left out. */
function sameListing(a: StoredSession, b: StoredSession): boolean {
  return a.customTitle === b.customTitle
    && a.aiTitle === b.aiTitle
    && a.preview === b.preview
    && a.tag === b.tag
    && a.model?.provider === b.model?.provider
    && a.model?.id === b.model?.id
    && a.worktree?.worktreeId === b.worktree?.worktreeId
    && a.worktree?.place === b.worktree?.place
    && a.design?.designId === b.design?.designId
    && a.design?.parentSessionId === b.design?.parentSessionId
    && a.design?.finishedVersion === b.design?.finishedVersion
    && a.design?.superseded === b.design?.superseded;
}

/**
 * `rows` with each design chat marked `superseded` while its design's `link.json` names another chat (D70, as
 * `SessionDesign.standing` reads it), each link read once; a link that cannot be read leaves its rows unmarked.
 */
async function withDesignStanding<T extends StoredSession>(rows: readonly T[]): Promise<T[]> {
  const holders = new Map<string, Promise<string | null | undefined>>();
  const holderOf = (designId: string): Promise<string | null | undefined> => {
    let read = holders.get(designId);
    if (!read) {
      read = (async () => (await readDesignLink(designStateDirOf(designId)))?.designSessionId)().catch((err: unknown) => {
        log("[StorageManager] reading the link of design %s failed: %O", designId, err);
        return undefined;
      });
      holders.set(designId, read);
    }
    return read;
  };
  return Promise.all(rows.map(async (row) => {
    if (!row.design) return row;
    const holder = await holderOf(row.design.designId);
    const superseded = holder != null && holder !== row.id;
    if (superseded === (row.design.superseded === true)) return row;
    const { superseded: _was, ...design } = row.design;
    return { ...row, design: superseded ? { ...design, superseded } : design };
  }));
}

/**
 * Calls `listener` after a registry change that alters which session directories the projects list (AD12 Listing): a record
 * added, removed or marked deleted. Most writes (usedAt, an Apply's tree, a Merge's base) alter none.
 */
export function onListingChange(registry: Pick<WorktreeRegistry, "records" | "onDidChange">, listener: () => void): Disposable {
  const keyOf = (): string => JSON.stringify(registry.records().map((r) => [r.id, r.kind, r.projectPath ?? null, r.workingFolder, r.deletedAt !== undefined]));
  let last = keyOf();
  return registry.onDidChange(() => {
    const next = keyOf();
    if (next === last) return;
    last = next;
    listener();
  });
}

/** Whether the session's shown title or tag, or with `matchFolder` its folder label, contains `query` (lowercased, trimmed). */
export function sessionMatchesQuery(session: StoredSession, query: string, matchFolder: boolean): boolean {
  const displayName = session.customTitle || session.aiTitle || session.preview;
  return displayName.toLowerCase().includes(query)
    || (session.tag?.toLowerCase().includes(query) ?? false)
    || (matchFolder && (session.workspaceFolder?.label.toLowerCase().includes(query) ?? false));
}

function sameRow(a: StoredSession, b: StoredSession): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof StoredSession)[]);
  return [...keys].every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

/**
 * The folder a session with no worktree entry was started in, mapped through the relocations as of its start, while the session
 * directory keyed `dirKey` is that folder's; undefined where that directory decides (docs/invariants.md "Worktree chats", Ownership).
 */
function startedFolderIn(origin: IndexedSession["origin"], dirKey: string): string | undefined {
  const started = origin ? currentPathOf(currentRelocations().aliases, origin.cwd, origin.startedAt) : undefined;
  return started !== undefined && folderKey(piSessionDir(started)) === dirKey ? started : undefined;
}

export class StorageManager {
  private allSessionsCache: StoredSession[] | null = null;
  /** The one list load in flight; every caller that finds the cache empty shares it. */
  private sessionsLoad: Promise<StoredSession[]> | null = null;
  /** Bumped on invalidation, so a load that started before it never fills the cache. */
  private sessionsGeneration = 0;
  private promptHistoryCache: string[] | null = null;
  private pendingPromptEntries: string[] = [];
  /** Each listed session directory's watcher, by the directory's folderKey. */
  private readonly sessionWatchers = new Map<string, FileWatcher>();
  private pendingChangeTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly prunedFolders = new Set<string>();
  /** Session id to the key of the open project it lists under. */
  private sessionFolder = new Map<string, string>();
  /** The session directories the lists read, computed by `reloadFolders` so no update reads the registry. */
  private listedDirSnapshot: readonly ListedDir[] | null = null;
  /** Sessions read or deleted since the list loaded; a row the list parsed earlier never replaces theirs. */
  private readonly readSinceList = new Set<string>();
  /** Parsed rows applied to the list and not yet pushed or announced, with the projects whose listing they changed. */
  private parsedRowsPush: { readonly timer: NodeJS.Timeout; readonly changed: Set<string> } | null = null;
  /** Resolves once every row the index parsed for the load of `generation` was applied, or dropped: true when every file yielded its row. */
  private sessionsParsed: { readonly generation: number; readonly done: Promise<boolean> } | null = null;
  private readonly folders: StorageManagerConfig["folders"];
  private readonly isMultiRoot: StorageManagerConfig["isMultiRoot"];
  private readonly postMessage: StorageManagerConfig["postMessage"];
  private readonly getPanels: StorageManagerConfig["getPanels"];
  private readonly liveSession: StorageManagerConfig["liveSession"];
  private readonly fileWatchers: FileWatcherFactory;
  readonly metaIndex: SessionMetaIndex;
  private readonly changeListeners = new Set<(change: StoredSessionsChange) => void>();

  constructor(config: StorageManagerConfig) {
    this.folders = config.folders;
    this.isMultiRoot = config.isMultiRoot;
    this.postMessage = config.postMessage;
    this.getPanels = config.getPanels;
    this.liveSession = config.liveSession;
    this.fileWatchers = config.fileWatchers;
    this.metaIndex = config.metaIndex;
  }

  /** Fires when a session is added or removed, or a field a list shows changes; not for timestamp-only writes. */
  onDidChangeSessions(listener: (change: StoredSessionsChange) => void): Disposable {
    this.changeListeners.add(listener);
    return { dispose: (): void => { this.changeListeners.delete(listener); } };
  }

  private emitChange(change: StoredSessionsChange): void {
    for (const listener of [...this.changeListeners]) {
      try {
        listener(change);
      } catch (err) {
        log("[StorageManager] stored sessions listener error: %O", err);
      }
    }
  }

  /** Drop the cached list after a write the watcher reports late, and announce the folder's change now. */
  markSessionsChanged(folderKey: string): void {
    this.invalidateSessionsCache();
    this.emitChange({ projectKey: folderKey });
  }

  /** One open folder's stored sessions, newest first; empty for a key that is not open. Rows still being parsed arrive later, announced by `onDidChangeSessions`. */
  async sessionsOf(folderKey: string): Promise<StoredSession[]> {
    const all = await this.ensureSessionsLoaded();
    return all.filter((s) => s.workspaceFolder?.key === folderKey);
  }

  /** Stored session `sessionId`'s row in the list of every open folder; undefined while the list holds none. */
  async storedSession(sessionId: string): Promise<StoredSession | undefined> {
    return (await this.ensureSessionsLoaded()).find((s) => s.id === sessionId);
  }

  /** `sessionsOf` once the index parsed every file of the list: for a decision a missing row would make wrong, so it rejects when a file yielded no row. */
  async completeSessionsOf(folderKey: string): Promise<StoredSession[]> {
    const { sessions, complete } = await this.completeSessions();
    if (!complete) throw new Error("the session list is incomplete: a session file could not be parsed");
    return sessions.filter((s) => s.workspaceFolder?.key === folderKey);
  }

  /** Puts the session file's current row in the index, so a list loaded after a write finds it valid instead of parsing it. */
  async indexSessionRow(sessionId: string, folderKey: string): Promise<void> {
    const folder = this.openFolder(folderKey);
    if (!folder || this.liveMetadata(sessionId) !== undefined) return;
    await getPiSessionMetadata(this.metaIndex, folder.fsPath, sessionId);
  }

  /** The loaded list once every parsed row of its load was applied, and whether every file yielded one; a load an invalidation overtook is waited out again. */
  private async completeSessions(): Promise<{ sessions: StoredSession[]; complete: boolean }> {
    for (;;) {
      await this.ensureSessionsLoaded();
      const generation = this.sessionsGeneration;
      const parsed = this.sessionsParsed;
      const complete = parsed?.generation === generation ? await parsed.done : true;
      if (generation === this.sessionsGeneration && this.allSessionsCache) return { sessions: this.allSessionsCache, complete };
    }
  }

  private openFolder(key: string): FolderTarget | undefined {
    return this.folders().find((t) => t.key === key);
  }

  /** The session directories the open projects' lists read as of the last `reloadFolders`, each once: the projects' own first, in folder order. */
  private listedDirs(): readonly ListedDir[] {
    this.listedDirSnapshot ??= this.readListedDirs();
    return this.listedDirSnapshot;
  }

  // Asks the registry, which checks each adopted record's folder on disk.
  private readListedDirs(): ListedDir[] {
    type Building = { key: string; folder: string; folders: Map<string, string>; own: FolderTarget[]; record?: NonNullable<ListedDir["record"]> };
    const dirs = new Map<string, Building>();
    const dirOf = (folder: string, key: string): Building => {
      const dirKey = folderKey(piSessionDir(folder));
      let dir = dirs.get(dirKey);
      if (!dir) dirs.set(dirKey, (dir = { key: dirKey, folder, folders: new Map(), own: [] }));
      if (!dir.folders.has(key)) dir.folders.set(key, folder);
      return dir;
    };
    const projects = this.folders();
    for (const own of projects) dirOf(own.fsPath, own.key).own.push(own);
    for (const project of projects) {
      for (const record of listedWorktreeRecords(project.fsPath)) dirOf(record.workingFolder, folderKey(record.workingFolder)).record ??= { project, kind: record.kind, workingFolder: record.workingFolder };
    }
    return [...dirs.values()];
  }

  /** The listed directory that is folder `key`'s session directory. */
  private listedDirOfFolder(key: string): ListedDir | undefined {
    return this.listedDirs().find((listed) => listed.folders.has(key));
  }

  /** The listed directory holding a session file's directory. */
  private listedDirOf(dir: string): ListedDir | undefined {
    const key = folderKey(dir);
    return this.listedDirs().find((listed) => listed.key === key);
  }

  /**
   * Where a session in `dir` lists (docs/invariants.md "Worktree chats", Ownership): under the project its latest worktree
   * entry's record names, else under the folder its header names (`originOf`). Undefined when that project is not open.
   */
  private listingOf(session: Pick<IndexedSession, "worktree" | "origin">, dir: ListedDir): Listing | undefined {
    const recorded = session.worktree ? worktreeProjectById(session.worktree.worktreeId) : undefined;
    const folder = recorded !== undefined
      ? this.folders().find((open) => folderKey(open.fsPath) === folderKey(recorded))
      : this.originOf(session.origin, dir);
    if (!folder) return undefined;
    return dir.own.some((own) => own.key === folder.key) ? { folder } : { folder, listedFrom: dir.folder };
  }

  /**
   * The open project a session with no worktree entry belongs to (docs/invariants.md "Worktree chats", Ownership): the folder its
   * header names, mapped as of its start, while `dir` is that folder's session directory; else `dir`'s own or adopted project.
   */
  private originOf(origin: IndexedSession["origin"], dir: ListedDir): FolderTarget | undefined {
    const adopted = dir.record?.kind === "adopted" ? dir.record : undefined;
    const started = startedFolderIn(origin, dir.key);
    if (started === undefined) return dir.own[0] ?? adopted?.project;
    const key = folderKey(started);
    return dir.own.find((own) => folderKey(own.fsPath) === key) ?? (adopted && folderKey(adopted.workingFolder) === key ? adopted.project : undefined);
  }

  /**
   * Where the file of `sessionId` is found from `folder` (rule 1, which also searches the folder's project's worktree folders):
   * `own` in the folder's own session directory and the folder's by the listing's rule (`startedFolderIn`), `other` in any
   * other place, null when it is found nowhere.
   */
  async storedFileFrom(folder: string, sessionId: string): Promise<"own" | "other" | null> {
    const file = await resolvePiSessionFile(folder, sessionId);
    if (file === null) return null;
    const dirKey = folderKey(path.dirname(file));
    if (dirKey !== folderKey(piSessionDir(folder))) return "other";
    const started = startedFolderIn((await getPiSessionMetadataByFile(this.metaIndex, file))?.origin, dirKey);
    return started === undefined || folderKey(started) === folderKey(folder) ? "own" : "other";
  }

  private stamp(session: IndexedSession, folder: FolderTarget): StoredSession {
    return { ...listRow(session), workspaceFolder: { key: folder.key, label: folder.label } };
  }

  /**
   * Every open folder's stored sessions, newest first, each listed once under its project (AD12 Listing). Resolves with
   * the rows the index still holds; rows of the files the index parses are upserted as they arrive, under this load's
   * generation, so none lands on a list loaded after an invalidation.
   */
  private async loadAllSessions(): Promise<StoredSession[]> {
    const generation = this.sessionsGeneration;
    const parsed: Promise<boolean>[] = [];
    const list = async (dir: ListedDir): Promise<StoredSession[]> => {
      const applied: Promise<unknown>[] = [];
      const { sessions, parsed: listParsed } = await listPiSessions(this.metaIndex, dir.folder, (rows) => {
        applied.push(this.upsertSessionsInCache(rows, dir.key, generation, { fromList: true })
          .catch((err) => log("[StorageManager] applying parsed session rows failed for %s: %O", dir.folder, err)));
      });
      // Every batch arrives before the list ends, so `applied` is complete by then.
      parsed.push(listParsed.then(async (complete) => {
        await Promise.all(applied);
        return complete;
      }));
      return (await withDesignStanding(sessions)).flatMap((s) => {
        const listing = this.listingOf(s, dir);
        return listing ? [this.listed(s, listing)] : [];
      });
    };
    for (const folder of this.folders()) void this.pruneOrphanCheckpointReposOnce(folder);
    const perDir = await Promise.all(this.listedDirs().map(list));
    if (generation === this.sessionsGeneration) this.sessionsParsed = { generation, done: Promise.all(parsed).then((lists) => lists.every(Boolean)) };
    // each session once, the copy in its project's own directory first
    const unique = new Map<string, StoredSession>();
    for (const session of perDir.flat()) if (!unique.has(session.id)) unique.set(session.id, session);
    return [...unique.values()].sort(newestFirst);
  }

  private listed(session: IndexedSession, listing: Listing): StoredSession {
    return listing.listedFrom !== undefined ? { ...this.stamp(session, listing.folder), listedFrom: listing.listedFrom } : this.stamp(session, listing.folder);
  }

  /** The cached session list, loading it once when empty. A load overtaken by an invalidation is discarded and redone. */
  private async ensureSessionsLoaded(): Promise<StoredSession[]> {
    while (!this.allSessionsCache) {
      const generation = this.sessionsGeneration;
      if (!this.sessionsLoad) {
        const load = this.loadAllSessions().finally(() => {
          if (this.sessionsLoad === load) this.sessionsLoad = null;
        });
        this.sessionsLoad = load;
      }
      let sessions: StoredSession[];
      try {
        sessions = await this.sessionsLoad;
      } catch (err) {
        if (generation !== this.sessionsGeneration) continue;
        throw err;
      }
      if (generation !== this.sessionsGeneration) continue;
      if (!this.allSessionsCache) {
        this.allSessionsCache = sessions;
        this.sessionFolder = new Map(sessions.map((s) => [s.id, s.workspaceFolder!.key]));
      }
    }
    return this.allSessionsCache;
  }

  /**
   * Once per folder, delete THIS workspace's checkpoint repos whose session file no longer
   * exists (US-013b). `deletePiSession` already removes a repo on explicit delete, so this only
   * reclaims repos orphaned out-of-band (file removed by another process or a prior crash). The sweep
   * is scoped to the workspace's own checkpoint subdir — a global sweep would delete OTHER workspaces'
   * repos, since the live set here is only this workspace's sessions. Runs off the session-list load
   * and never blocks it; the live set is the FULL on-disk session set, so pagination can't mis-prune.
   */
  private pruneOrphanCheckpointReposOnce(folder: FolderTarget): Promise<void> {
    if (this.prunedFolders.has(folder.key)) return Promise.resolve();
    this.prunedFolders.add(folder.key);
    return (async () => {
      try {
        // A missing folder gets no session dir, and is pruned once it is back; a relocation moves repos ahead of their session files.
        if (isRelocationPending(folder.fsPath) || !(await folderPresent(folder.fsPath))) {
          this.prunedFolders.delete(folder.key);
          return;
        }
        const dir = ensurePiSessionDir(folder.fsPath);
        const files = await fs.promises.readdir(dir);
        const liveBases = new Set(files.filter(isPiSessionFile).map((f) => path.basename(f, ".jsonl")));
        const workspaceRepoDir = getWorkspaceCheckpointDir(dir);
        await this.migrateFlatCheckpointRepos(liveBases, workspaceRepoDir);
        await pruneOrphanCheckpointRepos(liveBases, workspaceRepoDir);
      } catch (err) {
        log("[StorageManager] orphan checkpoint repo prune failed: %O", err);
      }
    })();
  }

  /**
   * Move legacy flat checkpoint repos (`<base>/<basename>`, the pre per-workspace layout) for this
   * workspace's live sessions into the workspace subdir (`<base>/<encoded-cwd>/<basename>`), so their
   * rewind history survives the layout change. The repo dir is named after the full session-file
   * basename (`<timestamp>_<uuidv7-id>`), which is globally unique, so matching a flat repo against
   * this workspace's session set unambiguously attributes it here. Skips any already at the new path
   * (e.g. the live session already created it), and the atomic rename keeps it race-safe.
   */
  private async migrateFlatCheckpointRepos(liveBases: ReadonlySet<string>, workspaceRepoDir: string): Promise<void> {
    const flatBase = getCheckpointsBaseDir();
    for (const base of liveBases) {
      const flat = path.join(flatBase, base);
      const scoped = path.join(workspaceRepoDir, base);
      try {
        if (!fs.existsSync(flat) || fs.existsSync(scoped)) continue;
        await fs.promises.mkdir(workspaceRepoDir, { recursive: true });
        await fs.promises.rename(flat, scoped);
      } catch (err) {
        log("[StorageManager] checkpoint repo migration skipped for %s: %O", base, err);
      }
    }
  }

  async getStoredSessions(
    offset: number = 0,
    limit: number = SESSIONS_PAGE_SIZE,
    selectedSessionId?: string
  ): Promise<{ sessions: StoredSession[]; hasMore: boolean; nextOffset: number }> {
    const all = await this.ensureSessionsLoaded();
    const total = all.length;
    const sessions = all.slice(offset, offset + limit);
    const hasMore = offset + limit < total;
    const nextOffset = offset + sessions.length;

    if (selectedSessionId && !sessions.some((s) => s.id === selectedSessionId)) {
      const selectedSession = all.find((s) => s.id === selectedSessionId);
      if (selectedSession) {
        sessions.push(selectedSession);
      }
    }

    return { sessions, hasMore, nextOffset };
  }

  async searchSessions(
    query: string,
    offset: number = 0,
    selectedSessionId?: string
  ): Promise<{ sessions: StoredSession[]; hasMore: boolean; nextOffset: number }> {
    const all = await this.ensureSessionsLoaded();

    if (!query.trim()) {
      return this.getStoredSessions(offset, SESSIONS_PAGE_SIZE, selectedSessionId);
    }

    const normalizedQuery = query.toLowerCase().trim();
    // Sessions carry a visible folder label only with two or more folders open; otherwise every one would match.
    const matchFolder = this.isMultiRoot();
    const allMatches = all.filter((session) => sessionMatchesQuery(session, normalizedQuery, matchFolder));

    const total = allMatches.length;
    const sessions = allMatches.slice(offset, offset + SESSIONS_PAGE_SIZE);
    const hasMore = offset + SESSIONS_PAGE_SIZE < total;
    const nextOffset = offset + sessions.length;

    return { sessions, hasMore, nextOffset };
  }

  /**
   * The open project whose list holds `sessionId` (AD12 Listing), else undefined. The id is only ever matched
   * against directory entries of open folders, so a webview-supplied id cannot name another path.
   */
  async folderOf(sessionId: string): Promise<FolderTarget | undefined> {
    const indexed = this.allSessionsCache?.find((s) => s.id === sessionId)?.workspaceFolder?.key ?? this.sessionFolder.get(sessionId);
    const known = indexed !== undefined ? this.openFolder(indexed) : undefined;
    if (known) return known;
    for (const folder of this.folders()) {
      const file = await resolvePiSessionFile(folder.fsPath, sessionId);
      if (file === null) continue;
      // rule 1 finds the file from every folder of its project, while the session itself names the project it lists under
      const dir = this.listedDirOf(path.dirname(file));
      if (!dir) return undefined;
      // A row the index cannot give (a worker error, a file that does not parse) lists by its directory alone.
      const listing = this.listingOf((await getPiSessionMetadataByFile(this.metaIndex, file)) ?? {}, dir);
      if (!listing) return undefined;
      this.sessionFolder.set(sessionId, listing.folder.key);
      return listing.folder;
    }
    return undefined;
  }

  /** Follow folder adds, removes and relabels: one watcher per listed session dir, then a fresh list. */
  async reloadFolders(): Promise<void> {
    this.listedDirSnapshot = this.readListedDirs();
    const open = new Set(this.folders().map((t) => t.key));
    // A registry folder's watcher goes with its project and with its record.
    const listed = new Set(this.listedDirs().map((dir) => dir.key));
    for (const [key, watcher] of this.sessionWatchers) {
      if (listed.has(key)) continue;
      watcher.dispose();
      this.sessionWatchers.delete(key);
    }
    // A folder re-added later is pruned again, since its sessions may have changed while it was closed.
    for (const key of this.prunedFolders) if (!open.has(key)) this.prunedFolders.delete(key);
    this.invalidateSessionsCache();
    await this.setupSessionWatcher();
    await this.ensureSessionsLoaded();
    this.pushSessionsToAllPanels();
    this.emitChange({});
  }

  invalidateSessionsCache(): void {
    this.allSessionsCache = null;
    this.sessionsLoad = null;
    this.sessionsGeneration++;
    this.promptHistoryCache = null;
    this.readSinceList.clear();
  }

  /** A list not loaded yet reads the tag from the file, so only a loaded one is updated; the change is announced either way. */
  updateSessionTag(sessionId: string, tag: string | null, folderKey: string): void {
    const session = this.allSessionsCache?.find(s => s.id === sessionId);
    if (session) {
      if (tag) {
        session.tag = tag;
      } else {
        delete session.tag;
      }
      this.pushSessionsToAllPanels();
    }
    this.emitChange({ projectKey: folderKey });
  }

  /** A chat announces its session under its working folder; the file's directory and the session's entry decide its list. */
  async addOrUpdateSession(sessionId: string, workingFolderKey: string): Promise<void> {
    const named = this.listedDirOfFolder(workingFolderKey);
    const workingFolder = named?.folders.get(workingFolderKey);
    if (!named || workingFolder === undefined) return;
    const span = perfSpan("sessions.upsert", { minMs: UPSERT_LOG_MIN_MS });
    const generation = this.sessionsGeneration;
    const file = this.liveSession(sessionId)?.liveSessionFile() ?? (await resolvePiSessionFile(workingFolder, sessionId)) ?? undefined;
    const dir = file !== undefined ? this.listedDirOf(path.dirname(file)) : named;
    if (!dir) return;
    const live = this.liveMetadata(sessionId);
    const source = live !== undefined ? "live" : "file";
    const metadata = live !== undefined ? live : await getPiSessionMetadata(this.metaIndex, dir.folder, sessionId);
    const applied = metadata ? await this.upsertSessionsInCache([metadata], dir.key, generation) : false;
    span.end({ source, applied });
  }

  async getPromptHistory(
    offset: number = 0
  ): Promise<{ history: string[]; hasMore: boolean }> {
    // Complete, since nothing rebuilds the history when parsed rows arrive. A file that yielded no row only misses its prompts, so an incomplete list still serves.
    const { sessions: all } = await this.completeSessions();

    if (!this.promptHistoryCache) {
      const allHistory = await extractPiPromptHistory(this.metaIndex, this.folders().map((t) => t.fsPath), all);
      const diskSet = new Set(allHistory);
      const uniquePending = this.pendingPromptEntries.filter((e) => !diskSet.has(e));
      this.promptHistoryCache = [...uniquePending, ...allHistory];
      this.pendingPromptEntries = uniquePending;
    }

    const PROMPT_HISTORY_PAGE_SIZE = 100;
    const pageItems = this.promptHistoryCache.slice(offset, offset + PROMPT_HISTORY_PAGE_SIZE);
    const hasMore = this.promptHistoryCache.length > offset + PROMPT_HISTORY_PAGE_SIZE;

    return { history: pageItems, hasMore };
  }

  /** Watch the session dir of the folder `workingFolderKey` when a list reads it, or every listed one when omitted. Idempotent per dir. */
  async setupSessionWatcher(workingFolderKey?: string): Promise<void> {
    const dirs = this.listedDirs();
    for (const dir of workingFolderKey !== undefined ? dirs.filter((listed) => listed.folders.has(workingFolderKey)) : dirs) await this.watchDir(dir);
  }

  private async watchDir(dir: ListedDir): Promise<void> {
    if (this.sessionWatchers.has(dir.key)) return;
    let sessionDir = piSessionDir(dir.folder);
    if (dir.own.length > 0) {
      // pi writes to the Damocles-owned pi tree dir (created here so the watcher attaches even before
      // the first session); a missing folder's existing one is watched, and none is created for it.
      if (await folderPresent(dir.folder)) sessionDir = ensurePiSessionDir(dir.folder);
      try {
        await fs.promises.access(sessionDir);
      } catch {
        return;
      }
      // Re-checked after the await: a concurrent call may have attached one, or the folder may have closed.
      if (this.sessionWatchers.has(dir.key) || !this.listedDirs().some((listed) => listed.key === dir.key)) return;
    }
    // A registry folder's is not created here: a watch on a missing directory starts once it appears, and only a session there creates it.
    const watcher = this.fileWatchers.watch(sessionDir, "*.jsonl");
    // An event's path may spell the directory another way (an 8.3 name, a link), so updates go by the watched directory's key.
    watcher.onDidCreate((filePath) => {
      this.handleSessionFileCreated(filePath, dir.key).catch((err) => log("[StorageManager] session file create upsert failed for %s: %O", filePath, err));
    });
    watcher.onDidChange((filePath) => this.handleSessionFileChanged(filePath, dir.key));
    watcher.onDidDelete((filePath) => this.handleSessionFileDeleted(filePath));
    this.sessionWatchers.set(dir.key, watcher);
  }

  pushSessionsToAllPanels(): void {
    if (!this.allSessionsCache) return;

    const sessions = this.allSessionsCache.slice(0, SESSIONS_PAGE_SIZE);
    const hasMore = this.allSessionsCache.length > SESSIONS_PAGE_SIZE;
    const nextOffset = sessions.length;

    for (const [, instance] of this.getPanels()) {
      this.postMessage(instance.host, {
        type: "storedSessions",
        sessions,
        hasMore,
        nextOffset,
        isFirstPage: true,
      });
    }
  }

  broadcastPromptHistoryEntry(entry: string): void {
    const MAX_PENDING_ENTRIES = 50;
    this.pendingPromptEntries = [entry, ...this.pendingPromptEntries.filter((e) => e !== entry)].slice(0, MAX_PENDING_ENTRIES);
    this.promptHistoryCache = null;

    for (const [, instance] of this.getPanels()) {
      this.postMessage(instance.host, {
        type: "promptHistoryPush",
        entry,
      });
    }
  }

  /** Stops watching at once, and closes the session index once `indexReleased` settles. */
  async dispose(indexReleased: Promise<void> = Promise.resolve()): Promise<void> {
    for (const watcher of this.sessionWatchers.values()) watcher.dispose();
    this.sessionWatchers.clear();
    for (const timer of this.pendingChangeTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingChangeTimers.clear();
    if (this.parsedRowsPush) clearTimeout(this.parsedRowsPush.timer);
    this.parsedRowsPush = null;
    await indexReleased;
    await this.metaIndex.close();
  }

  private async handleSessionFileCreated(filePath: string, dirKey: string): Promise<void> {
    return this.handlePiSessionFileUpsert(filePath, dirKey);
  }

  private handleSessionFileChanged(filePath: string, dirKey: string): void {
    return this.handlePiSessionFileChanged(filePath, dirKey);
  }

  /** A live session's metadata from its in-memory manager, or undefined when no live session here holds the file. */
  private liveMetadata(sessionId: string, filePath?: string): IndexedSession | null | undefined {
    const source = this.liveSession(sessionId);
    return source ? readLiveSessionMetadata(this.metaIndex, source, sessionId, filePath) : undefined;
  }

  /**
   * Applied after the load too, because a shared load may have read the file before this change. Dropped
   * when the list was invalidated after `generation` (the list loaded since then read the file after the
   * metadata was) or no list reads the dir any more; a row whose project is not open is not listed. `fromList`
   * marks rows the list parsed after it loaded, read when it listed: one never replaces a row read since, nor
   * one listed from another dir (`listedFrom`, a registry folder's session dir). Returns whether any row was applied.
   */
  private async upsertSessionsInCache(
    rows: readonly IndexedSession[],
    dirKey: string,
    generation: number,
    options?: { ifChanged?: boolean; fromList?: boolean },
  ): Promise<boolean> {
    if (rows.length === 0 || generation !== this.sessionsGeneration) return false;
    const standing = await withDesignStanding(rows);
    const all = await this.ensureSessionsLoaded();
    const dir = this.listedDirs().find((listed) => listed.key === dirKey);
    if (generation !== this.sessionsGeneration || !dir) return false;
    const changedProjects = new Set<string>();
    let applied = false;
    for (const metadata of standing) {
      const listing = this.listingOf(metadata, dir);
      if (!listing) continue;
      const existingIndex = all.findIndex((s) => s.id === metadata.id);
      const existing = existingIndex >= 0 ? all[existingIndex]! : undefined;
      if (options?.fromList) {
        // The project's own dir wins over a registry folder's, as in `loadAllSessions`; between registry folders the first listed wins.
        if (this.readSinceList.has(metadata.id) || (existing && existing.listedFrom !== listing.listedFrom && listing.listedFrom !== undefined)) continue;
      } else {
        this.readSinceList.add(metadata.id);
      }
      const row = this.listed(metadata, listing);
      this.sessionFolder.set(metadata.id, listing.folder.key);
      if (existing) {
        if (options?.ifChanged && sameRow(existing, row)) continue;
        all[existingIndex] = row;
      } else {
        all.push(row);
      }
      applied = true;
      if (!existing || !sameListing(existing, row) || existing.workspaceFolder?.key !== row.workspaceFolder?.key) {
        changedProjects.add(listing.folder.key);
        if (existing?.workspaceFolder && existing.workspaceFolder.key !== listing.folder.key) changedProjects.add(existing.workspaceFolder.key);
      }
    }
    if (!applied) return false;
    all.sort(newestFirst);
    if (options?.fromList) {
      this.announceParsedRows(changedProjects);
      return true;
    }
    this.pushSessionsToAllPanels();
    for (const projectKey of changedProjects) this.emitChange({ projectKey });
    return true;
  }

  /** A cold list delivers its parsed rows in many batches, so their pushes and change events go out once per `PARSED_ROWS_PUSH_MS`. */
  private announceParsedRows(changedProjects: ReadonlySet<string>): void {
    this.parsedRowsPush ??= {
      changed: new Set(),
      timer: setTimeout(() => {
        const pending = this.parsedRowsPush;
        this.parsedRowsPush = null;
        if (!pending) return;
        this.pushSessionsToAllPanels();
        for (const projectKey of pending.changed) this.emitChange({ projectKey });
      }, PARSED_ROWS_PUSH_MS),
    };
    for (const projectKey of changedProjects) this.parsedRowsPush.changed.add(projectKey);
  }

  private handleSessionFileDeleted(filePath: string): void {
    return this.handlePiSessionFileDeleted(filePath);
  }

  // ---- pi tree watcher handlers (FR-1) ------------------------------------
  // pi session files are named `<timestamp>_<id>.jsonl`, so the file base is NOT the session id and
  // metadata is read from the file itself; debounce timers are keyed by file path.

  private async handlePiSessionFileUpsert(filePath: string, dirKey: string): Promise<void> {
    if (!isPiSessionFile(filePath)) return;
    // Let pi finish writing the header before the first read.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await this.upsertFromFile(filePath, dirKey);
  }

  /**
   * When the file's size and mtime match the cached read, the cached row is applied and the file is not
   * read: on Windows, reading a file can update its last-access time, which `fs.watch` reports as a
   * change, so the list's own reads would otherwise re-trigger it.
   */
  private async upsertFromFile(filePath: string, dirKey: string): Promise<void> {
    const generation = this.sessionsGeneration;
    const cached = await currentCachedRow(this.metaIndex, filePath);
    if (cached !== undefined) {
      if (cached) await this.upsertSessionsInCache([cached], dirKey, generation, { ifChanged: true });
      return;
    }
    const span = perfSpan("sessions.upsert", { minMs: UPSERT_LOG_MIN_MS });
    const live = this.liveMetadata(piSessionIdFromFile(filePath), filePath);
    const source = live !== undefined ? "live" : "file";
    const metadata = live !== undefined ? live : await getPiSessionMetadataByFile(this.metaIndex, filePath);
    const applied = metadata ? await this.upsertSessionsInCache([metadata], dirKey, generation) : false;
    span.end({ source, applied });
  }

  private handlePiSessionFileChanged(filePath: string, dirKey: string): void {
    if (!isPiSessionFile(filePath)) return;
    const key = filePath;
    const existingTimer = this.pendingChangeTimers.get(key);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      this.pendingChangeTimers.delete(key);
      this.upsertFromFile(filePath, dirKey).catch((err) => log("[StorageManager] session file change upsert failed for %s: %O", filePath, err));
    }, CHANGE_DEBOUNCE_MS);
    this.pendingChangeTimers.set(key, timer);
  }

  private handlePiSessionFileDeleted(filePath: string): void {
    if (!isPiSessionFile(filePath)) return;
    const key = filePath;
    const existingTimer = this.pendingChangeTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.pendingChangeTimers.delete(key);
    }
    // Another window's delete, too, leaves the index.
    forgetSessionMetadata(this.metaIndex, filePath);
    const sessionId = piSessionIdFromFile(filePath);
    this.readSinceList.add(sessionId);
    const folderKey = this.sessionFolder.get(sessionId);
    this.sessionFolder.delete(sessionId);
    if (this.allSessionsCache) {
      this.allSessionsCache = this.allSessionsCache.filter((s) => s.id !== sessionId);
    } else if (this.sessionsLoad) {
      // The load in flight may have listed the file before it went.
      this.invalidateSessionsCache();
    }
    this.pushSessionsToAllPanels();
    if (folderKey !== undefined) this.emitChange({ projectKey: folderKey });
  }
}
