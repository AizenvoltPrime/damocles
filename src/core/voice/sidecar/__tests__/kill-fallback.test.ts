import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installProcessLauncher, type KillOptions, type LaunchedProcess, type Launcher, type ProcessExit, type SpawnSpec } from "../../../process-launcher";
import { VoiceSidecarManager } from "../manager";
import type { ManagerConfig } from "../manager";
import { spawnSidecar } from "../spawn";

// Passthrough, so only the taskkill call a case sets up is faked.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const spawnSyncMock = vi.mocked(spawnSync);
const realPlatform = process.platform;
const PID = 4242;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function enoent(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error("spawn taskkill ENOENT");
  err.code = "ENOENT";
  return err;
}

/** A launched process that records how it was asked to die; a kill ends it unless it was told to survive. */
class FakeChild implements LaunchedProcess {
  readonly pid: Promise<number> = Promise.resolve(PID);
  readonly exited: Promise<ProcessExit>;
  readonly closed: Promise<void>;
  readonly kills: KillOptions[] = [];
  private readonly survives: boolean;
  private finish!: (exit: ProcessExit) => void;
  private fail!: (error: Error) => void;
  constructor(survives = false) {
    this.survives = survives;
    this.exited = new Promise((resolve, reject) => {
      this.finish = resolve;
      this.fail = reject;
    });
    this.closed = this.exited.then(() => undefined);
    this.closed.catch(() => undefined);
  }
  onData(): void {}
  write(): Promise<void> {
    return Promise.resolve();
  }
  end(): void {}
  kill(options: KillOptions = {}): void {
    this.kills.push(options);
    if (!this.survives) this.exit(null, options.signal ?? "SIGTERM");
  }
  exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.finish({ code, signal });
  }
  workerDied(): void {
    this.fail(new Error("The process launcher worker that ran this process stopped"));
  }
}

/** A manager holding one child, with nothing started, because both kill paths read only that child. */
function managerWith(child: FakeChild): VoiceSidecarManager {
  const manager = new VoiceSidecarManager({} as ManagerConfig);
  Object.assign(manager as unknown as { child: LaunchedProcess; childPid: number }, { child, childPid: PID });
  return manager;
}

/** The exit wiring the manager installs on a real start, reachable without starting python. */
function attachExitHandler(manager: VoiceSidecarManager, child: FakeChild): void {
  (manager as unknown as { attachExitHandler(c: LaunchedProcess): void }).attachExitHandler(child);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms)),
  ]);
}

// The processes the manager starts itself (the graceful taskkill), each answering with an exit code.
let launched: SpawnSpec[];
let previous: Launcher | undefined;

beforeEach(() => {
  spawnSyncMock.mockClear();
  launched = [];
  const launcher: Launcher = {
    launch: (spec) => {
      launched.push(spec);
      const sweep = new FakeChild();
      sweep.exit(1, null);
      return sweep;
    },
    createSessionJob: () => ({ id: 1, dispose: () => undefined }),
    dispose: async () => undefined,
  };
  previous = installProcessLauncher(launcher);
});

afterEach(() => {
  if (previous) installProcessLauncher(previous);
  setPlatform(realPlatform);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the voice sidecar's force kill", () => {
  it("kills the sidecar's tree from the async stop path, so the Python workers release their VRAM", async () => {
    setPlatform("win32");
    const child = new FakeChild();
    await managerWith(child).stop(0);
    expect(child.kills).toEqual([{ tree: true, signal: "SIGKILL" }]);
  });

  it("runs a failed graceful sweep without a fallback, because every other kill on Windows is the force path", async () => {
    setPlatform("win32");
    vi.useFakeTimers();
    const child = new FakeChild();

    const stopped = managerWith(child).stop(10_000);
    // The graceful sweep runs at 1s and the force kill at 10s, so this window holds the graceful one alone.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(launched).toEqual([expect.objectContaining({ args: ["/T", "/PID", String(PID)] })]);
    expect(launched[0]!.file).toMatch(/taskkill\.exe$/i);
    expect(child.kills).toEqual([]);

    await vi.advanceTimersByTimeAsync(9_000);
    expect(child.kills).toEqual([{ tree: true, signal: "SIGKILL" }]);
    await stopped;
  });

  it("signals the sidecar itself on POSIX, SIGTERM first", async () => {
    setPlatform("linux");
    vi.useFakeTimers();
    const child = new FakeChild(true);
    const stopped = managerWith(child).stop(5_000);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(child.kills).toEqual([{ signal: "SIGTERM" }]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.kills).toEqual([{ signal: "SIGTERM" }, { tree: true, signal: "SIGKILL" }]);
    await stopped;
  });
});

describe("the voice sidecar's synchronous disposal kill", () => {
  it("asks the launcher for the tree kill and kills the root itself when taskkill cannot be spawned", () => {
    setPlatform("win32");
    const child = new FakeChild(true);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    // spawnSync reports a missing taskkill synchronously by returning `error`, never by throwing, so a
    // stub that throws would pass against code whose catch never fires.
    spawnSyncMock.mockImplementationOnce(() => ({ error: enoent() }) as unknown as ReturnType<typeof spawnSync>);

    managerWith(child).killChildSync();

    expect(child.kills).toEqual([{ tree: true, signal: "SIGKILL" }]);
    expect(kill).toHaveBeenCalledWith(PID, "SIGKILL");
  });

  it("kills the root when taskkill runs and is denied", () => {
    setPlatform("win32");
    const child = new FakeChild(true);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    // The measured shape on this host: taskkill spawns, prints "Access is denied." and exits 128, so
    // `error` stays undefined and only `status` reports the failure.
    spawnSyncMock.mockImplementationOnce(
      () =>
        ({ error: undefined, status: 128, stderr: "ERROR: The process ... Access is denied." }) as unknown as ReturnType<
          typeof spawnSync
        >,
    );

    managerWith(child).killChildSync();

    expect(kill).toHaveBeenCalledWith(PID, "SIGKILL");
  });

  it("leaves the root alone once taskkill killed the tree", () => {
    setPlatform("win32");
    const child = new FakeChild(true);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    spawnSyncMock.mockImplementationOnce(() => ({ error: undefined, status: 0, stderr: "" }) as unknown as ReturnType<typeof spawnSync>);

    managerWith(child).killChildSync();

    expect(spawnSyncMock.mock.calls[0]![1]).toEqual(["/F", "/T", "/PID", String(PID)]);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("the voice sidecar's process group on POSIX", () => {
  it.each([["linux", true], ["darwin", true], ["win32", false]] as const)("on %s starts the sidecar detached: %s", async (platform, detached) => {
    setPlatform(platform);
    await spawnSidecar({ pythonExe: "/venv/bin/python", pythonSourceDir: "/app/python", modelsDir: "/models", runtimeMode: "cpu", diagnostics: false, wakePhrase: null, ttsEnabled: true });
    expect(launched[0]).toMatchObject({ file: "/venv/bin/python", detached });
  });

  it("kills the sidecar's whole group from the synchronous disposal kill", () => {
    setPlatform("linux");
    const child = new FakeChild(true);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);

    managerWith(child).killChildSync();

    expect(child.kills).toEqual([{ tree: true, signal: "SIGKILL" }]);
    expect(kill).toHaveBeenCalledWith(-PID, "SIGKILL");
  });
});

describe("the voice sidecar manager settles its shutdown", () => {
  it("counts a sidecar whose launcher worker died as exited", async () => {
    const child = new FakeChild();
    const manager = managerWith(child);
    const exits: unknown[] = [];
    manager.on("exit", (exit) => exits.push(exit));
    attachExitHandler(manager, child);
    child.workerDied();

    await vi.waitFor(() => expect(exits).toEqual([{ code: null, signal: null }]));
    await expect(withTimeout(manager.stop(), 200)).resolves.toBeUndefined();
  });

  it("settles stop() for a sidecar that already crashed, so the lock handle is released", async () => {
    setPlatform("linux");
    const child = new FakeChild();
    const manager = managerWith(child);
    attachExitHandler(manager, child);
    child.exit(1, null);

    await expect(withTimeout(manager.stop(), 200)).resolves.toBeUndefined();
  });

  it("releases the lock once when two stops overlap", async () => {
    setPlatform("linux");
    const manager = new VoiceSidecarManager({} as ManagerConfig);
    let releases = 0;
    (manager as unknown as { lockHandle: unknown }).lockHandle = {
      kind: "owned",
      release: async () => void (releases += 1),
    };

    await Promise.all([manager.stop(), manager.stop()]);

    expect(releases).toBe(1);
  });
});
