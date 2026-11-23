// Every frame a video wallpaper's container declares, for the theme renderer's flash check (docs/themes.md "Wallpapers"):
// MP4's sample tables and movie fragments, WebM's clusters. The check hands each frame to a decoder itself, with no playback,
// so it must know all of them: anything this reader cannot place exactly is refused, never skipped. Pure.
import {
  ascii, boxes, child, children, CLUSTER, CODEC_ID, elements, INFO, reader, SEGMENT, TIMECODE_SCALE, TRACK_ENTRY, TRACK_TYPE, TRACKS, uint, VIDEO_TRACK, vint,
  sniffVideo, VideoHeaderError, type Box, type Element,
} from './video-header';
import { MAX_VIDEO_MS } from './limits';

// The most frames a video wallpaper holds: its longest length at 240 frames a second.
export const MAX_VIDEO_FRAMES: number = (MAX_VIDEO_MS / 1000) * 240;

/** A video whose frames cannot all be placed; the message is the refusal's detail, in English. */
export class VideoSamplesError extends Error {}

const refuse = (message: string): VideoSamplesError => new VideoSamplesError(message);

export interface VideoSample {
  readonly offset: number;
  readonly size: number;
  // presentation time in microseconds, from the earliest frame's
  readonly timestamp: number;
  readonly key: boolean;
  // false for a frame the codec decodes and never shows (a VP8 alternate reference)
  readonly shown: boolean;
}

export interface VideoSamples {
  // as WebCodecs names it: avc1.PPCCLL, vp8, vp09.PP.LL.DD, av01.P.LLT.DD
  readonly codec: string;
  // H.264's decoder configuration record (avcC)
  readonly description?: Uint8Array;
  readonly width: number;
  readonly height: number;
  // how far the track's matrix turns the picture clockwise, in degrees
  readonly rotation: 0 | 90 | 180 | 270;
  // in decode order
  readonly samples: readonly VideoSample[];
  // the shown frames' timestamps in presentation order, each later than the one before
  readonly shown: readonly number[];
  // from the earliest frame to the end of the last
  readonly durationMs: number;
}

// A frame as its container places it, in the track's own time units.
interface Placed {
  readonly offset: number;
  readonly size: number;
  readonly time: number;
  readonly duration: number;
  readonly key: boolean;
}

const hex2 = (value: number): string => value.toString(16).padStart(2, '0');
const dec2 = (value: number): string => String(value).padStart(2, '0');

// av01.P.LLT.DD from an AV1CodecConfigurationRecord: marker and version, then profile and level, then tier and bit depth.
function av1Codec(record: Uint8Array): string {
  if (record.length < 4 || record[0] !== 0x81) throw refuse('the AV1 configuration does not hold up');
  const profile = record[1]! >> 5;
  const level = record[1]! & 0x1f;
  const flags = record[2]!;
  const depth = (flags & 0x40) === 0 ? 8 : profile === 2 && (flags & 0x20) !== 0 ? 12 : 10;
  return `av01.${profile}.${dec2(level)}${(flags & 0x80) !== 0 ? 'H' : 'M'}.${dec2(depth)}`;
}

// vp09.PP.LL.DD from a key frame's uncompressed header (VP9 bitstream specification, 6.2); WebM carries no other statement.
function vp9Codec(frame: Uint8Array): string {
  let at = 0;
  const bit = (): number => {
    const value = ((frame[at >> 3] ?? 0) >> (7 - (at & 7))) & 1;
    at++;
    return value;
  };
  const bad = (): VideoSamplesError => refuse('the first VP9 frame is not a key frame that holds up');
  if (frame.length < 6 || bit() !== 1 || bit() !== 0) throw bad();
  const low = bit();
  const profile = (bit() << 1) | low;
  if (profile === 3 && bit() !== 0) throw bad();
  // show_existing_frame, then frame_type, which is 0 for a key frame
  if (bit() !== 0 || bit() !== 0) throw bad();
  // show_frame and error_resilient_mode
  at += 2;
  if (frame[at >> 3] !== 0x49 || frame[(at >> 3) + 1] !== 0x83 || frame[(at >> 3) + 2] !== 0x42) throw bad();
  at += 24;
  const depth = profile >= 2 ? (bit() === 1 ? 12 : 10) : 8;
  return `vp09.${dec2(profile)}.10.${dec2(depth)}`;
}

// A VP8 frame's tag shows it or not in bit 4 of its first byte (RFC 6386, 9.1).
const vp8Shown = (bytes: Uint8Array, offset: number): boolean => (bytes[offset]! & 0x10) !== 0;

/** The frames in decode order with their presentation times in microseconds, checked: inside the file, not empty, no time twice. */
function finish(bytes: Uint8Array, placed: readonly Placed[], unitsPerSecond: number, track: Pick<VideoSamples, 'codec' | 'description' | 'width' | 'height' | 'rotation'>): VideoSamples {
  if (placed.length === 0) throw refuse('the video holds no frame');
  const first = placed.reduce((least, frame) => Math.min(least, frame.time), Number.POSITIVE_INFINITY);
  const micros = (units: number): number => Math.round((units * 1_000_000) / unitsPerSecond);
  const vp8 = track.codec === 'vp8';
  const samples = placed.map((frame, index): VideoSample => {
    if (frame.size < 1 || frame.offset < 0 || frame.offset + frame.size > bytes.length) throw refuse(`frame ${index + 1} lies outside the file`);
    return { offset: frame.offset, size: frame.size, timestamp: micros(frame.time - first), key: frame.key, shown: !vp8 || vp8Shown(bytes, frame.offset) };
  });
  const shown = samples.filter((sample) => sample.shown).map((sample) => sample.timestamp).sort((a, b) => a - b);
  if (shown.length === 0) throw refuse('the video shows no frame');
  if (shown.some((time, index) => index > 0 && time <= shown[index - 1]!)) throw refuse('two frames of the video are shown at one time');
  const end = placed.reduce((latest, frame) => Math.max(latest, frame.time + frame.duration), 0);
  return { ...track, samples, shown, durationMs: micros(end - first) / 1000 };
}

// MP4

// A full box's entries after its version, flags and count: `width` bytes each, all inside the box.
function table(bytes: Uint8Array, box: Box | undefined, width: number, name: string): { readonly count: number; at(index: number): number } {
  if (!box) return { count: 0, at: () => 0 };
  const read = reader(bytes, 'MP4');
  const count = read.u32(box.start + 4);
  if (box.start + 8 + count * width > box.end) throw refuse(`the MP4's ${name} table runs past its box`);
  return { count, at: (index) => box.start + 8 + index * width };
}

const signed = (value: number): number => value | 0;

// The frames the track's sample table lists (ISO/IEC 14496-12, 8.6 and 8.7): sizes, chunks, times and sync samples.
function tableFrames(bytes: Uint8Array, stbl: Box): Placed[] {
  const read = reader(bytes, 'MP4');
  const stsz = child(bytes, stbl, 'stsz');
  if (!stsz) {
    if (child(bytes, stbl, 'stz2')) throw refuse('the MP4 lists its frame sizes in a compact table');
    return [];
  }
  const fixedSize = read.u32(stsz.start + 4);
  const count = read.u32(stsz.start + 8);
  if (count > MAX_VIDEO_FRAMES) throw refuse(`the video holds more than ${MAX_VIDEO_FRAMES} frames`);
  if (fixedSize === 0 && stsz.start + 12 + count * 4 > stsz.end) throw refuse('the MP4\'s frame size table runs past its box');
  const sizeOf = (index: number): number => (fixedSize !== 0 ? fixedSize : read.u32(stsz.start + 12 + index * 4));
  const stco = child(bytes, stbl, 'stco');
  const co64 = child(bytes, stbl, 'co64');
  const chunks = table(bytes, stco ?? co64, stco ? 4 : 8, 'chunk offset');
  const chunkOffset = (index: number): number => (stco ? read.u32(chunks.at(index)) : Number(read.u64(chunks.at(index))));
  const stsc = table(bytes, child(bytes, stbl, 'stsc'), 12, 'sample to chunk');
  const offsets: number[] = [];
  for (let run = 0; run < stsc.count && offsets.length < count; run++) {
    const firstChunk = read.u32(stsc.at(run));
    const perChunk = read.u32(stsc.at(run) + 4);
    const nextChunk = run + 1 < stsc.count ? read.u32(stsc.at(run + 1)) : chunks.count + 1;
    if (firstChunk < 1 || nextChunk <= firstChunk || nextChunk > chunks.count + 1 || perChunk < 1) throw refuse('the MP4\'s sample to chunk table does not hold up');
    for (let chunk = firstChunk; chunk < nextChunk && offsets.length < count; chunk++) {
      let at = chunkOffset(chunk - 1);
      for (let i = 0; i < perChunk && offsets.length < count; i++) {
        offsets.push(at);
        at += sizeOf(offsets.length - 1);
      }
    }
  }
  if (offsets.length !== count) throw refuse('the MP4\'s chunks hold fewer frames than it lists');
  const times: number[] = [];
  const durations: number[] = [];
  const stts = table(bytes, child(bytes, stbl, 'stts'), 8, 'time to sample');
  let time = 0;
  for (let run = 0; run < stts.count && times.length < count; run++) {
    const delta = read.u32(stts.at(run) + 4);
    for (let left = read.u32(stts.at(run)); left > 0 && times.length < count; left--) {
      times.push(time);
      durations.push(delta);
      time += delta;
    }
  }
  if (times.length !== count) throw refuse('the MP4 gives a time to fewer frames than it lists');
  const ctts = table(bytes, child(bytes, stbl, 'ctts'), 8, 'composition offset');
  let shifted = 0;
  for (let run = 0; run < ctts.count && shifted < count; run++) {
    const offset = signed(read.u32(ctts.at(run) + 4));
    for (let left = read.u32(ctts.at(run)); left > 0 && shifted < count; left--) times[shifted++]! += offset;
  }
  const stssBox = child(bytes, stbl, 'stss');
  const stss = table(bytes, stssBox, 4, 'sync sample');
  const keys = new Set<number>();
  for (let i = 0; i < stss.count; i++) keys.add(read.u32(stss.at(i)));
  return offsets.map((offset, index) => ({ offset, size: sizeOf(index), time: times[index]!, duration: durations[index]!, key: !stssBox || keys.has(index + 1) }));
}

// The frames the track's movie fragments list (ISO/IEC 14496-12, 8.8): each moof's traf of `trackId`, its truns in order.
function fragmentFrames(bytes: Uint8Array, top: readonly Box[], moov: Box, trackId: number, from: number): Placed[] {
  const read = reader(bytes, 'MP4');
  let defaults = { duration: 0, size: 0, flags: 0 };
  const mvex = child(bytes, moov, 'mvex');
  for (const trex of mvex ? children(bytes, mvex, 'trex') : []) {
    if (read.u32(trex.start + 4) === trackId) defaults = { duration: read.u32(trex.start + 12), size: read.u32(trex.start + 16), flags: read.u32(trex.start + 20) };
  }
  const out: Placed[] = [];
  let time = from;
  for (const moof of top) {
    if (moof.type !== 'moof') continue;
    // the box's own first byte, 8 before its body: a moof of 2^32 bytes or more is no wallpaper's
    const moofStart = moof.start - 8;
    const trafs = children(bytes, moof, 'traf');
    for (const [index, traf] of trafs.entries()) {
      const tfhd = child(bytes, traf, 'tfhd');
      if (!tfhd) throw refuse('an MP4 fragment has no header');
      if (read.u32(tfhd.start + 4) !== trackId) continue;
      const flags = read.u32(tfhd.start) & 0xffffff;
      let at = tfhd.start + 8;
      const field = (mask: number, width: 4 | 8): number | undefined => {
        if ((flags & mask) === 0) return undefined;
        const value = width === 8 ? Number(read.u64(at)) : read.u32(at);
        at += width;
        return value;
      };
      const explicitBase = field(0x1, 8);
      field(0x2, 4);
      const duration = field(0x8, 4) ?? defaults.duration;
      const size = field(0x10, 4) ?? defaults.size;
      const sampleFlags = field(0x20, 4) ?? defaults.flags;
      // with neither an explicit base nor default-base-is-moof, only the first traf's data starts at its moof
      if (explicitBase === undefined && (flags & 0x20000) === 0 && index > 0) throw refuse('an MP4 fragment places its frames after another track\'s');
      const base = explicitBase ?? moofStart;
      const tfdt = child(bytes, traf, 'tfdt');
      if (tfdt) time = bytes[tfdt.start] === 1 ? Number(read.u64(tfdt.start + 4)) : read.u32(tfdt.start + 4);
      let next = base;
      for (const trun of children(bytes, traf, 'trun')) {
        const runFlags = read.u32(trun.start) & 0xffffff;
        const count = read.u32(trun.start + 4);
        let cursor = trun.start + 8;
        if ((runFlags & 0x1) !== 0) {
          next = base + signed(read.u32(cursor));
          cursor += 4;
        }
        let firstFlags: number | undefined;
        if ((runFlags & 0x4) !== 0) {
          firstFlags = read.u32(cursor);
          cursor += 4;
        }
        const perSample = [0x100, 0x200, 0x400, 0x800].filter((mask) => (runFlags & mask) !== 0).length * 4;
        if (cursor + count * perSample > trun.end) throw refuse('an MP4 fragment\'s frame table runs past its box');
        if (out.length + count > MAX_VIDEO_FRAMES) throw refuse(`the video holds more than ${MAX_VIDEO_FRAMES} frames`);
        for (let i = 0; i < count; i++) {
          const take = (mask: number): number | undefined => {
            if ((runFlags & mask) === 0) return undefined;
            const value = read.u32(cursor);
            cursor += 4;
            return value;
          };
          const sampleDuration = take(0x100) ?? duration;
          const sampleSize = take(0x200) ?? size;
          const own = take(0x400) ?? (i === 0 && firstFlags !== undefined ? firstFlags : sampleFlags);
          const offset = signed(take(0x800) ?? 0);
          // sample_is_non_sync_sample
          out.push({ offset: next, size: sampleSize, time: time + offset, duration: sampleDuration, key: (own & 0x10000) === 0 });
          next += sampleSize;
          time += sampleDuration;
        }
      }
    }
  }
  return out;
}

// The quarter turn of a track header's matrix (ISO/IEC 14496-12, 8.3.2); a matrix that is no quarter turn turns nothing.
function rotationOf(bytes: Uint8Array, tkhd: Box): 0 | 90 | 180 | 270 {
  const read = reader(bytes, 'MP4');
  const at = tkhd.start + (bytes[tkhd.start] === 1 ? 52 : 40);
  const [a, b, c, d] = [signed(read.u32(at)), signed(read.u32(at + 4)), signed(read.u32(at + 12)), signed(read.u32(at + 16))];
  const one = 0x10000;
  if (a === 0 && b === one && c === -one && d === 0) return 90;
  if (a === -one && b === 0 && c === 0 && d === -one) return 180;
  if (a === 0 && b === -one && c === one && d === 0) return 270;
  return 0;
}

function mp4(bytes: Uint8Array): VideoSamples {
  const read = reader(bytes, 'MP4');
  const top = boxes(bytes, 0, bytes.length);
  const moov = top.find((box) => box.type === 'moov');
  if (!moov) throw refuse('the MP4 has no movie header');
  const tracks = children(bytes, moov, 'trak').filter((trak) => {
    const hdlr = child(bytes, child(bytes, trak, 'mdia'), 'hdlr');
    return hdlr !== undefined && hdlr.start + 12 <= hdlr.end && ascii(bytes, hdlr.start + 8, hdlr.start + 12) === 'vide';
  });
  if (tracks.length !== 1) throw refuse(`the MP4 holds ${tracks.length} video tracks, and the check reads exactly one`);
  const trak = tracks[0]!;
  const tkhd = child(bytes, trak, 'tkhd');
  const mdia = child(bytes, trak, 'mdia');
  const mdhd = child(bytes, mdia, 'mdhd');
  const stbl = child(bytes, child(bytes, mdia, 'minf'), 'stbl');
  const stsd = child(bytes, stbl, 'stsd');
  if (!tkhd || !mdhd || !stbl || !stsd) throw refuse('the MP4 video track has no header that holds up');
  const wide = bytes[tkhd.start] === 1;
  const trackId = read.u32(tkhd.start + (wide ? 20 : 12));
  const timescale = read.u32(mdhd.start + (bytes[mdhd.start] === 1 ? 20 : 12));
  if (timescale === 0) throw refuse('the MP4 video track states no time scale');
  const entries = boxes(bytes, stsd.start + 8, stsd.end);
  if (entries.length !== 1) throw refuse(`the MP4 video track has ${entries.length} sample descriptions, and the check reads exactly one`);
  const entry = entries[0]!;
  // a visual sample entry is 78 bytes; its codec's configuration boxes follow
  const config = (type: string): Uint8Array => {
    const box = entry.start + 78 <= entry.end ? boxes(bytes, entry.start + 78, entry.end).find((candidate) => candidate.type === type) : undefined;
    if (!box) throw refuse(`the MP4 video track has no ${type} box`);
    return bytes.subarray(box.start, box.end);
  };
  let codec: string;
  let description: Uint8Array | undefined;
  if (entry.type === 'avc1' || entry.type === 'avc3') {
    description = config('avcC');
    if (description.length < 4) throw refuse('the MP4 video track\'s avcC box does not hold up');
    codec = `${entry.type}.${hex2(description[1]!)}${hex2(description[2]!)}${hex2(description[3]!)}`;
  } else if (entry.type === 'av01') codec = av1Codec(config('av1C'));
  else if (entry.type === 'vp09') {
    // a full box: version and flags, then profile, level and the bit depth in the next byte's high half
    const vpcc = config('vpcC');
    if (vpcc.length < 7) throw refuse('the MP4 video track\'s vpcC box does not hold up');
    codec = `vp09.${dec2(vpcc[4]!)}.${dec2(vpcc[5]!)}.${dec2(vpcc[6]! >> 4)}`;
  } else if (entry.type === 'vp08') codec = 'vp8';
  else throw refuse(`the check does not read the ${entry.type} codec`);
  const listed = tableFrames(bytes, stbl);
  const after = listed.reduce((latest, frame) => Math.max(latest, frame.time + frame.duration), 0);
  const placed = [...listed, ...fragmentFrames(bytes, top, moov, trackId, after)];
  return finish(bytes, placed, timescale, { codec, ...(description ? { description } : {}), width: read.u16(entry.start + 24), height: read.u16(entry.start + 26), rotation: rotationOf(bytes, tkhd) });
}

// WebM

const TRACK_NUMBER = 0xd7;
const CODEC_PRIVATE = 0x63a2;
const DEFAULT_DURATION = 0x23e383;
const CONTENT_ENCODINGS = 0x6d80;
const VIDEO = 0xe0;
const PIXEL_WIDTH = 0xb0;
const PIXEL_HEIGHT = 0xba;
const TIMECODE = 0xe7;
const SIMPLE_BLOCK = 0xa3;
const BLOCK_GROUP = 0xa0;
const BLOCK = 0xa1;
const BLOCK_DURATION = 0x9b;
const REFERENCE_BLOCK = 0xfb;
const NANOS_PER_SECOND = 1_000_000_000;

function webm(bytes: Uint8Array): VideoSamples {
  const read = reader(bytes, 'WebM');
  const segment = elements(bytes, 0, bytes.length).find((element) => element.id === SEGMENT);
  const level1 = segment ? elements(bytes, segment.start, segment.end, true) : [];
  const info = level1.find((element) => element.id === INFO);
  const tracks = level1.find((element) => element.id === TRACKS);
  if (!info || !tracks) throw refuse('the WebM lists no segment info or tracks');
  const scaleElement = elements(bytes, info.start, info.end).find((element) => element.id === TIMECODE_SCALE);
  // nanoseconds a timestamp unit
  const scale = scaleElement ? uint(bytes, scaleElement) : 1_000_000;
  if (scale === 0) throw refuse('the WebM states no time scale');
  const entries = elements(bytes, tracks.start, tracks.end).filter((element) => element.id === TRACK_ENTRY).map((entry) => elements(bytes, entry.start, entry.end)).filter((items) => {
    const type = items.find((element) => element.id === TRACK_TYPE);
    return type !== undefined && uint(bytes, type) === VIDEO_TRACK;
  });
  if (entries.length !== 1) throw refuse(`the WebM holds ${entries.length} video tracks, and the check reads exactly one`);
  const items = entries[0]!;
  const item = (id: number): Element | undefined => items.find((element) => element.id === id);
  const number = item(TRACK_NUMBER);
  const codecId = item(CODEC_ID);
  if (!number || !codecId) throw refuse('the WebM video track has no number or codec');
  if (item(CONTENT_ENCODINGS)) throw refuse('the WebM video track is compressed or encrypted');
  const trackNumber = uint(bytes, number);
  const sizes = item(VIDEO) ? elements(bytes, item(VIDEO)!.start, item(VIDEO)!.end) : [];
  const side = (id: number): number => {
    const element = sizes.find((candidate) => candidate.id === id);
    return element ? uint(bytes, element) : 0;
  };
  const defaultDuration = item(DEFAULT_DURATION);
  const placed: Placed[] = [];
  for (const cluster of level1) {
    if (cluster.id !== CLUSTER) continue;
    if (cluster.unknownSize) throw refuse('a WebM cluster does not state its size');
    let base = 0;
    const block = (element: Element, key: boolean, duration: number | undefined): void => {
      const track = vint(bytes, element.start, false);
      if (track.value !== trackNumber) return;
      const head = element.start + track.length;
      if (head + 3 > element.end) throw refuse('a WebM block is cut short');
      if ((bytes[head + 2]! & 0x06) !== 0) throw refuse('a WebM block holds several frames laced together');
      if (placed.length >= MAX_VIDEO_FRAMES) throw refuse(`the video holds more than ${MAX_VIDEO_FRAMES} frames`);
      // a signed 16-bit offset from the cluster's timestamp
      const time = base + ((read.u16(head) << 16) >> 16);
      placed.push({ offset: head + 3, size: element.end - head - 3, time, duration: duration ?? 0, key });
    };
    for (const element of elements(bytes, cluster.start, cluster.end)) {
      if (element.id === TIMECODE) base = uint(bytes, element);
      else if (element.id === SIMPLE_BLOCK) block(element, (bytes[element.start + vint(bytes, element.start, false).length + 2]! & 0x80) !== 0, undefined);
      else if (element.id === BLOCK_GROUP) {
        const group = elements(bytes, element.start, element.end);
        const held = group.find((candidate) => candidate.id === BLOCK);
        const duration = group.find((candidate) => candidate.id === BLOCK_DURATION);
        if (held) block(held, !group.some((candidate) => candidate.id === REFERENCE_BLOCK), duration ? uint(bytes, duration) : undefined);
      }
    }
  }
  if (placed.length === 0) throw refuse('the video holds no frame');
  // the last frame lasts what its block says, else the track's frame time, else as long as the frame before it
  const times = placed.map((frame) => frame.time).sort((a, b) => a - b);
  const tail = defaultDuration ? uint(bytes, defaultDuration) / scale : times.length > 1 ? times[times.length - 1]! - times[times.length - 2]! : 0;
  const last = placed.reduce((latest, frame) => (frame.time > latest.time ? frame : latest));
  const timed = placed.map((frame) => (frame === last && frame.duration === 0 ? { ...frame, duration: tail } : frame));
  const name = ascii(bytes, codecId.start, codecId.end).replace(/\0+$/, '');
  let codec: string;
  if (name === 'V_VP8') codec = 'vp8';
  else if (name === 'V_VP9') {
    const first = placed[0]!;
    if (first.size < 1 || first.offset + first.size > bytes.length) throw refuse('frame 1 lies outside the file');
    codec = vp9Codec(bytes.subarray(first.offset, first.offset + first.size));
  } else if (name === 'V_AV1') {
    const record = item(CODEC_PRIVATE);
    if (!record) throw refuse('the WebM video track has no AV1 configuration');
    codec = av1Codec(bytes.subarray(record.start, record.end));
  } else throw refuse(`the check does not read the ${name} codec`);
  return finish(bytes, timed, NANOS_PER_SECOND / scale, { codec, width: side(PIXEL_WIDTH), height: side(PIXEL_HEIGHT), rotation: 0 });
}

/**
 * Every frame of an MP4 or WebM file's one video track. Total: any bytes give the frames or a VideoSamplesError, and nothing
 * else is thrown.
 */
export function readVideoSamples(bytes: Uint8Array): VideoSamples {
  try {
    switch (sniffVideo(bytes)) {
      case 'mp4': return mp4(bytes);
      case 'webm': return webm(bytes);
      default: throw refuse('the file is not an MP4 or WebM video');
    }
  } catch (err) {
    if (err instanceof VideoSamplesError) throw err;
    throw refuse(err instanceof VideoHeaderError ? err.message : 'the video\'s frame tables do not hold up');
  }
}
