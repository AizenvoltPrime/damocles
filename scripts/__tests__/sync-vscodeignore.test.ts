import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';
import { allowPatterns, platformFamilyGlob, desktopOnlyIn, DESKTOP_ONLY_PACKAGES, DESKTOP_EXCLUDE_RULES, vsixExclusionProblems, forbiddenVsixEntries, isBuildToolPackage, requiredVsixEntries, vsixScopeProblems, distNegations } from '../sync-vscodeignore.ts';
import { EXTENSION_BUNDLE_FILES, WEBVIEW_DIST_FOLDER } from '../extension-bundles.ts';
import { readZip, zip } from '../server-archive.ts';

/**
 * `.github/workflows/release.yml` runs `sync-vscodeignore.ts --check` on `ubuntu-latest` while every
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
      '@fontsource-variable/geist', '@fontsource-variable/geist-mono', '@fontsource-variable/inter', '@devcontainers/cli',
    ]));
    const shipped = block.map((line) => line.slice('!node_modules/'.length).replace(/\/\*\*$/, ''));
    expect(desktopOnlyIn(shipped)).toEqual([]);
    expect(desktopOnlyIn(['zod', 'electron', 'undici', 'node-pty', '@xterm/xterm', '@xterm/addon-fit'])).toEqual(['@xterm/addon-fit', '@xterm/xterm', 'electron', 'node-pty']);
  });

  // The generator refuses esbuild at any depth of the closure; this pins the top-level half and the name match.
  it('carries no esbuild package', () => {
    const shipped = block.map((line) => line.slice('!node_modules/'.length).split('/'));
    expect(shipped.filter((segments) => isBuildToolPackage(segments[0]!.startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0]!))).toEqual([]);
    expect(['esbuild', '@esbuild/win32-x64', '@esbuild/linux-arm64', 'esbuild-wasm', 'zod'].filter(isBuildToolPackage)).toEqual(['esbuild', '@esbuild/win32-x64', '@esbuild/linux-arm64']);
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
      'dist/webview/assets/monaco-*', 'dist/desktop/**', 'dist/desktop-shell/**', 'dist/core-host.js', 'dist/daemon.js', 'dist/server-packages/**', 'dist/formatter-host.js', 'dist/pty-host.js', 'dist/quick-open-worker.js', 'dist/watch-worker.js', 'dist-desktop/**', 'dist/e2e*/**',
      'e2e/**', 'playwright.*.config.ts', 'electron-builder.yml', 'build/**', '**/*.log',
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

// A file left in dist/ (a probe, screenshots, a trace) must never ship; only the extension's own build output does.
describe('the dist allowlist', () => {
  const root = join(__dirname, '..', '..');
  const ignoreText = readFileSync(join(root, '.vscodeignore'), 'utf8');
  // vsce's own matcher and rule (@vscode/vsce out/package.js): a file is kept unless an ignore line matches it and no negation does.
  const { minimatch } = createRequire(join(root, 'node_modules', '@vscode', 'vsce', 'package.json'))('minimatch') as typeof import('minimatch');
  const lines = ignoreText.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));
  const ignores = lines.filter((line) => !line.startsWith('!'));
  const negations = lines.filter((line) => line.startsWith('!')).map((line) => line.slice(1));
  const ships = (file: string): boolean => !ignores.some((rule) => minimatch(file, rule, { dot: true })) || negations.some((rule) => minimatch(file, rule, { dot: true }));

  it('ships the extension bundles, dist/package.json and the webview build, and nothing else of dist/', () => {
    for (const file of ['dist/package.json', ...Object.values(EXTENSION_BUNDLE_FILES), 'dist/webview/index.html', 'dist/webview/assets/index-abc.js']) expect(ships(file), file).toBe(true);
    for (const file of ['dist/probe/trace-0.zip', 'dist/review/crop.png', 'dist/touched.txt', 'dist/cli.js', 'dist/bin/damocles', 'dist/server-bin/remote-cli', 'dist/desktop/main.js', 'dist/core-host.js', 'dist/webview/assets/monaco-editor.js', 'dist/extension.cjs.map', 'dist/.hidden']) {
      expect(ships(file), file).toBe(false);
    }
  });

  it('names exactly the bundles esbuild.config.ts builds for the extension', async () => {
    const { EXTENSION_BUNDLES } = await import('../../esbuild.config.ts');
    expect(EXTENSION_BUNDLES.map((bundle) => bundle.outfile).sort()).toEqual(Object.values(EXTENSION_BUNDLE_FILES).sort());
  });

  it('keeps the webview folder vite.config.ts writes', () => {
    expect(readFileSync(join(root, 'vite.config.ts'), 'utf8')).toContain(`outDir: '../../dist/${WEBVIEW_DIST_FOLDER}'`);
  });

  it('accepts only its own exact negations of dist/ files', () => {
    expect(distNegations()).toContain('!dist/extension.cjs');
    expect(vsixExclusionProblems(`${DESKTOP_EXCLUDE_RULES.join('\n')}\n${distNegations().join('\n')}\n`)).toEqual([]);
    expect(vsixExclusionProblems(`${DESKTOP_EXCLUDE_RULES.join('\n')}\n!dist/probe/trace.zip\n`)).toEqual(['the negation !dist/probe/trace.zip could re-include a desktop-only file']);
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
      'extension/dist/core-host.js',
      'extension/dist/daemon.js',
      'extension/dist/server-packages/damocles-server-1.0.0-linux-x64.tar.gz',
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
      'extension/playwright.remote.config.ts',
      'extension/playwright.journey.config.ts',
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
      'extension/dist/extension.cjs',
      'extension/dist/package.json',
      'extension/dist/compass-worker.js',
      'extension/dist/usage-stats-worker.js',
      'extension/dist/sentinel.js',
      'extension/dist/process-launcher-worker.js',
      'extension/dist/memory-integrity-worker.js',
      'extension/dist/session-meta-index-worker.js',
      'extension/dist/voice-extract-worker.js',
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

// The manifest says "type": "module", so without dist/package.json the workers load as ES modules and fail on require.
describe('vsixScopeProblems', () => {
  const MANIFEST = Buffer.from(JSON.stringify({ name: 'damocles', type: 'module', main: './dist/extension.cjs' }));
  const SCOPE = Buffer.from('{"type":"commonjs"}\n');
  const LISTING = ['extension/package.json', 'extension/dist/package.json', 'extension/dist/extension.cjs', 'extension/dist/process-launcher-worker.js'];
  const files = (scope: Buffer | null = SCOPE, manifest: Buffer | null = MANIFEST): Map<string, Buffer> => {
    const map = new Map<string, Buffer>();
    if (manifest) map.set('extension/package.json', manifest);
    if (scope) map.set('extension/dist/package.json', scope);
    return map;
  };

  it('requires the manifest, its main and the dist scope', () => {
    expect(requiredVsixEntries('./dist/extension.cjs')).toEqual(['extension/package.json', 'extension/dist/package.json', 'extension/dist/extension.cjs']);
    expect(requiredVsixEntries('dist/extension.cjs')).toContain('extension/dist/extension.cjs');
  });

  it('passes a VSIX whose dist/package.json declares commonjs', () => {
    expect(vsixScopeProblems(LISTING, files())).toEqual([]);
  });

  it('fails a VSIX without dist/package.json or its main entry', () => {
    expect(vsixScopeProblems(LISTING.filter((entry) => entry !== 'extension/dist/package.json'), files(null))).toEqual(['missing extension/dist/package.json']);
    expect(vsixScopeProblems(LISTING.filter((entry) => entry !== 'extension/dist/extension.cjs'), files())).toEqual(['missing extension/dist/extension.cjs']);
  });

  it('fails a dist/package.json that does not declare commonjs', () => {
    expect(vsixScopeProblems(LISTING, files(Buffer.from('{"type":"module"}')))).toEqual(['extension/dist/package.json declares type module, not commonjs']);
    expect(vsixScopeProblems(LISTING, files(Buffer.from('{}')))).toEqual(['extension/dist/package.json declares type none, not commonjs']);
  });

  it('fails a VSIX without a manifest main', () => {
    expect(vsixScopeProblems(LISTING, files(SCOPE, null))).toEqual(['no extension/package.json']);
    expect(vsixScopeProblems(LISTING, files(SCOPE, Buffer.from('{"type":"module"}')))).toEqual(['extension/package.json names no main']);
  });

  it('reads the two files from a real zip', () => {
    const archive = zip([
      { path: 'extension/package.json', mode: 0o644, data: MANIFEST },
      { path: 'extension/dist/package.json', mode: 0o644, data: SCOPE },
      { path: 'extension/dist/extension.cjs', mode: 0o644, data: Buffer.from('module.exports = {};') },
    ]);
    const wanted = new Set(['extension/package.json', 'extension/dist/package.json']);
    const read = readZip(archive, (path) => wanted.has(path));
    expect(read.map((entry) => entry.path)).toEqual(['extension/dist/package.json', 'extension/package.json']);
    expect(vsixScopeProblems(LISTING, new Map(read.map((entry) => [entry.path, entry.data])))).toEqual([]);
  });
});
