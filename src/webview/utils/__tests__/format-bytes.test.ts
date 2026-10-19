import { describe, expect, it } from 'vitest';
import { formatBytes } from '../format-bytes';

const KIB = 1024;
const MIB = KIB * KIB;

describe('formatBytes', () => {
  it('counts bytes below 1 KiB in the long unit, so a small size never reads 0 kB', () => {
    expect(formatBytes(8, 'en')).toBe('8 bytes');
    expect(formatBytes(1023, 'en')).toBe('1,023 bytes');
  });

  it('steps up by 1024 with at most one decimal, in the UI language', () => {
    expect(formatBytes(2048, 'en')).toBe('2 kB');
    expect(formatBytes(1536, 'en')).toBe('1.5 kB');
    expect(formatBytes(50 * MIB, 'en')).toBe('50 MB');
    expect(formatBytes(1024 * MIB, 'en')).toBe('1 GB');
    expect(formatBytes(2.25 * MIB, 'el')).toBe('2,3 MB');
  });
});
