// The frames a video's container declares, read from real files (e2e/desktop/fixtures/wallpapers, each made by FFmpeg) and
// from files built byte by byte for what a real encoder does not write.
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_VIDEO_FRAMES, readVideoSamples, VideoSamplesError, type VideoSamples } from '../video-samples';

const FIXTURES = path.resolve(import.meta.dirname, '../../../../e2e/desktop/fixtures/wallpapers');
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(path.join(FIXTURES, name)));
const refusal = (bytes: Uint8Array): string => {
  try {
    readVideoSamples(bytes);
  } catch (err) {
    if (err instanceof VideoSamplesError) return err.message;
    throw err;
  }
  return 'read';
};

// big-endian fields and boxes
const u32 = (value: number): number[] => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
const u16 = (value: number): number[] => [(value >>> 8) & 0xff, value & 0xff];
const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
const zeros = (count: number): number[] => new Array<number>(count).fill(0);
const box = (type: string, body: number[]): number[] => [...u32(body.length + 8), ...ascii(type), ...body];
const fullBox = (type: string, body: number[], version = 0): number[] => box(type, [version, 0, 0, 0, ...body]);

interface Mp4Shape {
  // each frame's bytes, in decode order
  readonly frames?: readonly number[][];
  // ticks each frame lasts, of 1000 a second
  readonly delta?: number;
  // composition offsets, one per frame
  readonly offsets?: readonly number[];
  // sync samples, 1-based; absent: every frame is one
  readonly sync?: readonly number[];
  readonly codec?: string;
  readonly config?: number[];
  readonly videoTracks?: number;
  // the track header's matrix a, b, c, d
  readonly matrix?: readonly [number, number, number, number];
  // replaces the chunk offset the frames really start at
  readonly chunkOffset?: number;
  // replaces the frame count stsz states
  readonly count?: number;
  readonly compactSizes?: boolean;
}

const AVCC = [1, 0x42, 0xc0, 0x0a, 0xff, 0xe0, 0];
const ONE = 0x10000;

/** An MP4 with one video track's whole sample table and its frames in mdat. */
function mp4(shape: Mp4Shape = {}): Uint8Array {
  const frames = shape.frames ?? [[1, 2, 3], [4, 5], [6]];
  const [a, b, c, d] = shape.matrix ?? [ONE, 0, 0, ONE];
  const build = (chunkOffset: number): number[] => {
    const entry = box(shape.codec ?? 'avc1', [...zeros(6), ...u16(1), ...zeros(16), ...u16(64), ...u16(48), ...zeros(50), ...box('avcC', shape.config ?? AVCC)]);
    const sizes = shape.compactSizes
      ? fullBox('stz2', [0, 0, 0, 8, ...u32(frames.length), ...frames.map((frame) => frame.length)])
      : fullBox('stsz', [...u32(0), ...u32(shape.count ?? frames.length), ...frames.flatMap((frame) => u32(frame.length))]);
    const stbl = box('stbl', [
      ...fullBox('stsd', [...u32(1), ...entry]),
      ...fullBox('stts', [...u32(1), ...u32(frames.length), ...u32(shape.delta ?? 100)]),
      ...(shape.offsets ? fullBox('ctts', [...u32(shape.offsets.length), ...shape.offsets.flatMap((offset) => [...u32(1), ...u32(offset >>> 0)])], 1) : []),
      ...(shape.sync ? fullBox('stss', [...u32(shape.sync.length), ...shape.sync.flatMap(u32)]) : []),
      ...fullBox('stsc', [...u32(1), ...u32(1), ...u32(frames.length), ...u32(1)]),
      ...sizes,
      ...fullBox('stco', [...u32(1), ...u32(shape.chunkOffset ?? chunkOffset)]),
    ]);
    const trak = box('trak', [
      ...fullBox('tkhd', [...u32(0), ...u32(0), ...u32(1), ...u32(0), ...u32(0), ...zeros(16), ...u32(a), ...u32(b), ...u32(0), ...u32(c), ...u32(d), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000), ...u32(64 << 16), ...u32(48 << 16)]),
      ...box('mdia', [
        ...fullBox('mdhd', [...u32(0), ...u32(0), ...u32(1000), ...u32(0), ...u32(0)]),
        ...fullBox('hdlr', [...u32(0), ...ascii('vide'), ...zeros(13)]),
        ...box('minf', stbl),
      ]),
    ]);
    const moov = box('moov', [...fullBox('mvhd', [...u32(0), ...u32(0), ...u32(1000), ...u32(frames.length * 100), ...zeros(80)]), ...Array.from({ length: shape.videoTracks ?? 1 }, () => trak).flat()]);
    return [...box('ftyp', [...ascii('isom'), ...u32(512), ...ascii('isom')]), ...moov];
  };
  const head = build(0).length + 8;
  return new Uint8Array([...build(head), ...box('mdat', frames.flat())]);
}

// EBML: an ID as its bytes, a size as an 8-byte vint
const element = (id: number[], body: number[]): number[] => [...id, 0x01, 0, 0, 0, ...u32(body.length), ...body];
const VP9_KEY = [0x82, 0x49, 0x83, 0x42, 0, 0];
// track number 1, a 16-bit time from the cluster's, flags, then the frame
const simpleBlock = (time: number, frame: number[], flags = 0x80): number[] => element([0xa3], [0x81, ...u16(time & 0xffff), flags, ...frame]);

interface WebmShape {
  readonly codec?: string;
  readonly blocks?: number[];
  readonly unknownClusterSize?: boolean;
  readonly trackExtra?: number[];
}

/** A WebM with one video track and one cluster of `blocks`, 1 ms a time unit. */
function webm(shape: WebmShape = {}): Uint8Array {
  const blocks = shape.blocks ?? [...simpleBlock(0, VP9_KEY), ...simpleBlock(33, [0x86, 0]), ...simpleBlock(67, [0x86, 0], 0)];
  const cluster = [...element([0xe7], [0]), ...blocks];
  const segment = [
    ...element([0x15, 0x49, 0xa9, 0x66], [...element([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]), ...element([0x44, 0x89], [0x40, 0x59, 0, 0, 0, 0, 0, 0])]),
    ...element([0x16, 0x54, 0xae, 0x6b], element([0xae], [
      ...element([0xd7], [1]), ...element([0x83], [1]), ...element([0x86], ascii(shape.codec ?? 'V_VP9')),
      ...element([0xe0], [...element([0xb0], [64]), ...element([0xba], [48])]), ...(shape.trackExtra ?? []),
    ])),
    ...(shape.unknownClusterSize ? [0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...cluster] : element([0x1f, 0x43, 0xb6, 0x75], cluster)),
  ];
  return new Uint8Array([...element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x82], ascii('webm'))), ...element([0x18, 0x53, 0x80, 0x67], segment)]);
}

const frameBytes = (bytes: Uint8Array, video: VideoSamples): number[][] => video.samples.map((sample) => [...bytes.subarray(sample.offset, sample.offset + sample.size)]);

describe('the frames of real files', () => {
  it('lists every frame of a 60 fps H.264 clip once, 1/60 s apart, with its codec and decoder configuration', () => {
    const video = readVideoSamples(fixture('strobe-60fps.mp4'));
    expect(video).toMatchObject({ codec: 'avc1.42c00a', width: 64, height: 64, rotation: 0, durationMs: 2000 });
    expect(video.samples).toHaveLength(120);
    expect(video.shown).toEqual(Array.from({ length: 120 }, (_, index) => Math.round((index * 1_000_000) / 60)));
    expect(video.samples[0]!.key).toBe(true);
    // the AVCDecoderConfigurationRecord: version 1, then the profile and level the codec string names
    expect([...video.description!.subarray(0, 4)]).toEqual([1, 0x42, 0xc0, 0x0a]);
  });

  it('reads a 30 fps clip as half as many frames over the same time', () => {
    const video = readVideoSamples(fixture('strobe-30fps.mp4'));
    expect(video.samples).toHaveLength(60);
    expect(video.shown[1]).toBe(33_333);
    expect(video.durationMs).toBe(2000);
  });

  it('reads moov at the start and at the end alike', () => {
    for (const name of ['moov-start.mp4', 'moov-end.mp4']) {
      const video = readVideoSamples(fixture(name));
      expect(video.samples, name).toHaveLength(45);
      expect(video.durationMs, name).toBe(3000);
    }
  });

  it('keeps the decode order of frames stored out of presentation order, and their presentation times from 0', () => {
    const video = readVideoSamples(fixture('bframes.mp4'));
    const decodeOrder = video.samples.map((sample) => sample.timestamp);
    expect(video.samples).toHaveLength(60);
    expect(decodeOrder).not.toEqual([...decodeOrder].sort((a, b) => a - b));
    expect(video.shown).toEqual([...decodeOrder].sort((a, b) => a - b));
    expect(video.shown[0]).toBe(0);
    expect(new Set(video.shown).size).toBe(60);
  });

  it('reads the frames of movie fragments, whose moov lists none', () => {
    const video = readVideoSamples(fixture('fragmented.mp4'));
    expect(video.samples).toHaveLength(60);
    // a fragment starts at each key frame, every 15 frames at most
    expect(video.samples[0]!.key).toBe(true);
    expect(video.samples.filter((sample) => sample.key).length).toBeGreaterThanOrEqual(4);
    expect(video.samples.filter((sample) => !sample.key).length).toBeGreaterThan(40);
    expect(video.durationMs).toBe(2000);
  });

  it('names AV1, VP8 and VP9 as WebCodecs does', () => {
    expect(readVideoSamples(fixture('av1.mp4'))).toMatchObject({ codec: 'av01.0.00M.08', samples: { length: 60 } });
    expect(readVideoSamples(fixture('vp8.webm'))).toMatchObject({ codec: 'vp8', samples: { length: 60 } });
    const vp9 = readVideoSamples(fixture('loop.webm'));
    expect(vp9).toMatchObject({ codec: 'vp09.00.10.08', width: 160, height: 90 });
    expect(vp9.samples).toHaveLength(45);
    expect(vp9.description).toBeUndefined();
  });

  it('places every frame inside its file', () => {
    for (const name of ['strobe-60fps.mp4', 'bframes.mp4', 'fragmented.mp4', 'av1.mp4', 'vp8.webm', 'loop.webm']) {
      const bytes = fixture(name);
      for (const sample of readVideoSamples(bytes).samples) expect(sample.offset + sample.size, name).toBeLessThanOrEqual(bytes.length);
    }
  });
});

describe('an MP4 built by hand', () => {
  it('reads each frame at its place with its time, in microseconds', () => {
    const bytes = mp4();
    const video = readVideoSamples(bytes);
    expect(frameBytes(bytes, video)).toEqual([[1, 2, 3], [4, 5], [6]]);
    expect(video.samples.map((sample) => [sample.timestamp, sample.key, sample.shown])).toEqual([[0, true, true], [100_000, true, true], [200_000, true, true]]);
    expect(video).toMatchObject({ codec: 'avc1.42c00a', width: 64, height: 48, durationMs: 300 });
  });

  it('adds each frame\'s composition offset, starts the times at 0 and reads the sync samples', () => {
    const video = readVideoSamples(mp4({ offsets: [100, 300, 0], sync: [1] }));
    expect(video.samples.map((sample) => sample.timestamp)).toEqual([0, 300_000, 100_000]);
    expect(video.shown).toEqual([0, 100_000, 300_000]);
    expect(video.samples.map((sample) => sample.key)).toEqual([true, false, false]);
  });

  it('reads the quarter turn of the track\'s matrix, and no turn from any other matrix', () => {
    expect(readVideoSamples(mp4({ matrix: [0, ONE, -ONE, 0] })).rotation).toBe(90);
    expect(readVideoSamples(mp4({ matrix: [-ONE, 0, 0, -ONE] })).rotation).toBe(180);
    expect(readVideoSamples(mp4({ matrix: [0, -ONE, ONE, 0] })).rotation).toBe(270);
    expect(readVideoSamples(mp4({ matrix: [-ONE, 0, 0, ONE] })).rotation).toBe(0);
  });

  it('refuses a frame it cannot place rather than leaving it out', () => {
    expect(refusal(mp4({ chunkOffset: 1_000_000 }))).toBe('frame 1 lies outside the file');
    expect(refusal(mp4({ frames: [[1], [], [2]] }))).toBe('frame 2 lies outside the file');
    expect(refusal(mp4({ count: 5 }))).toContain('runs past its box');
    expect(refusal(mp4({ compactSizes: true }))).toBe('the MP4 lists its frame sizes in a compact table');
    expect(refusal(mp4({ frames: [] }))).toBe('the video holds no frame');
  });

  it('refuses two frames shown at one time, more than one video track, and a codec or configuration it does not read', () => {
    expect(refusal(mp4({ delta: 0 }))).toBe('two frames of the video are shown at one time');
    expect(refusal(mp4({ videoTracks: 2 }))).toBe('the MP4 holds 2 video tracks, and the check reads exactly one');
    expect(refusal(mp4({ codec: 'hvc1' }))).toBe('the check does not read the hvc1 codec');
    expect(refusal(mp4({ config: [1, 0x42] }))).toContain('avcC');
  });

  it('refuses more frames than a video wallpaper may hold, before it lists them', () => {
    expect(MAX_VIDEO_FRAMES).toBe(14_400);
    expect(refusal(mp4({ count: 14_401 }))).toBe('the video holds more than 14400 frames');
  });
});

describe('a WebM built by hand', () => {
  it('reads each block of the video track with its time, and the key frames', () => {
    const bytes = webm();
    const video = readVideoSamples(bytes);
    expect(frameBytes(bytes, video)).toEqual([VP9_KEY, [0x86, 0], [0x86, 0]]);
    expect(video.samples.map((sample) => [sample.timestamp, sample.key])).toEqual([[0, true], [33_000, true], [67_000, false]]);
    // the last frame lasts as long as the one before it
    expect(video).toMatchObject({ codec: 'vp09.00.10.08', width: 64, height: 48, durationMs: 101 });
  });

  it('reads a VP9 key frame\'s profile and bit depth', () => {
    // profile 2 (the high bit), then the sync code, then ten_or_twelve_bit set
    expect(readVideoSamples(webm({ blocks: simpleBlock(0, [0x90, 0x49, 0x83, 0x42, 0x80, 0]) })).codec).toBe('vp09.02.10.12');
    expect(refusal(webm({ blocks: simpleBlock(0, [0x86, 0, 0, 0, 0, 0]) }))).toBe('the first VP9 frame is not a key frame that holds up');
  });

  it('feeds a VP8 frame the codec never shows and lists no time for it', () => {
    // a VP8 frame tag shows its frame in bit 4
    const video = readVideoSamples(webm({ codec: 'V_VP8', blocks: [...simpleBlock(0, [0x10, 0, 0]), ...simpleBlock(33, [0x01, 0, 0]), ...simpleBlock(34, [0x11, 0, 0])] }));
    expect(video.samples.map((sample) => sample.shown)).toEqual([true, false, true]);
    expect(video.shown).toEqual([0, 34_000]);
  });

  it('refuses what it cannot place exactly: a cluster of unknown size, laced frames, a transformed track', () => {
    expect(refusal(webm({ unknownClusterSize: true }))).toBe('a WebM cluster does not state its size');
    expect(refusal(webm({ blocks: simpleBlock(0, VP9_KEY, 0x82) }))).toBe('a WebM block holds several frames laced together');
    expect(refusal(webm({ trackExtra: element([0x6d, 0x80], []) }))).toBe('the WebM video track is compressed or encrypted');
    expect(refusal(webm({ codec: 'V_AV1' }))).toBe('the WebM video track has no AV1 configuration');
    expect(refusal(webm({ codec: 'V_MPEG4/ISO/AVC' }))).toBe('the check does not read the V_MPEG4/ISO/AVC codec');
    expect(refusal(webm({ blocks: [] }))).toBe('the video holds no frame');
  });
});

describe('any bytes', () => {
  it('give the frames or a VideoSamplesError, and nothing else is thrown', () => {
    expect(refusal(new Uint8Array(0))).toBe('the file is not an MP4 or WebM video');
    for (const name of ['strobe-30fps.mp4', 'fragmented.mp4', 'loop.webm']) {
      const bytes = fixture(name);
      for (let cut = 0; cut < bytes.length; cut += 7) refusal(bytes.subarray(0, cut));
      // one byte changed at a time, through the header and the tables
      let seed = 7;
      for (let n = 0; n < 600; n++) {
        seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
        const copy = bytes.slice();
        copy[seed % copy.length] = (seed >> 8) & 0xff;
        refusal(copy);
      }
    }
  });
});
