import * as crypto from "crypto";
import { statSync } from "fs";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { slugify } from "@shared/utils";
import { canonicalPath, spelledPath } from "./canonical-path";

export const DAMOCLES_HOME_DIR: string = path.join(os.homedir(), ".damocles");

export const DAMOCLES_PLANS_DIR: string = path.join(DAMOCLES_HOME_DIR, "plans");
export const DAMOCLES_EXPLORES_DIR: string = path.join(DAMOCLES_HOME_DIR, "explores");
/** Design folders, `<designId>/`, and core's state folder for them, `.state/<designId>/`. */
export const DAMOCLES_DESIGNS_DIR: string = path.join(DAMOCLES_HOME_DIR, "designs");

export const DAMOCLES_USAGE_DIR: string = path.join(DAMOCLES_HOME_DIR, "usage");
/** Append-only JSONL of internal sub-call usage (titles, memory, /btw), which no session file records. */
export const SUBCALL_USAGE_LEDGER_PATH: string = path.join(DAMOCLES_USAGE_DIR, "subcalls.jsonl");
/** SQLite cache behind `/stats`, rebuilt incrementally from session files and the ledger. */
export const USAGE_INDEX_DB_PATH: string = path.join(DAMOCLES_USAGE_DIR, "usage.db");

/** Persistent session-list metadata, one JSON file per pi session dir; a pure cache of the session files. */
export const SESSION_META_CACHE_DIR: string = path.join(DAMOCLES_HOME_DIR, "cache", "session-meta");

/** `{ movedAt, by }`: which host moved auth.json's OpenAI API key into its own secret store. Never holds the key. */
export const OPENAI_KEY_MOVED_MARKER_PATH: string = path.join(DAMOCLES_HOME_DIR, "openai-api-key-moved.json");

/** `{ sweptAt }`: the key sync's one-time removal of plain-text key-provider keys older versions wrote to auth.json ran. */
export const PROVIDER_KEY_SWEEP_MARKER_PATH: string = path.join(DAMOCLES_HOME_DIR, "provider-key-sweep.json");

/** Root for browser-captured downloads; the browser service saves each launch's files under a per-launch subdir. */
export const DAMOCLES_BROWSER_DOWNLOADS_DIR: string = path.join(DAMOCLES_HOME_DIR, "browser-downloads");

/**
 * The deterministic per-session plan-file path: `~/.damocles/plans/<slug>-<id8>.md`, where `slug` is the
 * (immutable) first user message slugified and capped at 50 chars (falling back to `plan` when empty) and
 * `id8` is the first 8 hex chars of the SHA-256 of the session id. Hashing (rather than slicing the raw id)
 * is what makes the suffix the real disambiguator: pi session ids are uuidv7, whose leading bytes are a
 * millisecond timestamp shared by every session created in the same ~65s window, so a raw `slice(0, 8)`
 * would collide for same-minute sessions — collapsing entirely onto the slug, and silently overwriting the
 * `plan-<id8>.md` fallback of any two never-prompted sessions. Pure function of `(sessionId, firstMessage)`,
 * so every producer (plan-mode write, approve-on-exit) and consumer (view-plan resolve) computes the same
 * path with no stored state — correct across reload, clear-context, and re-planning.
 */
export function computePlanFilePath(sessionId: string, firstMessage: string): string {
  return path.join(DAMOCLES_PLANS_DIR, `${planFileStem(sessionId, firstMessage)}.md`);
}

/** `<slug>-<id8>`, the plan file's name without `.md`; a design folder of the same session takes the same name. */
export function planFileStem(sessionId: string, firstMessage: string): string {
  const slug = slugify(firstMessage).slice(0, 50).replace(/-+$/, "") || "plan";
  return `${slug}-${planFileIdSuffix(sessionId)}`;
}

/**
 * The stable 8-hex disambiguator a session stamps onto every plan file it writes, regardless of how its
 * first-message slug later evolves. Consumers match on this suffix (see `findSessionPlanFiles`) rather than
 * recomputing the full slug, so a plan written before the slug settled — e.g. one bound to a session that
 * had not yet been prompted — is still found once the user's first message changes the slug.
 */
export function planFileIdSuffix(sessionId: string): string {
  return crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
}

/**
 * Every existing plan file for a session, located by its stable `-<id8>.md` suffix and ordered newest-mtime
 * first (the active plan when slug drift left more than one). Empty when the plans dir or any match is
 * absent. The suffix-match is what decouples lookup from the cosmetic slug — see `planFileIdSuffix`.
 */
export async function findSessionPlanFiles(sessionId: string): Promise<string[]> {
  const suffix = `-${planFileIdSuffix(sessionId)}.md`;
  let entries: string[];
  try {
    entries = await fs.readdir(DAMOCLES_PLANS_DIR);
  } catch {
    return [];
  }
  const stated = await Promise.all(
    entries
      .filter((name) => name.endsWith(suffix))
      .map(async (name) => {
        const filePath = path.join(DAMOCLES_PLANS_DIR, name);
        try {
          return { filePath, mtime: (await fs.stat(filePath)).mtimeMs };
        } catch {
          return null;
        }
      }),
  );
  return stated
    .filter((entry): entry is { filePath: string; mtime: number } => entry !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .map((entry) => entry.filePath);
}

/**
 * Whether `filePath` is a Damocles plan markdown file (a `.md` inside `~/.damocles/plans`). This is the
 * single carve-out used to auto-allow `Edit`/`Write` to the plan file in every permission mode — including
 * plan mode, where all other writes are blocked — so the model can maintain its plan as it designs.
 * Pass the absolute path the tool writes: a relative one resolves against this process's cwd, not the session's.
 */
export function isPlanFilePath(filePath: string): boolean {
  const canonical = canonicalPathBelow(DAMOCLES_PLANS_DIR, filePath);
  return canonical !== undefined && (process.platform === "win32" ? canonical.toLowerCase() : canonical).endsWith(".md");
}

/**
 * Whether `filePath` names an entry below `dir`. Both the path as written and the path it resolves to through
 * links must sit below `dir`, compared as the file system spells them (8.3 names expanded, stored case, no
 * `\\?\` prefix), and an existing entry must have an `nlink` of 1, so no other hard link shares it. It does not
 * check that the entry is a file: an existing directory passes only where its `nlink` is 1, as on NTFS.
 * Pass an absolute path: a relative one resolves against this process's cwd.
 */
export function isFileBelow(dir: string, filePath: string): boolean {
  return canonicalPathBelow(dir, filePath) !== undefined;
}

/** The canonical path of `filePath` when `isFileBelow(dir, filePath)` holds, else undefined. */
function canonicalPathBelow(dir: string, filePath: string): string | undefined {
  if (!filePath) return undefined;
  const requested = path.resolve(filePath);
  const below = (parent: string, target: string): boolean => {
    const relative = path.relative(parent, target);
    return relative !== "" && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
  };
  const canonical = canonicalPath(requested);
  return below(spelledPath(dir), spelledPath(requested))
    && below(canonicalPath(dir), canonical)
    // A hard link shares its content with a name outside `dir`, which no path comparison sees.
    && !hasOtherHardLink(canonical)
    ? canonical
    : undefined;
}

/** Whether an existing entry at canonical path `canonical` has an `nlink` above 1; false when nothing is there. */
export function hasOtherHardLink(canonical: string): boolean {
  return (statSync(canonical, { throwIfNoEntry: false })?.nlink ?? 1) !== 1;
}

export function workspaceHash(workspacePath: string): string {
  return crypto.createHash("sha256").update(workspacePath).digest("hex").slice(0, 12);
}

export function getExploreSessionDir(workspacePath: string, sessionId: string): string {
  return path.join(DAMOCLES_EXPLORES_DIR, workspaceHash(workspacePath), sessionId);
}
