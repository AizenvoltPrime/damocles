import { closeSync, openSync, readSync, writeFileSync } from 'node:fs';

// Reads and writes asar archives without Electron.

/** A file in an asar header; an unpacked file (one in app.asar.unpacked) has no offset. */
export interface AsarFileEntry {
  size: number;
  offset?: string;
  unpacked?: boolean;
}

export interface AsarDirectory {
  files: Record<string, AsarNode>;
}

export type AsarNode = AsarDirectory | AsarFileEntry;

export interface AsarFile {
  path: string;
  entry: AsarFileEntry;
}

function readExactly(fd: number, length: number, position: number): Buffer {
  const buffer = Buffer.alloc(length);
  const read = readSync(fd, buffer, 0, length, position);
  if (read !== length) throw new Error(`short read: ${read} of ${length} bytes at ${position}`);
  return buffer;
}

/** The asar header (a pickled JSON tree) and the offset where file data starts. */
export function readAsarHeader(asarPath: string): { header: AsarDirectory; dataOffset: number } {
  const fd = openSync(asarPath, 'r');
  try {
    const sizes = readExactly(fd, 16, 0);
    const headerPickleSize = sizes.readUInt32LE(4);
    const jsonLength = sizes.readUInt32LE(12);
    const header = JSON.parse(readExactly(fd, jsonLength, 16).toString('utf8')) as AsarDirectory;
    return { header, dataOffset: 8 + headerPickleSize };
  } finally {
    closeSync(fd);
  }
}

/** Every file path in an asar header tree, forward slashes, with its entry. */
export function asarFiles(node: AsarDirectory, prefix = ''): AsarFile[] {
  const out: AsarFile[] = [];
  for (const [name, entry] of Object.entries(node.files)) {
    const path = prefix === '' ? name : `${prefix}/${name}`;
    if ('files' in entry) out.push(...asarFiles(entry, path));
    else out.push({ path, entry });
  }
  return out;
}

/** Writes an archive holding `files` (forward-slash path to text or Buffer) in the layout readAsarHeader reads. */
export function writeAsar(asarPath: string, files: Record<string, string | Buffer>): void {
  const root: AsarDirectory = { files: {} };
  const data: Buffer[] = [];
  let offset = 0;
  for (const [filePath, content] of Object.entries(files)) {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const names = filePath.split('/');
    if (names.some((name) => name === '' || name === '.' || name === '..')) throw new Error(`asar path ${filePath} has an empty, . or .. segment`);
    // split returns at least one segment
    const leaf = names.pop()!;
    let node = root;
    for (const name of names) {
      const child: AsarNode = node.files[name] ??= { files: {} };
      if (!('files' in child)) throw new Error(`asar path ${filePath} goes through a file`);
      node = child;
    }
    if (node.files[leaf] !== undefined) throw new Error(`asar path ${filePath} is already in the archive`);
    node.files[leaf] = { size: bytes.length, offset: String(offset) };
    data.push(bytes);
    offset += bytes.length;
  }
  const json = Buffer.from(JSON.stringify(root), 'utf8');
  // A pickle pads its string to 4 bytes.
  const padded = (json.length + 3) & ~3;
  const header = Buffer.alloc(16 + padded);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(8 + padded, 4);
  header.writeUInt32LE(4 + padded, 8);
  header.writeUInt32LE(json.length, 12);
  json.copy(header, 16);
  writeFileSync(asarPath, Buffer.concat([header, ...data]));
}

export function readAsarFile(asarPath: string, dataOffset: number, entry: AsarFileEntry): string {
  const fd = openSync(asarPath, 'r');
  try {
    return readExactly(fd, entry.size, dataOffset + Number(entry.offset)).toString('utf8');
  } finally {
    closeSync(fd);
  }
}
