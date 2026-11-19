import * as path from "path";
import type { AppPaths } from "../../platform/app-paths";

type RipgrepModule = typeof import("@vscode/ripgrep");
let ripgrepModulePromise: Promise<RipgrepModule> | null = null;

/**
 * Resolves the ripgrep binary shipped with the @vscode/ripgrep dependency.
 * The binary is provided per-platform via that package's optional dependencies,
 * so the path no longer depends on the host editor's install layout.
 */
export async function resolveRgPath(paths: Pick<AppPaths, "resourceRoot" | "unpackedRoot">): Promise<string> {
  if (!ripgrepModulePromise) {
    ripgrepModulePromise = import("@vscode/ripgrep");
  }
  const { rgPath } = await ripgrepModulePromise;
  return unpackedExecutable(rgPath, paths);
}

/** The unpackedRoot copy of a file under resourceRoot. child_process.spawn cannot execute a file inside the packaged app's app.asar. */
export function unpackedExecutable(file: string, paths: Pick<AppPaths, "resourceRoot" | "unpackedRoot">): string {
  const relative = path.relative(paths.resourceRoot, file);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return file;
  return path.join(paths.unpackedRoot, relative);
}
