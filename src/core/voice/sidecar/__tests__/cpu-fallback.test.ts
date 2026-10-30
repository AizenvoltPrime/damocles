import { EventEmitter } from "node:events";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { LaunchedProcess, ProcessExit } from "../../../process-launcher";
import type { SpawnOptions, SpawnResult } from "../spawn";
import type { ManagerConfig, CpuFallbackEvent } from "../manager";

class FakeChild implements LaunchedProcess {
  readonly pid: Promise<number> = Promise.resolve(4242);
  readonly exited: Promise<ProcessExit>;
  readonly closed: Promise<void>;
  private finish!: (exit: ProcessExit) => void;
  constructor() {
    this.exited = new Promise((resolve) => (this.finish = resolve));
    this.closed = this.exited.then(() => undefined);
  }
  onData(): void {}
  write(): Promise<void> {
    return Promise.resolve();
  }
  end(): void {}
  kill(): void {
    this.exit(null, "SIGTERM");
  }
  exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.finish({ code, signal });
  }
}

class FakeWebSocket extends EventEmitter {
  readyState: number = 0;
  bufferedAmount: number = 0;
  static OPEN = 1;
  constructor(_url: string, _protocols: string[], _opts: unknown) {
    super();
  }
  close(): void {
    this.readyState = 3;
  }
  send(_data: unknown, _opts?: unknown): void {}
  override once(event: string, listener: (...args: unknown[]) => void): this {
    return super.once(event, listener);
  }
}

const spawnCalls: SpawnOptions[] = [];
const spawnedChildren: FakeChild[] = [];

vi.mock("../spawn", () => {
  return {
    spawnSidecar: async (opts: SpawnOptions): Promise<SpawnResult> => {
      spawnCalls.push(opts);
      const child = new FakeChild();
      spawnedChildren.push(child);
      return {
        child,
        pid: 4242,
        port: 65000 + spawnedChildren.length,
        token: "test-token",
      };
    },
    pickEphemeralPort: async (): Promise<number> => 65000,
    buildSidecarEnv: (token: string, _pythonSourceDir: string): Record<string, string> => ({ DAMOCLES_VOICE_TOKEN: token }),
  };
});

vi.mock("../lockfile", () => {
  return {
    acquireSidecarLock: async () => ({
      kind: "owned" as const,
      commit: async (): Promise<void> => {},
      release: async (): Promise<void> => {},
    }),
  };
});

vi.mock("../output-channel", () => {
  return {
    appendSidecarLine: (): void => {},
    getVoiceOutputChannel: (): { appendLine: () => void; show: () => void; dispose: () => void } => ({
      appendLine: (): void => {},
      show: (): void => {},
      dispose: (): void => {},
    }),
  };
});

vi.mock("ws", () => {
  return {
    default: FakeWebSocket,
    WebSocket: FakeWebSocket,
  };
});

const baseConfig: ManagerConfig = {
  pythonExe: "/fake/python",
  pythonSourceDir: "/fake/python-source",
  modelsDir: "/fake/models",
  runtimeMode: "cuda",
  wakePhrase: "hey jarvis",
  diagnostics: false,
  initPayload: {
    wakeSensitivity: 0.5,
    endOfTurnSilenceMs: 800,
    maxUtteranceMs: 30000,
    ttsEnabled: false,
    ttsVoice: "alloy",
  },
  lockDir: "/tmp/damocles-test-lock",
};

async function loadManager(): Promise<typeof import("../manager")> {
  return await import("../manager");
}

describe("VoiceSidecarManager CPU fallback", () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    spawnedChildren.length = 0;
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("on exit code 7 emits cpuFallback and restarts in CPU mode", async () => {
    const { VoiceSidecarManager } = await loadManager();
    const manager = new VoiceSidecarManager({ ...baseConfig, runtimeMode: "cuda" });

    const cpuFallbackEvents: CpuFallbackEvent[] = [];
    manager.on("cpuFallback", (e) => cpuFallbackEvents.push(e));
    manager.on("error", () => {});

    void manager.start().catch(() => {});
    await vi.waitFor(() => expect(spawnedChildren.length).toBeGreaterThanOrEqual(1));

    expect(spawnCalls[0]?.runtimeMode).toBe("cuda");

    const firstChild = spawnedChildren[0];
    expect(firstChild).toBeDefined();

    if (firstChild !== undefined) {
      firstChild.exit(7, null);
    }

    await vi.waitFor(() => expect(spawnCalls.length).toBeGreaterThanOrEqual(2));

    expect(cpuFallbackEvents.length).toBe(1);
    expect(cpuFallbackEvents[0]?.reason).toBe("cuda-oom-fallback");
    expect(manager.isCpuFallbackActive()).toBe(true);
    expect(spawnCalls[spawnCalls.length - 1]?.runtimeMode).toBe("cpu");
  });

  it("words a second out-of-memory exit for the user, and keeps the developer detail in English for the log", async () => {
    const { VoiceSidecarManager } = await loadManager();
    const manager = new VoiceSidecarManager({ ...baseConfig, runtimeMode: "cuda" });
    const errors: Array<{ message: string }> = [];
    manager.on("error", (e) => errors.push(e));

    void manager.start().catch(() => {});
    await vi.waitFor(() => expect(spawnedChildren.length).toBe(1));
    spawnedChildren[0]!.exit(7, null);
    await vi.waitFor(() => expect(spawnedChildren.length).toBe(2));
    spawnedChildren[1]!.exit(7, null);

    await vi.waitFor(() => expect(manager.getStatus().kind).toBe("error"));
    expect(manager.getStatus()).toMatchObject({ message: { message: "The voice helper process ran out of memory on the GPU and then on the CPU too, so voice cannot run." } });
    expect(errors.map((e) => e.message)).toEqual(["CPU-mode sidecar also OOM'd; voice runtime cannot recover."]);
  });

  it("respects forced CPU runtime mode at boot", async () => {
    const { VoiceSidecarManager } = await loadManager();
    const manager = new VoiceSidecarManager({ ...baseConfig, runtimeMode: "cpu" });
    manager.on("error", () => {});

    void manager.start().catch(() => {});
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1));

    expect(spawnCalls[0]?.runtimeMode).toBe("cpu");
    expect(manager.isCpuFallbackActive()).toBe(false);
  });
});
