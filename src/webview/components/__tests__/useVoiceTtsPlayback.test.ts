import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { effectScope } from "vue";

interface FakeBufferSource {
  buffer: AudioBuffer | null;
  startedAt: number | null;
  stopped: boolean;
  onended: ((this: AudioScheduledSourceNode, ev: Event) => unknown) | null;
  connect: (target: unknown) => unknown;
  disconnect: () => void;
  start: (when?: number) => void;
  stop: (when?: number) => void;
}

interface FakeGainNode {
  gain: { setValueAtTime: ReturnType<typeof vi.fn>; linearRampToValueAtTime: ReturnType<typeof vi.fn> };
  connect: (target: unknown) => unknown;
  disconnect: () => void;
}

interface FakeBuffer {
  duration: number;
  sampleRate: number;
  length: number;
  numberOfChannels: number;
  channel: Float32Array;
  getChannelData: (i: number) => Float32Array;
}

const sources: FakeBufferSource[] = [];
const gains: FakeGainNode[] = [];

class FakeAudioContext {
  state: AudioContextState = "running";
  currentTime = 0;
  sampleRate: number;
  destination = {} as AudioDestinationNode;
  closeCalls = 0;

  constructor(options: { sampleRate?: number } = {}) {
    this.sampleRate = options.sampleRate ?? 24000;
  }

  createBufferSource(): FakeBufferSource {
    const src: FakeBufferSource = {
      buffer: null,
      startedAt: null,
      stopped: false,
      onended: null,
      connect(target) {
        return target;
      },
      disconnect() {
        return undefined;
      },
      start(when) {
        this.startedAt = when ?? 0;
      },
      stop() {
        this.stopped = true;
      },
    };
    sources.push(src);
    return src;
  }

  createBuffer(_channels: number, length: number, sampleRate: number): FakeBuffer {
    const channel = new Float32Array(length);
    return {
      duration: length / sampleRate,
      sampleRate,
      length,
      numberOfChannels: 1,
      channel,
      getChannelData: () => channel,
    };
  }

  createGain(): FakeGainNode {
    const gain: FakeGainNode = {
      gain: {
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
      },
      connect(target) {
        return target;
      },
      disconnect() {
        return undefined;
      },
    };
    gains.push(gain);
    return gain;
  }

  async resume(): Promise<void> {
    this.state = "running";
  }

  async close(): Promise<void> {
    this.closeCalls++;
    this.state = "closed";
  }
}

function installGlobals(): void {
  (globalThis as unknown as { window: object }).window = {
    AudioContext: FakeAudioContext,
  };
  (globalThis as unknown as { AudioContext: typeof FakeAudioContext }).AudioContext = FakeAudioContext;
}

beforeEach(() => {
  sources.length = 0;
  gains.length = 0;
  installGlobals();
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
});

async function withScope<T>(fn: () => Promise<T> | T): Promise<T> {
  const scope = effectScope();
  try {
    let result!: T;
    await scope.run(async () => {
      result = await fn();
    });
    return result;
  } finally {
    scope.stop();
  }
}

describe("useVoiceTtsPlayback", () => {
  it("schedules the first chunk at currentTime", async () => {
    const { useVoiceTtsPlayback } = await import("../../composables/useVoiceTtsPlayback");

    await withScope(async () => {
      const playback = useVoiceTtsPlayback();
      const samples = new Float32Array(2400);
      playback.enqueue(samples.buffer, 24000);

      expect(sources).toHaveLength(1);
      expect(sources[0]!.startedAt).toBe(0);
      expect(playback.isPlaying.value).toBe(true);
      playback.cancel();
    });
  });

  it("schedules consecutive chunks back-to-back", async () => {
    const { useVoiceTtsPlayback } = await import("../../composables/useVoiceTtsPlayback");

    await withScope(async () => {
      const playback = useVoiceTtsPlayback();
      const samples = new Float32Array(2400);
      playback.enqueue(samples.buffer, 24000);
      playback.enqueue(samples.buffer, 24000);

      expect(sources).toHaveLength(2);
      const first = sources[0]!.startedAt!;
      const second = sources[1]!.startedAt!;
      expect(second).toBeGreaterThan(first);
      expect(second).toBeLessThan(first + 0.1);
      playback.cancel();
    });
  });

  it("cancel() stops all in-flight sources and resets isPlaying", async () => {
    const { useVoiceTtsPlayback } = await import("../../composables/useVoiceTtsPlayback");

    await withScope(async () => {
      const playback = useVoiceTtsPlayback();
      const samples = new Float32Array(2400);
      playback.enqueue(samples.buffer, 24000);
      playback.enqueue(samples.buffer, 24000);

      expect(playback.isPlaying.value).toBe(true);
      playback.cancel();

      expect(sources.every((s) => s.stopped)).toBe(true);
      expect(playback.isPlaying.value).toBe(false);
    });
  });

  it("isPlaying returns to false when source ends naturally", async () => {
    const { useVoiceTtsPlayback } = await import("../../composables/useVoiceTtsPlayback");

    await withScope(async () => {
      const playback = useVoiceTtsPlayback();
      const samples = new Float32Array(2400);
      playback.enqueue(samples.buffer, 24000);
      expect(playback.isPlaying.value).toBe(true);

      const src = sources[0]!;
      src.onended?.call(src as unknown as AudioScheduledSourceNode, new Event("ended"));
      expect(playback.isPlaying.value).toBe(false);
    });
  });
});
