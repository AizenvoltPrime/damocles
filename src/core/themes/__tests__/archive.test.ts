import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { deflateSync } from 'fflate';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The inflater, seen: an entry is refused by the output bound it was given, not by how long it took to pass it.
const { inflateRawSpy } = vi.hoisted(() => ({ inflateRawSpy: vi.fn() }));
vi.mock('node:zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:zlib')>();
  inflateRawSpy.mockImplementation(actual.inflateRaw as never);
  return { ...actual, inflateRaw: inflateRawSpy };
});

import { englishText } from '../../../shared/localized-text';
import { MAX_FONT_BYTES } from '../../../shared/themes/fonts';
import { MAX_SPRITE_BYTES } from '../../../shared/themes/characters';
import {
  ARCHIVE_LIMITS,
  ArchiveRefusedError,
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_UNCOMPRESSED_BYTES,
  MAX_ENTRY_NAME_BYTES,
  MAX_ENTRY_RATIO,
  MAX_LICENSE_BYTES,
  readCappedHandle,
  readThemeArchive,
  readThemeArchiveFile,
  writeThemeArchive,
  type ArchiveLimits,
} from '../archive';
import { checkWallpaper, wallpaperAsset } from '../assets';
import { sha256Of } from '../blobs';
import { createThemeInstalls } from '../install';
import { MAX_THEME_FILE_BYTES } from '../store';
import { sfntFont, woff2Font } from './font-fixtures';
import { jpeg, png } from '../../../shared/themes/testing/image-fixtures';

// Every fixture is a zip built here: a hand-written container (so names, sizes, flags and attributes can lie exactly as a
// hostile file would) around fflate's deflate.

interface FixtureEntry {
  readonly name: string;
  readonly data: Uint8Array;
  readonly deflate?: boolean;
  // the local header's own name, when it differs from the central directory's
  readonly localName?: string;
  // the uncompressed size both headers declare, when it lies
  readonly declaredSize?: number;
  // the central directory's external attributes; a unix mode sits in the upper 16 bits
  readonly external?: number;
  // the host system in "version made by": 0 MS-DOS, 3 unix
  readonly madeBy?: number;
  readonly flags?: number;
  readonly method?: number;
  // the CRC-32 both headers declare, when it is not the data's
  readonly crc?: number;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: readonly FixtureEntry[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const stored = entry.deflate ? deflateSync(entry.data, { level: 9 }) : entry.data;
    const method = entry.method ?? (entry.deflate ? 8 : 0);
    const flags = entry.flags ?? 0;
    const size = entry.declaredSize ?? entry.data.length;
    const crc = entry.crc ?? crc32(entry.data);
    const name = Buffer.from(entry.name, 'utf8');
    const localName = Buffer.from(entry.localName ?? entry.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(localName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(((entry.madeBy ?? 0) << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((entry.external ?? 0) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, localName, Buffer.from(stored));
    centrals.push(central, name);
    offset += 30 + localName.length + stored.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
// hex digits from a fixed generator: about 2:1 under deflate, far inside the ratio limit
function hexText(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    out[i] = '0123456789abcdef'.charCodeAt(state >>> 28);
  }
  return out;
}
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const unixMode = (type: number, permissions = 0o644): number => (((type | permissions) << 16) >>> 0);

const THEME = text(JSON.stringify({
  schemaVersion: 1,
  id: '0f6c5c1e-8f1d-4c39-9d3b-6c8a0f5b2a11',
  name: 'Shared',
  looks: { dark: { colors: { background: '#141413', panel: '#1f1e1c', text: '#ece8df', accent: '#d97757', success: '#7fb069', warning: '#f0b429', danger: '#f2555a', info: '#6a9bcc' } } },
}));
const WALLPAPER = png(64, 48);
const FONT = woff2Font();
const SPRITE = text('<svg xmlns="http://www.w3.org/2000/svg" width="6" height="2" viewBox="0 0 6 2"><rect width="6" height="2" fill="#d97757"/></svg>');
const LICENSE = text('SIL Open Font License, Version 1.1\n');
const asset = (bytes: Uint8Array, ext: string, deflate = false): FixtureEntry => ({ name: `assets/${sha256Of(bytes)}.${ext}`, data: bytes, deflate });
const theme = (): FixtureEntry => ({ name: 'theme.json', data: THEME, deflate: true });
const VALID: readonly FixtureEntry[] = [theme(), asset(WALLPAPER, 'png'), asset(FONT, 'woff2'), asset(SPRITE, 'svg', true), { name: 'LICENSES/OFL.txt', data: LICENSE, deflate: true }];

let root: string;
let incoming: string;

// The whole tree under root, with each file's size: what any read could have changed.
function tree(): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const key = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        out[`${key}/`] = 0;
        walk(full);
      } else {
        out[key] = fs.lstatSync(full).size;
      }
    }
  };
  walk(root);
  return out;
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-archive-'));
  incoming = path.join(root, 'incoming');
  fs.mkdirSync(path.join(root, 'blobs'), { recursive: true });
  fs.mkdirSync(incoming);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function verdict(bytes: Uint8Array, limits?: ArchiveLimits): Promise<string> {
  try {
    await readThemeArchive(bytes, limits);
    return 'accepted';
  } catch (err) {
    if (err instanceof ArchiveRefusedError) return err.reason;
    throw err;
  }
}

// The file form, as Import reads it: the verdict, and nothing anywhere under the store's root changed by reading it.
async function fileVerdict(bytes: Uint8Array, limits?: ArchiveLimits): Promise<string> {
  const file = path.join(incoming, 'fixture.damocles-theme');
  fs.writeFileSync(file, bytes);
  const before = tree();
  let result: string;
  try {
    await readThemeArchiveFile(file, limits);
    result = 'accepted';
  } catch (err) {
    if (!(err instanceof ArchiveRefusedError)) throw err;
    result = err.reason;
  }
  expect(tree()).toEqual(before);
  expect(fs.readdirSync(path.join(root, 'blobs'))).toEqual([]);
  fs.rmSync(file);
  return result;
}

async function bothVerdicts(bytes: Uint8Array, limits?: ArchiveLimits): Promise<string> {
  const inMemory = await verdict(bytes, limits);
  expect(await fileVerdict(bytes, limits)).toBe(inMemory);
  return inMemory;
}

describe('the theme archive limits', () => {
  it('are the documented ones', () => {
    expect(MAX_ARCHIVE_BYTES).toBe(100 * 1024 * 1024);
    expect(MAX_ARCHIVE_UNCOMPRESSED_BYTES).toBe(256 * 1024 * 1024);
    expect(MAX_ARCHIVE_ENTRIES).toBe(512);
    expect(MAX_ENTRY_RATIO).toBe(100);
    expect(ARCHIVE_LIMITS).toEqual({ archiveBytes: MAX_ARCHIVE_BYTES, uncompressedBytes: MAX_ARCHIVE_UNCOMPRESSED_BYTES, entries: MAX_ARCHIVE_ENTRIES, ratio: MAX_ENTRY_RATIO });
  });
});

describe('a valid theme archive', () => {
  it('is accepted whole: theme.json, every asset with its bytes, and the license texts', async () => {
    const read = await readThemeArchive(zip(VALID));
    expect(read.themeJson).toEqual(JSON.parse(new TextDecoder().decode(THEME)));
    expect([...read.assets.keys()].sort()).toEqual([sha256Of(WALLPAPER), sha256Of(FONT), sha256Of(SPRITE)].sort());
    expect(read.assets.get(sha256Of(WALLPAPER))).toEqual({ ext: 'png', bytes: WALLPAPER });
    expect(read.assets.get(sha256Of(SPRITE))).toEqual({ ext: 'svg', bytes: SPRITE });
    expect(read.licenses.get('OFL.txt')).toBe('SIL Open Font License, Version 1.1\n');
    expect(read.uncompressedBytes).toBe(THEME.length + WALLPAPER.length + FONT.length + SPRITE.length + LICENSE.length);
    expect(await fileVerdict(zip(VALID))).toBe('accepted');
  });

  it('is accepted as the export writes it', async () => {
    const assets = new Map([[sha256Of(WALLPAPER), { ext: 'png', bytes: WALLPAPER }], [sha256Of(jpeg(32, 32)), { ext: 'jpg', bytes: jpeg(32, 32) }], [sha256Of(FONT), { ext: 'woff2', bytes: FONT }], [sha256Of(SPRITE), { ext: 'svg', bytes: SPRITE }]]);
    const written = await writeThemeArchive(new TextDecoder().decode(THEME), assets, new Map([['OFL.txt', 'license text']]));
    const read = await readThemeArchive(written);
    expect(new Map([...read.assets].map(([sha, entry]) => [sha, entry.ext]))).toEqual(new Map([...assets].map(([sha, entry]) => [sha, entry.ext])));
    expect(read.licenses).toEqual(new Map([['OFL.txt', 'license text']]));
    expect(await fileVerdict(written)).toBe('accepted');
  });

  it('gives each asset its own buffer, stored or deflated, so a kept asset never holds the whole archive in memory', async () => {
    const read = await readThemeArchive(zip(VALID.map((entry) => ({ ...entry, deflate: false }))));
    const deflated = await readThemeArchive(zip(VALID.map((entry) => ({ ...entry, deflate: true }))));
    for (const { bytes } of [...read.assets.values(), ...deflated.assets.values()]) expect(bytes.buffer.byteLength).toBe(bytes.byteLength);
  });

  it('is accepted with unix regular-file modes, as zip tools on macOS and Linux write them', async () => {
    expect(await bothVerdicts(zip(VALID.map((entry) => ({ ...entry, madeBy: 3, external: unixMode(S_IFREG) }))))).toBe('accepted');
  });

  it('is accepted at exactly the entry limit, and refused one past it', async () => {
    const licenses = (count: number): FixtureEntry[] => Array.from({ length: count }, (_, n) => ({ name: `LICENSES/l${n}.txt`, data: text(`license ${n}`) }));
    expect(await bothVerdicts(zip([theme(), ...licenses(MAX_ARCHIVE_ENTRIES - 1)]))).toBe('accepted');
    expect(await bothVerdicts(zip([theme(), ...licenses(MAX_ARCHIVE_ENTRIES)]))).toBe('tooManyEntries');
  });
});

describe('an archive over a size limit', () => {
  it('is refused past 100 MB from its length alone, and a file from its size before it is read', async () => {
    // zero pages: the check reads the length before any byte
    expect(await verdict(new Uint8Array(MAX_ARCHIVE_BYTES + 1))).toBe('tooLarge');
    // exactly at the limit it is read, and found not to be a zip
    expect(await verdict(new Uint8Array(MAX_ARCHIVE_BYTES))).toBe('notZip');
    const file = path.join(incoming, 'huge.damocles-theme');
    const handle = fs.openSync(file, 'w');
    fs.ftruncateSync(handle, MAX_ARCHIVE_BYTES + 1);
    fs.closeSync(handle);
    const before = tree();
    await expect(readThemeArchiveFile(file)).rejects.toMatchObject({ reason: 'tooLarge' });
    expect(tree()).toEqual(before);
    fs.rmSync(file);
  });

  it('counts the uncompressed total while inflating, whatever the headers declare', async () => {
    // the total limit scaled to 128 KB runs the same code as 256 MB; every other limit is the real one
    const limits: ArchiveLimits = { ...ARCHIVE_LIMITS, uncompressedBytes: 128 * 1024 };
    // one entry declaring 2 bytes that inflates past the total
    expect(await bothVerdicts(zip([{ name: 'theme.json', data: hexText(200 * 1024), deflate: true, declaredSize: 2 }]), limits)).toBe('uncompressedTooLarge');
    // the total crosses the limit inside the second entry, which declares 10 bytes
    const entries = (declaredSize?: number): FixtureEntry[] => [
      theme(),
      { name: 'LICENSES/a.txt', data: hexText(100 * 1024, 1), deflate: true },
      { name: 'LICENSES/b.txt', data: hexText(100 * 1024, 2), deflate: true, ...(declaredSize !== undefined ? { declaredSize } : {}) },
    ];
    expect(await bothVerdicts(zip(entries(10)), limits)).toBe('uncompressedTooLarge');
    expect(await bothVerdicts(zip(entries()), limits)).toBe('uncompressedTooLarge');
    // the same entries under the real limit are accepted, so the total is what refused them
    expect(await bothVerdicts(zip(entries()))).toBe('accepted');
    // a header that lies without crossing a limit is caught once the entry ends
    expect(await bothVerdicts(zip(entries(10)))).toBe('corrupt');
  });

  it('refuses an entry inflating past 100 times its stored size, even when its header declares one byte', async () => {
    const bomb = new Uint8Array(MAX_LICENSE_BYTES - 1).fill(0x61);
    expect(await bothVerdicts(zip([theme(), { name: 'LICENSES/bomb.txt', data: bomb, deflate: true, declaredSize: 1 }]))).toBe('ratio');
    expect(await bothVerdicts(zip([theme(), { name: 'LICENSES/bomb.txt', data: bomb, deflate: true }]))).toBe('ratio');
    // theme.json made of spaces: the ratio stops it long before its 4 MB cap
    expect(await bothVerdicts(zip([{ name: 'theme.json', data: new Uint8Array(MAX_THEME_FILE_BYTES).fill(0x20), deflate: true, declaredSize: 2 }]))).toBe('ratio');
    // text that compresses about 2:1 is far inside the ratio
    expect(await bothVerdicts(zip([theme(), { name: 'LICENSES/plain.txt', data: hexText(64 * 1024), deflate: true }]))).toBe('accepted');
  });

  it('refuses an entry past its kind\'s cap while it inflates', async () => {
    expect(await bothVerdicts(zip([{ name: 'theme.json', data: hexText(MAX_THEME_FILE_BYTES + 1), deflate: true, declaredSize: 2 }]))).toBe('asset');
    expect(await bothVerdicts(zip([theme(), { name: 'LICENSES/long.txt', data: hexText(MAX_LICENSE_BYTES + 1), deflate: true }]))).toBe('asset');
  });

  it('refuses an asset past its own cap', async () => {
    const font = new Uint8Array(MAX_FONT_BYTES + 1);
    font.set(sfntFont());
    expect(await bothVerdicts(zip([theme(), asset(font, 'ttf')]))).toBe('asset');
    // a wallpaper wider than 8192 pixels and a sprite over its byte cap: their header checks refuse them
    expect(await bothVerdicts(zip([theme(), asset(png(9000, 10), 'png')]))).toBe('asset');
    const sprite = new Uint8Array(MAX_SPRITE_BYTES + 1).fill(0x20);
    sprite.set(SPRITE);
    expect(await bothVerdicts(zip([theme(), asset(sprite, 'svg')]))).toBe('asset');
  });
});

describe('an archive entry that is not a plain file of the three shapes', () => {
  it('is refused as a symbolic link, whoever made it', async () => {
    const link = { name: 'LICENSES/OFL.txt', data: text('../../../../etc/passwd') };
    expect(await bothVerdicts(zip([theme(), { ...link, madeBy: 3, external: unixMode(S_IFLNK, 0o777) }]))).toBe('symlink');
    expect(await bothVerdicts(zip([theme(), { ...link, madeBy: 0, external: unixMode(S_IFLNK, 0o777) }]))).toBe('symlink');
    expect(await bothVerdicts(zip([{ ...theme(), madeBy: 3, external: unixMode(S_IFLNK, 0o777) }]))).toBe('symlink');
    const wallpaper = asset(WALLPAPER, 'png');
    expect(await bothVerdicts(zip([theme(), { ...wallpaper, madeBy: 3, external: unixMode(S_IFLNK, 0o777) }]))).toBe('symlink');
  });

  it('is refused as a folder or another file type', async () => {
    expect(await bothVerdicts(zip([theme(), { name: 'LICENSES/OFL.txt', data: LICENSE, madeBy: 3, external: unixMode(S_IFDIR, 0o755) }]))).toBe('unexpectedEntry');
    expect(await bothVerdicts(zip([theme(), { name: 'assets/', data: new Uint8Array(0), madeBy: 3, external: unixMode(S_IFDIR, 0o755) }]))).toBe('unexpectedEntry');
    expect(await bothVerdicts(zip([theme(), { name: 'assets/', data: new Uint8Array(0), external: 0x10 }]))).toBe('unexpectedEntry');
  });

  it('is refused when a name repeats, exactly or in another case', async () => {
    expect(await bothVerdicts(zip([theme(), theme()]))).toBe('duplicate');
    expect(await bothVerdicts(zip([theme(), { name: 'LICENSES/ofl.txt', data: LICENSE }, { name: 'LICENSES/OFL.txt', data: LICENSE }]))).toBe('duplicate');
    // one asset under two extensions
    expect(await bothVerdicts(zip([theme(), asset(WALLPAPER, 'png'), asset(WALLPAPER, 'apng')]))).toBe('duplicate');
  });

  it('is refused for a name that could reach outside a folder', async () => {
    const sha = sha256Of(WALLPAPER);
    for (const name of [
      '../theme.json',
      'assets/../theme.json',
      'LICENSES/../../evil.txt',
      `assets/../../${sha}.png`,
      '/theme.json',
      '/etc/passwd',
      'C:\\Windows\\evil.dll',
      'C:theme.json',
      'c:/theme.json',
      'D:/Users/me/evil.txt',
      `assets\\${sha}.png`,
      '..\\theme.json',
      '\\\\server\\share\\evil.txt',
      'theme.json\u0000.png',
      './theme.json',
      'LICENSES/./OFL.txt',
      'LICENSES/O FL.txt',
      'thème.json',
      'LICENSES/OFL\u202e.txt',
    ]) {
      expect(await bothVerdicts(zip([theme(), { name, data: WALLPAPER }])), JSON.stringify(name)).toBe('badName');
    }
  });

  it('is refused when its local header names another path than the directory does', async () => {
    expect(await bothVerdicts(zip([{ ...theme(), localName: '../theme.json' }]))).toBe('corrupt');
  });

  it('is refused outside theme.json, assets/<sha256>.<ext> and LICENSES/<name>.txt', async () => {
    const sha = sha256Of(WALLPAPER);
    for (const name of [
      'readme.md',
      'Theme.json',
      'theme.json.bak',
      'theme.json/',
      'assets/wallpaper.png',
      `assets/${sha.toUpperCase()}.png`,
      `assets/${sha}`,
      `assets/${sha}.exe`,
      `assets/sub/${sha}.png`,
      `${sha}.png`,
      'LICENSES/OFL.md',
      'LICENSES/sub/OFL.txt',
      'LICENSES/.txt',
      'licenses/OFL.txt',
      '.git/config',
    ]) {
      expect(await bothVerdicts(zip([theme(), { name, data: WALLPAPER }])), name).toBe('unexpectedEntry');
    }
  });

  it('is refused when it is encrypted or compressed by another method', async () => {
    expect(await bothVerdicts(zip([{ ...theme(), flags: 0x1 }]))).toBe('encrypted');
    expect(await bothVerdicts(zip([{ ...theme(), method: 12 }]))).toBe('method');
  });
});

describe('an archive asset whose bytes are not what its name says', () => {
  it('is refused when its SHA-256 is another file\'s', async () => {
    expect(await bothVerdicts(zip([theme(), { name: `assets/${sha256Of(FONT)}.png`, data: WALLPAPER }]))).toBe('hashMismatch');
    const tampered = WALLPAPER.slice();
    tampered[tampered.length - 5] = tampered.at(-5)! ^ 0xff;
    expect(await bothVerdicts(zip([theme(), { name: `assets/${sha256Of(WALLPAPER)}.png`, data: tampered }]))).toBe('hashMismatch');
  });

  it('is refused when its extension names another type than its bytes sniff as', async () => {
    expect(await bothVerdicts(zip([theme(), asset(WALLPAPER, 'jpg')]))).toBe('typeMismatch');
    expect(await bothVerdicts(zip([theme(), asset(FONT, 'ttf')]))).toBe('typeMismatch');
    expect(await bothVerdicts(zip([theme(), asset(sfntFont(), 'woff2')]))).toBe('typeMismatch');
    expect(await bothVerdicts(zip([theme(), asset(WALLPAPER, 'svg')]))).toBe('typeMismatch');
    expect(await bothVerdicts(zip([theme(), asset(SPRITE, 'png', true)]))).toBe('typeMismatch');
    expect(await bothVerdicts(zip([theme(), asset(FONT, 'png')]))).toBe('typeMismatch');
  });
});

describe('an install from a theme file', () => {
  // the staged install's only write is putBlobs, after the whole file passed
  function installs() {
    const stored: string[][] = [];
    const service = createThemeInstalls({
      list: async () => [],
      putBlobs: async (assets) => {
        stored.push([...assets.keys()]);
        return new Map([...assets.keys()].map((sha256) => [sha256, 0]));
      },
      dropBlobs: async () => undefined,
      analyzeWallpaper: async () => ({}),
      analyzeSprite: async () => ({}),
      newId: () => '7b0e6f4c-3a2d-4e1f-9c8b-5a6d7e8f9012',
      now: () => 0,
    });
    return { service, stored };
  }
  const prepareFile = async (service: ReturnType<typeof installs>['service'], bytes: Uint8Array): Promise<string> => {
    const file = path.join(incoming, 'install.damocles-theme');
    fs.writeFileSync(file, bytes);
    const before = tree();
    try {
      await service.prepare({ kind: 'file', path: file });
      return 'accepted';
    } catch (err) {
      return err instanceof ArchiveRefusedError ? err.reason : 'refused';
    } finally {
      expect(tree()).toEqual(before);
      fs.rmSync(file);
    }
  };

  it('stores nothing for a refused file, and only the declared assets of an accepted one', async () => {
    const { service, stored } = installs();
    const sha = sha256Of(WALLPAPER);
    for (const bytes of [
      zip([theme(), { name: '../evil.txt', data: LICENSE }]),
      zip([theme(), { name: 'LICENSES/OFL.txt', data: LICENSE, madeBy: 3, external: unixMode(S_IFLNK, 0o777) }]),
      zip([theme(), { name: `assets/${sha}.png`, data: png(32, 32) }]),
      zip([theme(), { name: 'LICENSES/bomb.txt', data: new Uint8Array(MAX_LICENSE_BYTES - 1).fill(0x61), deflate: true, declaredSize: 1 }]),
    ]) {
      expect(await prepareFile(service, bytes)).not.toBe('accepted');
    }
    expect(stored).toEqual([]);
    const declared = text(JSON.stringify({ ...JSON.parse(new TextDecoder().decode(THEME)), assets: { [sha]: wallpaperAsset(WALLPAPER, checkWallpaper(WALLPAPER)) } }));
    // an asset the file holds but the theme does not name is never stored
    expect(await prepareFile(service, zip([{ name: 'theme.json', data: declared, deflate: true }, asset(WALLPAPER, 'png'), asset(jpeg(16, 16), 'jpg')]))).toBe('accepted');
    expect(stored).toEqual([[sha]]);
  });
});

describe('an archive that is not a theme file', () => {
  it('is refused without theme.json, damaged, or not a zip', async () => {
    expect(await bothVerdicts(zip([{ name: 'LICENSES/OFL.txt', data: LICENSE }]))).toBe('noTheme');
    expect(await bothVerdicts(zip([{ name: 'theme.json', data: text('{ not json') }]))).toBe('badTheme');
    expect(await bothVerdicts(text('PK not really'))).toBe('notZip');
    expect(await bothVerdicts(WALLPAPER)).toBe('notZip');
  });
});

const refusalText = async (bytes: Uint8Array, limits?: ArchiveLimits): Promise<string> => {
  try {
    await readThemeArchive(bytes, limits);
  } catch (err) {
    if (err instanceof ArchiveRefusedError) return englishText(err.text);
    throw err;
  }
  throw new Error('not refused');
};
// the end of central directory record of a fixture, which has no comment
const endRecord = (bytes: Uint8Array): number => bytes.length - 22;

describe('an archive entry as it inflates', () => {
  beforeEach(() => {
    inflateRawSpy.mockClear();
  });

  it('is inflated off the event loop, which runs between entries', async () => {
    let turns = 0;
    const count = setInterval(() => turns++, 0);
    try {
      await readThemeArchive(zip([theme(), ...Array.from({ length: 6 }, (_, n) => ({ name: `LICENSES/l${n}.txt`, data: hexText(200 * 1024, n + 1), deflate: true }))]));
    } finally {
      clearInterval(count);
    }
    // a read that held the thread would end before one timer ran
    expect(turns).toBeGreaterThan(0);
    expect(inflateRawSpy).toHaveBeenCalledTimes(7);
  });

  it('gives the inflater the smallest of the three bounds as its hard output limit, and names the one that was passed', async () => {
    const bomb = new Uint8Array(MAX_LICENSE_BYTES - 1).fill(0x61);
    const stored = deflateSync(bomb, { level: 9 });
    expect(await verdict(zip([theme(), { name: 'LICENSES/bomb.txt', data: bomb, deflate: true }]))).toBe('ratio');
    expect(inflateRawSpy.mock.calls.at(-1)![1]).toEqual({ maxOutputLength: MAX_ENTRY_RATIO * stored.length });

    expect(await verdict(zip([theme(), { name: 'LICENSES/long.txt', data: hexText(MAX_LICENSE_BYTES + 1), deflate: true }]))).toBe('asset');
    expect(inflateRawSpy.mock.calls.at(-1)![1]).toEqual({ maxOutputLength: MAX_LICENSE_BYTES });

    const limits: ArchiveLimits = { ...ARCHIVE_LIMITS, uncompressedBytes: 128 * 1024 };
    expect(await verdict(zip([{ name: 'theme.json', data: hexText(200 * 1024), deflate: true }]), limits)).toBe('uncompressedTooLarge');
    expect(inflateRawSpy.mock.calls.at(-1)![1]).toEqual({ maxOutputLength: 128 * 1024 });
  });

  it('words a cap under 1 MB in KB', async () => {
    expect(await refusalText(zip([theme(), { name: 'LICENSES/long.txt', data: hexText(MAX_LICENSE_BYTES + 1), deflate: true }]))).toBe('LICENSES/long.txt in this file is larger than 256 KB.');
    expect(await refusalText(zip([{ name: 'theme.json', data: hexText(MAX_THEME_FILE_BYTES + 1) }]))).toBe('theme.json in this file is larger than 4 MB.');
  });
});

describe('an archive entry whose bytes are not the ones its checksum was made from', () => {
  it('is refused, stored or deflated, even when it still parses', async () => {
    const altered = text(new TextDecoder().decode(THEME).replace('Shared', 'Shored'));
    expect(JSON.parse(new TextDecoder().decode(altered))).toMatchObject({ name: 'Shored' });
    expect(await bothVerdicts(zip([{ name: 'theme.json', data: altered, crc: crc32(THEME) }]))).toBe('corrupt');
    expect(await bothVerdicts(zip([{ name: 'theme.json', data: altered, crc: crc32(THEME), deflate: true }]))).toBe('corrupt');
    expect(await bothVerdicts(zip([theme(), { name: 'LICENSES/OFL.txt', data: LICENSE, crc: 0 }]))).toBe('corrupt');
    expect(await refusalText(zip([theme(), { name: 'LICENSES/OFL.txt', data: LICENSE, crc: 0 }]))).toBe('LICENSES/OFL.txt in this file does not match its checksum.');
  });
});

describe('an archive entry name', () => {
  // the bound as a number, so these inputs are the same whatever the module exports
  const NAME_LIMIT = 1024;

  it('is bounded at 1024 bytes', () => {
    expect(MAX_ENTRY_NAME_BYTES).toBe(NAME_LIMIT);
  });

  it('is refused as a bad name past 1024 bytes', async () => {
    const long = `LICENSES/${'a'.repeat(NAME_LIMIT)}.txt`;
    expect(await bothVerdicts(zip([theme(), { name: long, data: LICENSE }]))).toBe('badName');
    expect(await bothVerdicts(zip([theme(), { name: 'a'.repeat(65_535), data: LICENSE }]))).toBe('badName');
  });
});

describe('a zip structure that does not read', () => {
  it('is no zip without its end record, and damaged when the end record points at no directory', async () => {
    const whole = zip(VALID);
    expect(await bothVerdicts(whole.subarray(0, whole.length - 30))).toBe('notZip');
    const damaged = whole.slice();
    const directory = new DataView(damaged.buffer).getUint32(endRecord(damaged) + 16, true);
    damaged[directory] = damaged[directory]! ^ 0xff;
    expect(await bothVerdicts(damaged)).toBe('corrupt');
    const past = whole.slice();
    new DataView(past.buffer).setUint32(endRecord(past) + 12, past.length, true);
    expect(await bothVerdicts(past)).toBe('corrupt');
  });

  it('is refused as ZIP64 by the markers of one', async () => {
    const entries = zip(VALID);
    new DataView(entries.buffer).setUint16(endRecord(entries) + 10, 0xffff, true);
    expect(await refusalText(entries)).toBe('This file uses ZIP64, which Damocles does not read.');
    const offset = zip(VALID);
    new DataView(offset.buffer).setUint32(endRecord(offset) + 16, 0xffffffff, true);
    expect(await bothVerdicts(offset)).toBe('corrupt');
  });
});

describe('a file read through its handle', () => {
  const handleOf = (content: Uint8Array, perRead: number, size = content.length) => ({
    stat: async () => ({ isFile: () => true, size }),
    read: async (buffer: Uint8Array, offset: number, length: number, position: number) => {
      const part = content.subarray(position, position + Math.min(length, perRead));
      buffer.set(part, offset);
      return { bytesRead: part.length };
    },
  }) as unknown as Parameters<typeof readCappedHandle>[0];

  it('is read whole when a read returns fewer bytes than asked', async () => {
    const content = hexText(1000);
    expect(await readCappedHandle(handleOf(content, 7), 'f', 2000)).toEqual(content);
  });

  it('is refused as changed only when it ends before its size', async () => {
    await expect(readCappedHandle(handleOf(hexText(600), 64, 1000), 'f', 2000)).rejects.toMatchObject({ reason: 'corrupt' });
    await expect(readCappedHandle(handleOf(hexText(600), 64), 'f', 500)).rejects.toMatchObject({ reason: 'tooLarge' });
  });
});
