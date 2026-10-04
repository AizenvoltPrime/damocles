import type { Disposable } from "../../platform/disposable";
import type { NotificationService } from "../../platform/notification-service";
import type { StoredSession } from "../../shared/types/session";
import type { MemoryService } from "../memory";
import type { HostInstance } from "./types";
import type { StorageManager, StoredSessionsChange } from "./storage-manager";
import { sessionMatchesQuery } from "./storage-manager";
import { log } from "../logger";
import { t } from "../l10n";
import { deletePiSession, renamePiSession, tagPiSession } from "../pi-session/session-store";
import { PiRuntime } from "../pi-session/pi-runtime";
import { isSafeAgentPathId } from "../pi-session/agent-records";
import { whileSessionLeased } from "./session-ownership";

export const MAX_SESSION_NAME_CHARS = 200;
export const MAX_SESSION_TAG_CHARS = 50;

/** `leased` was already announced to the user; `invalid` and `failed` carry a localized reason. */
export type CatalogResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "leased" | "missing" }
  | { readonly ok: false; readonly reason: "invalid" | "failed"; readonly message: string };

/** The stored conversations of the open folders, and the only path that renames, tags or deletes one. */
export interface SessionCatalog {
  /** The open folder's sessions, newest first and complete; empty for a key that is not an open folder. */
  list(projectKey: string): Promise<readonly StoredSession[]>;
  /** `list` narrowed to titles and tags containing `query`, case-insensitively; a blank query is `list`. */
  search(projectKey: string, query: string): Promise<readonly StoredSession[]>;
  rename(sessionId: string, name: string): Promise<CatalogResult>;
  /** Null removes the tag. */
  tag(sessionId: string, tag: string | null): Promise<CatalogResult>;
  delete(sessionId: string): Promise<CatalogResult>;
  /** A session was added or removed, or a listed field changed; not for timestamp-only writes. */
  onDidChange(listener: (change: StoredSessionsChange) => void): Disposable;
}

export interface SessionCatalogDeps {
  storage: Pick<StorageManager, "sessionsOf" | "folderOf" | "markSessionsChanged" | "updateSessionTag" | "onDidChangeSessions">;
  getPanels: () => Map<string, HostInstance>;
  notifications: NotificationService;
  memoryService?: Pick<MemoryService, "deleteSessionMemories">;
}

const OK: CatalogResult = { ok: true };
const LEASED: CatalogResult = { ok: false, reason: "leased" };
const MISSING: CatalogResult = { ok: false, reason: "missing" };

function failed(action: string, sessionId: string, err: unknown): CatalogResult {
  log("[SessionCatalog] %s of session %s failed: %O", action, sessionId, err);
  return { ok: false, reason: "failed", message: err instanceof Error ? err.message : String(err) };
}

/** Webview and IPC callers pass raw values, and the id names lease and session paths: anything else names no session. */
function isSessionId(value: unknown): value is string {
  return typeof value === "string" && isSafeAgentPathId(value);
}

/** Trimmed `value` when it is a string whose trimmed length is within 1..`max`, else undefined. */
function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= max ? trimmed : undefined;
}

export function createSessionCatalog(deps: SessionCatalogDeps): SessionCatalog {
  const { storage, getPanels, notifications, memoryService } = deps;

  /**
   * Rename and tag go through the live session when one holds the conversation: a second file writer
   * would fork the branch and drop messages. Otherwise the file is written under the session's lease.
   * Resolves the folder key the change belongs to, or undefined when the session has no file yet and so sits in no list.
   */
  const mutate = async (
    sessionId: string,
    live: (mutator: NonNullable<ReturnType<typeof PiRuntime.liveSessionMutator>>) => Promise<void>,
    file: (cwd: string) => Promise<void>,
  ): Promise<{ result: CatalogResult; folderKey?: string }> => {
    const folder = await storage.folderOf(sessionId);
    // Read after the await, so a session that went live or let go meanwhile is routed by what holds it now.
    const mutator = PiRuntime.liveSessionMutator(sessionId);
    if (mutator) {
      await live(mutator);
      return folder ? { result: OK, folderKey: folder.key } : { result: OK };
    }
    if (!folder) return { result: MISSING };
    const written = await whileSessionLeased(notifications, sessionId, () => file(folder.fsPath));
    return written ? { result: OK, folderKey: folder.key } : { result: LEASED };
  };

  return {
    list: (projectKey) => storage.sessionsOf(projectKey),

    search: async (projectKey, query) => {
      const sessions = await storage.sessionsOf(projectKey);
      const normalized = query.trim().toLowerCase();
      return normalized === "" ? sessions : sessions.filter((s) => sessionMatchesQuery(s, normalized, false));
    },

    rename: async (sessionId, name) => {
      if (!isSessionId(sessionId)) return MISSING;
      const newName = bounded(name, MAX_SESSION_NAME_CHARS);
      if (newName === undefined) {
        return { ok: false, reason: "invalid", message: t("A session name must be 1 to {0} characters.", MAX_SESSION_NAME_CHARS) };
      }
      try {
        const { result, folderKey } = await mutate(
          sessionId,
          (mutator) => mutator.renameActiveSession(newName),
          (cwd) => renamePiSession(cwd, sessionId, newName),
        );
        if (!result.ok) return result;
        if (folderKey !== undefined) storage.markSessionsChanged(folderKey);
        return OK;
      } catch (err) {
        return failed("rename", sessionId, err);
      }
    },

    tag: async (sessionId, tag) => {
      if (!isSessionId(sessionId)) return MISSING;
      const newTag = tag === null ? null : bounded(tag, MAX_SESSION_TAG_CHARS);
      if (newTag === undefined) {
        return { ok: false, reason: "invalid", message: t("A tag must be 1 to {0} characters.", MAX_SESSION_TAG_CHARS) };
      }
      try {
        const { result, folderKey } = await mutate(
          sessionId,
          (mutator) => mutator.setActiveSessionTag(newTag),
          (cwd) => tagPiSession(cwd, sessionId, newTag),
        );
        if (!result.ok) return result;
        if (folderKey !== undefined) storage.updateSessionTag(sessionId, newTag, folderKey);
        return OK;
      } catch (err) {
        return failed("tag", sessionId, err);
      }
    },

    delete: async (sessionId) => {
      if (!isSessionId(sessionId)) return MISSING;
      try {
        // Looked up before the lease, so no await separates the detach from the rm.
        const folder = await storage.folderOf(sessionId);
        if (!folder) return MISSING;
        // Every holder stops writing before the file goes, or its next append recreates the path as a
        // header-less file; a detach that rejects aborts the delete. The lease is held throughout, so no
        // other process and no panel of this one claims the session between the detach and the rm.
        const deleted = await whileSessionLeased(notifications, sessionId, async () => {
          const holders = new Set<{ detachFromDeletedSession(): Promise<void> }>();
          const registered = PiRuntime.liveSessionMutator(sessionId);
          if (registered) holders.add(registered);
          // A panel that only points at the session as a resume or fork target registers no mutator.
          for (const [, instance] of getPanels()) {
            if (instance.session.holdsSession(sessionId)) holders.add(instance.session);
          }
          await Promise.all([...holders].map((holder) => holder.detachFromDeletedSession()));
          await deletePiSession(folder.fsPath, sessionId);
        });
        if (!deleted) return LEASED;
        // The file is gone, which is the deletion; a memory cleanup failure leaves it deleted.
        try {
          await memoryService?.deleteSessionMemories(sessionId);
        } catch (err) {
          log("[SessionCatalog] session %s deleted but its memory cleanup failed: %O", sessionId, err);
        }
        storage.markSessionsChanged(folder.key);
        return OK;
      } catch (err) {
        return failed("delete", sessionId, err);
      }
    },

    onDidChange: (listener) => storage.onDidChangeSessions(listener),
  };
}
