// The wire's value codec (frozen): a recursive tagged encoding of structured-clone data. Decode never trusts a count or a
// length before checking it against the bytes left, sets keys with defineProperty and copies bytes out of the frame.

export const MAX_DEPTH = 64;
// values in one message, every nested one counted; encode refuses past it, so a sender never builds a message its peer refuses
export const MAX_ITEMS = 1_000_000;

// Tags; frozen across every protocol version.
const UNDEFINED = 0;
const NULL = 1;
const FALSE = 2;
const TRUE = 3;
const UINT = 4;
const NEGINT = 5;
const FLOAT64 = 6;
const UTF8 = 7;
const UTF16 = 8;
const BYTES = 9;
const ARRAY = 10;
const OBJECT = 11;

// A safe integer needs at most 53 bits: 8 VQL bytes of 7 bits.
const MAX_VQL_BYTES = 8;
const UTF16_CHUNK = 8192;

export class CodecError extends Error {
  override readonly name = 'CodecError';
}

export interface DecodeLimits {
  // the channel's message bound in bytes
  readonly maxBytes: number;
  // every value counts, nested ones included
  readonly maxItems?: number;
  readonly maxDepth?: number;
}

interface Writer {
  buffer: Uint8Array;
  view: DataView;
  length: number;
  // values still allowed
  budget: number;
}

const utf8 = new TextEncoder();
const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function reserve(writer: Writer, bytes: number): void {
  const needed = writer.length + bytes;
  if (needed <= writer.buffer.length) return;
  let size = writer.buffer.length * 2;
  while (size < needed) size *= 2;
  const next = new Uint8Array(size);
  next.set(writer.buffer.subarray(0, writer.length));
  writer.buffer = next;
  writer.view = new DataView(next.buffer);
}

function writeByte(writer: Writer, byte: number): void {
  reserve(writer, 1);
  writer.buffer[writer.length++] = byte;
}

// 7 bits per byte, least significant group first, the high bit on every byte but the last.
function writeVql(writer: Writer, value: number): void {
  reserve(writer, MAX_VQL_BYTES);
  let rest = value;
  while (rest >= 0x80) {
    writer.buffer[writer.length++] = (rest % 0x80) | 0x80;
    rest = Math.floor(rest / 0x80);
  }
  writer.buffer[writer.length++] = rest;
}

function writeBytes(writer: Writer, bytes: Uint8Array): void {
  reserve(writer, bytes.length);
  writer.buffer.set(bytes, writer.length);
  writer.length += bytes.length;
}

function writeString(writer: Writer, value: string): void {
  // ES2024's isWellFormed, which Node 20+ has and this project's lib does not declare
  if ((value as string & { isWellFormed(): boolean }).isWellFormed()) {
    const encoded = utf8.encode(value);
    writeByte(writer, UTF8);
    writeVql(writer, encoded.length);
    writeBytes(writer, encoded);
    return;
  }
  // A lone surrogate survives as raw UTF-16 code units, big-endian, as structured clone keeps it.
  writeByte(writer, UTF16);
  writeVql(writer, value.length);
  reserve(writer, value.length * 2);
  for (let index = 0; index < value.length; index++) {
    writer.view.setUint16(writer.length, value.charCodeAt(index));
    writer.length += 2;
  }
}

function refusedName(value: object): string {
  if (value instanceof Map) return 'a Map';
  if (value instanceof Set) return 'a Set';
  if (value instanceof Date) return 'a Date';
  if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)) return 'an ArrayBuffer';
  if (ArrayBuffer.isView(value)) return `a ${value.constructor.name}`;
  const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
  return `an instance of ${typeof name === 'string' && name !== '' ? name : 'a class'}`;
}

function encodeValue(writer: Writer, value: unknown, depth: number, ancestors: Set<object>): void {
  if (--writer.budget < 0) throw new CodecError('cannot encode more values than the bound allows');
  switch (typeof value) {
    case 'undefined':
      writeByte(writer, UNDEFINED);
      return;
    case 'boolean':
      writeByte(writer, value ? TRUE : FALSE);
      return;
    case 'number':
      if (Number.isSafeInteger(value) && !Object.is(value, -0)) {
        writeByte(writer, value >= 0 ? UINT : NEGINT);
        writeVql(writer, Math.abs(value));
        return;
      }
      writeByte(writer, FLOAT64);
      reserve(writer, 8);
      writer.view.setFloat64(writer.length, value);
      writer.length += 8;
      return;
    case 'string':
      writeString(writer, value);
      return;
    case 'object':
      break;
    default:
      throw new CodecError(`cannot encode a ${typeof value}`);
  }
  if (value === null) {
    writeByte(writer, NULL);
    return;
  }
  // A Buffer is a Uint8Array and decodes as one; every other view is refused.
  if (value instanceof Uint8Array) {
    writeByte(writer, BYTES);
    writeVql(writer, value.byteLength);
    writeBytes(writer, value);
    return;
  }
  if (depth >= MAX_DEPTH) throw new CodecError(`cannot encode a value nested deeper than ${MAX_DEPTH}`);
  if (ancestors.has(value)) throw new CodecError('cannot encode a cycle');
  const proto: unknown = Object.getPrototypeOf(value);
  ancestors.add(value);
  if (Array.isArray(value) && proto === Array.prototype) {
    writeByte(writer, ARRAY);
    writeVql(writer, value.length);
    // a hole reads as undefined
    for (let index = 0; index < value.length; index++) encodeValue(writer, value[index], depth + 1, ancestors);
  } else if (proto === Object.prototype || proto === null) {
    const keys = Object.keys(value);
    writeByte(writer, OBJECT);
    writeVql(writer, keys.length);
    for (const key of keys) {
      writeString(writer, key);
      encodeValue(writer, (value as Record<string, unknown>)[key], depth + 1, ancestors);
    }
  } else {
    throw new CodecError(`cannot encode ${refusedName(value)}`);
  }
  ancestors.delete(value);
}

/** Encodes data: undefined, null, booleans, numbers, strings, Uint8Arrays, arrays and plain objects; anything else throws. */
export function encode(value: unknown, maxItems: number = MAX_ITEMS): Uint8Array {
  const buffer = new Uint8Array(256);
  const writer: Writer = { buffer, view: new DataView(buffer.buffer), length: 0, budget: maxItems };
  encodeValue(writer, value, 0, new Set());
  return writer.buffer.slice(0, writer.length);
}

interface Reader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  offset: number;
  // values still allowed
  budget: number;
  readonly maxDepth: number;
}

function left(reader: Reader): number {
  return reader.bytes.length - reader.offset;
}

function readByte(reader: Reader): number {
  if (reader.offset >= reader.bytes.length) throw new CodecError('the value ends early');
  return reader.bytes[reader.offset++]!;
}

function readVql(reader: Reader): number {
  let value = 0;
  let scale = 1;
  for (let index = 0; index < MAX_VQL_BYTES; index++) {
    const byte = readByte(reader);
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) {
      if (!Number.isSafeInteger(value)) throw new CodecError('an integer past the safe range');
      if (index > 0 && byte === 0) throw new CodecError('an integer not in its shortest form');
      return value;
    }
    scale *= 0x80;
  }
  throw new CodecError('an integer longer than 8 bytes');
}

// A count or length is checked against the bytes left before anything is allocated for it.
function readLength(reader: Reader, unitBytes: number): number {
  const length = readVql(reader);
  if (length * unitBytes > left(reader)) throw new CodecError('a length past the end of the value');
  return length;
}

function readCount(reader: Reader, minBytesPerItem: number): number {
  const count = readVql(reader);
  if (count > reader.budget) throw new CodecError('more values than the bound allows');
  if (count * minBytesPerItem > left(reader)) throw new CodecError('a count past the end of the value');
  return count;
}

function readString(reader: Reader, tag: number): string {
  if (tag === UTF8) {
    const length = readLength(reader, 1);
    const start = reader.offset;
    reader.offset += length;
    try {
      return utf8Strict.decode(reader.bytes.subarray(start, reader.offset));
    } catch (err) {
      throw new CodecError(`a string that is not UTF-8: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (tag === UTF16) {
    const length = readLength(reader, 2);
    // String.fromCharCode over a chunk keeps the call within the engine's argument limit.
    const units = new Uint16Array(Math.min(length, UTF16_CHUNK));
    let text = '';
    for (let start = 0; start < length; start += UTF16_CHUNK) {
      const count = Math.min(UTF16_CHUNK, length - start);
      for (let index = 0; index < count; index++) {
        units[index] = reader.view.getUint16(reader.offset);
        reader.offset += 2;
      }
      text += String.fromCharCode(...units.subarray(0, count));
    }
    return text;
  }
  throw new CodecError('an object key that is not a string');
}

function decodeValue(reader: Reader, depth: number): unknown {
  if (--reader.budget < 0) throw new CodecError('more values than the bound allows');
  const tag = readByte(reader);
  switch (tag) {
    case UNDEFINED:
      return undefined;
    case NULL:
      return null;
    case FALSE:
      return false;
    case TRUE:
      return true;
    case UINT:
      return readVql(reader);
    case NEGINT: {
      const magnitude = readVql(reader);
      // -0 travels as a float
      if (magnitude === 0) throw new CodecError('a negative zero integer');
      return -magnitude;
    }
    case FLOAT64: {
      if (left(reader) < 8) throw new CodecError('the value ends early');
      const value = reader.view.getFloat64(reader.offset);
      reader.offset += 8;
      return value;
    }
    case UTF8:
    case UTF16:
      return readString(reader, tag);
    case BYTES: {
      const length = readLength(reader, 1);
      const start = reader.offset;
      reader.offset += length;
      // a copy, never a view of the frame
      return Uint8Array.prototype.slice.call(reader.bytes, start, reader.offset);
    }
    case ARRAY: {
      if (depth >= reader.maxDepth) throw new CodecError(`a value nested deeper than ${reader.maxDepth}`);
      const count = readCount(reader, 1);
      const out = new Array<unknown>(count);
      for (let index = 0; index < count; index++) out[index] = decodeValue(reader, depth + 1);
      return out;
    }
    case OBJECT: {
      if (depth >= reader.maxDepth) throw new CodecError(`a value nested deeper than ${reader.maxDepth}`);
      // each entry holds at least a key tag, its length and a value tag
      const count = readCount(reader, 3);
      const out: Record<string, unknown> = {};
      for (let index = 0; index < count; index++) {
        const key = readString(reader, readByte(reader));
        if (Object.hasOwn(out, key)) throw new CodecError('an object with a repeated key');
        Object.defineProperty(out, key, { value: decodeValue(reader, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
    default:
      throw new CodecError(`an unknown tag ${tag}`);
  }
}

/** Decodes one value that fills bytes exactly; throws CodecError for anything else. */
export function decode(bytes: Uint8Array, limits: DecodeLimits): unknown {
  if (bytes.length > limits.maxBytes) throw new CodecError(`a value of ${bytes.length} bytes, over the ${limits.maxBytes} byte bound`);
  const reader: Reader = {
    bytes,
    view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    offset: 0,
    budget: limits.maxItems ?? MAX_ITEMS,
    maxDepth: limits.maxDepth ?? MAX_DEPTH,
  };
  const value = decodeValue(reader, 0);
  if (reader.offset !== bytes.length) throw new CodecError('bytes after the value');
  return value;
}
