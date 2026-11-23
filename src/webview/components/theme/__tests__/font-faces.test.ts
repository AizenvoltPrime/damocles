// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { BUILTIN_THEME } from '@shared/themes/builtin';
import type { ThemeFile } from '@shared/themes/schema';

const SHA = 'ab'.repeat(32);

function themed(asset: string, family = 'Iosevka'): Pick<ThemeFile, 'style' | 'assets'> {
  return { style: { fonts: { mono: { asset, family } } }, assets: { [asset]: { kind: 'font', mime: 'font/woff2', bytes: 10, license: {} } } };
}

interface Face {
  readonly family: string;
  readonly source: string;
  fail(): void;
}

let faces: Face[] = [];
let added: Set<unknown>;
// font-faces.ts keeps the families it declared in module state, so each test loads it afresh
let declareBundledFonts: typeof import('../font-faces').declareBundledFonts;

beforeEach(async () => {
  faces = [];
  added = new Set();
  class FakeFontFace {
    readonly family: string;
    readonly source: string;
    readonly loaded: Promise<unknown>;
    private reject: (reason: Error) => void = () => undefined;
    constructor(family: string, source: string) {
      this.family = family;
      this.source = source;
      this.loaded = new Promise((_resolve, reject) => { this.reject = reject; });
      faces.push(this);
    }
    fail(): void {
      this.reject(new Error('the blob was not served'));
    }
  }
  vi.stubGlobal('FontFace', FakeFontFace);
  Object.defineProperty(document, 'fonts', { configurable: true, value: { add: (face: unknown) => added.add(face), delete: (face: unknown) => added.delete(face) } });
  vi.resetModules();
  ({ declareBundledFonts } = await import('../font-faces'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, 'fonts');
});

describe('a miniature\'s bundled fonts', () => {
  it('are declared once per family, each from the app\'s own blob URL', () => {
    declareBundledFonts(themed(SHA));
    declareBundledFonts(themed(SHA));
    expect(faces.map((face) => [face.family, face.source])).toEqual([[`dt-${SHA.slice(0, 8)}-Iosevka`, `url(app://damocles/theme-blob/${SHA})`]]);
    expect(added.size).toBe(1);
    declareBundledFonts(BUILTIN_THEME);
    expect(faces).toHaveLength(1);
  });

  it('declare nothing for an asset key that is not a blob\'s SHA-256, so no source is added to the face', () => {
    for (const asset of [`${'a'.repeat(60)}), url(https://example.com/f.woff2`, 'AB'.repeat(32), 'abc']) declareBundledFonts(themed(asset));
    expect(faces).toEqual([]);
    expect(added.size).toBe(0);
  });

  it('are declared again by the next miniature after a face failed to load', async () => {
    declareBundledFonts(themed(SHA));
    faces[0]!.fail();
    await flushPromises();
    expect(added.size).toBe(0);

    declareBundledFonts(themed(SHA));
    expect(faces).toHaveLength(2);
    expect(added.has(faces[1])).toBe(true);
  });
});
