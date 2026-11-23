// Video files built byte by byte for header tests: each holds a valid MP4 box tree or WebM element tree and as little else as
// the header needs. None decodes to frames; the theme renderer's playback is e2e's.

const u32 = (value: number): number[] => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
const u16 = (value: number): number[] => [(value >>> 8) & 0xff, value & 0xff];
const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
const box = (type: string, body: number[]): number[] => [...u32(body.length + 8), ...ascii(type), ...body];
const fullBox = (type: string, body: number[], version = 0): number[] => box(type, [version, 0, 0, 0, ...body]);

export interface Mp4Options {
  readonly codec?: string;
  readonly width?: number;
  readonly height?: number;
  readonly durationMs?: number;
  // moov after mdat, as a recorder that writes the index last leaves it
  readonly moovAtEnd?: boolean;
  // a sound track beside the video, which a muted wallpaper ignores
  readonly audio?: boolean;
  // mvhd version 1, with 64-bit times
  readonly version1?: boolean;
  // a fragmented MP4: mvhd's duration 0, the duration in mvex/mehd
  readonly fragmented?: boolean;
  // mvhd's duration 0 and an mehd box with no body, as the last box of moov
  readonly emptyMehd?: boolean;
  // mvhd's duration all ones: not known
  readonly unknownDuration?: boolean;
}

const TIMESCALE = 1000;

function track(handler: string, entry: number[]): number[] {
  return box('trak', box('mdia', [
    ...fullBox('hdlr', [0, 0, 0, 0, ...ascii(handler), ...new Array<number>(13).fill(0)]),
    ...box('minf', box('stbl', fullBox('stsd', [...u32(1), ...entry]))),
  ]));
}

/** An MP4: ftyp, moov (mvhd, a video track, and a sound track when asked) and mdat, in either order. */
export function mp4(options: Mp4Options = {}): Uint8Array {
  const { codec = 'avc1', width = 640, height = 360, durationMs = 4000 } = options;
  const duration = options.fragmented || options.emptyMehd ? 0 : durationMs;
  const ones = u32(0xffffffff);
  const mvhd = options.version1
    ? fullBox('mvhd', [...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(TIMESCALE), ...(options.unknownDuration ? [...ones, ...ones] : [...u32(0), ...u32(duration)]), ...new Array<number>(80).fill(0)], 1)
    : fullBox('mvhd', [...u32(0), ...u32(0), ...u32(TIMESCALE), ...(options.unknownDuration ? ones : u32(duration)), ...new Array<number>(80).fill(0)]);
  // a visual sample entry: 6 reserved, the data reference index, 16 reserved, then width and height
  const visual = box(codec, [...new Array<number>(6).fill(0), ...u16(1), ...new Array<number>(16).fill(0), ...u16(width), ...u16(height), ...new Array<number>(50).fill(0)]);
  const sound = box('mp4a', [...new Array<number>(6).fill(0), ...u16(1), ...new Array<number>(20).fill(0)]);
  const moov = box('moov', [
    ...mvhd,
    ...track('vide', visual),
    ...(options.audio ? track('soun', sound) : []),
    ...(options.fragmented ? box('mvex', fullBox('mehd', u32(durationMs))) : []),
    ...(options.emptyMehd ? box('mvex', box('mehd', [])) : []),
  ]);
  const ftyp = box('ftyp', [...ascii('isom'), ...u32(512), ...ascii('isom'), ...ascii('mp41')]);
  const mdat = box('mdat', new Array<number>(64).fill(0));
  return new Uint8Array(options.moovAtEnd ? [...ftyp, ...mdat, ...moov] : [...ftyp, ...moov, ...mdat]);
}

// EBML: an ID as its bytes, a size as an 8-byte vint
const size = (length: number): number[] => [0x01, 0, 0, 0, ...u32(length)];
const element = (id: number[], body: number[]): number[] => [...id, ...size(body.length), ...body];
const uintBytes = (value: number): number[] => (value < 256 ? [value] : value < 65_536 ? u16(value) : u32(value));
const float64 = (value: number): number[] => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value);
  return [...bytes];
};

export interface WebmOptions {
  readonly codec?: string;
  readonly width?: number;
  readonly height?: number;
  // undefined leaves Duration out, as a live recording does
  readonly durationMs?: number | null;
  readonly docType?: string;
  // the segment's size unknown, as a streamed recording writes it
  readonly unknownSegmentSize?: boolean;
  // the track type as an unsigned integer of 9 bytes, one more than EBML allows
  readonly longTrackType?: boolean;
}

/** A WebM: the EBML header, then a segment with Info, Tracks (one video track) and an empty cluster. */
export function webm(options: WebmOptions = {}): Uint8Array {
  const { codec = 'V_VP9', width = 640, height = 360, docType = 'webm' } = options;
  const durationMs = options.durationMs === undefined ? 4000 : options.durationMs;
  const header = element([0x1a, 0x45, 0xdf, 0xa3], [...element([0x42, 0x82], ascii(docType)), ...element([0x42, 0x87], [4])]);
  const info = element([0x15, 0x49, 0xa9, 0x66], [
    ...element([0x2a, 0xd7, 0xb1], uintBytes(1_000_000)),
    ...(durationMs === null ? [] : element([0x44, 0x89], float64(durationMs))),
  ]);
  const tracks = element([0x16, 0x54, 0xae, 0x6b], element([0xae], [
    ...element([0xd7], [1]),
    ...element([0x83], options.longTrackType ? [0, 0, 0, 0, 0, 0, 0, 0, 1] : [1]),
    ...element([0x86], ascii(codec)),
    ...element([0xe0], [...element([0xb0], uintBytes(width)), ...element([0xba], uintBytes(height))]),
  ]));
  const cluster = element([0x1f, 0x43, 0xb6, 0x75], element([0xe7], [0]));
  const body = [...info, ...tracks, ...cluster];
  const segment = options.unknownSegmentSize ? [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...body] : element([0x18, 0x53, 0x80, 0x67], body);
  return new Uint8Array([...header, ...segment]);
}
