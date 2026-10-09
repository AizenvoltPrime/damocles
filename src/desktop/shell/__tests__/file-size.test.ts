import { describe, expect, it } from 'vitest';
import { fileSize } from '../editor/file-size';

const MIB = 1024 * 1024;

describe('fileSize', () => {
  it('counts kilobytes of 1024 bytes below 1 MiB', () => {
    expect(fileSize(1536, 'en')).toBe('1.5 kB');
    expect(fileSize(MIB - 1024, 'en')).toBe('1,023 kB');
  });

  it('steps to megabytes of 1024 KiB from 1 MiB, so a 50 MiB file reads 50 MB', () => {
    expect(fileSize(MIB, 'en')).toBe('1 MB');
    expect(fileSize(50 * MIB, 'en')).toBe('50 MB');
    expect(fileSize(2.25 * MIB, 'el')).toBe('2,3 MB');
  });
});
