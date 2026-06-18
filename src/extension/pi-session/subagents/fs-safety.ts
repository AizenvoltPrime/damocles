/**
 * fs-safety.ts — Filesystem-safety helpers for agent/skill loading.
 *
 * Extracted from @tintinweb/pi-subagents `memory.ts` (MIT, © 2026 tintinweb; see
 * THIRD-PARTY-NOTICES.md). Only the symlink / path-traversal guards are ported — the
 * agent-memory feature itself is intentionally not.
 */

import { existsSync, lstatSync, readFileSync } from 'node:fs';

/**
 * True if a name contains characters not allowed in agent/skill names.
 * Whitelist: alphanumeric, hyphens, underscores, and dots (no leading dot), max 128 chars.
 */
export function isUnsafeName(name: string): boolean {
  if (!name || name.length > 128) return true;
  return !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
}

/** True if the given path is a symlink (defense against symlink attacks). */
export function isSymlink(filePath: string): boolean {
  try {
    return lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Safely read a file, rejecting symlinks. Returns undefined if the file doesn't
 * exist, is a symlink, or can't be read.
 */
export function safeReadFile(filePath: string): string | undefined {
  if (!existsSync(filePath)) return undefined;
  if (isSymlink(filePath)) return undefined;
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return undefined;
  }
}
