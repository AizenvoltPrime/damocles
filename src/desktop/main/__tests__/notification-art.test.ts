import { describe, expect, it } from 'vitest';
import { badgeArt, badgeLabel, validPng } from '../notification-art';
import { pngChunk, pngFixture } from './png-fixture';

const CAP = 64 * 1024;
// The signature, then IHDR's 25 bytes, then IDAT's length and type.
const IDAT_DATA = 8 + 25 + 8;

describe('rasterized PNG validation', () => {
  it('accepts one complete PNG of exactly the size asked for', () => {
    const png = pngFixture(16, 16);
    expect(validPng(new Uint8Array(png), 16, 16, CAP)).toEqual(png);
  });

  it('refuses another size, a non-PNG, a broken chunk, trailing bytes, a missing end and anything over the cap', () => {
    const png = pngFixture(16, 16);
    expect(validPng(png, 32, 32, CAP)).toBeUndefined();
    expect(validPng(Buffer.from('<svg/>'), 16, 16, CAP)).toBeUndefined();
    expect(validPng('not bytes', 16, 16, CAP)).toBeUndefined();
    // A byte of IDAT's data, so only the CRC tells.
    const corrupted = Buffer.from(png);
    corrupted[IDAT_DATA + 2] = corrupted[IDAT_DATA + 2]! ^ 0xff;
    expect(validPng(corrupted, 16, 16, CAP)).toBeUndefined();
    expect(validPng(Buffer.concat([png, Buffer.from([0])]), 16, 16, CAP)).toBeUndefined();
    expect(validPng(png.subarray(0, png.length - 12), 16, 16, CAP)).toBeUndefined();
    expect(validPng(png, 16, 16, png.length - 1)).toBeUndefined();
  });

  it('refuses a chunk before IHDR, a second IHDR, no IDAT, a non-empty IEND and another bit depth or colour type, each with correct CRCs', () => {
    const png = pngFixture(16, 16);
    const signature = png.subarray(0, 8);
    const ihdr = png.subarray(8, IDAT_DATA - 8);
    const idat = png.subarray(IDAT_DATA - 8, png.length - 12);
    const iend = png.subarray(png.length - 12);
    const header = (depth: number, colour: number): Buffer => {
      const data = Buffer.from(ihdr.subarray(8, 8 + 13));
      data[8] = depth;
      data[9] = colour;
      return pngChunk('IHDR', data);
    };
    expect(validPng(Buffer.concat([signature, ihdr, idat, iend]), 16, 16, CAP)).toEqual(png);
    expect(validPng(Buffer.concat([signature, header(8, 2), idat, iend]), 16, 16, CAP)).toBeDefined();
    expect(validPng(Buffer.concat([signature, pngChunk('tEXt', Buffer.from('Comment', 'latin1')), ihdr, idat, iend]), 16, 16, CAP)).toBeUndefined();
    // A first chunk shaped like IHDR in all but its type.
    expect(validPng(Buffer.concat([signature, pngChunk('tEXt', ihdr.subarray(8, 8 + 13)), idat, iend]), 16, 16, CAP)).toBeUndefined();
    expect(validPng(Buffer.concat([signature, ihdr, ihdr, idat, iend]), 16, 16, CAP)).toBeUndefined();
    expect(validPng(Buffer.concat([signature, ihdr, iend]), 16, 16, CAP)).toBeUndefined();
    expect(validPng(Buffer.concat([signature, ihdr, idat, pngChunk('IEND', Buffer.from([0]))]), 16, 16, CAP)).toBeUndefined();
    expect(validPng(Buffer.concat([signature, header(16, 6), idat, iend]), 16, 16, CAP)).toBeUndefined();
    expect(validPng(Buffer.concat([signature, header(8, 3), idat, iend]), 16, 16, CAP)).toBeUndefined();
  });
});

describe('taskbar badge art', () => {
  it('labels the badge with the count up to 9 and 9+ past it, and none at 0', () => {
    expect([0, 1, 4, 9, 10, 250].map(badgeLabel)).toEqual(['', '1', '4', '9', '9+', '9+']);
  });

  it('draws a filled circle with the count at the display scale in whole pixels, with a smaller face for 9+', () => {
    const colors = { fill: '#cd333a', text: '#ffffff' };
    expect(badgeArt('4', 1, colors)).toMatchObject({ width: 16, height: 16, scale: 1 });
    expect(badgeArt('4', 1.5, colors)).toMatchObject({ width: 24, height: 24, scale: 1.5 });
    expect(badgeArt('4', 1.1, colors)).toMatchObject({ width: 18, height: 18, scale: 18 / 16 });
    const [circle, digits] = badgeArt('9+', 1, colors).ops;
    expect(circle).toMatchObject({ svg: expect.stringContaining('<circle cx="8" cy="8" r="8" fill="#cd333a"/>') });
    expect(digits).toMatchObject({ text: '9+', color: '#ffffff' });
    expect((digits as { size: number }).size).toBeLessThan((badgeArt('4', 1, colors).ops[1] as { size: number }).size);
  });

  it('refuses a colour that is not #rrggbb, which would land in the SVG unescaped', () => {
    expect(() => badgeArt('1', 1, { fill: 'red"/><script/>', text: '#ffffff' })).toThrow();
  });
});
