import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
// @ts-expect-error -- plain .mjs helper, no types
import { allowPatterns, platformFamilyGlob, desktopOnlyIn, DESKTOP_ONLY_PACKAGES, DESKTOP_EXCLUDE_RULES, vsixExclusionProblems, forbiddenVsixEntries } from '../sync-vscodeignore.mjs';

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

  // A narrowed package keeps only runtime extensions, so its license texts need their own re-include.
  it('keeps the license and notice files of narrowed packages', () => {
    const piMcpLicense = '@earendil-works/pi-mcp/**/modelcontextprotocol-typescript-sdk.txt';
    expect(allowPatterns('@earendil-works/pi-mcp')).toContain(piMcpLicense);
    expect(allowPatterns('@anthropic-ai/sdk')).toContain('@anthropic-ai/sdk/**/LICENSE');
    expect(allowPatterns('patchright-core')).toContain('patchright-core/**/ThirdPartyNotices.txt');
    expect(block).toContain(`!node_modules/${piMcpLicense}`);
  });

  // The desktop app's runtime and its editor, fonts, test and packaging tooling never ship in the VSIX.
  it('carries no desktop-only package', () => {
    expect(DESKTOP_ONLY_PACKAGES).toEqual(expect.arrayContaining([
      'electron', '@parcel/watcher', 'electron-updater', 'node-pty', 'monaco-editor', '@playwright/test', 'electron-builder', '@electron/fuses',
      '@fontsource-variable/geist', '@fontsource-variable/geist-mono', '@fontsource-variable/inter',
    ]));
    const shipped = block.map((line) => line.slice('!node_modules/'.length).replace(/\/\*\*$/, ''));
    expect(desktopOnlyIn(shipped)).toEqual([]);
    expect(desktopOnlyIn(['zod', 'electron', 'undici', 'node-pty', '@xterm/xterm', '@xterm/addon-fit'])).toEqual(['@xterm/addon-fit', '@xterm/xterm', 'electron', 'node-pty']);
  });
});

// Desktop output, Monaco, e2e specs and output, packaging config and logs must never enter the VSIX.
describe('vsixExclusionProblems', () => {
  const allRules = DESKTOP_EXCLUDE_RULES.join('\n');

  it('passes the committed .vscodeignore', () => {
    expect(vsixExclusionProblems(readFileSync(join(__dirname, '..', '..', '.vscodeignore'), 'utf8'))).toEqual([]);
  });

  it('names every desktop-only category', () => {
    expect(DESKTOP_EXCLUDE_RULES).toEqual(expect.arrayContaining([
      'dist/webview/assets/monaco-*', 'dist/desktop/**', 'dist/desktop-shell/**', 'dist/formatter-host.js', 'dist/pty-host.js', 'dist/quick-open-worker.js', 'dist/watch-worker.js', 'dist-desktop/**', 'dist/e2e*/**',
      'e2e/**', 'playwright.desktop.config.ts', 'electron-builder.yml', 'build/**', '**/*.log',
    ]));
  });

  it('fails for each missing rule', () => {
    for (const rule of DESKTOP_EXCLUDE_RULES) {
      const without = DESKTOP_EXCLUDE_RULES.filter((r: string) => r !== rule).join('\n');
      expect(vsixExclusionProblems(`node_modules/**\n${without}\n!README.md\n`)).toEqual([`missing the rule ${rule}`]);
    }
  });

  it('fails on a negation that could re-include a desktop-only file', () => {
    for (const negation of ['!dist/webview/**', '!**/*.js', '!dist/webview/assets/monaco-editor.js', '!*.css', '!e2e/desktop/app.ts', '!dist/desktop/main.js']) {
      expect(vsixExclusionProblems(`${allRules}\n${negation}\n`)).toEqual([`the negation ${negation} could re-include a desktop-only file`]);
    }
    expect(vsixExclusionProblems(`${allRules.replace(/\n/g, '\r\n')}\r\n!README.md\r\n!node_modules/zod/**\r\n`)).toEqual([]);
  });
});

// The release workflow runs this against every built VSIX, so it sees what vsce actually packed.
describe('forbiddenVsixEntries', () => {
  it('flags one path per exclusion rule and every desktop-only package', () => {
    const forbidden = [
      'extension/dist/webview/assets/monaco-editor-abc.js',
      'extension/dist/gate-test.log',
      'extension/python/damocles_voice_sidecar/run.log',
      'extension/dist/desktop/main.js',
      'extension/dist/desktop-shell/index.html',
      'extension/dist/formatter-host.js',
      'extension/dist/pty-host.js',
      'extension/dist/quick-open-worker.js',
      'extension/dist/watch-worker.js',
      'extension/dist/e2e/second-process.cjs',
      'extension/dist/e2e-results/.last-run.json',
      'extension/dist-desktop/win-unpacked/Damocles.exe',
      'extension/e2e/desktop/app.spec.ts',
      'extension/build/linux/apparmor.profile',
      'extension/types/no-vscode.d.ts',
      'extension/electron-builder.yml',
      'extension/playwright.desktop.config.ts',
      'extension/vite.shell.config.ts',
      'extension/resources/icon.ico',
      ...DESKTOP_ONLY_PACKAGES.map((name: string) => `extension/node_modules/${name}/package.json`),
      'extension/node_modules/@parcel/watcher-win32-x64/watcher.node',
      'extension/node_modules/@electron/asar/package.json',
      'extension/node_modules/node-pty/prebuilds/win32-x64/conpty.node',
      'extension/node_modules/@xterm/xterm/lib/xterm.js',
    ];
    expect(forbiddenVsixEntries(forbidden)).toEqual(forbidden);
  });

  it('keeps the extension runtime, including nested copies of a desktop-only package name', () => {
    const allowed = [
      'extension/package.json',
      'extension/dist/extension.js',
      'extension/dist/compass-worker.js',
      'extension/dist/usage-stats-worker.js',
      'extension/dist/sentinel.js',
      'extension/dist/webview/index.js',
      'extension/dist/webview/assets/index-abc.js',
      'extension/resources/grammars/tree-sitter-typescript.wasm',
      'extension/resources/icon.png',
      'extension/python/damocles_voice_sidecar/pyproject.toml',
      'extension/node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe',
      'extension/node_modules/@earendil-works/pi-coding-agent/node_modules/node-pty/package.json',
      'extension/node_modules/undici/index.js',
      'extension/node_modules/debug/src/index.js',
      'extension/node_modules/electron-to-chromium/package.json',
      'extension/l10n/bundle.l10n.json',
    ];
    expect(forbiddenVsixEntries(allowed)).toEqual([]);
  });
});
