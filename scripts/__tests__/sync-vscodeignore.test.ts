import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
// @ts-expect-error -- plain .mjs helper, no types
import { platformFamilyGlob } from '../sync-vscodeignore.mjs';

/**
 * `.github/workflows/release.yml` runs `sync-vscodeignore.mjs --check` on `ubuntu-latest` while every
 * developer generates the block on their own machine. A pattern that names one platform's binary package
 * therefore fails the check on another platform and aborts the tag push before the package matrix runs.
 * These tests pin the two halves that keep the generated block the same on every host.
 */

/** os / cpu / libc tokens npm uses in native-binary package names. */
const PLATFORM_TOKENS = [
  'win32', 'darwin', 'linux', 'freebsd', 'openbsd', 'netbsd', 'android', 'sunos', 'aix',
  'x64', 'arm64', 'arm', 'ia32', 'x86', 'ppc64', 'ppc', 's390x', 'riscv64', 'loong64', 'mips64el', 'mips64', 'universal',
  'musl', 'gnu', 'gnueabihf', 'eabi', 'msvc',
];

describe('platformFamilyGlob', () => {
  it('collapses two platforms of the same package to one glob', () => {
    expect(platformFamilyGlob('@vscode/ripgrep-win32-x64')).toBe('@vscode/ripgrep-*');
    expect(platformFamilyGlob('@vscode/ripgrep-linux-x64')).toBe('@vscode/ripgrep-*');
    expect(platformFamilyGlob('@koromix/koffi-win32-x64')).toBe('@koromix/koffi-*');
    expect(platformFamilyGlob('@koromix/koffi-linux-arm64')).toBe('@koromix/koffi-*');
    expect(platformFamilyGlob('@scope/clipboard-linux-x64-musl')).toBe('@scope/clipboard-*');
  });

  it('collapses a name made only of platform tokens to its scope', () => {
    expect(platformFamilyGlob('@esbuild/linux-x64')).toBe(platformFamilyGlob('@esbuild/win32-x64'));
    expect(platformFamilyGlob('@esbuild/win32-x64')).toBe('@esbuild/*');
    expect(platformFamilyGlob('@esbuild/darwin-arm64')).toBe('@esbuild/*');
  });

  it('returns null when the name carries no platform token', () => {
    expect(platformFamilyGlob('@vscode/ripgrep')).toBeNull();
    expect(platformFamilyGlob('koffi')).toBeNull();
  });

  it('returns null for an unscoped name made only of platform tokens', () => {
    expect(platformFamilyGlob('win32-x64')).toBeNull();
  });
});

describe('the generated .vscodeignore allowlist', () => {
  const block = readFileSync(join(__dirname, '..', '..', '.vscodeignore'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('!node_modules/'));

  it('reads a non-empty block (guards the filter itself from matching nothing)', () => {
    expect(block.length).toBeGreaterThan(50);
  });

  it('names no single platform, so the block a Windows host writes matches what ubuntu checks', () => {
    const named = block.filter((line) =>
      line.split('/').some((segment) => segment.split('-').some((token) => PLATFORM_TOKENS.includes(token.toLowerCase()))),
    );
    expect(named).toEqual([]);
  });
});
