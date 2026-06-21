import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { slugify } from "@shared/utils";

export const DAMOCLES_HOME_DIR: string = path.join(os.homedir(), ".damocles");

export const DAMOCLES_PLANS_DIR: string = path.join(DAMOCLES_HOME_DIR, "plans");
export const DAMOCLES_EXPLORES_DIR: string = path.join(DAMOCLES_HOME_DIR, "explores");

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
  const slug = slugify(firstMessage).slice(0, 50).replace(/-+$/, "") || "plan";
  return path.join(DAMOCLES_PLANS_DIR, `${slug}-${planFileIdSuffix(sessionId)}.md`);
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
 */
export function isPlanFilePath(filePath: string): boolean {
  if (!filePath) return false;
  const resolved = path.resolve(filePath);
  const plansDir = path.resolve(DAMOCLES_PLANS_DIR);
  return resolved.startsWith(plansDir + path.sep) && resolved.endsWith(".md");
}

export function workspaceHash(workspacePath: string): string {
  return crypto.createHash("sha256").update(workspacePath).digest("hex").slice(0, 12);
}

export function getExploreSessionDir(workspacePath: string, sessionId: string): string {
  return path.join(DAMOCLES_EXPLORES_DIR, workspaceHash(workspacePath), sessionId);
}
