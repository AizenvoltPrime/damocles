import { closeSync, openSync, readSync } from 'node:fs';

// Reads app.asar without Electron. No import.meta: the desktop e2e suite imports this through Playwright's CommonJS transform.

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

export function readAsarFile(asarPath, dataOffset, entry) {
  const fd = openSync(asarPath, 'r');
  try {
    return readExactly(fd, entry.size, dataOffset + Number(entry.offset)).toString('utf8');
  } finally {
    closeSync(fd);
  }
}
