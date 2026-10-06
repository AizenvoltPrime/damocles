import { describe, expect, it } from 'vitest';
import { CHIME_GAP_MS, createChime } from '../overlay/chime';

class FakeParam {
  value = 0;
  readonly ramps: Array<[number, number]> = [];
  readonly holds: number[] = [];
  setValueAtTime(value: number, at: number): void {
    this.ramps.push([value, at]);
  }
  exponentialRampToValueAtTime(value: number, at: number): void {
    this.ramps.push([value, at]);
  }
  cancelAndHoldAtTime(at: number): void {
    this.holds.push(at);
  }
}

class FakeNode {
  readonly connections: unknown[] = [];
  disconnected = false;
  connect<T>(node: T): T {
    this.connections.push(node);
    return node;
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

type FakeGain = FakeNode & { gain: FakeParam };
type FakeOscillator = FakeNode & { type: string; frequency: FakeParam; onended: (() => void) | null; start(at: number): void; stop(at: number): void };

class FakeContext {
  state = 'suspended';
  resumed = 0;
  closed = 0;
  currentTime = 10;
  readonly destination = {};
  readonly gains: FakeGain[] = [];
  readonly oscillators: Array<{ node: FakeOscillator; frequency: number; start: number; stop: number }> = [];
  resume(): Promise<void> {
    this.resumed++;
    this.state = 'running';
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closed++;
    this.state = 'closed';
    return Promise.resolve();
  }
  createGain(): FakeGain {
    const gain = Object.assign(new FakeNode(), { gain: new FakeParam() });
    this.gains.push(gain);
    return gain;
  }
  createOscillator(): FakeOscillator {
    const frequency = new FakeParam();
    const node: FakeOscillator = Object.assign(new FakeNode(), {
      type: '',
      frequency,
      onended: null,
      start: (at: number) => {
        record.frequency = frequency.value;
        record.start = at;
      },
      stop: (at: number) => {
        record.stop = at;
      },
    });
    const record = { node, frequency: 0, start: 0, stop: 0 };
    this.oscillators.push(record);
    return node;
  }
}

function setup(): { play: ReturnType<typeof createChime>['play']; close: () => void; context: FakeContext; clock: { now: number } } {
  const context = new FakeContext();
  const clock = { now: 0 };
  const chime = createChime(() => context as unknown as AudioContext, () => clock.now);
  return { play: chime.play, close: chime.close, context, clock };
}

// The fundamental of each note, the octave partials left out.
function fundamentals(context: FakeContext, from = 0): number[] {
  return context.oscillators.slice(from).filter((_, index) => index % 2 === 0).map((note) => note.frequency);
}

describe('popup chime (D52)', () => {
  it('rises for a prompt that waits on the user, rings once for a finished chat and falls for a stopped one', () => {
    const { play, context, clock } = setup();
    play('attention');
    expect(fundamentals(context)).toEqual([659.25, 880]);
    expect(context.oscillators[2]!.start).toBeGreaterThan(context.oscillators[0]!.start);
    clock.now += CHIME_GAP_MS;
    context.oscillators.length = 0;
    play('done');
    expect(fundamentals(context)).toEqual([1046.5]);
    clock.now += CHIME_GAP_MS;
    context.oscillators.length = 0;
    play('warning');
    expect(fundamentals(context)).toEqual([523.25, 392]);
    expect(context.resumed).toBe(1);
  });

  it('plays one chime for popups that arrive together', () => {
    const { play, context, clock } = setup();
    play('attention');
    const count = context.oscillators.length;
    clock.now += CHIME_GAP_MS - 1;
    play('done');
    expect(context.oscillators).toHaveLength(count);
    clock.now += 1;
    play('done');
    expect(context.oscillators.length).toBeGreaterThan(count);
  });

  it('plays the most urgent tone of a burst: a more urgent one fades out the chime still ringing, a less urgent one is dropped', () => {
    const { play, context, clock } = setup();
    play('done');
    const done = context.oscillators.slice();
    clock.now += 500;
    context.currentTime = 10.5;
    play('attention');
    expect(fundamentals(context, done.length)).toEqual([659.25, 880]);
    // The done chime is held where it is and fades out at once rather than ringing on under the new one.
    for (const { stop } of done) expect(stop).toBeCloseTo(10.52);
    const envelopes = context.gains.filter((gain) => done.some(({ node }) => node.connections.includes(gain)));
    expect(envelopes.map((envelope) => envelope.gain.holds)).toEqual([[10.5], [10.5]]);

    const count = context.oscillators.length;
    clock.now += 100;
    play('warning');
    play('attention');
    expect(context.oscillators).toHaveLength(count);
  });

  it('feeds every chime into one master gain and disconnects each note once it ends', () => {
    const { play, context, clock } = setup();
    play('attention');
    clock.now += CHIME_GAP_MS;
    play('warning');
    const masters = context.gains.filter((gain) => gain.connections.includes(context.destination));
    expect(masters).toHaveLength(1);
    expect(context.gains.filter((gain) => gain.connections.includes(masters[0]))).toHaveLength(context.oscillators.length);

    for (const { node } of context.oscillators) {
      const envelope = node.connections[0] as FakeGain;
      expect(node.disconnected).toBe(false);
      node.onended!();
      expect(node.disconnected).toBe(true);
      expect(envelope.disconnected).toBe(true);
    }
    expect(masters[0]!.disconnected).toBe(false);
  });

  it('closes its audio context, and never opens one it was not asked to play', () => {
    const idle = setup();
    idle.close();
    expect(idle.context.gains).toHaveLength(0);
    expect(idle.context.closed).toBe(0);

    const { play, close, context } = setup();
    play('done');
    close();
    expect(context.closed).toBe(1);
  });
});
