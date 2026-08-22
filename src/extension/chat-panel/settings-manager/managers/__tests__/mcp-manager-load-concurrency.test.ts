import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/**
 * Whether `loadConfig()` asks git while the config files are still being read, or waits for them.
 *
 * The git check is independent of every file read, and `loadConfig()` runs before a session can be
 * created, so serialising it puts a process spawn on the critical path of session start. That is a
 * latency property, and latency assertions are usually races. This one is not: every read is held on
 * a deferred the test resolves by hand, so "git was asked before any read finished" is decided by the
 * code under test rather than by how fast the machine is.
 */

/** Every `readFile` returns a promise this test resolves, so no read completes on its own. */
const pendingReads: { resolve: (contents: string) => void }[] = [];
const readFileMock = vi.hoisted(() => vi.fn());
const accessMock = vi.hoisted(() => vi.fn());
const execMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ stdout: "", stderr: "" })));

vi.mock("node:fs", () => ({ promises: { readFile: readFileMock, access: accessMock } }));
vi.mock("../../../../pi-session/checkpoints/exec", () => ({ exec: execMock }));
vi.mock("../../../../logger", () => ({ log: vi.fn() }));

import * as vscode from "vscode";
import { McpManager } from "../mcp-manager";

const workspaceState = {
  get: <T>(_key: string, defaultValue?: T): T => defaultValue as T,
  update: (): Promise<void> => Promise.resolve(),
  keys: (): readonly string[] => [],
} as unknown as vscode.Memento;

/** Let every already-queued microtask run, without advancing time. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Release reads until the load settles. A loop rather than one pass, so a sequential loader finishes
 * too: it exposes its next read only after the previous one resolves. Without this a regression would
 * surface as a test timeout, which in this suite is indistinguishable from the known flake class.
 */
async function drain(load: Promise<void>): Promise<void> {
  let settled = false;
  void load.then(() => { settled = true; }, () => { settled = true; });
  for (let pass = 0; pass < 50 && !settled; pass++) {
    while (pendingReads.length > 0) pendingReads.shift()!.resolve("{}");
    await flush();
  }
  await load;
}

beforeEach(() => {
  pendingReads.length = 0;
  readFileMock.mockReset();
  execMock.mockClear();
  accessMock.mockReset();
  // The personal config exists, so the git check is reached.
  accessMock.mockResolvedValue(undefined);
  readFileMock.mockImplementation(
    () => new Promise<string>((resolve) => { pendingReads.push({ resolve: (contents) => resolve(contents) }); }),
  );
  vscode.__setTrusted(true);
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: { fsPath: "/ws/project" } }];
});

afterAll(() => {
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [];
});

describe("McpManager.loadConfig scheduling", () => {
  it("asks git while the config reads are still outstanding", async () => {
    const manager = new McpManager(workspaceState);
    const load = manager.loadConfig();

    await flush();

    // Nothing has been allowed to finish, so any read the loader started is still pending. If the git
    // check were queued behind them it could not have run yet.
    expect(pendingReads.length).toBeGreaterThan(0);
    expect(execMock).toHaveBeenCalledTimes(1);

    await drain(load);
  });

  it("starts the user-global readers together rather than one at a time", async () => {
    // A narrower claim than the test above, and deliberately so: this one is satisfied by the
    // `Promise.all` inside `readGlobalMcpSources`, so it stays green even if the caller serialises
    // everything. It pins the inner fan-out, not the outer scheduling.
    const manager = new McpManager(workspaceState);
    const load = manager.loadConfig();

    await flush();
    const startedTogether = pendingReads.length;

    await drain(load);

    expect(startedTogether).toBeGreaterThan(1);
  });

  it("does not ask git at all when the workspace is untrusted, even though the reads still run", async () => {
    // Pins the assertion above to scheduling rather than to the check being unconditional.
    vscode.__setTrusted(false);
    const manager = new McpManager(workspaceState);
    const load = manager.loadConfig();

    await flush();

    expect(pendingReads.length).toBeGreaterThan(0);
    expect(execMock).not.toHaveBeenCalled();

    await drain(load);
  });
});
