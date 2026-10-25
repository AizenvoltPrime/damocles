import { describe, expect, it } from 'vitest';
import { CodecError, decode, encode } from '../codec';

// mulberry32: a fixed seed keeps a failure reproducible
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LIMITS = { maxBytes: 1024 * 1024, maxItems: 10_000 };
const PROTOTYPES = [Object.prototype, Array.prototype, Uint8Array.prototype];

function snapshot(): string[][] {
  return PROTOTYPES.map((proto) => Object.getOwnPropertyNames(proto).sort());
}

// a value or a CodecError, quickly; anything else fails the test
function decodesBounded(frame: Uint8Array): void {
  const started = performance.now();
  try {
    decode(frame, LIMITS);
  } catch (err) {
    if (!(err instanceof CodecError)) throw err;
  }
  expect(performance.now() - started).toBeLessThan(500);
}

const SAMPLES: unknown[] = [
  { kind: 'request', id: 7, method: 'files.read', params: { path: '/srv/app/a.ts', limitBytes: 1024 } },
  { kind: 'response', id: 7, ok: true, result: { kind: 'bytes', bytes: new Uint8Array(64).fill(7), mtimeMs: 1.5, dev: 1, ino: 2 } },
  [null, undefined, true, -5, 'text \ud800', [[[{ a: [1, 2, 3] }]]]],
  { __proto__: null, nested: { list: Array.from({ length: 50 }, (_, index) => ({ index, name: `n${index}` })) } },
];

describe('codec fuzz', () => {
  it('decodes random bytes to a value or a bounded error', () => {
    const next = random(1);
    const before = snapshot();
    for (let round = 0; round < 20_000; round++) {
      const frame = new Uint8Array(1 + Math.floor(next() * 64));
      for (let index = 0; index < frame.length; index++) frame[index] = Math.floor(next() * 256);
      // bias the first byte toward real tags so containers get exercised
      frame[0] = Math.floor(next() * 13);
      decodesBounded(frame);
    }
    expect(snapshot()).toEqual(before);
  });

  it('decodes mutated valid frames to a value or a bounded error', () => {
    const next = random(2);
    const before = snapshot();
    const frames = SAMPLES.map((sample) => encode(sample));
    for (let round = 0; round < 20_000; round++) {
      const frame = frames[round % frames.length]!.slice();
      const mutations = 1 + Math.floor(next() * 4);
      for (let count = 0; count < mutations; count++) {
        const at = Math.floor(next() * frame.length);
        const choice = next();
        if (choice < 0.6) frame[at] = Math.floor(next() * 256);
        else if (choice < 0.8) frame[at] = 0x80 | Math.floor(next() * 128);
        else frame[at] = Math.floor(next() * 13);
      }
      const cut = next() < 0.2 ? frame.subarray(0, Math.floor(next() * frame.length)) : frame;
      decodesBounded(cut);
    }
    expect(snapshot()).toEqual(before);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});
