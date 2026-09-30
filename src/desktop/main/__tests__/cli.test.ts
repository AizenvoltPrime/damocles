import { describe, expect, it } from 'vitest';
import { parseUserDataDir } from '../cli';

describe('parseUserDataDir', () => {
  it('reads the separate and the = forms', () => {
    expect(parseUserDataDir(['electron', 'main.js', '--user-data-dir', '/tmp/x'])).toBe('/tmp/x');
    expect(parseUserDataDir(['electron', 'main.js', '--user-data-dir=/tmp/y'])).toBe('/tmp/y');
    expect(parseUserDataDir(['electron', 'main.js'])).toBeUndefined();
  });
});
