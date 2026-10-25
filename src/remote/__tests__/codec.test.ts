import { describe, expect, it } from 'vitest';
import { CodecError, decode, encode, MAX_DEPTH, MAX_ITEMS } from '../codec';

const LIMITS = { maxBytes: 64 * 1024 * 1024 };
const roundTrip = (value: unknown): unknown => decode(encode(value), LIMITS);

describe('codec', () => {
  it('round-trips every tag', () => {
    const values: unknown[] = [
      undefined, null, false, true,
      0, 1, 127, 128, 300, Number.MAX_SAFE_INTEGER, -1, -128, -Number.MAX_SAFE_INTEGER,
      1.5, -0, Number.NaN, Infinity, -Infinity, 2 ** 60, -(2 ** 60), 5e-324,
      '', 'plain', 'émoji 🎉 中文',
      new Uint8Array([0, 1, 255]),
      [1, 'two', [3]],
      { a: 1, nested: { b: [true, null] } },
    ];
    for (const value of values) expect(roundTrip(value)).toStrictEqual(value);
    expect(Object.is(roundTrip(-0), -0)).toBe(true);
    expect(Number.isNaN(roundTrip(Number.NaN))).toBe(true);
  });

  it('keeps a lone surrogate as structured clone does', () => {
    for (const text of ['\ud800', 'a\udc00b', '\udbff\ud800', '🎉\ud83c']) expect(roundTrip(text)).toBe(text);
    expect(roundTrip({ ['\ud800key']: 1 })).toEqual({ ['\ud800key']: 1 });
  });

  it('reads holes as undefined', () => {
    // eslint-disable-next-line no-sparse-arrays -- the hole is the case under test
    const decoded = roundTrip([1, , 3]) as unknown[];
    expect(decoded).toEqual([1, undefined, 3]);
    expect(Object.hasOwn(decoded, 1)).toBe(true);
  });

  it('decodes a Buffer as a plain Uint8Array copied out of the frame', () => {
    const frame = encode({ data: Buffer.from('bytes') });
    const decoded = decode(frame, LIMITS) as { data: Uint8Array };
    expect(Object.getPrototypeOf(decoded.data)).toBe(Uint8Array.prototype);
    expect(Buffer.from(decoded.data).toString()).toBe('bytes');
    frame.fill(0);
    expect(Buffer.from(decoded.data).toString()).toBe('bytes');
    expect(decoded.data.buffer).not.toBe(frame.buffer);
  });

  it('makes __proto__ a plain own property', () => {
    const value = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"prototype": {"x": 1}}}') as object;
    const decoded = roundTrip(value) as Record<string, unknown>;
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(Object.hasOwn(decoded, '__proto__')).toBe(true);
    expect((decoded as { polluted?: unknown }).polluted).toBeUndefined();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('refuses every non-data type by name', () => {
    class Thing {}
    const cases: Array<[unknown, RegExp]> = [
      [() => 1, /function/],
      [Symbol('s'), /symbol/],
      [10n, /bigint/],
      [new Map(), /Map/],
      [new Set(), /Set/],
      [new Date(), /Date/],
      [new Thing(), /Thing/],
      [new ArrayBuffer(4), /ArrayBuffer/],
      [new Uint16Array(2), /Uint16Array/],
      [new DataView(new ArrayBuffer(2)), /DataView/],
      [/regex/, /RegExp/],
    ];
    for (const [value, name] of cases) {
      expect(() => encode(value)).toThrow(CodecError);
      expect(() => encode({ inner: [value] })).toThrow(name);
    }
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    expect(() => encode(cycle)).toThrow(/cycle/);
    const shared = { x: 1 };
    expect(roundTrip([shared, shared])).toEqual([{ x: 1 }, { x: 1 }]);
  });

  it('bounds the depth on both sides', () => {
    const nest = (depth: number): unknown => (depth === 0 ? 0 : [nest(depth - 1)]);
    expect(roundTrip(nest(MAX_DEPTH))).toEqual(nest(MAX_DEPTH));
    expect(() => encode(nest(MAX_DEPTH + 1))).toThrow(/deeper/);
    const frame = new Uint8Array((MAX_DEPTH + 1) * 2 + 1);
    for (let index = 0; index <= MAX_DEPTH; index++) frame.set([10, 1], index * 2);
    frame[frame.length - 1] = 0;
    expect(() => decode(frame, LIMITS)).toThrow(/deeper/);
  });

  it('bounds the bytes before decoding and every count against the bytes left', () => {
    const frame = encode('x'.repeat(100));
    expect(() => decode(frame, { maxBytes: 50 })).toThrow(/over the 50 byte bound/);
    // an array claiming 2^40 items in a few bytes
    expect(() => decode(Uint8Array.from([10, 0x80, 0x80, 0x80, 0x80, 0x80, 0x20]), LIMITS)).toThrow(CodecError);
    // a string claiming more bytes than follow
    expect(() => decode(Uint8Array.from([7, 50, 0x61]), LIMITS)).toThrow(/past the end/);
    expect(() => decode(Uint8Array.from([9, 200, 1]), LIMITS)).toThrow(/past the end/);
  });

  it('bounds the values in one message, nested ones included', () => {
    const inner = Array.from({ length: 100 }, () => ({}));
    const value = Array.from({ length: 100 }, () => inner);
    const frame = encode(value);
    expect(decode(frame, { maxBytes: frame.length, maxItems: 100 * 101 + 1 })).toEqual(value);
    expect(() => decode(frame, { maxBytes: frame.length, maxItems: 100 * 101 })).toThrow(/more values/);
  });

  it('refuses to encode a message with more values than its peer decodes', () => {
    const inner = Array.from({ length: 100 }, () => ({}));
    const value = Array.from({ length: 100 }, () => inner);
    expect(encode(value, 100 * 101 + 1)).toEqual(encode(value));
    expect(() => encode(value, 100 * 101)).toThrow(CodecError);
    expect(() => encode(new Array(MAX_ITEMS).fill(0))).toThrow(/more values/);
  });

  it('refuses malformed frames', () => {
    const bad: number[][] = [
      [],
      [99],
      [4, 0x80],
      // a VQL not in its shortest form
      [4, 0x81, 0x00],
      // past the safe integer range
      [4, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f],
      // a negative zero integer
      [5, 0],
      [6, 0, 0],
      // invalid UTF-8
      [7, 1, 0xff],
      // a repeated key
      [11, 2, 7, 1, 0x61, 0, 7, 1, 0x61, 0],
      // a key that is not a string
      [11, 1, 4, 1, 0],
      // bytes after the value
      [0, 0],
    ];
    for (const frame of bad) expect(() => decode(Uint8Array.from(frame), LIMITS)).toThrow(CodecError);
  });
});
