import { createHash } from 'crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ASKPASS_SCRIPTS,
  checkAppUpdate,
  checkAsarEntries,
  checkAskpassScripts,
  checkCliScripts,
  checkCredentialHelperScripts,
  checkAskpassTrampoline,
  checkChangelog,
  checkCoreHost,
  checkNoDaemon,
  checkNoThemeValidator,
  checkBuiltinThemes,
  checkLinuxDesktopEntry,
  checkLinuxSchemeHandlers,
  checkMacUrlScheme,
  checkWindowsSchemeRegistration,
  findCpioEntry,
  findInToolOutput,
  findTarEntry,
  LINUX_DESKTOP_ENTRY,
  checkServerManifest,
  checkFuses,
  checkNodePtyLayout,
  checkShellIntegrationScripts,
  checkSpawnHelperMode,
  checkUnpackedSet,
  checkWakeModel,
  EXPECTED_FUSES,
  SHELL_INTEGRATION_FILES,
  verifyPackage,
  WINDOWS_PUBLISHER,
  WORKERS,
} from '../verify-desktop-package.ts';
import { parse } from 'yaml';
import { ASAR_UNPACK } from '../../src/desktop/main/platform/unpacked-assets';
import { CREDENTIAL_RELAY_SCRIPTS } from '../../esbuild.config.ts';
import { desktopArtifacts } from '../release-targets.ts';

type Result = { check: string; ok: boolean; detail: string };

const CHANGELOG = ['# Changelog', '', '## [2.36.0] - 2026-01-02', '- notes', ''].join('\n');

// What esbuild writes for registerThemeLinkScheme (src/desktop/main/index.ts) into the unminified dist/desktop/main.js.
const MAIN_BUNDLE = [
  'var THEME_LINK_SCHEME = "damocles";',
  'var END_OF_OPTIONS = "--";',
  'function registerThemeLinkScheme() {',
  '  if (!await registersLinkScheme({ platform: process.platform, packaged: import_electron.app.isPackaged, argv: process.argv, installed })) return;',
  '  if (!import_electron.app.setAsDefaultProtocolClient(THEME_LINK_SCHEME, process.execPath, [END_OF_OPTIONS])) log("refused");',
  '}',
].join('\n');

// The URL types electron-builder writes into Contents/Info.plist from electron-builder.yml protocols.
const INFO_PLIST = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<plist version="1.0">',
  '<dict>',
  '  <key>CFBundleURLTypes</key>',
  '  <array>',
  '    <dict>',
  '      <key>CFBundleURLName</key>',
  '      <string>Damocles theme link</string>',
  '      <key>CFBundleURLSchemes</key>',
  '      <array>',
  '        <string>damocles</string>',
  '      </array>',
  '    </dict>',
  '  </array>',
  '  <key>LSApplicationCategoryType</key>',
  '  <string>public.app-category.developer-tools</string>',
  '</dict>',
  '</plist>',
].join('\n');

// What electron-builder's LinuxTargetHelper writes for linux.executableName damocles and the damocles protocol.
const DESKTOP_ENTRY = [
  '[Desktop Entry]',
  'Name=Damocles',
  'Exec=/opt/Damocles/damocles %U',
  'Terminal=false',
  'Type=Application',
  'Icon=damocles',
  'StartupWMClass=Damocles',
  'MimeType=x-scheme-handler/damocles;',
  'Categories=Development;',
  '',
].join('\n');

// FuseV1Options indexes and FuseState bytes from @electron/fuses 2.1.3.
const ENABLE = 49;
const DISABLE = 48;
const EXPECTED_WIRE = { version: '1', 0: ENABLE, 1: ENABLE, 2: DISABLE, 3: DISABLE, 4: ENABLE, 5: ENABLE, 6: DISABLE, 7: DISABLE, 8: ENABLE };

const failures = (results: Result[]): string[] => results.filter((r) => !r.ok).map((r) => r.check);

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('WORKERS', () => {
  it('names every top-level dist script the desktop build writes but Damocles Core, which stays packed, the loopback daemon, which never ships, and a target terminal\'s damocles command, which only a server package carries', async () => {
    const { DESKTOP_BUNDLES } = await import('../../esbuild.config.ts');
    const outfiles = DESKTOP_BUNDLES.map((bundle) => /^dist\/([^/]+\.js)$/.exec(bundle.outfile)?.[1])
      .filter((name): name is string => name !== undefined && name !== 'core-host.js' && name !== 'daemon.js' && name !== 'cli-remote.js');
    expect(outfiles).toContain('cli.js');
    expect(outfiles).toContain('process-launcher-worker.js');
    expect([...WORKERS].sort()).toEqual(outfiles.sort());
  });
});

describe('checkFuses', () => {
  it('passes the expected wire and reports the two fuses electron-builder.yml leaves at Electron defaults', () => {
    const results: Result[] = checkFuses(EXPECTED_WIRE);
    expect(failures(results)).toEqual([]);
    expect(results.map((r) => r.check)).toEqual(expect.arrayContaining(['fuse LoadBrowserProcessSpecificV8Snapshot', 'fuse WasmTrapHandlers']));
    expect(Object.keys(EXPECTED_FUSES)).toHaveLength(7);
  });

  it('fails a flipped fuse, a missing fuse and a fuse index nobody reviewed', () => {
    expect(failures(checkFuses({ ...EXPECTED_WIRE, 3: ENABLE }))).toEqual(['fuse EnableNodeCliInspectArguments']);
    const { 7: _dropped, ...withoutGrant } = EXPECTED_WIRE;
    expect(failures(checkFuses(withoutGrant))).toEqual(['fuse GrantFileProtocolExtraPrivileges']);
    expect(failures(checkFuses({ ...EXPECTED_WIRE, 9: DISABLE }))).toEqual(['fuse #9']);
    expect(failures(checkFuses({ ...EXPECTED_WIRE, version: '2' }))).toEqual(['fuses']);
  });
});

describe('checkUnpackedSet', () => {
  it('fails a file outside the globs and a glob that matches nothing', () => {
    const files = ['dist/sentinel.js', 'node_modules/koffi/index.cjs'];
    expect(failures(checkUnpackedSet(files, ['dist/sentinel.js', 'python/**']))).toEqual(['unpacked set', 'unpacked globs']);
    expect(failures(checkUnpackedSet(['dist/sentinel.js'], ['dist/sentinel.js']))).toEqual([]);
  });
});

describe('checkAppUpdate', () => {
  const feed = 'owner: AizenvoltPrime\nrepo: damocles\nprovider: github\nupdaterCacheDirName: damocles-updater\n';
  const publisher = 'publisherName:\n  - SignPath Foundation\n';

  it('requires the per-arch channel on Windows and the default feed elsewhere', () => {
    expect(failures(checkAppUpdate(`${feed}channel: latest-arm64\n${publisher}`, 'win32', 'arm64'))).toEqual([]);
    expect(failures(checkAppUpdate(`${feed}channel: latest-x64\n${publisher}`, 'win32', 'arm64'))).toEqual(['app-update.yml']);
    expect(failures(checkAppUpdate(`${feed}${publisher}`, 'win32', 'x64'))).toEqual(['app-update.yml']);
    expect(failures(checkAppUpdate(feed, 'linux', 'arm64'))).toEqual([]);
    expect(failures(checkAppUpdate(`${feed}channel: latest-x64\n`, 'darwin', 'arm64'))).toEqual(['app-update.yml']);
  });

  it('requires the release certificate as the Windows update publisher, and no publisher elsewhere', () => {
    expect(failures(checkAppUpdate(`${feed}channel: latest-x64\n`, 'win32', 'x64'))).toEqual(['app-update.yml']);
    expect(failures(checkAppUpdate(`${feed}channel: latest-x64\npublisherName:\n  - Someone Else\n`, 'win32', 'x64'))).toEqual(['app-update.yml']);
    expect(failures(checkAppUpdate(`${feed}${publisher}`, 'linux', 'x64'))).toEqual(['app-update.yml']);
  });

  it('agrees with the publisher electron-builder.yml writes', () => {
    const config = parse(readFileSync(join(__dirname, '..', '..', 'electron-builder.yml'), 'utf8')) as { win: { signtoolOptions: { publisherName: string } } };
    expect(config.win.signtoolOptions.publisherName).toBe(WINDOWS_PUBLISHER);
  });

  it('fails a missing file and a different repository', () => {
    expect(failures(checkAppUpdate(undefined, 'linux', 'x64'))).toEqual(['app-update.yml']);
    expect(failures(checkAppUpdate(feed.replace('repo: damocles', 'repo: other'), 'linux', 'x64'))).toEqual(['app-update.yml']);
  });
});

describe('checkAsarEntries', () => {
  it('fails sources, source maps and build tooling', () => {
    expect(failures(checkAsarEntries(['dist/desktop/main.js', 'node_modules/zod/index.js']))).toEqual([]);
    for (const entry of ['src/core/x.ts', 'dist/desktop/main.js.map', 'node_modules/esbuild/package.json', 'node_modules/electron/index.js', 'e2e/desktop/a.spec.ts']) {
      expect(failures(checkAsarEntries([entry])), entry).toEqual(['asar contents']);
    }
  });

  it('fails a node_modules copy of a library the theme code bundles, which package.json keeps in devDependencies', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    for (const name of ['css-tree', 'fflate', 'jsonc-parser', '@material/material-color-utilities']) {
      expect(Object.keys(manifest.dependencies), name).not.toContain(name);
      expect(Object.keys(manifest.devDependencies), name).toContain(name);
      expect(failures(checkAsarEntries([`node_modules/${name}/package.json`])), name).toEqual(['asar contents']);
    }
  });

  it('fails a second copy of the built-in themes, and electron-builder.yml leaves that copy out', () => {
    expect(failures(checkAsarEntries(['dist/desktop-shell/themes/damocles-paper/theme.json']))).toEqual([]);
    expect(failures(checkAsarEntries(['resources/themes/damocles-paper/theme.json']))).toEqual(['asar contents']);
    const config = parse(readFileSync(new URL('../../electron-builder.yml', import.meta.url), 'utf8')) as { files: string[] };
    expect(config.files).toContain('!resources/themes{,/**}');
    expect(config.files).toContain('dist/desktop-shell/**');
  });
});

describe('checkNoDaemon', () => {
  it('passes a package without the loopback daemon and fails one that ships it, packed or unpacked', () => {
    expect(failures(checkNoDaemon([{ path: 'dist/core-host.js', entry: { unpacked: false } }], []))).toEqual([]);
    expect(checkNoDaemon([{ path: 'dist/daemon.js', entry: { unpacked: false } }], [])[0]!.detail).toBe('dist/daemon.js ships in app.asar');
    expect(checkNoDaemon([], ['dist/daemon.js'])[0]!.detail).toBe('dist/daemon.js ships in app.asar.unpacked');
  });
});

describe('checkBuiltinThemes', () => {
  const PACKED = 'dist/desktop-shell/themes/';
  const source: Record<string, Buffer> = {
    'damocles-paper/theme.json': Buffer.from('{"name":"Paper"}'),
    'damocles-paper/LICENSE': Buffer.from('MIT'),
    'damocles-aurora/wallpaper.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0d, 0x0a]),
  };
  const files = Object.keys(source);
  const check = (shipped: Record<string, Buffer>): Result => checkBuiltinThemes(Object.keys(shipped), files, (file) => source[file], (file) => shipped[file])[0]!;
  const packed = (): Record<string, Buffer> => Object.fromEntries(files.map((file) => [`${PACKED}${file}`, source[file]!]));

  it('passes when the shell build holds every resources/themes file with the repo\'s bytes, and names each one missing', () => {
    expect(check({ ...packed(), 'dist/core-host.js': Buffer.from('') })).toEqual({ check: 'built-in themes', ok: true, detail: '3 files identical to the repo' });
    const withoutLicense = packed();
    delete withoutLicense[`${PACKED}damocles-paper/LICENSE`];
    expect(check(withoutLicense).detail).toBe('missing dist/desktop-shell/themes/damocles-paper/LICENSE');
    expect(failures(checkBuiltinThemes([], [], () => undefined, () => undefined))).toHaveLength(1);
  });

  it('fails a theme file whose bytes differ, a truncated wallpaper and a file the repo does not have', () => {
    expect(check({ ...packed(), [`${PACKED}damocles-paper/theme.json`]: Buffer.from('{"name":"Other"}') }).detail).toBe('differ from the repo: damocles-paper/theme.json');
    expect(check({ ...packed(), [`${PACKED}damocles-aurora/wallpaper.png`]: source['damocles-aurora/wallpaper.png']!.subarray(0, 5) }).detail).toBe('differ from the repo: damocles-aurora/wallpaper.png');
    expect(check({ ...packed(), [`${PACKED}damocles-old/theme.json`]: Buffer.from('{}') }).detail).toBe('not in the repo: dist/desktop-shell/themes/damocles-old/theme.json');
  });
});

describe('checkNoThemeValidator', () => {
  it('passes a package without the theme validator and fails one that ships its launcher or Electron host, packed or unpacked', () => {
    expect(failures(checkNoThemeValidator([{ path: 'dist/core-host.js', entry: { unpacked: false } }, { path: 'dist/theme-validated.js', entry: { unpacked: false } }], []))).toEqual([]);
    expect(checkNoThemeValidator([{ path: 'dist/theme-validate.js', entry: { unpacked: false } }], [])[0]!.detail).toBe('must not ship: dist/theme-validate.js in app.asar');
    expect(checkNoThemeValidator([{ path: 'dist/theme-validate/host.js', entry: { unpacked: false } }], [])[0]!.detail).toBe('must not ship: dist/theme-validate/host.js in app.asar');
    expect(checkNoThemeValidator([], ['dist/theme-validate/host.js'])[0]!.detail).toBe('must not ship: dist/theme-validate/host.js in app.asar.unpacked');
  });

  it('names every file the validator build writes', async () => {
    const { themeValidatorOptions } = await import('../../esbuild.config.ts');
    expect(themeValidatorOptions.map((options) => options.outfile).filter((file) => failures(checkNoThemeValidator([{ path: file, entry: { unpacked: false } }], [])).length === 0)).toEqual([]);
  });

  it('is what electron-builder.yml packs: no files pattern names the validator', () => {
    const config = readFileSync(new URL('../../electron-builder.yml', import.meta.url), 'utf8');
    expect(config).not.toMatch(/theme-validate/);
    expect(config).not.toMatch(/^\s*-\s*dist\/\*\*\s*$/m);
  });
});

describe('damocles:// scheme', () => {
  it('is what electron-builder.yml declares, for the macOS Info.plist and the Linux .desktop file', () => {
    const config = parse(readFileSync(new URL('../../electron-builder.yml', import.meta.url), 'utf8')) as { protocols?: Array<{ schemes?: string[] }> };
    expect(config.protocols?.flatMap((protocol) => protocol.schemes ?? [])).toContain('damocles');
  });

  // The uninstaller must find exactly the command line app.setAsDefaultProtocolClient writes, or it leaves the key behind.
  it('is removed by the Windows uninstaller only when it names this install and only on a real removal', () => {
    const nsh = readFileSync(new URL('../../build/win/installer.nsh', import.meta.url), 'utf8');
    const uninstall = nsh.slice(nsh.indexOf('!macro customUnInstall'));
    const removal = uninstall.slice(uninstall.indexOf('${ifNot} ${isUpdated}'));
    expect(removal).toContain('ReadRegStr $1 HKCU "Software\\Classes\\damocles\\shell\\open\\command" ""');
    expect(removal).toContain('${if} $1 == \'"$INSTDIR\\${APP_EXECUTABLE_FILENAME}" "--" "%1"\'');
    expect(removal).toContain('DeleteRegKey HKCU "Software\\Classes\\damocles"');
  });

  it('passes a macOS Info.plist whose CFBundleURLTypes lists damocles, and fails one that lists it only elsewhere', () => {
    expect(checkMacUrlScheme(INFO_PLIST).ok).toBe(true);
    expect(checkMacUrlScheme(undefined).detail).toBe('Contents/Info.plist is missing');
    expect(checkMacUrlScheme(INFO_PLIST.replace(/<key>CFBundleURLTypes<\/key>[^]*?<\/array>\s*<\/dict>\s*<\/array>/, '')).detail).toBe('Contents/Info.plist has no CFBundleURLTypes');
    const elsewhere = INFO_PLIST
      .replace('<string>damocles</string>', '<string>other</string>')
      .replace('<key>LSApplicationCategoryType</key>', '<key>Unrelated</key><array><dict><key>CFBundleURLSchemes</key><array><string>damocles</string></array></dict></array>\n  <key>LSApplicationCategoryType</key>');
    expect(checkMacUrlScheme(elsewhere).detail).toBe('Info.plist CFBundleURLTypes lists [other], not damocles');
  });

  it('passes a .desktop entry that handles x-scheme-handler/damocles and passes the link, and names each gap', () => {
    expect(checkLinuxDesktopEntry('damocles_2.36.0_amd64.deb', Buffer.from(DESKTOP_ENTRY))).toEqual({
      check: 'damocles:// scheme damocles_2.36.0_amd64.deb',
      ok: true,
      detail: '/usr/share/applications/damocles.desktop handles x-scheme-handler/damocles',
    });
    expect(checkLinuxDesktopEntry('a.deb', Buffer.from(DESKTOP_ENTRY.replace('\n', '\r\n').replace('MimeType=x-scheme-handler/damocles;', 'MimeType=text/plain;x-scheme-handler/damocles;'))).ok).toBe(true);
    expect(checkLinuxDesktopEntry('a.deb', undefined).detail).toBe('/usr/share/applications/damocles.desktop is not in the package');
    expect(checkLinuxDesktopEntry('a.deb', Buffer.from(DESKTOP_ENTRY.replace('MimeType=x-scheme-handler/damocles;\n', '').replace(' %U', ''))).detail)
      .toBe('MimeType does not list x-scheme-handler/damocles; Exec takes no %U or %u, so the link never reaches the app');
    expect(checkLinuxDesktopEntry('a.deb', Buffer.from(`${DESKTOP_ENTRY.replace('MimeType=x-scheme-handler/damocles;\n', '')}\n[Desktop Action new]\nMimeType=x-scheme-handler/damocles;\n`)).ok).toBe(false);
  });

  it('passes a Windows main bundle that registers the scheme with -- before the link, through constants or literally, and fails one that does not', () => {
    expect(checkWindowsSchemeRegistration(MAIN_BUNDLE).ok).toBe(true);
    expect(checkWindowsSchemeRegistration(MAIN_BUNDLE.replaceAll('THEME_LINK_SCHEME', 'THEME_LINK_SCHEME2').replaceAll('END_OF_OPTIONS', 'END_OF_OPTIONS2')).ok).toBe(true);
    expect(checkWindowsSchemeRegistration('app.setAsDefaultProtocolClient("damocles", process.execPath, ["--"]);').ok).toBe(true);
    expect(checkWindowsSchemeRegistration(undefined).detail).toBe('dist/desktop/main.js is not in app.asar');
    expect(checkWindowsSchemeRegistration(MAIN_BUNDLE.replace('setAsDefaultProtocolClient(THEME_LINK_SCHEME', 'isDefaultProtocolClient(THEME_LINK_SCHEME')).ok).toBe(false);
    expect(checkWindowsSchemeRegistration(MAIN_BUNDLE.replace('"damocles"', '"damocles-dev"')).ok).toBe(false);
    // a registration that puts nothing between the executable and the link lets a link's words be read as flags
    const bare = checkWindowsSchemeRegistration('app.setAsDefaultProtocolClient("damocles");');
    expect(bare.ok).toBe(false);
    expect(bare.detail).toBe("dist/desktop/main.js never calls app.setAsDefaultProtocolClient('damocles', process.execPath, ['--'])");
    expect(checkWindowsSchemeRegistration('app.setAsDefaultProtocolClient("damocles", process.execPath, []);').ok).toBe(false);
    expect(checkWindowsSchemeRegistration(MAIN_BUNDLE.replace('"--"', '"--open"')).ok).toBe(false);
  });
});

describe('package archive readers', () => {
  // Feeds the archive in 7-byte chunks, so headers, names and contents straddle chunk boundaries.
  async function* chunks(bytes: Buffer): AsyncGenerator<Buffer> {
    for (let offset = 0; offset < bytes.length; offset += 7) yield bytes.subarray(offset, offset + 7);
  }

  function tarEntry(name: string, content: string, { type = '0', prefix = '', gnu = false } = {}): Buffer {
    const data = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 'utf8');
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
    header.write(type, 156, 'ascii');
    header.write(gnu ? 'ustar  \0' : 'ustar\u000000', 257, 'latin1');
    if (prefix !== '') header.write(prefix, 345, 'utf8');
    return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
  }

  function cpioEntry(name: string, content: string, mode = 0o100644): Buffer {
    const data = Buffer.from(content);
    const path = Buffer.from(`${name}\0`);
    const fields = [0, mode, 0, 0, 1, 0, data.length, 0, 0, 0, 0, path.length, 0];
    const pad = (n: number): Buffer => Buffer.alloc((4 - (n % 4)) % 4);
    return Buffer.concat([Buffer.from(`070701${fields.map((field) => field.toString(16).padStart(8, '0')).join('')}`, 'ascii'), path, pad(110 + path.length), data, pad(data.length)]);
  }

  it('finds a regular file in a tar stream past long-name records, a ustar prefix and a same-named link', async () => {
    const longName = `./opt/Damocles/resources/app.asar.unpacked/${'x'.repeat(120)}`;
    const tar = Buffer.concat([
      tarEntry('././@LongLink', longName, { type: 'L', gnu: true }),
      tarEntry(longName.slice(0, 99), 'a'.repeat(700), { gnu: true }),
      tarEntry('./usr/share/applications/', '', { type: '5' }),
      tarEntry(`./${LINUX_DESKTOP_ENTRY}`, '', { type: '2' }),
      tarEntry('damocles.desktop', DESKTOP_ENTRY, { prefix: './usr/share/applications' }),
      Buffer.alloc(1024),
    ]);
    expect((await findTarEntry(chunks(tar), LINUX_DESKTOP_ENTRY))?.toString()).toBe(DESKTOP_ENTRY);
    expect(await findTarEntry(chunks(tar), 'usr/share/applications/other.desktop')).toBeUndefined();
    // a GNU header's bytes 345 on are times, never a name prefix
    const gnu = Buffer.concat([tarEntry('damocles.desktop', DESKTOP_ENTRY, { gnu: true, prefix: '0000' }), Buffer.alloc(1024)]);
    expect((await findTarEntry(chunks(gnu), 'damocles.desktop'))?.toString()).toBe(DESKTOP_ENTRY);
  });

  it('finds a regular file in a newc cpio stream and stops at the trailer', async () => {
    const cpio = Buffer.concat([
      cpioEntry('./opt/Damocles', '', 0o040755),
      cpioEntry('./opt/Damocles/damocles', 'elf'.repeat(50), 0o100755),
      cpioEntry(`./${LINUX_DESKTOP_ENTRY}`, DESKTOP_ENTRY),
      cpioEntry('TRAILER!!!', ''),
    ]);
    expect((await findCpioEntry(chunks(cpio), LINUX_DESKTOP_ENTRY))?.toString()).toBe(DESKTOP_ENTRY);
    expect(await findCpioEntry(chunks(cpio), 'usr/share/applications/other.desktop')).toBeUndefined();
    expect(await findCpioEntry(chunks(Buffer.concat([cpioEntry('TRAILER!!!', ''), cpioEntry(`./${LINUX_DESKTOP_ENTRY}`, DESKTOP_ENTRY)])), LINUX_DESKTOP_ENTRY)).toBeUndefined();
    expect(await findCpioEntry(chunks(Buffer.concat([cpioEntry(`./${LINUX_DESKTOP_ENTRY}`, '', 0o120777)])), LINUX_DESKTOP_ENTRY)).toBeUndefined();
  });

  it('throws for a stream that is no archive or ends inside an entry, so undefined means only that the entry is absent', async () => {
    await expect(findCpioEntry(chunks(Buffer.alloc(300, 0x78)), LINUX_DESKTOP_ENTRY)).rejects.toThrow('not a newc cpio archive at offset 0');
    const cpio = Buffer.concat([cpioEntry('./opt/Damocles/damocles', 'elf'.repeat(50), 0o100755), cpioEntry(`./${LINUX_DESKTOP_ENTRY}`, DESKTOP_ENTRY)]);
    await expect(findCpioEntry(chunks(Buffer.concat([cpio, Buffer.from('junk'.repeat(40))])), 'usr/share/applications/other.desktop')).rejects.toThrow(`not a newc cpio archive at offset ${cpio.length}`);
    await expect(findCpioEntry(chunks(cpio.subarray(0, 60)), LINUX_DESKTOP_ENTRY)).rejects.toThrow('the archive ends inside an entry, at offset 60');
    await expect(findCpioEntry(chunks(cpio.subarray(0, cpio.length - 8)), LINUX_DESKTOP_ENTRY)).rejects.toThrow('the archive ends inside an entry');
    await expect(findTarEntry(chunks(Buffer.alloc(2048, 0x78)), LINUX_DESKTOP_ENTRY)).rejects.toThrow('not a tar archive at offset 0');
    const tar = tarEntry(`./${LINUX_DESKTOP_ENTRY}`, DESKTOP_ENTRY);
    await expect(findTarEntry(chunks(tar.subarray(0, 300)), LINUX_DESKTOP_ENTRY)).rejects.toThrow('the archive ends inside an entry, at offset 300');
    await expect(findTarEntry(chunks(tar.subarray(0, 520)), LINUX_DESKTOP_ENTRY)).rejects.toThrow('the archive ends inside an entry');
    await expect(findTarEntry(chunks(tar.subarray(0, 600)), 'usr/share/applications/other.desktop')).rejects.toThrow('the archive ends inside an entry');
  });

  // The child writes more than a pipe holds, so it never exits while its output is left unread.
  it('rejects for a tool whose output is no archive, without waiting on output nobody reads', async () => {
    const junk = 'process.stdout.write(Buffer.alloc(4 * 1024 * 1024, 0x78))';
    await expect(findInToolOutput(process.execPath, ['-e', junk], (stream) => findCpioEntry(stream, LINUX_DESKTOP_ENTRY))).rejects.toThrow('not a newc cpio archive at offset 0');
  }, 20_000);

  // dpkg-deb forks the processes that write its output; they outlive a kill of dpkg-deb itself and hold the pipe open.
  it('ends a tool\'s own child that still writes once the entry is found', async () => {
    const placeholder = 'PIDPIDPIDP';
    const archive = cpioEntry(`./${LINUX_DESKTOP_ENTRY}`, placeholder).toString('base64');
    const writer = [
      `const bytes = Buffer.from('${archive}', 'base64');`,
      `bytes.write(String(process.pid).padStart(${placeholder.length}), bytes.indexOf('${placeholder}'));`,
      'process.stdout.write(bytes);',
      'const fill = () => { while (process.stdout.write(Buffer.alloc(65536))); process.stdout.once(\'drain\', fill); };',
      'fill();',
    ].join('');
    const tool = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(writer)}], { stdio: ['ignore', 'inherit', 'ignore'] }); setInterval(() => {}, 1000);`;
    const found = await findInToolOutput(process.execPath, ['-e', tool], (stream) => findCpioEntry(stream, LINUX_DESKTOP_ENTRY));
    const pid = Number(found?.toString());
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      expect(pid).toBeGreaterThan(0);
      await expect.poll(alive, { timeout: 10_000 }).toBe(false);
    } finally {
      if (alive()) process.kill(pid);
    }
  }, 20_000);

  it('reads a tool\'s output to its end before it reports the entry absent or the tool failed', async () => {
    const archive = Buffer.concat([cpioEntry('./opt/Damocles/damocles', 'elf'), cpioEntry('TRAILER!!!', '')]).toString('base64');
    const write = (code: number): string[] => ['-e', `process.stdout.write(Buffer.concat([Buffer.from('${archive}', 'base64'), Buffer.alloc(4 * 1024 * 1024)]), () => process.exit(${code}))`];
    const find = (stream: AsyncIterable<Buffer>): Promise<Buffer | undefined> => findCpioEntry(stream, LINUX_DESKTOP_ENTRY);
    await expect(findInToolOutput(process.execPath, write(0), find)).resolves.toBeUndefined();
    await expect(findInToolOutput(process.execPath, write(3), find)).rejects.toThrow(/exited with 3/);
  }, 20_000);

  it('checks the deb and rpm beside the unpacked app, and fails a missing or unreadable one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vdp-linux'));
    tempDirs.push(root);
    const [deb, rpm, missing] = ['damocles_2.36.0_amd64.deb', 'damocles-2.36.0.x86_64.rpm', 'damocles_2.36.0_arm64.deb'].map((name) => join(root, name));
    put(deb!);
    put(rpm!);
    const read = async (file: string, name: string): Promise<Buffer | undefined> => {
      expect(name).toBe(LINUX_DESKTOP_ENTRY);
      if (file === rpm) throw new Error('rpm2cpio exited with 1: not an rpm package');
      return Buffer.from(DESKTOP_ENTRY);
    };
    const results: Result[] = await checkLinuxSchemeHandlers([deb!, rpm!, missing!], read);
    expect(results.map(({ check, ok }) => [check, ok])).toEqual([
      ['damocles:// scheme damocles_2.36.0_amd64.deb', true],
      ['damocles:// scheme damocles-2.36.0.x86_64.rpm', false],
      ['damocles:// scheme damocles_2.36.0_arm64.deb', false],
    ]);
    expect(results[1]!.detail).toBe(`cannot read ${rpm}: rpm2cpio exited with 1: not an rpm package`);
    expect(results[2]!.detail).toBe(`${missing} is missing; build the deb/rpm targets, not --dir`);
  });
});

describe('checkServerManifest', () => {
  const release = (version: string, sha: string, build = 'a'.repeat(12)) => ({
    version,
    protocolVersion: 1,
    published: true,
    packages: Object.fromEntries(['linux-x64', 'win32-x64'].map((target) => [target, { file: `damocles-server-${version}-${target}.${target.startsWith('win32') ? 'zip' : 'tar.gz'}`, sha256: sha.repeat(64), size: 10, serverVersion: `${version}+${build}` }])),
  });

  it('passes a published manifest naming exactly the release packages', () => {
    expect(failures(checkServerManifest(JSON.stringify(release('3.7.0', 'a')), '3.7.0', release('3.7.0', 'a')))).toEqual([]);
  });

  it('fails a missing manifest, one the app cannot read, another version\'s and one whose hashes differ', () => {
    expect(checkServerManifest(undefined, '3.7.0', release('3.7.0', 'a'))[0]!.detail).toBe('dist/desktop/server-manifest.json is not in app.asar');
    expect(checkServerManifest(JSON.stringify({ ...release('3.7.0', 'a'), version: '..' }), '3.7.0', release('3.7.0', 'a'))[0]!.detail).toMatch(/does not parse/);
    expect(checkServerManifest(JSON.stringify(release('3.6.0', 'a')), '3.7.0', release('3.7.0', 'a'))[0]!.detail).toMatch(/it is for 3\.6\.0, the app is 3\.7\.0/);
    expect(checkServerManifest(JSON.stringify(release('3.7.0', 'b')), '3.7.0', release('3.7.0', 'a'))[0]!.detail).toBe(`linux-x64 is not damocles-server-3.7.0-linux-x64.tar.gz with its SHA-256, size and server version 3.7.0+${'a'.repeat(12)}; win32-x64 is not damocles-server-3.7.0-win32-x64.zip with its SHA-256, size and server version 3.7.0+${'a'.repeat(12)}`);
  });

  it('fails an unpublished manifest, whose hosts would never download, and another build\'s server versions', () => {
    expect(checkServerManifest(JSON.stringify({ ...release('3.7.0', 'a'), published: false }), '3.7.0', release('3.7.0', 'a'))[0]!.detail).toMatch(/^it is unpublished/);
    expect(checkServerManifest(JSON.stringify(release('3.7.0', 'a', 'b'.repeat(12))), '3.7.0', release('3.7.0', 'a'))[0]!.detail).toMatch(/^linux-x64 is not .* server version 3\.7\.0\+a{12}; win32-x64/);
  });
});

// utilityProcess.fork loads the core host from inside app.asar; an unpacked copy would run outside asar integrity.
describe('checkCoreHost', () => {
  const packed = { path: 'dist/core-host.js', entry: {} };

  it('passes the bundle inside app.asar only', () => {
    expect(failures(checkCoreHost([packed], []))).toEqual([]);
  });

  it('fails a missing bundle, one marked unpacked and an unpacked copy', () => {
    expect(checkCoreHost([], [])[0]!.detail).toBe('not in app.asar');
    expect(checkCoreHost([{ path: 'dist/core-host.js', entry: { unpacked: true } }], [])[0]!.detail).toBe('marked unpacked in app.asar');
    expect(checkCoreHost([packed], ['dist/core-host.js'])[0]!.detail).toBe('has a copy in app.asar.unpacked');
  });
});

describe('checkNodePtyLayout', () => {
  const pty = 'node_modules/node-pty';
  const packedJs = [`${pty}/package.json`, `${pty}/lib/index.js`, `${pty}/lib/unixTerminal.js`];
  const linux = [`${pty}/prebuilds/linux-x64/pty.node`];

  it('passes the target prebuild, unpacked, with the loader in app.asar', () => {
    expect(failures(checkNodePtyLayout('linux', 'x64', [...packedJs, ...linux], linux))).toEqual([]);
    const win = [`${pty}/prebuilds/win32-arm64/conpty.node`, `${pty}/prebuilds/win32-arm64/conpty_console_list.node`, `${pty}/prebuilds/win32-arm64/conpty/conpty.dll`];
    expect(failures(checkNodePtyLayout('win32', 'arm64', [...packedJs, ...win], win))).toEqual([]);
  });

  it('fails a second prebuild directory and a prebuild for another target', () => {
    const extra = `${pty}/prebuilds/linux-arm64/pty.node`;
    expect(failures(checkNodePtyLayout('linux', 'x64', [...packedJs, ...linux, extra], [...linux, extra]))).toEqual(['node-pty prebuild']);
    expect(failures(checkNodePtyLayout('linux', 'arm64', [...packedJs, ...linux], linux))).toEqual(['node-pty prebuild', 'node-pty binaries']);
  });

  it('fails a missing native binary', () => {
    const helperOnly = [`${pty}/prebuilds/darwin-arm64/spawn-helper`];
    expect(checkNodePtyLayout('darwin', 'arm64', [...packedJs, ...helperOnly], helperOnly).find((r: Result) => !r.ok)?.detail).toBe('missing from app.asar.unpacked: pty.node');
  });

  it('fails debug symbols and native sources', () => {
    for (const junk of [`${pty}/prebuilds/linux-x64/pty.pdb`, `${pty}/build/Release/conpty/conpty.dll`, `${pty}/src/unix/pty.cc`, `${pty}/third_party/conpty/x.dll`, `${pty}/scripts/prebuild.js`, `${pty}/deps/x.h`]) {
      expect(failures(checkNodePtyLayout('linux', 'x64', [...packedJs, ...linux, junk], linux)), junk).toEqual(['node-pty trimmed']);
    }
  });

  // Loaded from app.asar.unpacked, node-pty would rewrite its spawn-helper path to app.asar.unpacked.unpacked.
  it('fails a loader that is unpacked or missing', () => {
    expect(failures(checkNodePtyLayout('linux', 'x64', [...packedJs, ...linux], [...linux, `${pty}/lib/index.js`]))).toEqual(['node-pty loader']);
    expect(failures(checkNodePtyLayout('linux', 'x64', linux, linux))).toEqual(['node-pty loader']);
  });
});

describe('checkShellIntegrationScripts', () => {
  const lf = Buffer.from('a\nb\n');
  it('requires every script, and LF in all but the PowerShell one', () => {
    expect(failures(checkShellIntegrationScripts(() => lf))).toEqual([]);
    expect(failures(checkShellIntegrationScripts((file: string) => (file.endsWith('.ps1') ? Buffer.from('a\r\nb\r\n') : lf)))).toEqual([]);
    expect(failures(checkShellIntegrationScripts((file: string) => (file === 'shellIntegration-rc.zsh' ? undefined : lf)))).toEqual(['shell integration scripts']);
    expect(failures(checkShellIntegrationScripts((file: string) => (file === 'shellIntegration-login.zsh' ? Buffer.alloc(0) : lf)))).toEqual(['shell integration scripts']);
    expect(checkShellIntegrationScripts((file: string) => (file === 'shellIntegration-bash.sh' ? Buffer.from('a\r\n') : lf)).find((r: Result) => !r.ok)?.detail).toBe('CR in shellIntegration-bash.sh');
  });

  it('passes the repository\'s own scripts', () => {
    const dir = join(__dirname, '..', '..', 'resources', 'shell-integration');
    expect(failures(checkShellIntegrationScripts((file: string) => readFileSync(join(dir, file))))).toEqual([]);
  });
});

describe('checkCliScripts', () => {
  const mode = (value: number) => () => ({ mode: value });
  const files = (sh: string | undefined, cmd: string | undefined) => (file: string) => {
    const text = file === 'damocles' ? sh : cmd;
    return text === undefined ? undefined : Buffer.from(text);
  };
  it('requires resources/bin/damocles as an LF sh script, 0755 where modes are kept, and damocles.cmd as CRLF', () => {
    const sh = '#!/bin/sh\nexec app\n';
    const cmd = '@echo off\r\nsetlocal DisableDelayedExpansion\r\nexit /b\r\n';
    expect(failures(checkCliScripts(files(sh, cmd), mode(0o100755), true))).toEqual([]);
    // a registry DelayedExpansion=1 would eat a ! in the arguments
    expect(failures(checkCliScripts(files(sh, '@echo off\r\nsetlocal\r\nexit /b\r\n'), mode(0o100755), true))).toEqual(['damocles.cmd']);
    expect(failures(checkCliScripts(files(sh, cmd), mode(0o100644), false))).toEqual([]);
    expect(failures(checkCliScripts(files(sh, cmd), mode(0o100644), true))).toEqual(['damocles command mode']);
    expect(failures(checkCliScripts(files('#!/bin/sh\r\nexec app\r\n', cmd), mode(0o100755), true))).toEqual(['damocles command']);
    expect(failures(checkCliScripts(files(undefined, cmd), () => undefined, false))).toEqual(['damocles command']);
    expect(failures(checkCliScripts(files(sh, '@echo off\nexit /b\n'), mode(0o100755), true))).toEqual(['damocles.cmd']);
  });

  it('passes the repository\'s own scripts', () => {
    const dir = join(__dirname, '..', '..', 'resources', 'bin');
    expect(failures(checkCliScripts((file: string) => readFileSync(join(dir, file)), mode(0o100755), false))).toEqual([]);
  });
});

describe('checkCredentialHelperScripts', () => {
  const mode = (value: number) => () => ({ mode: value });
  const files = (sh: string | undefined, cmd: string | undefined) => (file: string) => {
    const text = file === 'git-credential-relay.sh' ? sh : cmd;
    return text === undefined ? undefined : Buffer.from(text);
  };
  it('requires the .sh as an LF sh script, 0755 where modes are kept, and the .cmd as CRLF with delayed expansion off', () => {
    const sh = '#!/bin/sh\nexec node\n';
    const cmd = '@echo off\r\nsetlocal DisableDelayedExpansion\r\nnode\r\n';
    expect(failures(checkCredentialHelperScripts(files(sh, cmd), mode(0o100755), true))).toEqual([]);
    expect(failures(checkCredentialHelperScripts(files(sh, cmd), mode(0o100644), false))).toEqual([]);
    expect(failures(checkCredentialHelperScripts(files(sh, cmd), mode(0o100644), true))).toEqual(['credential helper mode']);
    expect(failures(checkCredentialHelperScripts(files(undefined, cmd), () => undefined, false))).toEqual(['credential helper']);
    expect(failures(checkCredentialHelperScripts(files(sh, undefined), mode(0o100755), true))).toEqual(['credential helper .cmd']);
    expect(failures(checkCredentialHelperScripts(files('#!/bin/sh\r\nexec node\r\n', cmd), mode(0o100755), true))).toEqual(['credential helper']);
    expect(failures(checkCredentialHelperScripts(files(sh, '@echo off\nnode\n'), mode(0o100755), true))).toEqual(['credential helper .cmd']);
    // a registry DelayedExpansion=1 would eat a ! in the paths
    expect(failures(checkCredentialHelperScripts(files(sh, '@echo off\r\nsetlocal\r\nnode\r\n'), mode(0o100755), true))).toEqual(['credential helper .cmd']);
  });

  it('passes and names every script in resources/git-credential, which the desktop build copies', () => {
    const dir = join(__dirname, '..', '..', 'resources', 'git-credential');
    expect([...CREDENTIAL_RELAY_SCRIPTS].sort()).toEqual(readdirSync(dir).sort());
    expect(failures(checkCredentialHelperScripts((file: string) => readFileSync(join(dir, file)), mode(0o100755), false))).toEqual([]);
  });
});

describe('checkAskpassScripts', () => {
  const lf = Buffer.from('#!/bin/sh\nexec x\n');
  const mode = (value: number) => () => ({ mode: value });
  it('requires both scripts, LF and exactly 0755 where modes are kept', () => {
    expect(failures(checkAskpassScripts(() => lf, mode(0o100755), true))).toEqual([]);
    expect(failures(checkAskpassScripts(() => lf, mode(0o100644), false))).toEqual([]);
    expect(failures(checkAskpassScripts(() => lf, mode(0o100644), true))).toEqual(['askpass mode']);
    expect(failures(checkAskpassScripts(() => lf, mode(0o100775), true))).toEqual(['askpass mode']);
    expect(failures(checkAskpassScripts((file: string) => (file === 'ssh-askpass.sh' ? undefined : lf), () => undefined, true))).toEqual(['askpass scripts']);
    expect(failures(checkAskpassScripts(() => Buffer.from('#!/bin/sh\r\n'), mode(0o100755), true))).toEqual(['askpass line endings']);
  });

  it('names every script in resources/askpass, which the desktop build copies', () => {
    expect([...ASKPASS_SCRIPTS].sort()).toEqual(readdirSync(join(__dirname, '..', '..', 'resources', 'askpass')).filter((file) => file.endsWith('.sh')).sort());
  });

  it('passes the Windows askpass trampoline only as a PE executable', () => {
    expect(failures([checkAskpassTrampoline(undefined)])).toEqual(['askpass trampoline']);
    expect(failures([checkAskpassTrampoline(Buffer.from('@echo off\r\n'))])).toEqual(['askpass trampoline']);
    expect(failures([checkAskpassTrampoline(Buffer.from('MZ\x90\x00'))])).toEqual([]);
  });

  it('passes the repository\'s own scripts for line endings', () => {
    const dir = join(__dirname, '..', '..', 'resources', 'askpass');
    expect(failures(checkAskpassScripts((file: string) => readFileSync(join(dir, file)), mode(0o100755), true))).toEqual([]);
  });
});

describe('checkSpawnHelperMode', () => {
  it('requires exactly 0755', () => {
    expect(failures([checkSpawnHelperMode(0o100755)])).toEqual([]);
    for (const mode of [0o100644, 0o100775, 0o100777, 0o100700]) expect(failures([checkSpawnHelperMode(mode)]), mode.toString(8)).toEqual(['node-pty spawn-helper mode']);
  });
});

/** A minimal asar: the pickled JSON header, then the packed file bytes. */
function writeAsar(file: string, packed: Record<string, string>, unpacked: string[]): void {
  const root: { files: Record<string, unknown> } = { files: {} };
  const chunks: Buffer[] = [];
  let offset = 0;
  const place = (path: string, entry: object): void => {
    const parts = path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) node = ((node.files[part] as { files: Record<string, unknown> } | undefined) ??= { files: {} }) as typeof root;
    node.files[parts.at(-1)!] = entry;
  };
  for (const [path, content] of Object.entries(packed)) {
    const data = Buffer.from(content);
    place(path, { size: data.length, offset: String(offset) });
    chunks.push(data);
    offset += data.length;
  }
  for (const path of unpacked) place(path, { size: 1, unpacked: true });
  const json = Buffer.from(JSON.stringify(root));
  const aligned = Math.ceil(json.length / 4) * 4;
  const head = Buffer.alloc(16 + aligned);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(8 + aligned, 4);
  head.writeUInt32LE(4 + aligned, 8);
  head.writeUInt32LE(json.length, 12);
  json.copy(head, 16);
  writeFileSync(file, Buffer.concat([head, ...chunks]));
}

function put(file: string, content: string | Buffer = 'x'): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const WAKE_FILES: Record<string, string> = { 'encoder.int8.onnx': 'encoder', 'tokens.txt': 'tokens', 'bpe.model': 'bpe' };
const WAKE_MANIFEST = JSON.stringify({
  wake_model: {
    files: Object.entries(WAKE_FILES).map(([filename, content]) => ({
      filename,
      archive_path: `kws/${filename}`,
      sha256: createHash('sha256').update(content).digest('hex'),
      bytes: Buffer.byteLength(content),
    })),
  },
});

describe('checkWakeModel', () => {
  function wakeDirs(): { manifest: string; packaged: string } {
    const root = mkdtempSync(join(tmpdir(), 'vdp-wake'));
    tempDirs.push(root);
    const manifest = join(root, 'MODEL_MANIFEST.json');
    put(manifest, WAKE_MANIFEST);
    const packaged = join(root, 'wake');
    for (const [file, content] of Object.entries(WAKE_FILES)) put(join(packaged, file), content);
    put(join(packaged, '__init__.py'), '');
    return { manifest, packaged };
  }

  it('passes exactly the listed files at their listed checksums, beside the package marker', () => {
    const { manifest, packaged } = wakeDirs();
    const result: Result = checkWakeModel(manifest, packaged);
    expect(result.ok).toBe(true);
  });

  it('fails a missing, a changed and an unlisted file', () => {
    const { manifest, packaged } = wakeDirs();
    rmSync(join(packaged, 'bpe.model'));
    put(join(packaged, 'tokens.txt'), 'tokenz');
    put(join(packaged, 'hey_jarvis.onnx'), 'old model');
    const result: Result = checkWakeModel(manifest, packaged);
    expect(result).toEqual({
      check: 'wake model',
      ok: false,
      detail: 'missing bpe.model; differ from the manifest: tokens.txt; not in the manifest: hey_jarvis.onnx',
    });
  });
});

describe('checkChangelog', () => {
  const changelog = ['# Changelog', '', '## [2.36.0] - 2026-01-02', '- notes', ''].join('\r\n');
  it('passes the repo copy with the packaged version section, and fails a missing, stale or versionless copy', () => {
    expect(failures(checkChangelog(changelog, changelog, '2.36.0'))).toEqual([]);
    expect(checkChangelog(undefined, changelog, '2.36.0')[0]!.detail).toBe('dist/desktop/CHANGELOG.md is not in app.asar');
    expect(checkChangelog(changelog.replace('notes', 'old'), changelog, '2.36.0')[0]!.detail).toBe("differs from the repo's CHANGELOG.md");
    expect(checkChangelog(changelog, changelog, '2.37.0')[0]!.detail).toBe('has no ## [2.37.0] section');
  });

  // An empty section would fail release-notes after Windows is signed; this check runs before signing.
  it('fails a section with no notes before the next heading', () => {
    const empty = ['# Changelog', '', '## [2.37.0] - 2026-02-01', '  ', '## [2.36.0] - 2026-01-02', '- notes', ''].join('\n');
    expect(checkChangelog(empty, empty, '2.37.0')[0]!.detail).toBe('has an empty ## [2.37.0] section');
    const last = ['# Changelog', '', '## [2.37.0] - 2026-02-01', ''].join('\n');
    expect(checkChangelog(last, last, '2.37.0')[0]!.detail).toBe('has an empty ## [2.37.0] section');
    expect(failures(checkChangelog(empty, empty, '2.36.0'))).toEqual([]);
  });

  // release.yml's "Extract changelog section" makes the same choice, so a dry run checks the notes the next release publishes.
  it('checks [Unreleased] outside a tag run while the changelog has it, and the version section on a tag run', () => {
    const unreleased = ['# Changelog', '', '## [Unreleased]', '', '- next', '', '## [2.36.0] - 2026-01-02', '- notes', ''].join('\r\n');
    expect(checkChangelog(unreleased, unreleased, '2.36.0', false)[0]!.detail).toBe('dist/desktop/CHANGELOG.md has the Unreleased section');
    expect(checkChangelog(unreleased, unreleased, '2.37.0', true)[0]!.detail).toBe('has no ## [2.37.0] section');
    expect(failures(checkChangelog(unreleased, unreleased, '2.36.0', true))).toEqual([]);
    const empty = ['# Changelog', '', '## [Unreleased]', '', '## [2.36.0] - 2026-01-02', '- notes', ''].join('\n');
    expect(checkChangelog(empty, empty, '2.36.0', false)[0]!.detail).toBe('has an empty ## [Unreleased] section');
  });
});

describe('verifyPackage', () => {
  const LINUX_PACKAGES = desktopArtifacts('linux-x64', '2.36.0').filter((name) => /\.(deb|rpm)$/.test(name));

  function fakeApp(platform: 'win32' | 'darwin' | 'linux', omitPacked: string[] = [], manifest: Record<string, unknown> = {}, extraPacked: Record<string, string> = {}): { repoRoot: string; app: string; unpacked: string } {
    const root = mkdtempSync(join(tmpdir(), 'vdp'));
    tempDirs.push(root);
    const repoRoot = join(root, 'repo');
    const app = join(root, { win32: 'win-unpacked', darwin: 'Damocles.app', linux: 'linux-unpacked' }[platform]);
    const resources = platform === 'darwin' ? join(app, 'Contents', 'Resources') : join(app, 'resources');
    const binary = { win32: join(app, 'Damocles.exe'), darwin: join(app, 'Contents', 'MacOS', 'Damocles'), linux: join(app, 'damocles') }[platform];
    const unpacked = join(resources, 'app.asar.unpacked');
    put(join(repoRoot, 'package.json'), JSON.stringify({ version: '2.36.0' }));
    put(join(repoRoot, 'CHANGELOG.md'), CHANGELOG);
    put(join(repoRoot, 'resources', 'grammars', 'tree-sitter-go.wasm'), 'go-grammar');
    put(join(repoRoot, 'resources', 'themes', 'damocles-paper', 'theme.json'), '{}');
    for (const file of ASKPASS_SCRIPTS) put(join(repoRoot, 'resources', 'askpass', file));
    const credentialHelper: Record<string, string> = { 'git-credential-relay.sh': '#!/bin/sh\nexec node\n', 'git-credential-relay.cmd': '@echo off\r\nsetlocal DisableDelayedExpansion\r\nnode\r\n' };
    for (const [file, text] of Object.entries(credentialHelper)) put(join(repoRoot, 'resources', 'git-credential', file), text);
    put(join(repoRoot, 'python', 'damocles_voice_sidecar', 'damocles_voice_sidecar', 'models', 'MODEL_MANIFEST.json'), WAKE_MANIFEST);
    put(binary, 'binary');
    put(join(resources, 'monaco-editor-ThirdPartyNotices.txt'), 'notices');
    put(join(resources, 'app-update.yml'), `owner: AizenvoltPrime\nrepo: damocles\nprovider: github\n${platform === 'win32' ? 'channel: latest-x64\npublisherName:\n  - SignPath Foundation\n' : ''}updaterCacheDirName: damocles-updater\n`);
    const target = { win32: 'win32-x64', darwin: 'darwin-arm64', linux: 'linux-x64' }[platform];
    const unpackedFiles = [
      'dist/package.json',
      'dist/compass-worker.js',
      'dist/usage-stats-worker.js',
      'dist/sentinel.js',
      'dist/process-launcher-worker.js',
      'dist/memory-integrity-worker.js',
      'dist/session-meta-index-worker.js',
      'dist/voice-extract-worker.js',
      'dist/walk-child.js',
      'dist/diff-worker.js',
      'dist/formatter-host.js',
      'dist/pty-host.js',
      'dist/quick-open-worker.js',
      'dist/watch-worker.js',
      'dist/askpass-main.js',
      ...ASKPASS_SCRIPTS.map((file) => `dist/askpass/${file}`),
      'dist/cli.js',
      'resources/grammars/tree-sitter-go.wasm',
      ...SHELL_INTEGRATION_FILES.map((file) => `resources/shell-integration/${file}`),
      'python/damocles_voice_sidecar/damocles_voice_sidecar/__main__.py',
      'python/damocles_voice_sidecar/damocles_voice_sidecar/models/MODEL_MANIFEST.json',
      ...Object.keys(WAKE_FILES).map((file) => `python/damocles_voice_sidecar/damocles_voice_sidecar/models/wake/${file}`),
      'node_modules/web-tree-sitter/tree-sitter.wasm',
      'node_modules/koffi/package.json',
      'node_modules/@devcontainers/cli/devcontainer.js',
      `node_modules/@vscode/ripgrep-${target}/bin/${platform === 'win32' ? 'rg.exe' : 'rg'}`,
      `node_modules/@koromix/koffi-${target}/${target.replace('-', '_')}/koffi.node`,
      ...(platform === 'win32' ? [] : [`node_modules/@parcel/watcher-${target}${platform === 'linux' ? '-glibc' : ''}/watcher.node`]),
      ...{ win32: ['conpty.node', 'conpty_console_list.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe'], darwin: ['pty.node', 'spawn-helper'], linux: ['pty.node'] }[platform].map(
        (file) => `node_modules/node-pty/prebuilds/${target}/${file}`,
      ),
    ];
    for (const file of unpackedFiles) put(join(unpacked, file));
    put(join(unpacked, 'dist', 'package.json'), '{"type":"commonjs"}\n');
    if (platform === 'win32') put(join(unpacked, 'dist', 'askpass', 'ssh-askpass.exe'), 'MZ trampoline');
    // the desktop build gives the askpass scripts 0755 for every target, and a POSIX host checks it
    for (const file of ASKPASS_SCRIPTS) chmodSync(join(unpacked, 'dist', 'askpass', file), 0o755);
    for (const [file, text] of Object.entries(credentialHelper)) put(join(unpacked, 'dist', 'git-credential', file), text);
    chmodSync(join(unpacked, 'dist', 'git-credential', 'git-credential-relay.sh'), 0o755);
    put(join(resources, 'bin', 'damocles'), '#!/bin/sh\nexec app\n');
    chmodSync(join(resources, 'bin', 'damocles'), 0o755);
    put(join(resources, 'bin', 'damocles.cmd'), '@echo off\r\nsetlocal DisableDelayedExpansion\r\nexit /b\r\n');
    if (platform !== 'win32') {
      chmodSync(binary, 0o755);
      chmodSync(join(unpacked, 'node_modules', '@vscode', `ripgrep-${target}`, 'bin', 'rg'), 0o755);
    }
    if (platform === 'darwin') {
      put(join(app, 'Contents', 'Info.plist'), INFO_PLIST);
      chmodSync(join(unpacked, 'node_modules', 'node-pty', 'prebuilds', target, 'spawn-helper'), 0o755);
    }
    if (platform === 'linux') {
      put(join(app, 'chrome-sandbox'));
      put(join(resources, 'package-type'), 'deb');
      put(join(resources, 'apparmor-profile'), 'abi <abi/4.0>,\nprofile damocles /opt/Damocles/damocles flags=(unconfined) {\n  userns,\n}\n');
      // the deb and rpm electron-builder writes beside the unpacked app
      for (const name of LINUX_PACKAGES) put(join(root, name));
    }
    put(join(unpacked, 'resources', 'grammars', 'tree-sitter-go.wasm'), 'go-grammar');
    for (const [file, content] of Object.entries(WAKE_FILES)) put(join(unpacked, 'python', 'damocles_voice_sidecar', 'damocles_voice_sidecar', 'models', 'wake', file), content);
    const packed: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'damocles', version: '2.36.0', main: 'dist/desktop/main.js', type: 'commonjs', ...manifest }),
      'node_modules/node-pty/package.json': '{}',
      'node_modules/node-pty/lib/index.js': '',
      'dist/desktop/main.js': MAIN_BUNDLE,
      'dist/core-host.js': '',
      'dist/desktop-shell/themes/damocles-paper/theme.json': '{}',
      'dist/desktop/CHANGELOG.md': CHANGELOG,
      LICENSE: 'MIT',
      'THIRD-PARTY-NOTICES.md': '# Third-Party Notices',
      ...extraPacked,
    };
    for (const file of omitPacked) delete packed[file];
    writeAsar(join(resources, 'app.asar'), packed, unpackedFiles);
    return { repoRoot, app, unpacked };
  }

  it('passes a complete Windows layout and reads the fuses from the binary', async () => {
    const { repoRoot, app } = fakeApp('win32');
    let fuseTarget = '';
    const results: Result[] = await verifyPackage({ platform: 'win32', arch: 'x64', app, repoRoot, readFuseWire: async (target: string) => ((fuseTarget = target), EXPECTED_WIRE) });
    expect(failures(results)).toEqual([]);
    expect(fuseTarget).toBe(join(app, 'Damocles.exe'));
    expect(ASAR_UNPACK.length).toBeGreaterThan(0);
  });

  // Electron loads main as ESM under "type": "module", which the repo's own package.json declares
  it('fails a packaged manifest that does not declare the bundles CommonJS', async () => {
    for (const type of ['module', undefined]) {
      const { repoRoot, app } = fakeApp('win32', [], { type });
      const results: Result[] = await verifyPackage({ platform: 'win32', arch: 'x64', app, repoRoot, readFuseWire: async () => EXPECTED_WIRE });
      expect(failures(results)).toEqual(['package.json']);
    }
  });

  // without it, a package.json above the install folder decides how Node loads the unpacked bundles
  it('fails an unpacked dist/package.json that does not declare the bundles CommonJS', async () => {
    const { repoRoot, app, unpacked } = fakeApp('win32');
    put(join(unpacked, 'dist', 'package.json'), '{"type":"module"}');
    const results: Result[] = await verifyPackage({ platform: 'win32', arch: 'x64', app, repoRoot, readFuseWire: async () => EXPECTED_WIRE });
    expect(failures(results)).toEqual(['dist scope']);
  });

  it('fails a Windows package that ships the @parcel/watcher prebuild, which nothing there loads', async () => {
    const { repoRoot, app, unpacked } = fakeApp('win32');
    put(join(unpacked, 'node_modules', '@parcel', 'watcher-win32-x64', 'watcher.node'));
    const results: Result[] = await verifyPackage({ platform: 'win32', arch: 'x64', app, repoRoot, readFuseWire: async () => EXPECTED_WIRE });
    expect(failures(results)).toEqual(['unpacked set', '@parcel/watcher prebuild left out']);
  });

  it('fails a macOS package without its @parcel/watcher prebuild', async () => {
    const { repoRoot, app, unpacked } = fakeApp('darwin');
    rmSync(join(unpacked, 'node_modules', '@parcel', 'watcher-darwin-arm64', 'watcher.node'));
    const results: Result[] = await verifyPackage({ platform: 'darwin', arch: 'arm64', app, repoRoot, readFuseWire: async () => EXPECTED_WIRE, codesign: () => ({ ok: true, output: '' }) });
    expect(failures(results)).toEqual(['unpacked globs', '@parcel/watcher native']);
  });

  it('verifies the macOS node-pty binaries with codesign -v and fails an invalid signature', async () => {
    const { repoRoot, app, unpacked } = fakeApp('darwin');
    const signed: string[] = [];
    const prebuild = join(unpacked, 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64');
    const codesign = (file: string) => (signed.push(file), { ok: !file.endsWith('pty.node'), output: 'pty.node: invalid signature' });
    const results: Result[] = await verifyPackage({ platform: 'darwin', arch: 'arm64', app, repoRoot, readFuseWire: async () => EXPECTED_WIRE, codesign });
    expect(signed).toEqual([join(prebuild, 'pty.node'), join(prebuild, 'spawn-helper')]);
    expect(failures(results)).toEqual(['node-pty codesign pty.node']);
  });

  it('fails a missing pty host and a Windows prebuild that kept its debug symbols', async () => {
    const { repoRoot, app, unpacked } = fakeApp('win32');
    rmSync(join(unpacked, 'dist', 'pty-host.js'));
    put(join(unpacked, 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'conpty.pdb'));
    const results: Result[] = await verifyPackage({ platform: 'win32', arch: 'x64', app, repoRoot, readFuseWire: async () => EXPECTED_WIRE });
    expect(failures(results)).toEqual(['unpacked globs', 'worker pty-host.js', 'node-pty trimmed']);
  });

  it('fails a grammar that differs from the repo, a missing worker and a missing update feed', async () => {
    const { repoRoot, app, unpacked } = fakeApp('win32');
    put(join(unpacked, 'resources', 'grammars', 'tree-sitter-go.wasm'), 'stale');
    rmSync(join(unpacked, 'dist', 'sentinel.js'));
    rmSync(join(app, 'resources', 'app-update.yml'));
    const results: Result[] = await verifyPackage({ platform: 'win32', arch: 'x64', app, repoRoot, readFuseWire: async () => EXPECTED_WIRE });
    // The removed worker also leaves its ASAR_UNPACK glob matching nothing.
    expect(failures(results)).toEqual(['unpacked globs', 'worker sentinel.js', 'grammars', 'app-update.yml']);
  });

  it('fails a packaged askpass script that differs from resources/askpass, as a stale dist/askpass would', async () => {
    const { repoRoot, app, unpacked } = fakeApp('win32');
    put(join(unpacked, 'dist', 'askpass', ASKPASS_SCRIPTS[0]!), 'stale');
    const results: Result[] = await verifyPackage({ platform: 'win32', arch: 'x64', app, repoRoot, readFuseWire: async () => EXPECTED_WIRE });
    expect(failures(results)).toEqual(['askpass script contents']);
  });

  it('passes a complete Linux layout and reads the .desktop file of the deb and the rpm beside it', async () => {
    const { repoRoot, app } = fakeApp('linux');
    const read: string[] = [];
    const readLinuxPackage = async (file: string, name: string): Promise<Buffer> => (read.push(`${file} ${name}`), Buffer.from(DESKTOP_ENTRY));
    const results: Result[] = await verifyPackage({ platform: 'linux', arch: 'x64', app, repoRoot, readFuseWire: async () => EXPECTED_WIRE, readLinuxPackage });
    expect(failures(results)).toEqual([]);
    expect(LINUX_PACKAGES).toHaveLength(2);
    expect(read).toEqual(LINUX_PACKAGES.map((name) => `${join(dirname(app), name)} ${LINUX_DESKTOP_ENTRY}`));
    expect(results.map(({ check }) => check).filter((check) => check.startsWith('damocles:// scheme'))).toEqual(LINUX_PACKAGES.map((name) => `damocles:// scheme ${name}`));
  });

  it('fails a Linux package whose .desktop file does not handle damocles://, one that cannot be read and one that is missing', async () => {
    const { repoRoot, app } = fakeApp('linux');
    const [deb, rpm] = [LINUX_PACKAGES.find((name) => name.endsWith('.deb'))!, LINUX_PACKAGES.find((name) => name.endsWith('.rpm'))!];
    const readLinuxPackage = async (file: string): Promise<Buffer> => {
      if (file.endsWith('.rpm')) throw new Error('not a newc cpio archive at offset 0');
      return Buffer.from(DESKTOP_ENTRY.replace('MimeType=x-scheme-handler/damocles;\n', ''));
    };
    const results: Result[] = await verifyPackage({ platform: 'linux', arch: 'x64', app, repoRoot, readFuseWire: async () => EXPECTED_WIRE, readLinuxPackage });
    expect(failures(results)).toEqual([`damocles:// scheme ${deb}`, `damocles:// scheme ${rpm}`]);
    expect(results.find(({ check }) => check.endsWith(rpm))!.detail).toBe(`cannot read ${join(dirname(app), rpm)}: not a newc cpio archive at offset 0`);
    rmSync(join(dirname(app), deb));
    const withoutDeb: Result[] = await verifyPackage({ platform: 'linux', arch: 'x64', app, repoRoot, readFuseWire: async () => EXPECTED_WIRE, readLinuxPackage: async () => Buffer.from(DESKTOP_ENTRY) });
    expect(failures(withoutDeb)).toEqual([`damocles:// scheme ${deb}`]);
  });

  it('fails a Linux package without its sandbox helper, its package type or an AppArmor profile for the installed binary', async () => {
    const { repoRoot, app } = fakeApp('linux');
    rmSync(join(app, 'chrome-sandbox'));
    rmSync(join(app, 'resources', 'package-type'));
    put(join(app, 'resources', 'apparmor-profile'), 'profile damocles /usr/bin/damocles flags=(unconfined) {\n  userns,\n}\n');
    const results: Result[] = await verifyPackage({ platform: 'linux', arch: 'x64', app, repoRoot, readFuseWire: async () => EXPECTED_WIRE, readLinuxPackage: async () => Buffer.from(DESKTOP_ENTRY) });
    expect(failures(results)).toEqual(['chrome-sandbox', 'package-type', 'apparmor-profile']);
  });

  it.skipIf(process.platform === 'win32')('fails a Linux binary without the exec bit', async () => {
    const { repoRoot, app } = fakeApp('linux');
    chmodSync(join(app, 'damocles'), 0o644);
    const results: Result[] = await verifyPackage({ platform: 'linux', arch: 'x64', app, repoRoot, readFuseWire: async () => EXPECTED_WIRE, readLinuxPackage: async () => Buffer.from(DESKTOP_ENTRY) });
    expect(failures(results)).toEqual(['binary']);
  });

  it('fails a package whose built-in theme differs from resources/themes, and one that packs resources/themes a second time', async () => {
    const stale = fakeApp('win32');
    put(join(stale.repoRoot, 'resources', 'themes', 'damocles-paper', 'theme.json'), '{"name":"Paper"}');
    expect(failures(await verifyPackage({ platform: 'win32', arch: 'x64', app: stale.app, repoRoot: stale.repoRoot, readFuseWire: async () => EXPECTED_WIRE }))).toEqual(['built-in themes']);
    const twice = fakeApp('win32', [], {}, { 'resources/themes/damocles-paper/theme.json': '{}' });
    expect(failures(await verifyPackage({ platform: 'win32', arch: 'x64', app: twice.app, repoRoot: twice.repoRoot, readFuseWire: async () => EXPECTED_WIRE }))).toEqual(['asar contents']);
  });

  it('fails a Windows main bundle that never registers damocles:// and a macOS app whose Info.plist does not claim it', async () => {
    const windows = fakeApp('win32', ['dist/desktop/main.js']);
    expect(failures(await verifyPackage({ platform: 'win32', arch: 'x64', app: windows.app, repoRoot: windows.repoRoot, readFuseWire: async () => EXPECTED_WIRE }))).toEqual(['damocles:// scheme']);
    const mac = fakeApp('darwin');
    put(join(mac.app, 'Contents', 'Info.plist'), INFO_PLIST.replace('<string>damocles</string>', '<string>other</string>'));
    const results: Result[] = await verifyPackage({ platform: 'darwin', arch: 'arm64', app: mac.app, repoRoot: mac.repoRoot, readFuseWire: async () => EXPECTED_WIRE, codesign: () => ({ ok: true, output: '' }) });
    expect(failures(results)).toEqual(['damocles:// scheme']);
  });

  it('fails a package without the changelog that What\'s new reads', async () => {
    const { repoRoot, app } = fakeApp('win32', ['dist/desktop/CHANGELOG.md']);
    const results: Result[] = await verifyPackage({ platform: 'win32', arch: 'x64', app, repoRoot, readFuseWire: async () => EXPECTED_WIRE });
    expect(failures(results)).toEqual(['changelog']);
  });

  it('fails a package that ships without its license notices', async () => {
    const { repoRoot, app } = fakeApp('win32', ['THIRD-PARTY-NOTICES.md']);
    rmSync(join(app, 'resources', 'monaco-editor-ThirdPartyNotices.txt'));
    const results: Result[] = await verifyPackage({ platform: 'win32', arch: 'x64', app, repoRoot, readFuseWire: async () => EXPECTED_WIRE });
    expect(failures(results)).toEqual(['notice THIRD-PARTY-NOTICES.md', 'notice monaco-editor-ThirdPartyNotices.txt']);
  });
});
