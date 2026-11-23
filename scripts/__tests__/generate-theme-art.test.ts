import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { ARCADE_DIR, AURORA_DIR, renderArcade, renderAurora } from '../generate-theme-art.ts';

describe('built-in theme art', () => {
  // resources/themes/** is -text, so the generator alone decides these bytes on every platform.
  // Aurora's full render takes about 4 s on a fast machine, near the default 5 s timeout.
  it.each([
    ['Aurora', AURORA_DIR, renderAurora],
    ['Arcade', ARCADE_DIR, renderArcade],
  ] as const)('the committed %s folder holds exactly the bytes the generator writes', (_name, dir, render) => {
    const { files } = render();
    expect(readdirSync(dir).sort()).toEqual([...files.keys()].sort());
    for (const [file, bytes] of files) expect(readFileSync(join(dir, file)).equals(bytes), file).toBe(true);
  }, 30_000);

  it('names every image by the SHA-256 of its bytes', () => {
    for (const dir of [AURORA_DIR, ARCADE_DIR]) {
      const named = readdirSync(dir).filter((file) => /^[0-9a-f]{64}\./.test(file));
      expect(named.length).toBeGreaterThan(0);
      for (const file of named) expect(createHash('sha256').update(readFileSync(join(dir, file))).digest('hex')).toBe(file.slice(0, 64));
    }
  });
});
