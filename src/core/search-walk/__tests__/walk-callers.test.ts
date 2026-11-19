import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { backendSourceFiles, BUNDLED_TREES } from '../../../__mocks__/source-tree';

// Every walk runs in the walk process, so a share that stops answering holds only that process's libuv pool: only its serve
// loop calls walkFiles, and every host walks through a walk host (docs/invariants.md "Tool overrides").
describe('walkFiles callers', () => {
  it('are the walk process alone', () => {
    const callers = backendSourceFiles(undefined, BUNDLED_TREES)
      .filter((file) => /\bwalkFiles\(/.test(readFileSync(file.path, 'utf8')))
      .map((file) => file.rel);
    expect(callers.sort()).toEqual(['src/core/search-walk/walk-serve.ts', 'src/core/search-walk/walk.ts']);
  });
});
