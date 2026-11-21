import * as path from "path";
import type { Platform } from "../../platform/platform";
import { log } from "../logger";
import { walkHost, type TimedFiles } from "../search-walk";
import { worktreeProjectOf } from "../worktrees/personal-config";

export interface FileResult {
  relativePath: string;
  isDirectory: boolean;
  // a file the listing's timed rule names: its modified time in ms, which the walk process read
  modifiedAt?: number;
}

// Folder-only globs, so the walk never enters these folders and a file of the same name still lists.
const PRUNED_FOLDERS = ["node_modules", ".git", "dist", "build", "out", ".next"].map((name) => `!**/${name}/`);

/**
 * The chat's @ list of a folder: the files the walk process lists under the host's walk switches (walkSettings), at most
 * damocles.maxIndexedFiles of them, and the folders holding them, shallow first. Links are followed, by the path through the
 * link, only in a trusted folder with the follow switch on (D1), and in a worktree chat never into its project folder's copy,
 * which a mention refuses (mention-resolver.ts projectCopy); otherwise a link is never listed or entered. timed: the files
 * whose modified time the walk process returns. An abort of signal stops the walk and rejects.
 */
export async function listWorkspaceFiles(
  host: Pick<Platform, "settings" | "walkSettings" | "trust">,
  workspacePath: string,
  signal: AbortSignal,
  { limit, timed }: { readonly limit?: number; readonly timed?: TimedFiles } = {},
): Promise<FileResult[]> {
  const effectiveLimit = limit ?? host.settings.get<number>("damocles.maxIndexedFiles", 5000);
  const fileResults: FileResult[] = [];
  const dirSet = new Set<string>();
  if (effectiveLimit > 0) {
    const { ignore, followLinks } = host.walkSettings.read();
    const follow = followLinks && host.trust.isTrusted(workspacePath);
    const project = follow ? worktreeProjectOf(workspacePath) : undefined;
    const walk = walkHost().walk({
      root: workspacePath, requireGit: true, ignore, gitFolders: "skip", overrides: PRUNED_FOLDERS, maxFiles: effectiveLimit,
      ...(follow ? { followLinks: true } : {}),
      ...(project !== undefined ? { skipRealUnder: [project] } : {}),
      ...(timed !== undefined ? { timed } : {}),
    }, signal);
    for await (const batch of walk) {
      for (const relativePath of batch) {
        const modifiedAt = walk.modified.get(relativePath);
        fileResults.push({ relativePath, isDirectory: false, ...(modifiedAt !== undefined ? { modifiedAt } : {}) });
        for (let dirPath = path.posix.dirname(relativePath); dirPath !== "."; dirPath = path.posix.dirname(dirPath)) dirSet.add(dirPath);
      }
    }
    if (walk.errors.length > 0) {
      log(`[workspace-files] ${walk.errors.length} folder(s) or timed file(s) under ${workspacePath} could not be read (${fileResults.length} files listed): ${walk.errors.join("; ")}`);
    }
  }

  const allResults = [...fileResults, ...Array.from(dirSet, (dirPath) => ({ relativePath: dirPath, isDirectory: true }))];
  allResults.sort((a, b) => {
    const depthA = a.relativePath.split("/").length;
    const depthB = b.relativePath.split("/").length;
    if (depthA !== depthB) return depthA - depthB;
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.relativePath.localeCompare(b.relativePath);
  });
  return allResults;
}
