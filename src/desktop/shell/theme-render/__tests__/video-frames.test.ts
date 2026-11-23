// The theme render page's read of a video's frames against a fake WebCodecs decoder: every declared frame once and in order,
// or no answer. The real decoder's part is e2e's (themes-motion.spec.ts).
import { describe, expect, it, vi } from 'vitest';
import type { VideoSample, VideoSamples } from '@shared/themes/video-samples';
import { DECODE_QUEUE, decodeEveryFrame, type FrameCodecs } from '../video-frames';

interface Chunk { readonly type: 'key' | 'delta'; readonly timestamp: number; readonly data: Uint8Array }
interface Frame { readonly timestamp: number; readonly close: ReturnType<typeof vi.fn> }
interface Init { output(frame: Frame): void; error(err: Error): void }

// What the fake does with the chunk of `index` (in decode order) instead of giving its frame.
type Fault = 'drop' | 'error' | 'twice' | 'stall';

function fakeCodecs(options: { supported?: boolean; faults?: Readonly<Record<number, Fault>>; reorder?: number } = {}) {
  const decoded: Chunk[] = [];
  const frames: Frame[] = [];
  const configs: unknown[] = [];
  class Decoder {
    static isConfigSupported = async (config: unknown): Promise<{ supported: boolean }> => {
      configs.push(config);
      return { supported: options.supported ?? true };
    };
    state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
    decodeQueueSize = 0;
    private readonly init: Init;
    private readonly waiting: number[] = [];
    private dequeue: () => void = () => undefined;
    private stalled = false;

    constructor(init: Init) {
      this.init = init;
    }

    addEventListener(_type: 'dequeue', listener: () => void): void {
      this.dequeue = listener;
    }

    configure(): void {
      this.state = 'configured';
    }

    decode(chunk: Chunk): void {
      if (this.state !== 'configured') throw new Error('the decoder is closed');
      if (decoded.length === 0 && chunk.type !== 'key') throw new Error('A key frame is required after configure()');
      const index = decoded.push(chunk) - 1;
      this.decodeQueueSize++;
      setTimeout(() => this.work(index, chunk), 0);
    }

    private work(index: number, chunk: Chunk): void {
      if (this.state !== 'configured' || this.stalled) return;
      const fault = options.faults?.[index];
      if (fault === 'stall') {
        // the queue never drains again; the error comes later
        this.stalled = true;
        setTimeout(() => this.fail(), 5);
        return;
      }
      this.decodeQueueSize--;
      this.dequeue();
      if (fault === 'error') {
        this.fail();
        return;
      }
      if (fault === 'drop') return;
      this.waiting.push(chunk.timestamp);
      if (fault === 'twice') this.waiting.push(chunk.timestamp);
      this.waiting.sort((a, b) => a - b);
      while (this.waiting.length > (options.reorder ?? 0)) this.give(this.waiting.shift()!);
    }

    private fail(): void {
      this.state = 'closed';
      this.init.error(new Error('Decoding error.'));
    }

    private give(timestamp: number): void {
      const frame: Frame = { timestamp, close: vi.fn() };
      frames.push(frame);
      this.init.output(frame);
    }

    async flush(): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 1));
      while (this.decodeQueueSize > 0 && this.state === 'configured') await new Promise((resolve) => setTimeout(resolve, 1));
      if (this.state !== 'configured') throw new Error('Decoding error.');
      while (this.waiting.length > 0) this.give(this.waiting.shift()!);
    }

    close(): void {
      this.state = 'closed';
    }
  }
  class EncodedChunk implements Chunk {
    readonly type: 'key' | 'delta';
    readonly timestamp: number;
    readonly data: Uint8Array;
    constructor(init: Chunk) {
      this.type = init.type;
      this.timestamp = init.timestamp;
      this.data = init.data;
    }
  }
  return { codecs: { Decoder, Chunk: EncodedChunk } as unknown as FrameCodecs, decoded, frames, configs };
}

// `timestamps` in decode order; each frame is one byte, its index
function track(timestamps: readonly number[], hidden: readonly number[] = []): { readonly samples: VideoSamples; readonly bytes: Uint8Array } {
  const samples = timestamps.map((timestamp, index): VideoSample => ({ offset: index, size: 1, timestamp, key: index === 0, shown: !hidden.includes(index) }));
  const shown = samples.filter((sample) => sample.shown).map((sample) => sample.timestamp).sort((a, b) => a - b);
  return { samples: { codec: 'avc1.42c00a', width: 64, height: 64, rotation: 0, samples, shown, durationMs: 1000 }, bytes: Uint8Array.from(timestamps.map((_, index) => index)) };
}

const STEADY = [0, 16_667, 33_333, 50_000, 66_667];

async function read(fake: ReturnType<typeof fakeCodecs>, of: ReturnType<typeof track>, each: (frame: VideoFrame, index: number) => boolean = () => true): Promise<number[]> {
  const seen: number[] = [];
  await decodeEveryFrame(of.samples, of.bytes, (frame, index) => {
    seen.push(frame.timestamp);
    expect(index).toBe(seen.length - 1);
    return each(frame, index);
  }, fake.codecs);
  return seen;
}

describe('decodeEveryFrame', () => {
  it('gives every declared frame once, in presentation order, from the bytes the container places, and closes each', async () => {
    // decode order differs from presentation order, as with B-frames
    const of = track([0, 50_000, 16_667, 33_333, 66_667]);
    const fake = fakeCodecs({ reorder: 2 });
    expect(await read(fake, of)).toEqual(STEADY);
    expect(fake.decoded.map((chunk) => [chunk.type, chunk.timestamp, [...chunk.data]])).toEqual([['key', 0, [0]], ['delta', 50_000, [1]], ['delta', 16_667, [2]], ['delta', 33_333, [3]], ['delta', 66_667, [4]]]);
    expect(fake.frames.every((frame) => frame.close.mock.calls.length === 1)).toBe(true);
    // software decoding: one file reads alike on every computer
    expect(fake.configs).toEqual([{ codec: 'avc1.42c00a', codedWidth: 64, codedHeight: 64, hardwareAcceleration: 'prefer-software' }]);
  });

  it('reads a long video through a decoder that holds only a few frames at once', async () => {
    const of = track(Array.from({ length: 200 }, (_, index) => index * 16_667));
    expect(await read(fakeCodecs(), of)).toHaveLength(200);
    expect(DECODE_QUEUE).toBeLessThan(200);
  });

  it('refuses a video when the decoder gives no frame for one the container declares', async () => {
    await expect(read(fakeCodecs({ faults: { 4: 'drop' } }), track(STEADY))).rejects.toThrow("the decoder read 4 of the video's 5 frames");
    await expect(read(fakeCodecs({ faults: { 2: 'drop' } }), track(STEADY))).rejects.toThrow('frame 3 of the video was not read in its place');
  });

  it('refuses a video when a frame cannot be decoded, and closes the frames it had', async () => {
    const fake = fakeCodecs({ faults: { 3: 'error' } });
    await expect(read(fake, track(STEADY))).rejects.toThrow('a frame of the video did not decode: Decoding error.');
    expect(fake.frames.every((frame) => frame.close.mock.calls.length === 1)).toBe(true);
  });

  it('refuses, and does not wait for ever, when the decoder fails while its queue is full', async () => {
    const of = track(Array.from({ length: DECODE_QUEUE * 4 }, (_, index) => index * 16_667));
    await expect(read(fakeCodecs({ faults: { 2: 'stall' } }), of)).rejects.toThrow('a frame of the video did not decode');
  });

  it('refuses a frame given twice or one the video does not declare', async () => {
    await expect(read(fakeCodecs({ faults: { 1: 'twice' } }), track(STEADY))).rejects.toThrow('frame 3 of the video was not read in its place');
    await expect(read(fakeCodecs({ faults: { 4: 'twice' } }), track(STEADY))).rejects.toThrow('the decoder gave a frame the video does not declare');
  });

  it('refuses a codec the computer cannot decode, before any frame', async () => {
    const fake = fakeCodecs({ supported: false });
    await expect(read(fake, track(STEADY))).rejects.toThrow('the avc1.42c00a video cannot be decoded on this computer');
    expect(fake.decoded).toEqual([]);
  });

  it('refuses a video that does not start with a key frame', async () => {
    const of = track(STEADY);
    const samples = { ...of.samples, samples: of.samples.samples.map((sample) => ({ ...sample, key: false })) };
    await expect(read(fakeCodecs(), { samples, bytes: of.bytes })).rejects.toThrow('a frame of the video did not decode: A key frame is required');
  });

  it('feeds a frame the codec never shows and expects none for it', async () => {
    const of = track(STEADY, [2]);
    const fake = fakeCodecs({ faults: { 2: 'drop' } });
    expect(await read(fake, of)).toEqual([0, 16_667, 50_000, 66_667]);
    expect(fake.decoded).toHaveLength(5);
  });

  it('ends early when the caller has its answer, feeding no more of the video', async () => {
    const of = track(Array.from({ length: 100 }, (_, index) => index * 16_667));
    const fake = fakeCodecs();
    expect(await read(fake, of, (_frame, index) => index < 2)).toEqual([0, 16_667, 33_334]);
    expect(fake.decoded.length).toBeLessThan(100);
  });

  it('refuses when the caller\'s own work on a frame throws', async () => {
    await expect(read(fakeCodecs(), track(STEADY), () => {
      throw new Error('no 2d canvas');
    })).rejects.toThrow('no 2d canvas');
  });
});
