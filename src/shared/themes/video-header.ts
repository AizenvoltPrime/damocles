// A video wallpaper's container, codec, size and duration, read from its header alone (docs/themes.md "Wallpapers"):
// MP4's box tree, with moov at the start or the end, and WebM's EBML elements. Nothing here decodes a frame, so a file whose
// header declares more than the caps is refused before any decoder sees it. The caps bound what a file declares; the theme
// renderer's sandboxed decode checks the decoded duration again. Pure: main reads it too, to check a blob before it serves one.
import { englishText, l, type LocalizedText } from '../localized-text';
import { namesAvifBrand } from './image-header';

export type VideoContainer = 'mp4' | 'webm';

export interface VideoHeader {
  readonly container: VideoContainer;
  // each video track's codec as the file names it: MP4's sample entry type (avc1, av01, vp09...) or WebM's codec ID (V_VP9...)
  readonly codecs: readonly string[];
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
}

/** A header this module refuses: `unknown` is no MP4 or WebM; `malformed` one whose header does not hold up. */
export class VideoHeaderError extends Error {
  readonly reason: 'unknown' | 'malformed';
  readonly text: LocalizedText;
  constructor(reason: 'unknown' | 'malformed', text: LocalizedText) {
    super(englishText(text));
    this.reason = reason;
    this.text = text;
  }
}

const malformed = (text: LocalizedText): VideoHeaderError => new VideoHeaderError('malformed', text);
const cutShort = (container: string): VideoHeaderError => malformed(l('The {0} file ends before its header does.', container));
const noDuration = (container: string): VideoHeaderError => malformed(l('The {0} does not state its duration.', container));
// The longest name read from a file: a box type, a document type or a codec ID.
const MAX_NAME_BYTES = 32;
const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];

// At most MAX_NAME_BYTES bytes of the range, one character per byte.
export function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = '';
  for (let at = Math.max(0, start); at < Math.min(end, bytes.length, start + MAX_NAME_BYTES); at++) out += String.fromCharCode(bytes[at]!);
  return out;
}

/** Bounds-checked reads of `bytes`; a read past the end refuses the file as a cut-short `container`. */
export function reader(bytes: Uint8Array, container: string): { u16(at: number): number; u32(at: number): number; u64(at: number): bigint; f32(at: number): number; f64(at: number): number } {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const within = (at: number, size: number): number => {
    if (!Number.isInteger(at) || at < 0 || at + size > bytes.length) throw cutShort(container);
    return at;
  };
  return {
    u16: (at) => data.getUint16(within(at, 2)),
    u32: (at) => data.getUint32(within(at, 4)),
    u64: (at) => data.getBigUint64(within(at, 8)),
    f32: (at) => data.getFloat32(within(at, 4)),
    f64: (at) => data.getFloat64(within(at, 8)),
  };
}

/** The container `bytes` start like: an ISO BMFF ftyp that names no AVIF brand, or an EBML header. */
export function sniffVideo(bytes: Uint8Array): VideoContainer | undefined {
  if (bytes.length >= 4 && EBML_MAGIC.every((byte, at) => bytes[at] === byte)) return 'webm';
  return namesAvifBrand(bytes) === false ? 'mp4' : undefined;
}

// MP4

export interface Box { readonly type: string; readonly start: number; readonly end: number }
// The boxes of one box, or the elements of one element, a walk reads: more is no video header.
export const MAX_BOXES = 100_000;

export function boxes(bytes: Uint8Array, start: number, end: number): Box[] {
  const read = reader(bytes, 'MP4');
  const outside = (): VideoHeaderError => malformed(l('An MP4 box runs past the end of its parent.'));
  const out: Box[] = [];
  for (let at = start; at + 8 <= end;) {
    let size = read.u32(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) throw cutShort('MP4');
      const large = read.u64(at + 8);
      if (large > BigInt(end - at)) throw outside();
      size = Number(large);
      header = 16;
    } else if (size === 0) size = end - at;
    if (size < header || at + size > end) throw outside();
    out.push({ type: ascii(bytes, at + 4, at + 8), start: at + header, end: at + size });
    at += size;
    if (out.length > MAX_BOXES) throw malformed(l('The MP4 holds more than {0} boxes in one place.', String(MAX_BOXES)));
  }
  return out;
}

export const child = (bytes: Uint8Array, parent: Box | undefined, type: string, skip = 0): Box | undefined =>
  parent === undefined ? undefined : boxes(bytes, parent.start + skip, parent.end).find((box) => box.type === type);
export const children = (bytes: Uint8Array, parent: Box, type: string): Box[] => boxes(bytes, parent.start, parent.end).filter((box) => box.type === type);

// A full box's duration field at `at`, 32 bits wide at version 0 and 64 at version 1; undefined when it is all ones, which
// states that the duration is not known (ISO/IEC 14496-12, 8.2.2).
function durationAt(bytes: Uint8Array, box: Box, at: number): number | undefined {
  const read = reader(bytes, 'MP4');
  const wide = bytes[box.start] === 1;
  if (at + (wide ? 8 : 4) > box.end) throw cutShort('MP4');
  if (!wide) {
    const value = read.u32(at);
    return value === 0xffffffff ? undefined : value;
  }
  const value = read.u64(at);
  if (value === 0xffffffffffffffffn) return undefined;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw noDuration('MP4');
  return Number(value);
}

function mp4(bytes: Uint8Array): VideoHeader {
  const read = reader(bytes, 'MP4');
  const top = boxes(bytes, 0, bytes.length);
  if (top[0]?.type !== 'ftyp') throw malformed(l('The MP4 does not start with its ftyp box.'));
  // moov may come before the media data or after it
  const moov = top.find((box) => box.type === 'moov');
  const mvhd = child(bytes, moov, 'mvhd');
  if (!moov || !mvhd) throw malformed(l('The MP4 has no movie header.'));
  // mvhd: version and flags, then creation and modification times (8 bytes each at version 1), then timescale and duration
  const timescaleAt = mvhd.start + (bytes[mvhd.start] === 1 ? 20 : 12);
  if (timescaleAt + 4 > mvhd.end) throw cutShort('MP4');
  const timescale = read.u32(timescaleAt);
  let duration = durationAt(bytes, mvhd, timescaleAt + 4);
  if (duration === undefined || duration === 0) {
    // a fragmented MP4 states its duration in mvex/mehd: version and flags, then the duration
    const mehd = child(bytes, child(bytes, moov, 'mvex'), 'mehd');
    if (mehd) duration = durationAt(bytes, mehd, mehd.start + 4);
  }
  if (timescale === 0 || duration === undefined || duration === 0) throw noDuration('MP4');
  const codecs: string[] = [];
  let width = 0;
  let height = 0;
  for (const trak of children(bytes, moov, 'trak')) {
    const mdia = child(bytes, trak, 'mdia');
    const hdlr = child(bytes, mdia, 'hdlr');
    // hdlr: version and flags, pre_defined, then the handler type
    if (!hdlr || hdlr.start + 12 > hdlr.end || ascii(bytes, hdlr.start + 8, hdlr.start + 12) !== 'vide') continue;
    // stsd is a full box: version and flags, then its entry count
    const stsd = child(bytes, child(bytes, child(bytes, mdia, 'minf'), 'stbl'), 'stsd');
    if (!stsd) throw malformed(l('The MP4 video track has no valid sample description.'));
    for (const entry of boxes(bytes, stsd.start + 8, stsd.end)) {
      codecs.push(entry.type);
      // a visual sample entry: 8 bytes of SampleEntry, 16 reserved, then width and height
      if (entry.start + 28 > entry.end) throw malformed(l('The MP4 video track has no valid sample description.'));
      width = Math.max(width, read.u16(entry.start + 24));
      height = Math.max(height, read.u16(entry.start + 26));
    }
  }
  if (codecs.length === 0) throw malformed(l('The {0} has no video track.', 'MP4'));
  if (width === 0 || height === 0) throw malformed(l('The {0} video gives a size of {1} by {2} pixels.', 'MP4', String(width), String(height)));
  return { container: 'mp4', codecs, width, height, durationMs: Math.round((duration / timescale) * 1000) };
}

// WebM

export const SEGMENT = 0x18538067;
export const INFO = 0x1549a966;
export const TRACKS = 0x1654ae6b;
export const CLUSTER = 0x1f43b675;
export const TIMECODE_SCALE = 0x2ad7b1;
const DURATION = 0x4489;
export const TRACK_ENTRY = 0xae;
export const TRACK_TYPE = 0x83;
export const CODEC_ID = 0x86;
const VIDEO = 0xe0;
const PIXEL_WIDTH = 0xb0;
const PIXEL_HEIGHT = 0xba;
const DOC_TYPE = 0x4282;
export const VIDEO_TRACK = 1;

export interface Element { readonly id: number; readonly start: number; readonly end: number; readonly unknownSize: boolean }

const badElement = (): VideoHeaderError => malformed(l('The WebM has an element header that is not valid.'));

// A variable-length integer: the leading zeros of its first byte give its length; `marker` keeps the length bit (an ID) or not.
export function vint(bytes: Uint8Array, at: number, marker: boolean): { value: number; length: number; allOnes: boolean } {
  const first = bytes[at];
  if (first === undefined) throw cutShort('WebM');
  if (first === 0) throw badElement();
  const length = Math.clz32(first) - 23;
  if (at + length > bytes.length) throw cutShort('WebM');
  let value = marker ? first : first & (0xff >> length);
  let allOnes = value === (0xff >> length);
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[at + i]!;
    if (bytes[at + i] !== 0xff) allOnes = false;
  }
  return { value, length, allOnes };
}

// `clusters` walks on past each cluster, for a reader of the frames; a header read stops at the first.
export function elements(bytes: Uint8Array, start: number, end: number, clusters = false): Element[] {
  const out: Element[] = [];
  for (let at = start; at < end;) {
    const id = vint(bytes, at, true);
    const size = vint(bytes, at + id.length, false);
    const body = at + id.length + size.length;
    const elementEnd = size.allOnes ? end : body + size.value;
    if (elementEnd > end) throw malformed(l('A WebM element runs past the end of its parent.'));
    out.push({ id: id.value, start: body, end: elementEnd, unknownSize: size.allOnes });
    // past a cluster are only frames, and a cluster of unknown size runs to the end
    if (id.value === CLUSTER && (!clusters || size.allOnes)) break;
    at = elementEnd;
    if (out.length > MAX_BOXES) throw malformed(l('The WebM holds more than {0} elements in one place.', String(MAX_BOXES)));
  }
  return out;
}

// An EBML unsigned integer is at most 8 bytes long.
export const uint = (bytes: Uint8Array, element: Element): number => {
  if (element.end - element.start > 8) throw badElement();
  let value = 0;
  for (let at = element.start; at < element.end; at++) value = value * 256 + bytes[at]!;
  return value;
};

function float(bytes: Uint8Array, element: Element): number {
  const read = reader(bytes, 'WebM');
  const length = element.end - element.start;
  if (length === 4) return read.f32(element.start);
  if (length === 8) return read.f64(element.start);
  throw noDuration('WebM');
}

function webm(bytes: Uint8Array): VideoHeader {
  const top = elements(bytes, 0, bytes.length);
  const header = top[0];
  if (!header || header.id !== 0x1a45dfa3) throw malformed(l('The WebM does not start with its EBML header.'));
  const docType = elements(bytes, header.start, header.end).find((element) => element.id === DOC_TYPE);
  const doc = docType ? ascii(bytes, docType.start, docType.end).replace(/\0+$/, '') : '';
  if (doc !== 'webm') throw new VideoHeaderError('unknown', l('The file is a Matroska file of another kind, not WebM.'));
  const segment = top.find((element) => element.id === SEGMENT);
  const level1 = segment ? elements(bytes, segment.start, segment.end) : [];
  const info = level1.find((element) => element.id === INFO);
  const tracks = level1.find((element) => element.id === TRACKS);
  if (!info || !tracks) throw malformed(l('The WebM lists no segment info or tracks before its first cluster.'));
  const infoItems = elements(bytes, info.start, info.end);
  const scale = infoItems.find((element) => element.id === TIMECODE_SCALE);
  const durationElement = infoItems.find((element) => element.id === DURATION);
  if (!durationElement) throw noDuration('WebM');
  // the duration is in timecode-scale units, nanoseconds each by default
  const durationMs = (float(bytes, durationElement) * (scale ? uint(bytes, scale) : 1_000_000)) / 1_000_000;
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw noDuration('WebM');
  const codecs: string[] = [];
  let width = 0;
  let height = 0;
  for (const entry of elements(bytes, tracks.start, tracks.end).filter((element) => element.id === TRACK_ENTRY)) {
    const items = elements(bytes, entry.start, entry.end);
    const type = items.find((element) => element.id === TRACK_TYPE);
    if (!type || uint(bytes, type) !== VIDEO_TRACK) continue;
    const codec = items.find((element) => element.id === CODEC_ID);
    codecs.push(codec ? ascii(bytes, codec.start, codec.end).replace(/\0+$/, '') : '');
    const video = items.find((element) => element.id === VIDEO);
    const sizes = video ? elements(bytes, video.start, video.end) : [];
    const w = sizes.find((element) => element.id === PIXEL_WIDTH);
    const h = sizes.find((element) => element.id === PIXEL_HEIGHT);
    width = Math.max(width, w ? uint(bytes, w) : 0);
    height = Math.max(height, h ? uint(bytes, h) : 0);
  }
  if (codecs.length === 0) throw malformed(l('The {0} has no video track.', 'WebM'));
  if (width === 0 || height === 0) throw malformed(l('The {0} video gives a size of {1} by {2} pixels.', 'WebM', String(width), String(height)));
  return { container: 'webm', codecs, width, height, durationMs: Math.round(durationMs) };
}

/**
 * The header of an MP4 or WebM file. Total: any bytes give a header or a VideoHeaderError, for anything else or a header that
 * does not hold up, and nothing else is thrown.
 */
export function readVideoHeader(bytes: Uint8Array): VideoHeader {
  try {
    switch (sniffVideo(bytes)) {
      case 'mp4': return mp4(bytes);
      case 'webm': return webm(bytes);
      default: throw new VideoHeaderError('unknown', l('The file is not an MP4 or WebM video.'));
    }
  } catch (err) {
    if (err instanceof VideoHeaderError) throw err;
    throw malformed(l('The video\'s header is not valid.'));
  }
}

// The codec IDs of each container, by the name VIDEO_CODECS gives them.
const CODEC_NAMES: Readonly<Record<string, 'avc1' | 'av01' | 'vp08' | 'vp09'>> = {
  avc1: 'avc1', avc3: 'avc1', av01: 'av01', vp08: 'vp08', vp09: 'vp09',
  V_VP8: 'vp08', V_VP9: 'vp09', V_AV1: 'av01',
};

/** A codec the file names as one of VIDEO_CODECS, or undefined for any other (HEVC, an encrypted entry...). */
export const videoCodec = (name: string): 'avc1' | 'av01' | 'vp08' | 'vp09' | undefined => CODEC_NAMES[name];
