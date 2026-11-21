/**
 * fs-safety.ts — The name guard for agent/skill loading.
 *
 * Extracted from @tintinweb/pi-subagents `memory.ts` (MIT, © 2026 tintinweb; see
 * THIRD-PARTY-NOTICES.md). Links are judged by the asset walker (src/core/assets).
 */

/**
 * True if a name contains characters not allowed in agent/skill names.
 * Whitelist: alphanumeric, hyphens, underscores, and dots (no leading dot), max 128 chars.
 */
export function isUnsafeName(name: string): boolean {
  if (!name || name.length > 128) return true;
  return !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
}
