// Reproducible .tar.gz and .zip writers for the server packages, and the readers build-server.mjs and
// verify-server-package.mjs use on Node's archives, npm tarballs and the packages themselves.
import { createHash } from 'node:crypto';
import { crc32, deflateRawSync, gunzipSync, gzipSync, inflateRawSync } from 'node:zlib';

// 2000-01-01T00:00:00Z: every entry's mtime, in tar seconds and as a zip DOS date (a zip cannot say 1970)
export const FIXED_MTIME = 946_684_800;
const DOS_TIME = 0;
const DOS_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1;
// gzip header: bytes 4-7 are the mtime, byte 9 the OS (3, Unix, whatever zlib was built for)
const GZIP_OS_UNIX = 3;
const ZIP_MAX_ENTRIES = 0xffff;
const ZIP_MAX_BYTES = 0xffffffff;

/** sha256 of a buffer, hex. */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** @typedef {{ path: string, mode: number, data: Buffer }} ArchiveEntry */

function sorted(entries) {
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.path)) throw new Error(`${entry.path} is in the archive twice`);
    seen.add(entry.path);
  }
  return [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function tarHeader(fields) {
  const block = Buffer.alloc(512);
  block.write(fields.name, 0, 100, 'utf8');
  block.write(octal(fields.mode, 8), 100, 'ascii');
  block.write(octal(0, 8), 108, 'ascii');
  block.write(octal(0, 8), 116, 'ascii');
  block.write(octal(fields.size, 12), 124, 'ascii');
  block.write(octal(FIXED_MTIME, 12), 136, 'ascii');
  block.write(' '.repeat(8), 148, 'ascii');
  block.write(fields.type, 156, 'ascii');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  block.write(fields.prefix ?? '', 345, 155, 'utf8');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return block;
}

function padded(data) {
  const rest = data.length % 512;
  return rest === 0 ? [data] : [data, Buffer.alloc(512 - rest)];
}

// name (100 bytes) or prefix (155) + '/' + name, else undefined
function ustarName(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path };
  for (let at = path.indexOf('/'); at !== -1; at = path.indexOf('/', at + 1)) {
    const prefix = path.slice(0, at);
    const name = path.slice(at + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { prefix, name };
  }
  return undefined;
}

// a PAX record "<length> path=<path>\n", whose length counts its own digits
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body);
  while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body);
  return Buffer.from(`${length}${body}`, 'utf8');
}

/** A ustar archive of `entries` (files only), sorted, owned by 0:0, every mtime FIXED_MTIME, gzipped with a fixed header. */
export function tarGz(entries) {
  const parts = [];
  for (const entry of sorted(entries)) {
    let name = ustarName(entry.path);
    if (!name) {
      const pax = paxRecord('path', entry.path);
      parts.push(tarHeader({ name: 'PaxHeader', mode: 0o644, size: pax.length, type: 'x' }), ...padded(pax));
      name = { name: entry.path.slice(-100).replace(/^[^/]*\//, '') };
    }
    parts.push(tarHeader({ ...name, mode: entry.mode, size: entry.data.length, type: '0' }), ...padded(entry.data));
  }
  parts.push(Buffer.alloc(1024));
  const gz = gzipSync(Buffer.concat(parts), { level: 9 });
  gz.writeUInt32LE(0, 4);
  gz[9] = GZIP_OS_UNIX;
  return gz;
}

/** A zip of `entries`, sorted, deflated, every time 2000-01-01 00:00, with Unix modes in the external attributes. */
export function zip(entries) {
  const list = sorted(entries);
  if (list.length >= ZIP_MAX_ENTRIES) throw new Error(`${list.length} entries need zip64, which this writer does not write`);
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of list) {
    const name = Buffer.from(entry.path, 'utf8');
    const deflated = deflateRawSync(entry.data, { level: 9 });
    const stored = deflated.length >= entry.data.length;
    const body = stored ? entry.data : deflated;
    const crc = crc32(entry.data);
    if (body.length > ZIP_MAX_BYTES || entry.data.length > ZIP_MAX_BYTES || offset > ZIP_MAX_BYTES) throw new Error(`${entry.path} needs zip64`);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    // made by Unix (3), so the external attributes' high half is the mode
    header.writeUInt16LE((3 << 8) | 20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(stored ? 0 : 8, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(((0o100000 | entry.mode) << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    central.push(header, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(list.length, 8);
  end.writeUInt16LE(list.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function field(block, start, length) {
  const end = block.indexOf(0, start);
  return block.toString('utf8', start, end === -1 || end > start + length ? start + length : end);
}

function paxPath(data) {
  for (const record of data.toString('utf8').split('\n')) {
    const match = /^\d+ path=(.*)$/.exec(record);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * The files and symlinks of a .tar.gz, with their modes; PAX and GNU long names applied. `type` is 'file' or 'symlink'
 * (whose `data` is the link target).
 */
export function readTarGz(buffer) {
  const tar = gunzipSync(buffer);
  const entries = [];
  let longName;
  for (let at = 0; at + 512 <= tar.length;) {
    const block = tar.subarray(at, at + 512);
    if (block.every((byte) => byte === 0)) break;
    const size = Number.parseInt(field(block, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(block[156] || 48);
    const data = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { longName = paxPath(data) ?? longName; continue; }
    if (type === 'L') { longName = field(data, 0, data.length); continue; }
    if (type === 'g') continue;
    const prefix = field(block, 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(block, 0, 100)}` : field(block, 0, 100));
    longName = undefined;
    const mode = Number.parseInt(field(block, 100, 8).trim() || '0', 8) & 0o7777;
    if (type === '0') entries.push({ path: name, mode, type: 'file', data: Buffer.from(data) });
    else if (type === '2') entries.push({ path: name, mode, type: 'symlink', data: Buffer.from(field(block, 157, 100)) });
  }
  return entries;
}

/** The files of a zip with their Unix modes (0o644 when the zip records none); no zip64. */
export function readZip(buffer) {
  const endAt = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt === -1) throw new Error('not a zip: no end of central directory');
  const count = buffer.readUInt16LE(endAt + 10);
  let at = buffer.readUInt32LE(endAt + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = buffer.readUInt16LE(at + 10);
    const compressed = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const madeBy = buffer.readUInt16LE(at + 4) >> 8;
    const attributes = buffer.readUInt32LE(at + 38);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    const dataAt = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const body = buffer.subarray(dataAt, dataAt + compressed);
    const data = method === 0 ? Buffer.from(body) : method === 8 ? inflateRawSync(body) : undefined;
    if (!data) throw new Error(`${name}: zip method ${method} is not supported`);
    const mode = madeBy === 3 && attributes >>> 16 !== 0 ? (attributes >>> 16) & 0o7777 : 0o644;
    entries.push({ path: name, mode, type: 'file', data });
  }
  return entries;
}

/** The raw gzip header fields the writer normalizes, for checking an archive: mtime and OS byte. */
export function gzipHeader(buffer) {
  return { mtime: buffer.readUInt32LE(4), os: buffer[9] };
}
