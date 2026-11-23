import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readPickedFont } from '../font-file';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-font-file-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a font file the user picked', () => {
  it('is read whole up to the cap, the cap itself included', async () => {
    const file = path.join(dir, 'a.woff2');
    fs.writeFileSync(file, Buffer.from([1, 2, 3, 4]));
    expect(await readPickedFont(file, 16)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(await readPickedFont(file, 4)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('is too large one byte past the cap, and no byte of it is answered', async () => {
    const file = path.join(dir, 'big.ttf');
    fs.writeFileSync(file, Buffer.alloc(5, 7));
    expect(await readPickedFont(file, 4)).toBe('tooLarge');
  });

  it('is refused when it is a folder or is gone', async () => {
    await expect(readPickedFont(dir, 16)).rejects.toThrow();
    await expect(readPickedFont(path.join(dir, 'missing.otf'), 16)).rejects.toThrow();
  });
});
