import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/**
 * The leak guard for `<ws>/.damocles/mcp.local.json`. The file is the one MCP config the brief
 * expects to hold plaintext credentials, and it lives in the working tree, so "is git ignoring it?"
 * is a question with a real cost attached to the wrong answer.
 *
 * `exec` is faked because the assertion is about what Damocles ASKS git and what it concludes from
 * each answer; running a real `git status` would make the test depend on git's version and on the
 * temp directory's ancestry. The file itself is real, since existence is the first gate.
 */
const execMock = vi.hoisted(() => vi.fn());
const logMock = vi.hoisted(() => vi.fn());
vi.mock("../../../../pi-session/checkpoints/exec", () => ({ exec: execMock }));
vi.mock("../../../../logger", () => ({ log: logMock }));

import { isLocalMcpFileUnignored } from "../mcp-local-gitignore";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dam-mcp-ignore-"));
const workspaceRoot = path.join(tmpRoot, "workspace");
const LOCAL_MCP = path.join(workspaceRoot, ".damocles", "mcp.local.json");

function createLocalFile(): void {
  fs.mkdirSync(path.dirname(LOCAL_MCP), { recursive: true });
  fs.writeFileSync(LOCAL_MCP, JSON.stringify({ mcpServers: { p: { command: "node" } } }), "utf-8");
}

/** Make the faked git print `stdout` and exit zero. */
function gitPrints(stdout: string): void {
  execMock.mockResolvedValue({ stdout, stderr: "" });
}

beforeEach(() => {
  execMock.mockReset();
  logMock.mockReset();
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("isLocalMcpFileUnignored", () => {
  it("does not ask git anything when the file does not exist", async () => {
    expect(await isLocalMcpFileUnignored(workspaceRoot)).toBe(false);

    // Every workspace without the file would otherwise pay for a subprocess on every config load.
    expect(execMock).not.toHaveBeenCalled();
  });

  it("reports an existence check that failed for a reason other than absence", async () => {
    // EACCES is not "no file, nothing to leak": the answer is unknown. Returning false either way is
    // the right fail-open behaviour, but passing an unreadable path off as a clean result with no log
    // line would leave a wrong answer with nothing to trace it to.
    const denied = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
    denied.code = "EACCES";
    const accessSpy = vi.spyOn(fs.promises, "access").mockRejectedValueOnce(denied);

    try {
      expect(await isLocalMcpFileUnignored(workspaceRoot)).toBe(false);
      expect(execMock).not.toHaveBeenCalled();
      expect(logMock).toHaveBeenCalledTimes(1);
      expect(logMock.mock.calls[0]!.join(" ")).toContain("EACCES");
    } finally {
      accessSpy.mockRestore();
    }
  });

  it("stays quiet when git reports the file as ignored", async () => {
    createLocalFile();
    gitPrints("!! .damocles/mcp.local.json\n");

    expect(await isLocalMcpFileUnignored(workspaceRoot)).toBe(false);
    expect(logMock).not.toHaveBeenCalled();
  });

  it("warns when the file is untracked and NOT ignored", async () => {
    createLocalFile();
    gitPrints("?? .damocles/mcp.local.json\n");

    expect(await isLocalMcpFileUnignored(workspaceRoot)).toBe(true);
  });

  it("warns when the file is already tracked despite a later ignore rule", async () => {
    // The worst case: adding the ignore line now changes nothing, because git keeps tracking a file
    // it already has. `git check-ignore` would answer "ignored" here and say nothing.
    createLocalFile();
    gitPrints(" M .damocles/mcp.local.json\n");

    expect(await isLocalMcpFileUnignored(workspaceRoot)).toBe(true);
  });

  it("warns when the file is tracked and clean, which prints nothing at all", async () => {
    createLocalFile();
    gitPrints("");

    expect(await isLocalMcpFileUnignored(workspaceRoot)).toBe(true);
  });

  it("fails open in a workspace that is not a git repository", async () => {
    createLocalFile();
    execMock.mockRejectedValue(new Error("fatal: not a git repository (or any of the parent directories): .git"));

    await expect(isLocalMcpFileUnignored(workspaceRoot)).resolves.toBe(false);
    // Silently swallowing would leave a wrong answer unexplained; a warning nobody can act on is
    // worse than none, so the reason goes to the log instead of the panel.
    expect(logMock).toHaveBeenCalledTimes(1);
  });

  it("fails open when git is missing entirely", async () => {
    createLocalFile();
    const enoent = new Error("spawn git ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    execMock.mockRejectedValue(enoent);

    await expect(isLocalMcpFileUnignored(workspaceRoot)).resolves.toBe(false);
  });

  it("asks git about the user's repository, with the exact argv git accepts", async () => {
    createLocalFile();
    gitPrints("!! .damocles/mcp.local.json\n");

    await isLocalMcpFileUnignored(workspaceRoot);

    expect(execMock).toHaveBeenCalledTimes(1);
    const [command, args, env, cwd, timeoutMs] = execMock.mock.calls[0]!;
    expect(command).toBe("git");
    // Order carries meaning here: `-c` overrides only apply before the subcommand, and everything
    // after `--` is a pathspec. The sibling integration suite proves git accepts this list.
    expect(args).toEqual([
      "-c", "core.fsmonitor=false",
      "status", "--porcelain", "--ignored=matching", "--untracked-files=all",
      "--", ".damocles/mcp.local.json",
    ]);
    // `checkpoints/types.ts`'s ExecEnv points GIT_DIR/GIT_WORK_TREE at the private bare checkpoint
    // repo. Passing it would answer the ignore question about the wrong repository entirely.
    expect(env).toBeUndefined();
    expect(cwd).toBe(workspaceRoot);
    expect(timeoutMs).toBeGreaterThan(0);
  });

  it("overrides core.fsmonitor, which the repository sets and git runs as a command", async () => {
    createLocalFile();
    gitPrints("!! .damocles/mcp.local.json\n");

    await isLocalMcpFileUnignored(workspaceRoot);

    const args = execMock.mock.calls[0]![1] as string[];
    expect(args.slice(0, 2)).toEqual(["-c", "core.fsmonitor=false"]);
    expect(args.indexOf("core.fsmonitor=false")).toBeLessThan(args.indexOf("status"));
  });

  it("passes --untracked-files explicitly, since git refuses to infer it alongside --ignored", async () => {
    // `status.showUntrackedFiles=no` makes git exit 128 on the pair rather than answer, which turned
    // the warning off for anyone who set it.
    createLocalFile();
    gitPrints("?? .damocles/mcp.local.json\n");

    await isLocalMcpFileUnignored(workspaceRoot);

    const args = execMock.mock.calls[0]![1] as string[];
    expect(args).toContain("--untracked-files=all");
  });

  it("does NOT use check-ignore, which cannot see an already-tracked file", async () => {
    createLocalFile();
    gitPrints("");

    await isLocalMcpFileUnignored(workspaceRoot);

    expect(execMock.mock.calls[0]![1] as string[]).not.toContain("check-ignore");
  });

  it("fails open and names the timeout when git is killed for taking too long", async () => {
    // The rejection is the only trace a wedged filesystem leaves, so it has to reach the log readable.
    createLocalFile();
    execMock.mockRejectedValue(new Error("git status timed out after 10000ms"));

    await expect(isLocalMcpFileUnignored(workspaceRoot)).resolves.toBe(false);
    expect(logMock).toHaveBeenCalledTimes(1);
    expect(logMock.mock.calls[0]!.join(" ")).toContain("timed out");
  });

  it("bounds the git call, so a hung fsmonitor helper cannot hold up session start", async () => {
    createLocalFile();
    gitPrints("");

    await isLocalMcpFileUnignored(workspaceRoot);

    const timeoutMs = execMock.mock.calls[0]![4] as number;
    expect(typeof timeoutMs).toBe("number");
    expect(timeoutMs).toBeGreaterThan(0);
    expect(timeoutMs).toBeLessThanOrEqual(30_000);
  });
});
