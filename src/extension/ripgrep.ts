import * as childProcess from "child_process";
import * as path from "path";
import * as readline from "readline";
import * as vscode from "vscode";
import { log } from "./logger";

type RipgrepModule = typeof import("@vscode/ripgrep");
let ripgrepModulePromise: Promise<RipgrepModule> | null = null;

export interface FileResult {
  relativePath: string;
  isDirectory: boolean;
}

/**
 * Resolves the ripgrep binary shipped with the @vscode/ripgrep dependency.
 * The binary is provided per-platform via that package's optional dependencies,
 * so the path no longer depends on the host editor's install layout.
 */
async function resolveRgPath(): Promise<string> {
  if (!ripgrepModulePromise) {
    ripgrepModulePromise = import("@vscode/ripgrep");
  }
  const { rgPath } = await ripgrepModulePromise;
  return rgPath;
}

function getRipgrepSearchOptions(): string[] {
  const config = vscode.workspace.getConfiguration("search");
  const extraArgs: string[] = [];

  if (config.get("useIgnoreFiles") === false) {
    extraArgs.push("--no-ignore");
  }

  if (config.get("useGlobalIgnoreFiles") === false) {
    extraArgs.push("--no-ignore-global");
  }

  if (config.get("useParentIgnoreFiles") === false) {
    extraArgs.push("--no-ignore-parent");
  }

  return extraArgs;
}

export async function listWorkspaceFiles(
  workspacePath: string,
  limit?: number
): Promise<FileResult[]> {
  const effectiveLimit = limit ?? vscode.workspace.getConfiguration("damocles").get<number>("maxIndexedFiles", 5000);

  let rgPath: string;
  try {
    rgPath = await resolveRgPath();
  } catch (err) {
    log("[ripgrep] Failed to resolve the @vscode/ripgrep binary:", err);
    throw err instanceof Error ? err : new Error(String(err));
  }

  const args = [
    "--files",
    "--follow",
    "--hidden",
    ...getRipgrepSearchOptions(),
    "-g", "!**/node_modules/**",
    "-g", "!**/.git/**",
    "-g", "!**/dist/**",
    "-g", "!**/build/**",
    "-g", "!**/out/**",
    "-g", "!**/.next/**",
    workspacePath,
  ];

  return new Promise((resolve, reject) => {
    const rgProcess = childProcess.spawn(rgPath, args);
    const rl = readline.createInterface({ input: rgProcess.stdout, crlfDelay: Infinity });

    const fileResults: FileResult[] = [];
    const dirSet = new Set<string>();
    let count = 0;

    rl.on("line", (line) => {
      if (count < effectiveLimit) {
        try {
          const relativePath = path.relative(workspacePath, line).replace(/\\/g, "/");

          fileResults.push({ relativePath, isDirectory: false });

          let dirPath = path.dirname(relativePath);
          while (dirPath && dirPath !== "." && dirPath !== "/") {
            dirSet.add(dirPath);
            dirPath = path.dirname(dirPath);
          }

          count++;
        } catch {
          // Silently ignore errors processing individual paths
        }
      } else {
        rl.close();
        rgProcess.kill();
      }
    });

    let errorOutput = "";

    rgProcess.stderr.on("data", (data) => {
      errorOutput += data.toString();
    });

    rl.on("close", () => {
      const stderr = errorOutput.trim();
      if (stderr && fileResults.length === 0) {
        log(`[ripgrep] enumeration returned 0 files; stderr: ${stderr}`);
        reject(new Error(`ripgrep error: ${errorOutput}`));
      } else {
        if (stderr) {
          log(`[ripgrep] non-fatal stderr (${fileResults.length} files parsed): ${stderr}`);
        }

        const dirResults = Array.from(dirSet).map((dirPath) => ({
          relativePath: dirPath,
          isDirectory: true,
        }));

        const allResults = [...fileResults, ...dirResults];

        allResults.sort((a, b) => {
          const depthA = a.relativePath.split("/").length;
          const depthB = b.relativePath.split("/").length;
          if (depthA !== depthB) return depthA - depthB;
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.relativePath.localeCompare(b.relativePath);
        });

        if (fileResults.length === 0) {
          log(`[ripgrep] enumeration returned 0 files (exit ok, no stderr) using ${rgPath} for ${workspacePath}`);
        }
        resolve(allResults);
      }
    });

    rgProcess.on("error", (error) => {
      reject(new Error(`ripgrep process error: ${error.message}`));
    });
  });
}
