import * as fs from 'fs';
import * as path from 'path';

/**
 * Relocates the user-global instructions file from pi's `agentDir` (`~/.damocles/pi/agent/`, an
 * internal state directory users never open) to the top level of `~/.damocles/`, beside
 * `settings.json`. In a trusted workspace only the global slot moves: the ancestor walk, the
 * per-directory candidate order and the linked-worktree shadow suppression stay pi's, so project
 * discovery is unchanged. An untrusted workspace contributes no context file at all.
 *
 * Tracks pi `@earendil-works/pi-coding-agent@^0.84.2`,
 * `packages/coding-agent/src/core/resource-loader.ts`: `:70-71` candidate names,
 * `:118-156` `loadProjectContextFiles` (global entry first, then ancestors root-first),
 * `:514-522` where `agentsFilesOverride` is applied. Recheck these on a pi upgrade.
 */

/** pi's per-directory context-file candidates, in pi's order (`resource-loader.ts:71`). */
export const CONTEXT_FILE_CANDIDATES: readonly string[] = [
  'AGENTS.override.md',
  'AGENTS.md',
  'AGENTS.MD',
  'CLAUDE.md',
  'CLAUDE.MD',
];

/**
 * Size ceiling for a global instructions file. The content is spliced into the system prompt on every
 * turn, so a runaway file would be re-sent to the model for the life of the window.
 */
const MAX_CONTEXT_FILE_BYTES = 1024 * 1024;

/**
 * First regular-file candidate at the top level of `<homeDir>/.damocles`, or undefined when none is
 * readable. `homeDir` is a parameter rather than the `DAMOCLES_HOME_DIR` constant because that
 * constant freezes the real `os.homedir()` at import time.
 */
export function resolveGlobalContextFile(homeDir: string): { path: string; content: string } | undefined {
  const dir = path.join(homeDir, '.damocles');
  for (const filename of CONTEXT_FILE_CANDIDATES) {
    const filePath = path.join(dir, filename);
    try {
      // statSync, not lstatSync: a symlink to a regular file is a legitimate global.
      const stats = fs.statSync(filePath);
      if (!stats.isFile()) continue;
      if (stats.size > MAX_CONTEXT_FILE_BYTES) {
        console.warn(
          `[context-files] skipping ${filePath}: ${stats.size} bytes is over the ${MAX_CONTEXT_FILE_BYTES}-byte system-prompt limit`,
        );
        continue;
      }
      return { path: filePath, content: fs.readFileSync(filePath, 'utf8') };
    } catch {
      // Absent or unreadable: try the next candidate, matching pi's own per-candidate skip.
    }
  }
  return undefined;
}

/**
 * Resolved absolute form, case-folded only on win32, where the filesystem is case-insensitive and a
 * drive letter may legitimately differ in case between two sides of a comparison.
 */
function normalizePathKey(target: string): string {
  const resolved = path.resolve(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Whether `p` is `dir` itself or lies beneath it, so a sibling like `agentX` is not caught. */
function isUnder(p: string, dir: string): boolean {
  const resolved = normalizePathKey(p);
  const resolvedDir = normalizePathKey(dir);
  return resolved === resolvedDir || resolved.startsWith(resolvedDir + path.sep);
}

/**
 * Swaps pi's `agentDir`-sourced global entry for `~/.damocles/`'s, leaving every ancestor entry in
 * place and in order. With no global at `~/.damocles/`, `base` is returned untouched so the
 * `agentDir` file still loads.
 *
 * `opts.trusted` is the workspace trust state. An untrusted workspace keeps only the user's own
 * files, dropping every ancestor-walk entry, so a cloned repo cannot reach the system prompt through
 * its own `AGENTS.md` or `CLAUDE.md`. That matches the project skill and command dirs, which the same
 * repo cannot contribute either. Trust is a parameter so this module stays free of `vscode`; the
 * caller must read `vscode.workspace.isTrusted` per call, because granting trust re-runs the override
 * without a window reload.
 */
export function overrideGlobalContextFile(
  base: Array<{ path: string; content: string }>,
  opts: { agentDir: string; homeDir: string; trusted: boolean },
): Array<{ path: string; content: string }> {
  const global = resolveGlobalContextFile(opts.homeDir);
  if (!opts.trusted) {
    // With no `~/.damocles/` global, pi's `agentDir` file is the only remaining user-authored source.
    return global ? [global] : base.filter((entry) => isUnder(entry.path, opts.agentDir));
  }
  if (!global) return base;
  // pi's own dedupe (`seenPaths`) only ever covered the agentDir global and is discarded before the
  // override runs, so the swapped-in path must be excluded here: a workspace at or under `~/.damocles/`
  // puts the same file in the ancestor walk, which would otherwise repeat the instructions.
  const globalKey = normalizePathKey(global.path);
  return [
    global,
    ...base.filter((entry) => !isUnder(entry.path, opts.agentDir) && normalizePathKey(entry.path) !== globalKey),
  ];
}
