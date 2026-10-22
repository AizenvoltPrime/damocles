import { describe, expect, it } from 'vitest';
import { stripBom } from '../bom';

describe('stripBom', () => {
  it('drops exactly one leading BOM', () => {
    expect(stripBom('\uFEFF{"a":1}')).toBe('{"a":1}');
    expect(stripBom('\uFEFF\uFEFF{}')).toBe('\uFEFF{}');
  });

  it('keeps a BOM that is not at the start', () => {
    expect(stripBom('{"a":"\uFEFF"}')).toBe('{"a":"\uFEFF"}');
  });

  it('leaves text without a BOM unchanged', () => {
    expect(stripBom('')).toBe('');
    expect(stripBom('{}')).toBe('{}');
  });
});
