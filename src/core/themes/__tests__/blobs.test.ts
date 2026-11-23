import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BLOB_GRACE_MS, createBlobStore, sha256Of } from '../blobs';
import { writeFileAtomic } from '../store';

const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const SHA = sha256Of(BYTES);

let root: string;
const file = (): string => path.join(root, 'blobs', SHA);
const age = (ms: number): void => {
  const at = new Date(Date.now() - ms);
  fs.utimesSync(file(), at, at);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-blobs-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the blob store', () => {
  it('counts a blob stored again as written now, so a collection keeps what an import just reused', async () => {
    const blobs = createBlobStore(root, writeFileAtomic);
    expect(await blobs.put(BYTES)).toBe(SHA);
    age(2 * BLOB_GRACE_MS);
    expect(await blobs.put(BYTES)).toBe(SHA);
    expect(Date.now() - fs.statSync(file()).mtimeMs).toBeLessThan(60_000);
    expect(await blobs.collect([], Date.now())).toBe(0);
    expect(fs.existsSync(file())).toBe(true);
    age(2 * BLOB_GRACE_MS);
    expect(await blobs.collect([`a theme naming ${SHA}`], Date.now())).toBe(0);
    expect(await blobs.collect([], Date.now())).toBe(1);
    expect(fs.existsSync(file())).toBe(false);
  });

  it('writes a blob again when the file under its name holds other bytes of the same size', async () => {
    const blobs = createBlobStore(root, writeFileAtomic);
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]));
    await blobs.put(BYTES);
    expect(new Uint8Array(fs.readFileSync(file()))).toEqual(BYTES);
  });
});
