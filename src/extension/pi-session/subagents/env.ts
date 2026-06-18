/**
 * env.ts — Detect environment info (git, platform) for subagent system prompts.
 *
 * Adapted from @tintinweb/pi-subagents (MIT, © 2026 tintinweb; see THIRD-PARTY-NOTICES.md).
 * Upstream shelled out to `pi.exec("git", ...)`; here we read `.git/HEAD` directly — no child
 * process, no dependency on pi's exec surface (which the Damocles subagent path does not use).
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { EnvInfo } from './types';

/** Read the current branch from `.git/HEAD` (`ref: refs/heads/<branch>`), or a short SHA when detached. */
function readGitBranch(gitDir: string): string {
  try {
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf-8').trim();
    const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (match) return match[1] ?? 'unknown';
    return head.length >= 7 ? head.slice(0, 7) : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Detect git/platform facts for the agent system prompt. Synchronous and best-effort. */
export function detectEnv(cwd: string): EnvInfo {
  const gitDir = join(cwd, '.git');
  let isGitRepo = false;
  try {
    isGitRepo = existsSync(gitDir) && statSync(gitDir).isDirectory();
  } catch {
    isGitRepo = false;
  }
  return {
    isGitRepo,
    branch: isGitRepo ? readGitBranch(gitDir) : '',
    platform: process.platform,
  };
}
