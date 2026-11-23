import * as fs from 'node:fs';
import * as path from 'node:path';
import { deflateSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The two unpackers, counted: a hostile font is refused by how much it would unpack, not by how long that takes.
const { inflateSpy, brotliSpy } = vi.hoisted(() => ({ inflateSpy: vi.fn(), brotliSpy: vi.fn() }));
vi.mock('node:zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:zlib')>();
  inflateSpy.mockImplementation(actual.inflate as never);
  brotliSpy.mockImplementation(actual.brotliDecompress as never);
  return { ...actual, inflate: inflateSpy, brotliDecompress: brotliSpy };
});

import { embeddingOf, FontInfoError, MAX_SFNT_BYTES, readFontInfo, type FontRefusal } from '../font-info';
import { collectionFont, fixtureTables, nameTableOf, sfntFont, sfntOf, woff2Font, woff2Of, woffFont, woffOf, type NameRecord, type WoffEntry } from './font-fixtures';

const REPO = path.resolve(__dirname, '..', '..', '..', '..');

async function refusal(bytes: Uint8Array): Promise<FontRefusal | undefined> {
  try {
    await readFontInfo(bytes);
    return undefined;
  } catch (err) {
    return err instanceof FontInfoError ? err.reason : undefined;
  }
}

describe('readFontInfo', () => {
  it.each([
    ['TrueType', sfntFont(), 'ttf', 'font/ttf'],
    ['OpenType CFF', sfntFont({ flavor: 'otto' }), 'otf', 'font/otf'],
    ['WOFF', woffFont(), 'woff', 'font/woff'],
    ['WOFF2', woff2Font(), 'woff2', 'font/woff2'],
  ] as const)('reads a %s file\'s type and name IDs 1, 2, 4, 6, 13 and 14', async (_name, bytes, kind, mime) => {
    const info = await readFontInfo(bytes);
    expect(info.kind).toBe(kind);
    expect(info.mime).toBe(mime);
    expect(info.names).toEqual({
      family: 'Fixture Sans',
      subfamily: 'Regular',
      fullName: 'Fixture Sans Regular',
      postscriptName: 'FixtureSans-Regular',
      license: 'SIL Open Font License, Version 1.1',
      licenseUrl: 'https://openfontlicense.org',
    });
  });

  it.each([
    ['installable', 0x0000, 'installable'],
    ['restricted', 0x0002, 'restricted'],
    ['preview and print', 0x0004, 'previewPrint'],
    ['editable', 0x0008, 'editable'],
    ['restricted with editable (the least restrictive wins)', 0x000a, 'editable'],
    ['restricted with no-subsetting', 0x0102, 'restricted'],
  ] as const)('reads OS/2 fsType %s from every wrapping', async (_name, fsType, embedding) => {
    for (const bytes of [sfntFont({ fsType }), woffFont({ fsType }), woff2Font({ fsType })]) {
      const info = await readFontInfo(bytes);
      expect(info.fsType).toBe(fsType);
      expect(info.embedding).toBe(embedding);
    }
    expect(embeddingOf(fsType)).toBe(embedding);
  });

  it('refuses a collection, bare or wrapped in WOFF2', async () => {
    expect(await refusal(collectionFont())).toBe('collection');
    expect(await refusal(woff2Font({ collection: true }))).toBe('collection');
  });

  it('refuses what is not a font, a cut-short file and one over the size cap', async () => {
    expect(await refusal(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('unknown');
    expect(await refusal(sfntFont().subarray(0, 40))).toBe('malformed');
    expect(await refusal(woff2Font().subarray(0, 60))).toBe('malformed');
    expect(await refusal(new Uint8Array(10 * 1024 * 1024 + 1))).toBe('tooLarge');
  });

  it('reads a font with no OS/2 table as installable', async () => {
    const bytes = sfntFont();
    // the OS/2 record is the first; renaming its tag drops it
    bytes.set([0x58, 0x58, 0x58, 0x58], 12);
    expect(await readFontInfo(bytes)).toMatchObject({ fsType: 0, embedding: 'installable' });
  });

  it('reads the WOFF2 fonts Damocles ships, whose glyf and loca are transformed', async () => {
    // OFL-1.1, a dependency of the desktop build (its LICENSE ships beside it)
    const file = path.join(REPO, 'node_modules', '@fontsource-variable', 'geist-mono', 'files', 'geist-mono-latin-wght-normal.woff2');
    const info = await readFontInfo(new Uint8Array(fs.readFileSync(file)));
    expect(info.kind).toBe('woff2');
    expect(info.names.family).toMatch(/^Geist Mono/);
    expect(info.embedding).not.toBe('restricted');
  });
});

// A table of `length` bytes that deflates to a few hundred: what a hostile directory points many entries at.
const zeros = (length: number): { stored: Uint8Array; length: number } => ({ stored: new Uint8Array(deflateSync(new Uint8Array(length))), length });
const [OS2, NAME] = fixtureTables() as [{ tag: string; data: Uint8Array }, { tag: string; data: Uint8Array }];
const plain = (table: { tag: string; data: Uint8Array }): WoffEntry => ({ tag: table.tag, stored: table.data, length: table.data.length });

// The most a font may unpack to, as a number, so these inputs are the same whatever the module exports.
const SFNT_LIMIT = 64 * 1024 * 1024;

describe('a WOFF whose directory does not hold up', () => {
  it('is held to 64 MB unpacked', () => {
    expect(MAX_SFNT_BYTES).toBe(SFNT_LIMIT);
  });

  beforeEach(() => {
    inflateSpy.mockClear();
    brotliSpy.mockClear();
  });

  it('is refused before anything inflates when its entries share one compressed table', async () => {
    // 65 KB of file whose six entries each claim 8 MB of the same zlib stream
    const bomb = zeros(8 * 1024 * 1024);
    const entries = ['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee', 'name'].map((tag, i): WoffEntry => ({ tag, ...bomb, ...(i > 0 ? { sharesWith: 0 } : {}) }));
    const bytes = woffOf(entries);
    expect(bytes.length).toBeLessThan(65 * 1024);
    expect(await refusal(bytes)).toBe('malformed');
    expect(inflateSpy).not.toHaveBeenCalled();
  });

  it('is refused when its tags are not in ascending order, or one repeats', async () => {
    expect(await refusal(woffOf([plain(NAME), plain(OS2)]))).toBe('malformed');
    expect(await refusal(woffOf([plain(OS2), plain(NAME), plain(NAME)]))).toBe('malformed');
    expect(inflateSpy).not.toHaveBeenCalled();
  });

  it('is refused when its table lengths do not add up to the size its header declares', async () => {
    expect(await refusal(woffOf([plain(OS2), plain(NAME)], { totalSfntSize: 12 + 2 * 16 + OS2.data.length + NAME.data.length + 400 }))).toBe('malformed');
  });

  it('is refused when its header declares more than the limit, or a table is longer compressed than whole', async () => {
    expect(await refusal(woffOf([plain(OS2), plain(NAME)], { totalSfntSize: SFNT_LIMIT + 1 }))).toBe('tooLarge');
    expect(await refusal(woffOf([plain(OS2), { tag: 'name', stored: NAME.data, length: NAME.data.length - 4 }]))).toBe('malformed');
  });

  it('is refused when a table inflates to another length than its entry declares', async () => {
    const stored = new Uint8Array(deflateSync(NAME.data));
    expect(await refusal(woffOf([plain(OS2), { tag: 'name', stored, length: NAME.data.length + 4 }]))).toBe('malformed');
    expect(await refusal(woffOf([plain(OS2), { tag: 'name', stored, length: NAME.data.length - 4 }]))).toBe('malformed');
  });

  it('inflates only the name and OS/2 tables, whatever else the font holds', async () => {
    const big = zeros(4 * 1024 * 1024);
    const name = { tag: 'name', stored: new Uint8Array(deflateSync(NAME.data)), length: NAME.data.length };
    const info = await readFontInfo(woffOf([plain(OS2), { tag: 'cmap', ...big }, { tag: 'glyf', ...big }, { tag: 'loca', ...big }, name]));
    expect(info.names.family).toBe('Fixture Sans');
    expect(inflateSpy).toHaveBeenCalledTimes(1);
    expect(inflateSpy.mock.calls[0]![1]).toEqual({ maxOutputLength: NAME.data.length });
  });
});

describe('a WOFF2 whose directory does not hold up', () => {
  const tables = new Uint8Array([...OS2.data, ...NAME.data]);
  // known-table indexes 6 (OS/2) and 5 (name), each followed by its length
  const entry = (index: number, length: number[]): number[] => [index, ...length];

  beforeEach(() => {
    brotliSpy.mockClear();
  });

  it('is refused for a UIntBase128 with a leading zero byte, one longer than five bytes and one cut short', async () => {
    expect(await refusal(woff2Of(entry(6, [0x80, 0x4e]), 1, tables))).toBe('malformed');
    expect(await refusal(woff2Of(entry(6, [0x81, 0x81, 0x81, 0x81, 0x81, 0x01]), 1, tables))).toBe('malformed');
    expect(await refusal(woff2Of(entry(6, [0x81]), 1, tables).subarray(0, 50))).toBe('malformed');
    expect(brotliSpy).not.toHaveBeenCalled();
  });

  it('is refused before it unpacks when its tables add up to more than the limit', async () => {
    // 0x90 0x80 0x80 0x00 is 32 MB: three such tables pass the 64 MB limit
    const huge = [0x90, 0x80, 0x80, 0x00];
    expect(await refusal(woff2Of([...entry(6, huge), ...entry(5, huge), ...entry(0, huge)], 3, tables))).toBe('tooLarge');
    expect(await refusal(woff2Of(entry(6, [78]), 1, tables, { totalSfntSize: SFNT_LIMIT + 1 }))).toBe('tooLarge');
    expect(brotliSpy).not.toHaveBeenCalled();
  });

  it('never unpacks past the length its directory adds up to', async () => {
    // the directory names 78 bytes; the stream holds more
    expect(await refusal(woff2Of(entry(6, [78]), 1, new Uint8Array(4 * 1024 * 1024)))).toBe('malformed');
    expect(brotliSpy.mock.calls[0]![1]).toEqual({ maxOutputLength: 78 });
  });

  it('does not unpack a font that holds neither table', async () => {
    expect(await readFontInfo(woff2Of(entry(0, [78]), 1, new Uint8Array(78)))).toMatchObject({ kind: 'woff2', fsType: 0, names: {} });
    expect(brotliSpy).not.toHaveBeenCalled();
  });
});

describe('a name table of many records', () => {
  // UTF-16BE text of 32,767 characters, which every record points at
  const storage = new Uint8Array(65_534);
  for (let i = 0; i < storage.length; i += 2) storage[i + 1] = 0x41;
  const record = (platform: number, language: number, nameId = 1): NameRecord => ({ platform, encoding: platform === 1 ? 0 : 1, language, nameId, length: storage.length, offset: 0 });

  it('decodes a record only when it outranks the one held, so at most four per name however many records there are', async () => {
    // worst order: each rank arrives after 1,250 records of the rank below it
    const ranks: Array<[number, number]> = [[1, 0], [0, 0], [3, 0x408], [3, 0x409]];
    const records = ranks.flatMap(([platform, language]) => Array.from({ length: 1_250 }, () => record(platform, language)));
    const font = sfntOf([{ tag: 'name', data: nameTableOf(records, storage) }]);
    const swap = vi.spyOn(Buffer.prototype, 'swap16');
    // Counted, never recorded, and stopped past the bound: a decoder working a UTF-16 unit at a time would make 163 million calls.
    const fromCharCode = String.fromCharCode;
    const MAX_UNIT_CALLS = 100;
    let unitCalls = 0;
    String.fromCharCode = (...codes: number[]): string => {
      if (++unitCalls > MAX_UNIT_CALLS) throw new Error('decoded a unit at a time');
      return fromCharCode(...codes);
    };
    try {
      // settled either way first: the count is the verdict, however a stopped decoder's error comes out
      const info = await readFontInfo(font).then((read) => read, () => undefined);
      String.fromCharCode = fromCharCode;
      expect(unitCalls).toBeLessThanOrEqual(MAX_UNIT_CALLS);
      expect(info?.names.family).toBe('A'.repeat(20_000));
      // one decode for each of the three UTF-16 ranks (the Macintosh rank is read a byte a character), each of 40,000 bytes at most
      expect(swap).toHaveBeenCalledTimes(3);
      expect(swap.mock.contexts.map((buffer) => (buffer as Buffer).length)).toEqual([40_000, 40_000, 40_000]);
    } finally {
      swap.mockRestore();
      String.fromCharCode = fromCharCode;
    }
  });

  it('keeps the best-ranked record of each name: Windows English, then Windows, then Unicode, then Macintosh', async () => {
    const text = (value: string): Uint8Array => new Uint8Array([...value].flatMap((char) => [0, char.charCodeAt(0)]));
    const parts = [text('Win'), text('Uni'), new TextEncoder().encode('Mac')];
    const store = new Uint8Array(parts.flatMap((part) => [...part]));
    const at = (index: number): number => parts.slice(0, index).reduce((sum, part) => sum + part.length, 0);
    const records: NameRecord[] = [
      { platform: 1, encoding: 0, language: 0, nameId: 1, length: 3, offset: at(2) },
      { platform: 0, encoding: 3, language: 0, nameId: 1, length: 6, offset: at(1) },
      { platform: 3, encoding: 1, language: 0x408, nameId: 1, length: 6, offset: at(0) },
      { platform: 1, encoding: 0, language: 0, nameId: 2, length: 3, offset: at(2) },
    ];
    expect((await readFontInfo(sfntOf([{ tag: 'name', data: nameTableOf(records, store) }]))).names).toEqual({ family: 'Win', subfamily: 'Mac' });
  });

  it('refuses a table that lists more records than it holds', async () => {
    const table = nameTableOf([record(3, 0x409)], storage).subarray(0, 12);
    expect(await refusal(sfntOf([{ tag: 'name', data: table }]))).toBe('malformed');
  });
});

describe('any bytes', () => {
  it('give font info or a FontInfoError, never another error, at every length a font can be cut to', async () => {
    for (const font of [sfntFont(), woffFont(), woff2Font()]) {
      for (let length = 0; length <= font.length; length++) {
        const outcome = await readFontInfo(font.subarray(0, length)).then(() => 'read', (err: unknown) => (err instanceof FontInfoError ? 'refused' : String(err)));
        expect(['read', 'refused'], `cut to ${length}`).toContain(outcome);
      }
    }
  });
});
