import { describe, expect, it } from 'vitest';
import { englishText, LocalizedError } from '../../../shared/localized-text';
import { checkWallpaper } from '../assets';
import { MAX_BOXES, readVideoHeader, sniffVideo, videoCodec, VideoHeaderError } from '../../../shared/themes/video-header';
import { ftypBrands } from '../../../shared/themes/image-header';
import { MAX_MOVING_BYTES } from '../../../shared/themes/wallpapers';
import { avif } from '../../../shared/themes/testing/image-fixtures';
import { mp4, webm } from './video-fixtures';

// A video wallpaper's container, codec, size and duration come from its header, held to the caps before anything decodes it
// (docs/themes.md "Wallpapers").

const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (err) {
    if (err instanceof LocalizedError) return englishText(err.text);
    throw err;
  }
  throw new Error('not refused');
};

describe('readVideoHeader', () => {
  it.each([
    ['an MP4 with moov at the start', mp4()],
    ['an MP4 with moov at the end', mp4({ moovAtEnd: true })],
    ['an MP4 with 64-bit times', mp4({ version1: true })],
    ['a fragmented MP4, its duration in mehd', mp4({ fragmented: true })],
  ])('reads %s', (_name, bytes) => {
    expect(readVideoHeader(bytes)).toEqual({ container: 'mp4', codecs: ['avc1'], width: 640, height: 360, durationMs: 4000 });
  });

  it('reads the video track of an MP4 that has sound too, and its codec from stsd', () => {
    expect(readVideoHeader(mp4({ codec: 'av01', audio: true, width: 3840, height: 2160, durationMs: 59_500 }))).toEqual({ container: 'mp4', codecs: ['av01'], width: 3840, height: 2160, durationMs: 59_500 });
  });

  it('reads a WebM\'s codec ID, size and duration from its EBML elements', () => {
    expect(readVideoHeader(webm({ codec: 'V_VP8', width: 1280, height: 720, durationMs: 12_345 }))).toEqual({ container: 'webm', codecs: ['V_VP8'], width: 1280, height: 720, durationMs: 12_345 });
    expect(readVideoHeader(webm({ unknownSegmentSize: true }))).toMatchObject({ container: 'webm', codecs: ['V_VP9'], durationMs: 4000 });
  });

  it('tells an AVIF from an MP4, though both start with ftyp', () => {
    expect(sniffVideo(avif([[800, 600]]))).toBeUndefined();
    expect(sniffVideo(mp4())).toBe('mp4');
    expect(sniffVideo(webm())).toBe('webm');
  });

  it.each([
    ['an MP4 with no moov', (() => { const bytes = mp4(); return bytes.subarray(0, 28); })()],
    ['an MP4 whose box runs past its end', mp4().subarray(0, 60)],
    ['an MP4 that states no duration', mp4({ durationMs: 0 })],
    ['a WebM that states no duration', webm({ durationMs: null })],
    ['a WebM cut inside its header', webm().subarray(0, 6)],
  ])('refuses %s', (_name, bytes) => {
    expect(() => readVideoHeader(bytes)).toThrow(VideoHeaderError);
  });

  it('refuses a Matroska file that is not WebM', () => {
    expect(() => readVideoHeader(webm({ docType: 'matroska' }))).toThrow(/Matroska file of another kind, not WebM/);
  });

  it('names the codecs a wallpaper may use', () => {
    expect(['avc1', 'avc3', 'av01', 'vp09', 'V_VP8', 'V_VP9', 'V_AV1'].map(videoCodec)).toEqual(['avc1', 'avc1', 'av01', 'vp09', 'vp08', 'vp09', 'av01']);
    expect(['hvc1', 'hev1', 'encv', 'V_MPEG4/ISO/AVC', 'V_THEORA'].map(videoCodec)).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });
});

describe('checkWallpaper for videos', () => {
  it('accepts an MP4 and a WebM within every cap', () => {
    expect(checkWallpaper(mp4({ moovAtEnd: true }), 'loop.mp4')).toEqual({ kind: 'video', mime: 'video/mp4', format: 'mp4', width: 640, height: 360, durationMs: 4000 });
    expect(checkWallpaper(webm({ codec: 'V_AV1' }), 'loop.webm')).toEqual({ kind: 'video', mime: 'video/webm', format: 'webm', width: 640, height: 360, durationMs: 4000 });
    expect(checkWallpaper(mp4({ width: 3840, height: 2160, durationMs: 60_000 }))).toMatchObject({ width: 3840, height: 2160, durationMs: 60_000 });
  });

  it.each([
    ['longer than 60 s', mp4({ durationMs: 60_001 }), /lasts 60 seconds; a video wallpaper may last at most 60/],
    ['a WebM longer than 60 s', webm({ durationMs: 75_000 }), /lasts 75 seconds/],
    ['wider than 3840', mp4({ width: 4096, height: 2160 }), /4096 by 2160 pixels; a video wallpaper may be at most 3840 by 2160/],
    ['taller than 2160', webm({ width: 2160, height: 3840 }), /at most 3840 by 2160/],
    ['in HEVC', mp4({ codec: 'hvc1' }), /uses the hvc1 codec; a video wallpaper may use only avc1, av01, vp08, vp09/],
    ['in Theora', webm({ codec: 'V_THEORA' }), /uses the V_THEORA codec/],
  ])('refuses a video %s, from its header', (_name, bytes, message) => {
    expect(refusal(() => checkWallpaper(bytes))).toMatch(message);
  });

  it('refuses a video whose name says another type', () => {
    expect(refusal(() => checkWallpaper(webm(), 'clip.mp4'))).toMatch(/named \.mp4 but holds a WEBM file/);
  });

  it('names a header that does not hold up', () => {
    expect(refusal(() => checkWallpaper(webm({ durationMs: null })))).toMatch(/could not be read: The WebM does not state its duration/);
  });
});

const malformedText = (bytes: Uint8Array): string => {
  try {
    readVideoHeader(bytes);
  } catch (err) {
    if (err instanceof VideoHeaderError && err.reason === 'malformed') return englishText(err.text);
    throw err;
  }
  throw new Error('not refused');
};
const be32 = (value: number): number[] => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
const tag = (name: string): number[] => [...name].map((char) => char.charCodeAt(0));

describe('an MP4 duration', () => {
  it('is refused as cut short when mehd is empty, at the end of the file too', () => {
    expect(malformedText(mp4({ emptyMehd: true, moovAtEnd: true }))).toBe('The MP4 file ends before its header does.');
    expect(malformedText(mp4({ emptyMehd: true }))).toBe('The MP4 file ends before its header does.');
  });

  it('is read as not stated when it is all ones, at 32 and at 64 bits', () => {
    expect(malformedText(mp4({ unknownDuration: true }))).toBe('The MP4 does not state its duration.');
    expect(malformedText(mp4({ unknownDuration: true, version1: true }))).toBe('The MP4 does not state its duration.');
    expect(refusal(() => checkWallpaper(mp4({ unknownDuration: true, version1: true })))).toBe('This video could not be read: The MP4 does not state its duration.');
  });

  it('is refused when it is a 64-bit value no number holds', () => {
    const bytes = mp4({ unknownDuration: true, version1: true });
    // the last byte of the all-ones duration: 0xff..fe is a value, and far past 2^53
    const at = bytes.findIndex((_, i) => bytes.subarray(i, i + 8).every((byte) => byte === 0xff));
    bytes[at + 7] = 0xfe;
    expect(malformedText(bytes)).toBe('The MP4 does not state its duration.');
  });
});

describe('a name a video file states', () => {
  it('is read to 32 bytes at most: a megabyte of document type is no WebM, and a megabyte of codec ID no codec', () => {
    const long = 'w'.repeat(1024 * 1024);
    expect(() => readVideoHeader(webm({ docType: long }))).toThrow(VideoHeaderError);
    expect(readVideoHeader(webm({ codec: long })).codecs).toEqual(['w'.repeat(32)]);
    expect(refusal(() => checkWallpaper(webm({ codec: long })))).toMatch(/^This video uses the w{32} codec/);
  });
});

describe('a header walk', () => {
  // the bound as a number, so these inputs are the same whatever the module exports
  const BOXES = 100_000;

  it('is bounded at 100,000 boxes or elements in one place', () => {
    expect(MAX_BOXES).toBe(BOXES);
  });

  it('reads an ftyp box\'s brands from the first 1445 bytes only', () => {
    const padded = new Uint8Array(MAX_MOVING_BYTES);
    padded.set([...be32(1024 * 1024), ...tag('ftyp'), ...tag('isom'), 0, 0, 2, 0]);
    expect(ftypBrands(padded)!.length).toBeLessThanOrEqual(1445 / 4);
    expect(sniffVideo(padded)).toBe('mp4');
  });

  it('stops an MP4 at 100,000 boxes in one place', () => {
    const boxes = (count: number): Uint8Array => {
      const out = new Uint8Array(count * 8);
      for (let i = 0; i < count; i++) out.set([...be32(8), ...tag('free')], i * 8);
      return out;
    };
    const whole = mp4();
    const joined = (count: number): Uint8Array => {
      const padding = boxes(count);
      const out = new Uint8Array(whole.length + padding.length);
      out.set(whole);
      out.set(padding, whole.length);
      return out;
    };
    // the fixture's own three boxes count too
    expect(readVideoHeader(joined(BOXES - 3))).toMatchObject({ container: 'mp4' });
    expect(malformedText(joined(BOXES - 2))).toBe('The MP4 holds more than 100000 boxes in one place.');
  });

  it('stops a WebM at 100,000 elements in one place, and refuses an element header that does not hold up', () => {
    // an EBML header of Void elements of no length
    const voids = (count: number): Uint8Array => {
      const body = new Uint8Array(count * 2);
      for (let i = 0; i < count; i++) body.set([0xec, 0x80], i * 2);
      const out = new Uint8Array(12 + body.length);
      out.set([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0, 0, 0, ...be32(body.length)]);
      out.set(body, 12);
      return out;
    };
    expect(malformedText(voids(BOXES + 1))).toBe('The WebM holds more than 100000 elements in one place.');
    expect(malformedText(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00]))).toBe('The WebM has an element header that is not valid.');
    // an unsigned integer longer than 8 bytes: the track type of the fixture, stretched
    expect(malformedText(webm({ longTrackType: true }))).toBe('The WebM has an element header that is not valid.');
  });
});

describe('any bytes', () => {
  it('give a header or a VideoHeaderError, never another error, at every length a video can be cut to', () => {
    for (const video of [mp4(), mp4({ version1: true, moovAtEnd: true }), mp4({ fragmented: true, audio: true }), mp4({ emptyMehd: true, moovAtEnd: true }), webm(), webm({ unknownSegmentSize: true })]) {
      for (let length = 0; length <= video.length; length++) {
        let outcome = 'read';
        try {
          readVideoHeader(video.subarray(0, length));
        } catch (err) {
          outcome = err instanceof VideoHeaderError ? 'refused' : String(err);
        }
        expect(['read', 'refused'], `cut to ${length}`).toContain(outcome);
      }
    }
  });
});
