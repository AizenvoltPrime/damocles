import * as fs from 'fs';
import * as path from 'path';
import { stripBom } from '../config/bom';
import { checkConfigPathSync, noticeRefusedConfigRead, type ConfigNotices } from '../config/local-config-path';
import { folderKey } from '../workspace-folders/folder-key';

/**
 * Relocates the user-global instructions file from pi's `agentDir` (`~/.damocles/pi/agent/`, an
 * internal state directory users never open) to the top level of `~/.damocles/`, beside
 * `settings.json`. In a trusted workspace only the global slot moves: the ancestor walk, the
 * per-directory candidate order and the linked-worktree shadow suppression stay pi's, so project
 * discovery is unchanged. An untrusted workspace contributes no context file at all.
 *
 * Tracks pi `@earendil-works/pi-coding-agent@1.5.2`. Citations are line numbers in the shipped
 * `dist/core/resource-loader.js`, not the `.ts` lines its source maps carry: `:130` candidate
 * names, `:150-178` the linked-worktree shadow suppression, `:179-210` `loadProjectContextFiles` (global
 * entry first, then ancestors root-first via `unshift`), `:480-488` where `agentsFilesOverride` is
 * applied, after the `noContextFiles` check. Recheck these on a pi upgrade.
 */

/** pi's per-directory context-file candidates, in pi's order (`dist/core/resource-loader.js:130`). */
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
export function resolveGlobalContextFile(homeDir: string, notifications?: ConfigNotices): { path: string; content: string } | undefined {
  const dir = path.join(homeDir, '.damocles');
  // eslint-disable-next-line damocles/no-sync -- pi asks agentsFilesOverride synchronously, and this read is sync already
  return contextFileIn(dir, (file) => checkConfigPathSync(dir, file) === 'ok', notifications);
}

/**
 * The first of pi's candidates that is a readable regular file in `dir`, within the size limit. A candidate `admits` refuses
 * (the network rule) is skipped as unreadable, told through notifications when given; one it throws for is skipped.
 */
function contextFileIn(dir: string, admits: (file: string) => boolean, notifications?: ConfigNotices): { path: string; content: string } | undefined {
  for (const filename of CONTEXT_FILE_CANDIDATES) {
    const filePath = path.join(dir, filename);
    try {
      if (!admits(filePath)) {
        console.warn(`[context-files] skipping ${filePath}: it links to a network share or WSL path`);
        noticeRefusedConfigRead(filePath, notifications);
        continue;
      }
      // statSync, not lstatSync: a symlink to a regular file is a legitimate global.
      const stats = fs.statSync(filePath);
      if (!stats.isFile()) continue;
      if (stats.size > MAX_CONTEXT_FILE_BYTES) {
        console.warn(
          `[context-files] skipping ${filePath}: ${stats.size} bytes is over the ${MAX_CONTEXT_FILE_BYTES}-byte system-prompt limit`,
        );
        continue;
      }
      return { path: filePath, content: stripBom(fs.readFileSync(filePath, 'utf8')) };
    } catch {
      // Absent or unreadable: try the next candidate, matching pi's own per-candidate skip.
    }
  }
  return undefined;
}

/** A chat worktree's walk: its folders, and the link policy pi's loader of that folder has, which judges the ancestors too. */
export interface ContextWorktree {
  readonly worktreeRoot: string;
  readonly repositoryRoot: string;
  readonly linkPolicy: (file: string) => boolean;
}

/**
 * Slice 12a rule 21: a chat worktree reads as if it sat where its project does. pi's walk inside the worktree stays; above it,
 * the project's repository root's ancestors replace the worktree's own (`~/.damocles/worktrees/...`), root first, and
 * `~/.damocles` is never read as an ancestor (its file is the global slot).
 */
function worktreeWalk(
  base: Array<{ path: string; content: string }>,
  worktree: ContextWorktree,
  homeDir: string,
  agentDir: string,
): Array<{ path: string; content: string }> {
  const damoclesHome = path.join(homeDir, '.damocles');
  const ancestors: Array<{ path: string; content: string }> = [];
  for (let dir = path.dirname(path.resolve(worktree.repositoryRoot)); ; dir = path.dirname(dir)) {
    if (!isUnder(dir, damoclesHome)) {
      const file = contextFileIn(dir, worktree.linkPolicy);
      if (file) ancestors.unshift(file);
    }
    if (path.dirname(dir) === dir) break;
  }
  const inside = base.filter((entry) => isUnder(entry.path, worktree.worktreeRoot) || isUnder(entry.path, agentDir));
  return [...base.filter((entry) => isUnder(entry.path, agentDir)), ...ancestors, ...inside.filter((entry) => !isUnder(entry.path, agentDir))];
}

/** Whether `p` is `dir` itself or lies beneath it, so a sibling like `agentX` is not caught. */
function isUnder(p: string, dir: string): boolean {
  const resolved = folderKey(p);
  const resolvedDir = folderKey(dir);
  return resolved === resolvedDir || resolved.startsWith(resolvedDir + path.sep);
}

/**
 * Swaps pi's `agentDir`-sourced global entry for `~/.damocles/`'s, leaving every ancestor entry in
 * place and in order. With no global at `~/.damocles/`, `base` is returned untouched so the
 * `agentDir` file still loads.
 *
 * `opts.trusted` is the trust state of the folder the loader serves. An untrusted folder keeps only the user's own
 * files, dropping every ancestor-walk entry, so a cloned repo cannot reach the system prompt through
 * its own `AGENTS.md` or `CLAUDE.md`. That matches the project skill and command dirs, which the same
 * repo cannot contribute either. The caller must read `TrustService.isTrusted(folderPath)` per call,
 * because granting trust re-runs the override without a window reload.
 */
export function overrideGlobalContextFile(
  input: Array<{ path: string; content: string }>,
  opts: { agentDir: string; homeDir: string; trusted: boolean; notifications?: ConfigNotices; worktree?: ContextWorktree },
): Array<{ path: string; content: string }> {
  const global = resolveGlobalContextFile(opts.homeDir, opts.notifications);
  const base = opts.worktree ? worktreeWalk(input, opts.worktree, opts.homeDir, opts.agentDir) : input;
  if (!opts.trusted) {
    // With no `~/.damocles/` global, pi's `agentDir` file is the only remaining user-authored source.
    return global ? [global] : base.filter((entry) => isUnder(entry.path, opts.agentDir));
  }
  if (!global) return base;
  // pi's own dedupe (`seenPaths`) only ever covered the agentDir global and is discarded before the
  // override runs, so the swapped-in path must be excluded here: a workspace at or under `~/.damocles/`
  // puts the same file in the ancestor walk, which would otherwise repeat the instructions.
  const globalKey = folderKey(global.path);
  return [
    global,
    ...base.filter((entry) => !isUnder(entry.path, opts.agentDir) && folderKey(entry.path) !== globalKey),
  ];
}
