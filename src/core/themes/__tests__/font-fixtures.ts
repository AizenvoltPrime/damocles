// Small font files built in memory: an sfnt holding only name and OS/2, and the same tables wrapped as WOFF and WOFF2.
// Enough for readFontInfo; no renderer would load them.
import { brotliCompressSync, deflateSync } from 'node:zlib';

export interface FixtureOptions {
  readonly fsType?: number;
  // name ID to text, stored as Windows Unicode English records
  readonly names?: Readonly<Record<number, string>>;
  // the sfnt version tag: TrueType (0x00010000) or OpenType CFF ('OTTO')
  readonly flavor?: 'truetype' | 'otto';
}

const pad4 = (length: number): number => (length + 3) & ~3;

function nameTable(names: Readonly<Record<number, string>>): Uint8Array {
  const entries = Object.entries(names).map(([id, text]) => {
    const bytes = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      bytes[i * 2] = text.charCodeAt(i) >> 8;
      bytes[i * 2 + 1] = text.charCodeAt(i) & 0xff;
    }
    return { id: Number(id), bytes };
  });
  const header = 6 + entries.length * 12;
  const out = new Uint8Array(header + entries.reduce((sum, entry) => sum + entry.bytes.length, 0));
  const view = new DataView(out.buffer);
  view.setUint16(2, entries.length);
  view.setUint16(4, header);
  let offset = 0;
  entries.forEach((entry, i) => {
    const record = 6 + i * 12;
    [3, 1, 0x409, entry.id, entry.bytes.length, offset].forEach((value, field) => view.setUint16(record + field * 2, value));
    out.set(entry.bytes, header + offset);
    offset += entry.bytes.length;
  });
  return out;
}

function os2Table(fsType: number): Uint8Array {
  const out = new Uint8Array(78);
  new DataView(out.buffer).setUint16(8, fsType);
  return out;
}

export function fixtureTables(options: FixtureOptions = {}): Array<{ readonly tag: string; readonly data: Uint8Array }> {
  const names = options.names ?? { 1: 'Fixture Sans', 2: 'Regular', 4: 'Fixture Sans Regular', 6: 'FixtureSans-Regular', 13: 'SIL Open Font License, Version 1.1', 14: 'https://openfontlicense.org' };
  return [{ tag: 'OS/2', data: os2Table(options.fsType ?? 0) }, { tag: 'name', data: nameTable(names) }];
}

const writeTag = (out: Uint8Array, at: number, tag: string): void => {
  for (let i = 0; i < 4; i++) out[at + i] = tag.charCodeAt(i);
};

/** A TrueType or OpenType file holding name and OS/2. */
export function sfntFont(options: FixtureOptions = {}): Uint8Array {
  const tables = fixtureTables(options);
  const directory = 12 + tables.length * 16;
  const size = directory + tables.reduce((sum, table) => sum + pad4(table.data.length), 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  if (options.flavor === 'otto') writeTag(out, 0, 'OTTO');
  else view.setUint32(0, 0x00010000);
  view.setUint16(4, tables.length);
  let offset = directory;
  tables.forEach((table, i) => {
    const record = 12 + i * 16;
    writeTag(out, record, table.tag);
    view.setUint32(record + 8, offset);
    view.setUint32(record + 12, table.data.length);
    out.set(table.data, offset);
    offset += pad4(table.data.length);
  });
  return out;
}

/** The same tables as a WOFF file, each zlib-compressed. */
export function woffFont(options: FixtureOptions = {}): Uint8Array {
  const tables = fixtureTables(options).map((table) => ({ ...table, stored: new Uint8Array(deflateSync(table.data)) }));
  const directory = 44 + tables.length * 20;
  const size = directory + tables.reduce((sum, table) => sum + pad4(table.stored.length), 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  writeTag(out, 0, 'wOFF');
  view.setUint32(4, 0x00010000);
  view.setUint32(8, size);
  view.setUint16(12, tables.length);
  view.setUint32(16, sfntFont(options).length);
  view.setUint16(20, 1);
  let offset = directory;
  tables.forEach((table, i) => {
    const entry = 44 + i * 20;
    writeTag(out, entry, table.tag);
    view.setUint32(entry + 4, offset);
    view.setUint32(entry + 8, table.stored.length);
    view.setUint32(entry + 12, table.data.length);
    out.set(table.stored, offset);
    offset += pad4(table.stored.length);
  });
  return out;
}

function base128(value: number): number[] {
  const bytes = [value & 0x7f];
  for (let rest = Math.floor(value / 128); rest > 0; rest = Math.floor(rest / 128)) bytes.unshift((rest & 0x7f) | 0x80);
  return bytes;
}

// WOFF2's known-table indexes of the two tables (W3C WOFF2 5.1).
const WOFF2_INDEX: Readonly<Record<string, number>> = { name: 5, 'OS/2': 6 };

/** The same tables as a WOFF2 file: one brotli stream, both tables untransformed. */
export function woff2Font(options: FixtureOptions & { readonly collection?: boolean } = {}): Uint8Array {
  const tables = fixtureTables(options);
  const directory = tables.flatMap((table) => [WOFF2_INDEX[table.tag]!, ...base128(table.data.length)]);
  const stream = new Uint8Array(brotliCompressSync(Buffer.concat(tables.map((table) => table.data))));
  const size = 48 + directory.length + stream.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  writeTag(out, 0, 'wOF2');
  if (options.collection === true) writeTag(out, 4, 'ttcf');
  else view.setUint32(4, 0x00010000);
  view.setUint32(8, size);
  view.setUint16(12, tables.length);
  view.setUint32(16, sfntFont(options).length);
  view.setUint32(20, stream.length);
  view.setUint16(24, 1);
  out.set(directory, 48);
  out.set(stream, 48 + directory.length);
  return out;
}

/** A TrueType collection header naming one font. */
export function collectionFont(): Uint8Array {
  const font = sfntFont();
  const out = new Uint8Array(16 + font.length);
  const view = new DataView(out.buffer);
  writeTag(out, 0, 'ttcf');
  view.setUint32(4, 0x00010000);
  view.setUint32(8, 1);
  view.setUint32(12, 16);
  out.set(font, 16);
  return out;
}

/** An sfnt of the given tables, as they are. */
export function sfntOf(tables: ReadonlyArray<{ readonly tag: string; readonly data: Uint8Array }>): Uint8Array {
  const directory = 12 + tables.length * 16;
  const out = new Uint8Array(directory + tables.reduce((sum, table) => sum + pad4(table.data.length), 0));
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x00010000);
  view.setUint16(4, tables.length);
  let offset = directory;
  tables.forEach((table, i) => {
    const record = 12 + i * 16;
    writeTag(out, record, table.tag);
    view.setUint32(record + 8, offset);
    view.setUint32(record + 12, table.data.length);
    out.set(table.data, offset);
    offset += pad4(table.data.length);
  });
  return out;
}

export interface NameRecord {
  readonly platform: number;
  readonly encoding: number;
  readonly language: number;
  readonly nameId: number;
  readonly length: number;
  readonly offset: number;
}

/** A name table of the given records over one storage area, which records may share. */
export function nameTableOf(records: readonly NameRecord[], storage: Uint8Array): Uint8Array {
  const header = 6 + records.length * 12;
  const out = new Uint8Array(header + storage.length);
  const view = new DataView(out.buffer);
  view.setUint16(2, records.length);
  view.setUint16(4, header);
  records.forEach((record, i) => {
    [record.platform, record.encoding, record.language, record.nameId, record.length, record.offset].forEach((value, field) => view.setUint16(6 + i * 12 + field * 2, value));
  });
  out.set(storage, header);
  return out;
}

export interface WoffEntry {
  readonly tag: string;
  // the table's bytes as the file stores them, and the length the directory says they inflate to
  readonly stored: Uint8Array;
  readonly length: number;
  // the entry of the same file whose stored bytes this one points at instead of holding its own
  readonly sharesWith?: number;
}

/** A WOFF whose directory is exactly `entries`, in their order; totalSfntSize is the true one unless given. */
export function woffOf(entries: readonly WoffEntry[], options: { readonly totalSfntSize?: number } = {}): Uint8Array {
  const directory = 44 + entries.length * 20;
  const own = entries.filter((entry) => entry.sharesWith === undefined);
  const size = directory + own.reduce((sum, entry) => sum + pad4(entry.stored.length), 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  writeTag(out, 0, 'wOFF');
  view.setUint32(4, 0x00010000);
  view.setUint32(8, size);
  view.setUint16(12, entries.length);
  view.setUint32(16, options.totalSfntSize ?? 12 + entries.length * 16 + entries.reduce((sum, entry) => sum + pad4(entry.length), 0));
  const offsets: number[] = [];
  let offset = directory;
  entries.forEach((entry, i) => {
    if (entry.sharesWith !== undefined) return;
    offsets[i] = offset;
    out.set(entry.stored, offset);
    offset += pad4(entry.stored.length);
  });
  entries.forEach((entry, i) => {
    const at = 44 + i * 20;
    writeTag(out, at, entry.tag);
    view.setUint32(at + 4, offsets[entry.sharesWith ?? i]!);
    view.setUint32(at + 8, entry.stored.length);
    view.setUint32(at + 12, entry.length);
  });
  return out;
}

/** A WOFF2 whose table directory is the given bytes, before one brotli stream of `tables`. */
export function woff2Of(directory: readonly number[], count: number, tables: Uint8Array, options: { readonly totalSfntSize?: number } = {}): Uint8Array {
  const stream = new Uint8Array(brotliCompressSync(tables));
  const out = new Uint8Array(48 + directory.length + stream.length);
  const view = new DataView(out.buffer);
  writeTag(out, 0, 'wOF2');
  view.setUint32(4, 0x00010000);
  view.setUint32(8, out.length);
  view.setUint16(12, count);
  view.setUint32(16, options.totalSfntSize ?? tables.length);
  view.setUint32(20, stream.length);
  out.set(directory, 48);
  out.set(stream, 48 + directory.length);
  return out;
}
