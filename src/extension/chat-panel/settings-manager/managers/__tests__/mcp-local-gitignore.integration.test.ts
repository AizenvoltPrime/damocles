import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

/**
 * The leak guard against a real `git status`, in a real repository, with no mock in the way.
 *
 * The sibling unit suite fakes `exec`, so it can only pin what Damocles ASKS git and what it makes of
 * a canned answer. An argument list git refuses to run passes every one of those assertions. This
 * suite closes that by letting git answer.
 */

import * as vscode from "vscode";
import { isLocalMcpFileUnignored } from "../mcp-local-gitignore";

function gitIsAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAS_GIT = gitIsAvailable();

/** `os.tmpdir()` is a symlink on macOS, and git reports paths through the resolved one. */
const TMP_BASE = HAS_GIT ? fs.realpathSync(os.tmpdir()) : os.tmpdir();

let sandbox: string;
let neutralConfig: string;
const savedEnv: Record<string, string | undefined> = {};
let savedTrust = true;

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** A fresh repository per test, with every identity git needs to commit set repo-locally. */
function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(sandbox, "repo-"));
  git(["init", "--quiet"], root);
  git(["config", "user.email", "tests@damocles.invalid"], root);
  git(["config", "user.name", "Damocles Tests"], root);
  git(["config", "commit.gpgsign", "false"], root);
  return root;
}

function writeLocalMcp(root: string): void {
  fs.mkdirSync(path.join(root, ".damocles"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".damocles", "mcp.local.json"),
    JSON.stringify({ mcpServers: { probe: { command: "node", env: { TOKEN: "secret" } } } }),
    "utf-8",
  );
}

function writeGitignore(root: string, ...lines: string[]): void {
  fs.writeFileSync(path.join(root, ".gitignore"), `${lines.join("\n")}\n`, "utf-8");
}

beforeAll(() => {
  if (!HAS_GIT) return;
  sandbox = fs.mkdtempSync(path.join(TMP_BASE, "dam-git-ignore-"));
  neutralConfig = path.join(sandbox, "neutral.gitconfig");
  fs.writeFileSync(neutralConfig, "", "utf-8");

  // The answer must come from the temp repo alone, so the developer's own git config, any inherited
  // GIT_DIR, and the checkpoint engine's variables are all taken out of the picture.
  for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CEILING_DIRECTORIES"]) {
    savedEnv[key] = process.env[key];
  }
  process.env["GIT_CONFIG_GLOBAL"] = neutralConfig;
  process.env["GIT_CONFIG_SYSTEM"] = neutralConfig;
  process.env["GIT_CONFIG_NOSYSTEM"] = "1";
  delete process.env["GIT_DIR"];
  delete process.env["GIT_WORK_TREE"];
  delete process.env["GIT_INDEX_FILE"];
  // Without this git walks out of the sandbox and can find an enclosing repository.
  process.env["GIT_CEILING_DIRECTORIES"] = sandbox;
});

beforeEach(() => {
  savedTrust = vscode.workspace.isTrusted;
  vscode.__setTrusted(true);
});

afterEach(() => {
  vscode.__setTrusted(savedTrust);
});

afterAll(() => {
  if (!HAS_GIT) return;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe.skipIf(!HAS_GIT)("isLocalMcpFileUnignored against a real git repository", { timeout: 60_000 }, () => {
  it("stays quiet when a .gitignore line names the file", async () => {
    const root = makeRepo();
    writeLocalMcp(root);
    writeGitignore(root, ".damocles/mcp.local.json");

    await expect(isLocalMcpFileUnignored(root)).resolves.toBe(false);
  });

  it("warns when nothing in the repository ignores the file", async () => {
    const root = makeRepo();
    writeLocalMcp(root);

    await expect(isLocalMcpFileUnignored(root)).resolves.toBe(true);
  });

  it("warns when the file is committed despite an ignore rule", async () => {
    // Adding the ignore line after the first commit changes nothing, because git keeps tracking what
    // it already has. `git check-ignore` answers "ignored" here and would say nothing.
    const root = makeRepo();
    writeLocalMcp(root);
    writeGitignore(root, ".damocles/mcp.local.json");
    git(["add", "-f", ".damocles/mcp.local.json"], root);
    git(["commit", "--quiet", "-m", "add local mcp config"], root);

    await expect(isLocalMcpFileUnignored(root)).resolves.toBe(true);
  });

  it("stays quiet when .gitignore ignores the whole .damocles directory", async () => {
    // git collapses this to `!! .damocles/`, so a parser matching the full path would miss it.
    const root = makeRepo();
    writeLocalMcp(root);
    writeGitignore(root, ".damocles/");

    await expect(isLocalMcpFileUnignored(root)).resolves.toBe(false);
  });

  it("warns under status.showUntrackedFiles=no, which git refuses to combine with --ignored", async () => {
    // Set repo-locally so the result never depends on the developer's global config.
    const root = makeRepo();
    git(["config", "status.showUntrackedFiles", "no"], root);
    writeLocalMcp(root);

    await expect(isLocalMcpFileUnignored(root)).resolves.toBe(true);
  });

  it("stays quiet under status.showUntrackedFiles=no when the file is ignored", async () => {
    const root = makeRepo();
    git(["config", "status.showUntrackedFiles", "no"], root);
    writeLocalMcp(root);
    writeGitignore(root, ".damocles/mcp.local.json");

    await expect(isLocalMcpFileUnignored(root)).resolves.toBe(false);
  });

  it("does not let the repository's own core.fsmonitor command run", async (ctx) => {
    // git runs `core.fsmonitor` as a command, and an archive can ship a `.git/config` that sets it.
    // The override has to reach git, not merely appear in the argument list.
    const root = makeRepo();
    writeLocalMcp(root);
    const hook = path.join(sandbox, "fsmonitor-hook.js");
    const sentinel = path.join(sandbox, "fsmonitor-ran.txt");
    fs.writeFileSync(hook, 'require("fs").writeFileSync(process.argv[2], "ran");\n', "utf-8");
    const forwardSlashed = (target: string): string => target.replace(/\\/g, "/");
    git(["config", "core.fsmonitor", `"${forwardSlashed(process.execPath)}" "${forwardSlashed(hook)}" "${forwardSlashed(sentinel)}"`], root);

    // Run the same query without the override first. If git does not invoke the hook in this
    // environment the assertion below would pass for the wrong reason, so skip instead of pretending.
    fs.rmSync(sentinel, { force: true });
    try {
      git(["status", "--porcelain", "--ignored=matching", "--untracked-files=all", "--", ".damocles/mcp.local.json"], root);
    } catch {
      // Only whether the hook fired matters here, not what git answered.
    }
    if (!fs.existsSync(sentinel)) ctx.skip();

    fs.rmSync(sentinel, { force: true });
    await isLocalMcpFileUnignored(root);

    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it("fails open in a directory that is not a git repository", async () => {
    const root = fs.mkdtempSync(path.join(sandbox, "plain-"));
    writeLocalMcp(root);

    await expect(isLocalMcpFileUnignored(root)).resolves.toBe(false);
  });
});
