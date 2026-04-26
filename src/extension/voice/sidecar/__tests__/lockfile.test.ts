import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireSidecarLock } from "../lockfile";
import type { LockContents } from "../lockfile";

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
    }
    await first.release();
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
    }
  });
});
