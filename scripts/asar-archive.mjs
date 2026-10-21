import { closeSync, openSync, readSync, writeFileSync } from 'node:fs';

// Reads and writes asar archives without Electron. No import.meta: the desktop e2e suite imports this through Playwright's CommonJS transform.

function readExactly(fd, length, position) {
  const buffer = Buffer.alloc(length);
  const read = readSync(fd, buffer, 0, length, position);
  if (read !== length) throw new Error(`short read: ${read} of ${length} bytes at ${position}`);
  return buffer;
}

/** The asar header (a pickled JSON tree) and the offset where file data starts. */
export function readAsarHeader(asarPath) {
  const fd = openSync(asarPath, 'r');
  try {
    const sizes = readExactly(fd, 16, 0);
    const headerPickleSize = sizes.readUInt32LE(4);
    const jsonLength = sizes.readUInt32LE(12);
    const header = JSON.parse(readExactly(fd, jsonLength, 16).toString('utf8'));
    return { header, dataOffset: 8 + headerPickleSize };
  } finally {
    closeSync(fd);
  }
}

/** Every file path in an asar header tree, forward slashes, with its entry. */
export function asarFiles(node, prefix = '') {
  const out = [];
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix === '' ? name : `${prefix}/${name}`;
    if (entry.files) out.push(...asarFiles(entry, path));
    else out.push({ path, entry });
  }
  return out;
}

/** Writes an archive holding `files` (forward-slash path to text or Buffer) in the layout readAsarHeader reads. */
export function writeAsar(asarPath, files) {
  const root = { files: {} };
  const data = [];
  let offset = 0;
  for (const [filePath, content] of Object.entries(files)) {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const names = filePath.split('/');
    if (names.some((name) => name === '' || name === '.' || name === '..')) throw new Error(`asar path ${filePath} has an empty, . or .. segment`);
    let node = root;
    for (const name of names.slice(0, -1)) {
      node = node.files[name] ??= { files: {} };
      if (!node.files) throw new Error(`asar path ${filePath} goes through a file`);
    }
    if (node.files[names.at(-1)] !== undefined) throw new Error(`asar path ${filePath} is already in the archive`);
    node.files[names.at(-1)] = { size: bytes.length, offset: String(offset) };
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

export function readAsarFile(asarPath, dataOffset, entry) {
  const fd = openSync(asarPath, 'r');
  try {
    return readExactly(fd, entry.size, dataOffset + Number(entry.offset)).toString('utf8');
  } finally {
    closeSync(fd);
  }
}
