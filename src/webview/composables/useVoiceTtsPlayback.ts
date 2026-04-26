import { ref, readonly, onScopeDispose, type Ref } from "vue";

const TTS_NATIVE_SAMPLE_RATE = 24000;
const CROSSFADE_SECONDS = 0.01;
const GESTURE_EVENTS = ["pointerdown", "keydown", "touchstart"] as const;

export interface UseVoiceTtsPlaybackReturn {
  enqueue: (chunk: ArrayBuffer | Uint8Array, sampleRate: number) => void;
  cancel: () => void;
  isPlaying: Readonly<Ref<boolean>>;
}

interface ScheduledSource {
  source: AudioBufferSourceNode;
  gain: GainNode;
  endsAt: number;
}

interface PlaybackController {
  enqueue: (chunk: ArrayBuffer | Uint8Array, sampleRate: number) => void;
  cancel: () => void;
  isPlaying: Ref<boolean>;
}

let sharedAudioContext: AudioContext | null = null;
let gestureListenersArmed = false;

function instantiateAudioContext(): AudioContext {
  const ContextCtor: typeof AudioContext =
    (window as unknown as { AudioContext: typeof AudioContext }).AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  return new ContextCtor({ sampleRate: TTS_NATIVE_SAMPLE_RATE });
}

function getSharedAudioContext(): AudioContext {
  if (sharedAudioContext === null || sharedAudioContext.state === "closed") {
    sharedAudioContext = instantiateAudioContext();
  }
  return sharedAudioContext;
}

function armGestureUnlock(): void {
  if (gestureListenersArmed) return;
  if (typeof window === "undefined") return;
  if (typeof window.addEventListener !== "function") return;
  gestureListenersArmed = true;

  const handler = (): void => {
    const ctx = getSharedAudioContext();
    void ctx.resume().catch(() => undefined);
    for (const ev of GESTURE_EVENTS) {
      window.removeEventListener(ev, handler, true);
    }
  };
  for (const ev of GESTURE_EVENTS) {
    window.addEventListener(ev, handler, true);
  }
}

function createPlaybackController(): PlaybackController {
  const isPlaying = ref<boolean>(false);
  const activeSources: Set<ScheduledSource> = new Set();
  let nextStartTime: number | null = null;

  function chunkToFloat32(chunk: ArrayBuffer | Uint8Array): Float32Array {
    // Float32Array requires a multiple-of-4 source. Production data
    // arrives via base64-decoded Uint8Array, where any payload-length
    // drift (sidecar bug, future protocol change) would otherwise throw
    // RangeError straight up the playback callback. Drop trailing
    // partial samples and warn instead of failing the whole stream.
    const view = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    const usableBytes = view.byteLength - (view.byteLength % 4);
    if (usableBytes !== view.byteLength) {
      console.warn(
        `[VoiceTts] PCM chunk byte-misaligned: dropping ${view.byteLength - usableBytes} trailing bytes (got ${view.byteLength})`,
      );
    }
    if (usableBytes === 0) return new Float32Array(0);
    if (
      chunk instanceof ArrayBuffer &&
      usableBytes === chunk.byteLength
    ) {
      return new Float32Array(chunk);
    }
    const buf = new ArrayBuffer(usableBytes);
    new Uint8Array(buf).set(view.subarray(0, usableBytes));
    return new Float32Array(buf);
  }

  function enqueue(chunk: ArrayBuffer | Uint8Array, sampleRate: number): void {
    // Lazy-arm the gesture unlock the first time the webview actually
    // tries to play audio. Doing this at module import attached three
    // capture-phase window listeners on every webview load — including
    // panels where the user never enables TTS — and contradicted the
    // two-phase lazy-init pattern used elsewhere in the codebase.
    armGestureUnlock();
    const ctx = getSharedAudioContext();
    if (ctx.state === "suspended") {
      console.warn(
        "[VoiceTts] AudioContext suspended awaiting first user gesture; chunk will play once unlocked"
      );
    }

    const samples = chunkToFloat32(chunk);
    if (samples.length === 0) return;

    const audioBuffer = ctx.createBuffer(1, samples.length, sampleRate);
    audioBuffer.getChannelData(0).set(samples);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;

    const gain = ctx.createGain();
    source.connect(gain).connect(ctx.destination);

    const now = ctx.currentTime;
    if (nextStartTime === null) {
      nextStartTime = now;
    }
    const startAt = Math.max(now, nextStartTime);
    const duration = audioBuffer.duration;
    const fade = Math.min(CROSSFADE_SECONDS, duration / 2);

    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(1, startAt + fade);
    gain.gain.setValueAtTime(1, startAt + duration - fade);
    gain.gain.linearRampToValueAtTime(0, startAt + duration);

    source.start(startAt);

    const overlap = Math.min(fade, duration);
    nextStartTime = startAt + duration - overlap;

    const entry: ScheduledSource = {
      source,
      gain,
      endsAt: startAt + duration,
    };
    activeSources.add(entry);
    isPlaying.value = true;

    source.onended = (): void => {
      activeSources.delete(entry);
      try {
        gain.disconnect();
      } catch {
        // already disconnected
      }
      if (activeSources.size === 0) {
        isPlaying.value = false;
      }
    };
  }

  function cancel(): void {
    for (const entry of activeSources) {
      try {
        entry.source.onended = null;
        entry.source.stop();
        entry.source.disconnect();
        entry.gain.disconnect();
      } catch {
        // already stopped or disconnected
      }
    }
    activeSources.clear();
    nextStartTime = sharedAudioContext?.currentTime ?? null;
    isPlaying.value = false;
  }

  return { enqueue, cancel, isPlaying };
}

let sharedController: PlaybackController | null = null;

function getSharedController(): PlaybackController {
  if (sharedController === null) {
    sharedController = createPlaybackController();
  }
  return sharedController;
}

export function getVoiceTtsPlayback(): Pick<PlaybackController, "enqueue" | "cancel" | "isPlaying"> {
  return getSharedController();
}

export function useVoiceTtsPlayback(): UseVoiceTtsPlaybackReturn {
  const controller = getSharedController();

  onScopeDispose(() => {
    controller.cancel();
  });

  return {
    enqueue: controller.enqueue,
    cancel: controller.cancel,
    isPlaying: readonly(controller.isPlaying),
  };
}
