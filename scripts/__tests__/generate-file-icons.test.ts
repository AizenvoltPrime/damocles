import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
// @ts-expect-error -- plain .mjs helper, no types
import { renderFileIconTable, OUTPUT } from '../generate-file-icons.mjs';

describe('file icon table', () => {
  it('the committed file is what the generator produces from the installed material-icon-theme', () => {
    const committed = readFileSync(OUTPUT as string, 'utf8').replace(/\r\n/g, '\n');
    expect(committed).toBe((renderFileIconTable as () => string)());
  });
});
