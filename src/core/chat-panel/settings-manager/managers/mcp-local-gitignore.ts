import { promises as fs } from "node:fs";
import { exec } from "../../../pi-session/checkpoints/exec";
import { localMcpConfigPath } from "./mcp-config-import";
import { LOCAL_MCP_RELATIVE_PATH } from "../../../../shared/types/mcp";
import { log } from "../../../logger";

/**
 * Whether `<ws>/.damocles/mcp.local.json` is sitting in the working tree without git ignoring it. The
 * file is the intended home for a personal MCP definition, `env`/`headers` values included, so an
 * accidental commit publishes a credential to whoever can read the repository. Detection only: the
 * user's `.gitignore` is theirs, and the panel tells them the line to add.
 *
 * Only call this for a workspace the user has trusted. Running git here runs the repository's own
 * `.git/config`, and `core.fsmonitor` in it is a command git executes.
 */

/**
 * Long enough for a cold `git status` on a large repository, short enough that a wedged filesystem or
 * fsmonitor helper cannot hold up session start indefinitely.
 */
const GIT_TIMEOUT_MS = 10_000;

export async function isLocalMcpFileUnignored(workspaceRoot: string): Promise<boolean> {
  try {
    await fs.access(localMcpConfigPath(workspaceRoot));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT is the ordinary case: no file, nothing to leak. Anything else leaves the answer unknown,
    // so it is logged and no warning is raised.
    if (code !== "ENOENT") {
      log("[McpLocalGitignore] Could not check whether %s exists (%s); no leak warning shown", LOCAL_MCP_RELATIVE_PATH, code ?? "unknown error");
    }
    return false;
  }

  let stdout: string;
  try {
    // No `ExecEnv`: the checkpoint engine's overrides retarget git at its private bare repo, which
    // would answer the question about the wrong repository entirely.
    //
    // `git check-ignore` would be the obvious command, but it exits 1 for "not ignored", which `exec`
    // turns into a rejection indistinguishable from git being missing. `status` also catches the worse
    // case of a file already tracked despite a later ignore rule.
    //
    // `core.fsmonitor` is overridden because the repository sets it and git runs it as a command.
    // `--untracked-files` is passed explicitly because git refuses to combine `--ignored` with the
    // `status.showUntrackedFiles=no` a user may have set, and would exit 128 instead of answering.
    ({ stdout } = await exec(
      "git",
      ["-c", "core.fsmonitor=false", "status", "--porcelain", "--ignored=matching", "--untracked-files=all", "--", LOCAL_MCP_RELATIVE_PATH],
      undefined,
      workspaceRoot,
      GIT_TIMEOUT_MS,
    ));
  } catch (err) {
    log("[McpLocalGitignore] Could not ask git about %s (%s); no leak warning shown", LOCAL_MCP_RELATIVE_PATH, err instanceof Error ? err.message : "unknown error");
    return false;
  }

  // `!!` is git's ignored marker, on the file itself or on the directory holding it when that is what
  // the ignore rule names. Any other status (`??` untracked, a tracked-file status, or empty output
  // meaning tracked and clean) means the file is committable as it stands.
  return !stdout.split("\n").some(line => line.startsWith("!!"));
}
