import * as path from "path";
import type { Platform } from "../../platform/platform";
import { log } from "../logger";
import { walkHost, walkIgnoreOf } from "../search-walk";

export interface FileResult {
  relativePath: string;
  isDirectory: boolean;
}

// Folder-only globs, so the walk never enters these folders and a file of the same name still lists.
const PRUNED_FOLDERS = ["node_modules", ".git", "dist", "build", "out", ".next"].map((name) => `!**/${name}/`);

/**
 * The chat's @ list of a folder: the files the walk process lists under the search.use*IgnoreFiles switches, at most
 * damocles.maxIndexedFiles of them, and the folders holding them, shallow first. A link is never listed or entered. An abort of
 * signal stops the walk and rejects.
 */
export async function listWorkspaceFiles(host: Pick<Platform, "settings">, workspacePath: string, signal: AbortSignal, limit?: number): Promise<FileResult[]> {
  const { settings } = host;
  const effectiveLimit = limit ?? settings.get<number>("damocles.maxIndexedFiles", 5000);
  const fileResults: FileResult[] = [];
  const dirSet = new Set<string>();
  if (effectiveLimit > 0) {
    const walk = walkHost().walk({ root: workspacePath, requireGit: true, ignore: walkIgnoreOf(settings), gitFolders: "skip", overrides: PRUNED_FOLDERS, maxFiles: effectiveLimit }, signal);
    for await (const batch of walk) {
      for (const relativePath of batch) {
        fileResults.push({ relativePath, isDirectory: false });
        for (let dirPath = path.posix.dirname(relativePath); dirPath !== "."; dirPath = path.posix.dirname(dirPath)) dirSet.add(dirPath);
      }
    }
    if (walk.errors.length > 0) {
      log(`[workspace-files] ${walk.errors.length} folder(s) under ${workspacePath} could not be listed (${fileResults.length} files listed): ${walk.errors.join("; ")}`);
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
