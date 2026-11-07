import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { renderFileIconTable, OUTPUT } from '../generate-file-icons.ts';

describe('file icon table', () => {
  it('the committed file is what the generator produces from the installed material-icon-theme', () => {
    const committed = readFileSync(OUTPUT, 'utf8').replace(/\r\n/g, '\n');
    expect(committed).toBe(renderFileIconTable());
  });
});
