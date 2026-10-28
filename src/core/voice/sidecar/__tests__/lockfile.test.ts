import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { windowsSystemTool } from "../../../system-tools";
import { acquireSidecarLock } from "../lockfile";
import type { LockContents } from "../lockfile";

const restrict = vi.hoisted(() => ({ fail: false }));
vi.mock("../../../owner-only-acl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../owner-only-acl")>();
  return {
    restrictToUser: async (folder: string) => {
      if (restrict.fail) throw new Error("icacls could not restrict the folder");
      await actual.restrictToUser(folder);
    },
  };
});

function makeContents(overrides: Partial<LockContents> = {}): LockContents {
  return {
    pid: process.pid,
    port: 12345,
    token: "tok",
    protocolVersion: 1,
    startedAt: Date.now(),
    ...overrides,
  };
}

describe("acquireSidecarLock", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "damocles-voice-lock-"));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(tmp, { recursive: true, force: true });
  });

  it("first acquisition owns the lock and exposes commit/release", async () => {
    const lockDir = join(tmp, "sidecar.lock");
    const result = await acquireSidecarLock(lockDir);
    expect(result.kind).toBe("owned");
    if (result.kind === "owned") {
      await result.commit(makeContents());
      await result.release();
    }
  });

  it("gives the lock up and writes no token when its folder cannot be made the user's alone", async () => {
    restrict.fail = true;
    try {
      const lockDir = join(tmp, "sidecar.lock");
      await expect(acquireSidecarLock(lockDir)).rejects.toThrow("icacls could not restrict the folder");
      await expect(stat(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      restrict.fail = false;
    }
  });

  it.runIf(process.platform === "win32")("keeps the token file to the user alone", async () => {
    const lockDir = join(tmp, "sidecar.lock");
    const result = await acquireSidecarLock(lockDir);
    if (result.kind !== "owned") throw new Error("the first acquisition should own the lock");
    await result.commit(makeContents());
    const file = join(lockDir, "data.json");
    // icacls prints the path before the first entry and a summary line last
    const entries = execFileSync(windowsSystemTool("icacls"), [file], { encoding: "utf8" }).replace(file, "").split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[^ ]+\\?[^:]*:\(/.test(line));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.toLowerCase().startsWith(`${process.env["USERDOMAIN"]}\\${userInfo().username}:`.toLowerCase())).toBe(true);
    await result.release();
  });

  it("second acquisition attaches to a committed live owner", async () => {
    const lockDir = join(tmp, "sidecar.lock");
    const first = await acquireSidecarLock(lockDir);
    expect(first.kind).toBe("owned");
    if (first.kind !== "owned") return;
    await first.commit(makeContents({ port: 12345 }));

    const second = await acquireSidecarLock(lockDir);
    expect(second.kind).toBe("attached");
    if (second.kind === "attached") {
      expect(second.existing.port).toBe(12345);
      second.detach();
    }
    await first.release();
  });

  it("attaches to a live sidecar however long ago it started, while its lock is kept fresh", async () => {
    const lockDir = join(tmp, "sidecar.lock");
    const first = await acquireSidecarLock(lockDir);
    if (first.kind !== "owned") throw new Error("expected to own the lock");
    await first.commit(makeContents({ port: 4321, startedAt: Date.now() - 30 * 60 * 1000 }));

    const second = await acquireSidecarLock(lockDir);

    expect(second).toMatchObject({ kind: "attached", existing: { port: 4321 } });
    if (second.kind === "attached") second.detach();
    await first.release();
  });

  it("evicts a lock nobody refreshed for two minutes, even when its pid now names a live process", async () => {
    const lockDir = join(tmp, "sidecar.lock");
    await mkdir(lockDir);
    await writeFile(join(lockDir, "data.json"), JSON.stringify({ ...makeContents({ port: 1 }), owner: "gone", state: "ready" }));
    const old = new Date(Date.now() - 3 * 60 * 1000);
    await utimes(lockDir, old, old);

    const result = await acquireSidecarLock(lockDir);

    expect(result.kind).toBe("owned");
    if (result.kind === "owned") await result.release();
  });

  it("keeps the lock fresh while it is held, from the owner and from an attached window", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const lockDir = join(tmp, "sidecar.lock");
    const first = await acquireSidecarLock(lockDir);
    if (first.kind !== "owned") throw new Error("expected to own the lock");
    await first.commit(makeContents());
    const second = await acquireSidecarLock(lockDir);
    if (second.kind !== "attached") throw new Error("expected to attach");
    await first.release();
    await mkdir(lockDir);
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(lockDir, old, old);

    vi.advanceTimersByTime(20_000);

    await vi.waitFor(async () => expect(Date.now() - (await stat(lockDir)).mtimeMs).toBeLessThan(60_000));
    second.detach();
  });

  it("releases only its own lock, never one another window took over", async () => {
    const lockDir = join(tmp, "sidecar.lock");
    const first = await acquireSidecarLock(lockDir);
    if (first.kind !== "owned") throw new Error("expected to own the lock");
    await first.commit(makeContents());
    await writeFile(join(lockDir, "data.json"), JSON.stringify({ ...makeContents({ port: 2 }), owner: "another window", state: "ready" }));

    await first.release();

    expect(await stat(join(lockDir, "data.json")).then(() => true, () => false)).toBe(true);
  });

  it("stale lock dir (older than 10 minutes) is reclaimed", async () => {
    const lockDir = join(tmp, "sidecar.lock");
    const result1 = await acquireSidecarLock(lockDir);
    expect(result1.kind).toBe("owned");
    if (result1.kind !== "owned") return;
    await result1.commit(makeContents({ pid: 999999, port: 1, token: "tok", startedAt: Date.now() - 11 * 60 * 1000 }));

    const oldTime = new Date(Date.now() - 11 * 60 * 1000);
    await utimes(lockDir, oldTime, oldTime);

    const result2 = await acquireSidecarLock(lockDir);
    expect(result2.kind).toBe("owned");
    if (result2.kind === "owned") {
      await result2.commit(makeContents({ port: 2, token: "tok2" }));
      await result2.release();
    }
    await stat(tmp);
  });

  it("waits for an in-progress claim to commit before attaching", async () => {
    const lockDir = join(tmp, "sidecar.lock");
    await mkdir(lockDir, { recursive: false });
    const dataPath = join(lockDir, "data.json");
    await writeFile(
      dataPath,
      JSON.stringify({
        pid: process.pid,
        port: 0,
        token: "",
        protocolVersion: 0,
        startedAt: Date.now(),
        state: "claiming",
      }),
      { mode: 0o600 },
    );

    const acquirePromise = acquireSidecarLock(lockDir);

    setTimeout(() => {
      void writeFile(
        dataPath,
        JSON.stringify({
          ...makeContents({ port: 9876, token: "ready-tok" }),
          state: "ready",
        }),
        { mode: 0o600 },
      );
    }, 400);

    const result = await acquirePromise;
    expect(result.kind).toBe("attached");
    if (result.kind === "attached") {
      expect(result.existing.port).toBe(9876);
      expect(result.existing.token).toBe("ready-tok");
      result.detach();
    }
  });
});
