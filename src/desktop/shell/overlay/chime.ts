import { CHIME_URGENCY, type ChimeTone } from '../../preload/notifications';

// Each tone's notes: frequency in Hz and start in seconds after the chime begins.
const TONES: Readonly<Record<ChimeTone, ReadonlyArray<{ readonly frequency: number; readonly at: number }>>> = {
  // rising E5 to A5: something waits on the user
  attention: [{ frequency: 659.25, at: 0 }, { frequency: 880, at: 0.11 }],
  // a single soft C6
  done: [{ frequency: 1046.5, at: 0 }],
  // falling C5 to G4: a chat stopped
  warning: [{ frequency: 523.25, at: 0 }, { frequency: 392, at: 0.13 }],
};
// A sine and a quiet octave above it, struck and left to ring out like a small bell.
const PARTIALS: ReadonlyArray<readonly [multiple: number, level: number]> = [[1, 1], [2, 0.18]];
const VOLUME = 0.16;
const ATTACK_S = 0.008;
const DECAY_S = 0.45;
// A chime a more urgent one replaces fades this fast; stopping it dead would click.
const RELEASE_S = 0.02;
// Popups that arrive together play one chime.
export const CHIME_GAP_MS = 800;

export interface Chime {
  readonly play: (tone: ChimeTone) => void;
  // releases the audio context; call it only once nothing can play any more
  readonly close: () => void;
}

interface Voice {
  readonly oscillator: OscillatorNode;
  readonly envelope: GainNode;
}

/**
 * Plays a popup's sound, synthesized so no audio file ships; the window allows audio without a user gesture. A burst
 * plays its most urgent tone: a more urgent one arriving within it replaces the chime still ringing.
 */
export function createChime(createContext: () => AudioContext = () => new AudioContext(), now: () => number = () => performance.now()): Chime {
  let output: { readonly context: AudioContext; readonly master: GainNode } | undefined;
  let burst: { readonly at: number; urgency: number; voices: readonly Voice[] } | undefined;

  function open(): { readonly context: AudioContext; readonly master: GainNode } {
    if (output) return output;
    const context = createContext();
    const master = context.createGain();
    master.gain.value = VOLUME;
    master.connect(context.destination);
    output = { context, master };
    return output;
  }

  function ring(tone: ChimeTone): Voice[] {
    const { context, master } = open();
    if (context.state === 'suspended') void context.resume();
    const begin = context.currentTime + 0.01;
    const voices: Voice[] = [];
    for (const note of TONES[tone]) {
      const start = begin + note.at;
      for (const [multiple, level] of PARTIALS) {
        const oscillator = context.createOscillator();
        oscillator.type = 'sine';
        oscillator.frequency.value = note.frequency * multiple;
        const envelope = context.createGain();
        // An exponential ramp cannot start from 0.
        envelope.gain.setValueAtTime(0.0001, start);
        envelope.gain.exponentialRampToValueAtTime(level, start + ATTACK_S);
        envelope.gain.exponentialRampToValueAtTime(0.0001, start + DECAY_S);
        oscillator.connect(envelope).connect(master);
        oscillator.onended = () => {
          oscillator.disconnect();
          envelope.disconnect();
        };
        oscillator.start(start);
        oscillator.stop(start + DECAY_S + 0.05);
        voices.push({ oscillator, envelope });
      }
    }
    return voices;
  }

  function silence(voices: readonly Voice[]): void {
    const at = open().context.currentTime;
    for (const { oscillator, envelope } of voices) {
      envelope.gain.cancelAndHoldAtTime(at);
      envelope.gain.exponentialRampToValueAtTime(0.0001, at + RELEASE_S);
      oscillator.stop(at + RELEASE_S);
    }
  }

  return {
    play(tone) {
      const time = now();
      const urgency = CHIME_URGENCY[tone];
      if (burst && time - burst.at < CHIME_GAP_MS) {
        if (urgency <= burst.urgency) return;
        silence(burst.voices);
        burst.urgency = urgency;
        burst.voices = ring(tone);
        return;
      }
      burst = { at: time, urgency, voices: ring(tone) };
    },
    close() {
      if (output) void output.context.close();
      output = undefined;
      burst = undefined;
    },
  };
}
