import { describe, expect, it } from 'vitest';
import { parseCliPathAction, parseUserDataDir } from '../cli';

describe('parseUserDataDir', () => {
  it('reads the separate and the = forms', () => {
    expect(parseUserDataDir(['electron', 'main.js', '--user-data-dir', '/tmp/x'])).toBe('/tmp/x');
    expect(parseUserDataDir(['electron', 'main.js', '--user-data-dir=/tmp/y'])).toBe('/tmp/y');
    expect(parseUserDataDir(['electron', 'main.js'])).toBeUndefined();
  });
});

describe('parseCliPathAction', () => {
  it('reads the installer\'s add and the uninstaller\'s remove, and marks any other value invalid instead of throwing', () => {
    expect(parseCliPathAction(['Damocles.exe', '--cli-path', 'add'])).toBe('add');
    expect(parseCliPathAction(['Damocles.exe', '--cli-path', 'remove'])).toBe('remove');
    expect(parseCliPathAction(['Damocles.exe', '--cli-path'])).toBe('invalid');
    expect(parseCliPathAction(['Damocles.exe', '--cli-path', 'Add'])).toBe('invalid');
    expect(parseCliPathAction(['Damocles.exe', 'add'])).toBeUndefined();
  });
});
