import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceSidecarManager } from "../manager";
import type { ManagerConfig } from "../manager";
import type { ShellJob } from "../../../pi-session/tools/process-tree";

// Passthrough, so only the taskkill call a case sets up is faked.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn), spawnSync: vi.fn(actual.spawnSync) };
});

const spawnMock = vi.mocked(spawn);
const spawnSyncMock = vi.mocked(spawnSync);
const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function enoent(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error("spawn taskkill ENOENT");
  err.code = "ENOENT";
  return err;
}

/** The signals the sidecar child was asked to die by. Its exit is what lets `stop()` settle. */
class FakeChild extends EventEmitter {
  pid = 4242;
  killed = false;
  readonly signals: (NodeJS.Signals | number | undefined)[] = [];
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.signals.push(signal);
    this.emit("exit", null, signal);
    return true;
  }
}

/** A manager holding one child, with nothing started, because both kill paths read only that child. */
function managerWith(child: FakeChild): VoiceSidecarManager {
  const manager = new VoiceSidecarManager({} as ManagerConfig);
  (manager as unknown as { child: ChildProcess | null }).child = child as unknown as ChildProcess;
  return manager;
}

/** The exit wiring the manager installs on a real spawn, reachable without spawning python. */
function attachExitHandler(manager: VoiceSidecarManager, child: FakeChild): void {
  (manager as unknown as { attachExitHandler(c: ChildProcess): void }).attachExitHandler(
    child as unknown as ChildProcess,
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms)),
  ]);
}

beforeEach(() => {
  spawnMock.mockClear();
  spawnSyncMock.mockClear();
});

afterEach(() => {
  setPlatform(realPlatform);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the voice sidecar child dies when taskkill cannot be spawned", () => {
  it("force-kills the child from the async stop path, so the Python interpreter releases its VRAM", async () => {
    setPlatform("win32");
    const child = new FakeChild();
    const killer = new EventEmitter();
    // spawn reports a missing taskkill on a later tick as an 'error' event, never by throwing, so a
    // stub that throws would pass against code that only logs. Every call is stubbed, or the graceful
    // sweep this case outlives would reach the real taskkill with a pid this host owns.
    spawnMock.mockImplementation(() => {
      setImmediate(() => killer.emit("error", enoent()));
      return killer as unknown as ReturnType<typeof spawn>;
    });

    // `stop()` waits on the child's exit, so the kill is asserted before it is awaited; a child that
    // never dies must report the missing signal rather than a timeout.
    const stopped = managerWith(child).stop(0);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(child.signals).toEqual(["SIGKILL"]);
    await stopped;
  });

  it("force-kills the child from the synchronous disposal path, which no thrown error ever reaches", () => {
    setPlatform("win32");
    const child = new FakeChild();
    // spawnSync reports a missing taskkill synchronously by returning `error`, never by throwing, so a
    // stub that throws would pass against code whose catch never fires.
    spawnSyncMock.mockImplementationOnce(() => ({ error: enoent() }) as unknown as ReturnType<typeof spawnSync>);

    managerWith(child).killChildSync();

    expect(child.signals).toEqual(["SIGKILL"]);
  });

  it("force-kills the child from the async stop path when taskkill runs and exits non-zero", async () => {
    setPlatform("win32");
    const child = new FakeChild();
    const killer = new EventEmitter();
    // A denied taskkill spawns fine and exits 128, so it never emits 'error' and the exit code is the
    // only report of the failure.
    spawnMock.mockImplementation(() => {
      setImmediate(() => killer.emit("exit", 128, null));
      return killer as unknown as ReturnType<typeof spawn>;
    });

    const stopped = managerWith(child).stop(0);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(child.signals).toEqual(["SIGKILL"]);
    await stopped;
  });

  it("force-kills from the synchronous disposal path when taskkill runs and is denied", () => {
    setPlatform("win32");
    const child = new FakeChild();
    // The measured shape on this host: taskkill spawns, prints "Access is denied." and exits 128, so
    // `error` stays undefined and only `status` reports the failure.
    spawnSyncMock.mockImplementationOnce(
      () =>
        ({ error: undefined, status: 128, stderr: "ERROR: The process ... Access is denied." }) as unknown as ReturnType<
          typeof spawnSync
        >,
    );

    managerWith(child).killChildSync();

    expect(child.signals).toEqual(["SIGKILL"]);
  });

  it("leaves the child alone when the graceful sweep fails, because child.kill on Windows is the force path", async () => {
    setPlatform("win32");
    vi.useFakeTimers();
    const child = new FakeChild();
    const killer = new EventEmitter();
    spawnMock.mockImplementation(() => {
      setImmediate(() => killer.emit("error", enoent()));
      return killer as unknown as ReturnType<typeof spawn>;
    });

    const stopped = managerWith(child).stop(10_000);
    // The graceful sweep runs at 1s and the force kill at 10s, so this window holds the graceful one alone.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(child.signals).toEqual([]);

    await vi.advanceTimersByTimeAsync(9_000);
    expect(child.signals).toEqual(["SIGKILL"]);
    await stopped;
  });
});

describe("the voice sidecar job object", () => {
  it("puts the sidecar in its job in the statement right after spawn", () => {
    const source = readFileSync(resolve(__dirname, "../spawn.ts"), "utf8");
    const statements = source
      .slice(source.indexOf("const child = spawn("))
      .replace(/\/\/[^\n]*/g, "")
      .split(";")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter((s) => s.length > 0);

    // A worker forked before the assignment is outside the job permanently, and python starts loading
    // torch within milliseconds of the spawn.
    expect(statements[0]).toContain("spawn(opts.pythonExe");
    expect(statements[1]).toContain("createShellJob(child.pid, undefined)");
  });

  it("terminates the job instead of spawning taskkill, so the python workers die with the wrapper", () => {
    setPlatform("win32");
    const child = new FakeChild();
    const manager = managerWith(child);
    let terminated = 0;
    const job: ShellJob = { terminate: () => void (terminated += 1), dispose: () => {} };
    (manager as unknown as { childJob: ShellJob }).childJob = job;

    manager.killChildSync();

    expect(terminated).toBe(1);
    expect(spawnSyncMock).not.toHaveBeenCalled();
    // TerminateJobObject reaches the root as well, so no signal is needed and none is sent.
    expect(child.signals).toEqual([]);
  });
});

describe("the voice sidecar manager settles its shutdown", () => {
  it("listens for errors on the sidecar child, because an unhandled one takes the extension host down", () => {
    const child = new FakeChild();
    attachExitHandler(managerWith(child), child);

    // EventEmitter rethrows an 'error' that has no listener, so this call throwing is the host dying.
    expect(() => child.emit("error", new Error("kill EPERM"))).not.toThrow();
  });

  it("settles stop() for a sidecar that already crashed, so the lock handle is released", async () => {
    setPlatform("linux");
    const child = new FakeChild();
    const manager = managerWith(child);
    attachExitHandler(manager, child);
    child.emit("exit", 1, null);

    // A stop that registers 'exit' on an already-exited child waits for an event that cannot fire again.
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
