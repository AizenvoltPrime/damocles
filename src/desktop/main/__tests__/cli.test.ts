import { describe, expect, it, vi } from 'vitest';

// the design renderer's module reads the app only when it runs
vi.mock('electron', () => ({ app: {} }));

import { isSafeThemeLaunch, operandArgs, optionArgs, parseCliPathAction, parseCrashReporterDirectory, parseUserDataDir, registersLinkScheme, relaunchArgs } from '../cli';
import { isDesignRendererLaunch } from '../design/design-renderer';
import { DESIGN_RENDERER_SWITCH } from '../design/design-renderer-protocol';
import { parseCommandLine } from '../../cli/cli-protocol';

const LINK = 'damocles://theme/install?url=https%3A%2F%2Fthemes.example.com%2Fa.damocles-theme';
const EXE = 'C:\\Program Files\\Damocles\\Damocles.exe';

describe('parseUserDataDir', () => {
  it('reads the separate and the = forms', () => {
    expect(parseUserDataDir(['electron', 'main.js', '--user-data-dir', '/tmp/x'])).toBe('/tmp/x');
    expect(parseUserDataDir(['electron', 'main.js', '--user-data-dir=/tmp/y'])).toBe('/tmp/y');
    expect(parseUserDataDir(['electron', 'main.js'])).toBeUndefined();
  });
});

describe('parseCrashReporterDirectory', () => {
  it('reads the separate and the = forms, and never from a link after the end-of-options marker', () => {
    expect(parseCrashReporterDirectory(['electron', 'main.js', '--crash-reporter-directory', '/tmp/dumps'])).toBe('/tmp/dumps');
    expect(parseCrashReporterDirectory(['electron', 'main.js', '--crash-reporter-directory=/tmp/dumps'])).toBe('/tmp/dumps');
    expect(parseCrashReporterDirectory([EXE, '--', '--crash-reporter-directory=C:\\x'])).toBeUndefined();
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

describe('the end-of-options marker', () => {
  it('splits a command line at the first --', () => {
    expect(optionArgs([EXE, '--a', '--', LINK, '--', '--b'])).toEqual([EXE, '--a']);
    expect(operandArgs([EXE, '--a', '--', LINK, '--', '--b'])).toEqual([LINK, '--', '--b']);
    expect(optionArgs([EXE, '--a'])).toEqual([EXE, '--a']);
    expect(operandArgs([EXE, '--a'])).toBeUndefined();
  });

  // What Windows starts for a link whose text breaks out of the quoted %1 of the registered command.
  it('reads no flag from the words a crafted link adds after it', () => {
    const injected = [EXE, '--', 'damocles://x', '--cli-path', 'remove', '--user-data-dir', 'C:\\evil', '--user-data-dir=C:\\evil', DESIGN_RENDERER_SWITCH, '--damocles-safe-theme', '--damocles-cli=e30'];
    expect(parseCliPathAction(injected)).toBeUndefined();
    expect(parseUserDataDir(injected)).toBeUndefined();
    expect(isDesignRendererLaunch(injected)).toBe(false);
    expect(isSafeThemeLaunch(injected)).toBe(false);
    expect(parseCommandLine(optionArgs(injected))).toBeUndefined();
    // a flag whose value would be the marker itself has none
    expect(parseUserDataDir([EXE, '--user-data-dir', '--', 'C:\\evil'])).toBeUndefined();
    expect(parseCliPathAction([EXE, '--cli-path', '--', 'remove'])).toBe('invalid');
  });

  it('still reads each flag placed before it', () => {
    expect(parseUserDataDir([EXE, '--user-data-dir', 'C:\\u', '--', LINK])).toBe('C:\\u');
    expect(parseCliPathAction([EXE, '--cli-path', 'add', '--', LINK])).toBe('add');
    expect(isDesignRendererLaunch([EXE, DESIGN_RENDERER_SWITCH, '--', LINK])).toBe(true);
    expect(isSafeThemeLaunch([EXE, '--damocles-safe-theme', '--', LINK])).toBe(true);
  });
});

describe('relaunchArgs', () => {
  it('passes the launch\'s own arguments on', () => {
    expect(relaunchArgs(['electron', 'dist/desktop/main.js', '--user-data-dir', '/tmp/x', '--lang=el'])).toEqual(['dist/desktop/main.js', '--user-data-dir', '/tmp/x', '--lang=el']);
    expect(relaunchArgs([EXE])).toEqual([]);
  });

  it('drops what acts once: a link, a damocles command\'s request and the safe start flag', () => {
    expect(relaunchArgs([EXE, '--user-data-dir=C:\\u', '--', LINK])).toEqual(['--user-data-dir=C:\\u']);
    // a Linux desktop entry passes the link bare
    expect(relaunchArgs(['/opt/Damocles/damocles', LINK, '--no-sandbox'])).toEqual(['--no-sandbox']);
    expect(relaunchArgs(['/opt/Damocles/damocles', 'DAMOCLES://theme/install?url=x'])).toEqual([]);
    expect(relaunchArgs([EXE, '--damocles-cli=e30', '--damocles-safe-theme', '--lang=el'])).toEqual(['--lang=el']);
  });
});

describe('registersLinkScheme', () => {
  const installed = { platform: 'win32' as NodeJS.Platform, packaged: true, argv: [EXE], installed: async () => true };

  it('registers only for the installed Windows app on its own user data folder', async () => {
    expect(await registersLinkScheme(installed)).toBe(true);
    expect(await registersLinkScheme({ ...installed, argv: [EXE, '--', LINK] })).toBe(true);
  });

  it('never registers for an unpacked build, a development run, a run with --user-data-dir, or another platform', async () => {
    expect(await registersLinkScheme({ ...installed, installed: async () => false })).toBe(false);
    expect(await registersLinkScheme({ ...installed, packaged: false })).toBe(false);
    expect(await registersLinkScheme({ ...installed, argv: [EXE, '--user-data-dir', 'C:\\tmp\\u'] })).toBe(false);
    expect(await registersLinkScheme({ ...installed, argv: [EXE, '--user-data-dir=C:\\tmp\\u'] })).toBe(false);
    expect(await registersLinkScheme({ ...installed, platform: 'linux' })).toBe(false);
    expect(await registersLinkScheme({ ...installed, platform: 'darwin' })).toBe(false);
  });

  it('looks for the uninstaller only in a packaged Windows run without --user-data-dir', async () => {
    const looked = async (): Promise<never> => {
      throw new Error('looked for the uninstaller');
    };
    expect(await registersLinkScheme({ ...installed, platform: 'linux', installed: looked })).toBe(false);
    expect(await registersLinkScheme({ ...installed, packaged: false, installed: looked })).toBe(false);
    expect(await registersLinkScheme({ ...installed, argv: [EXE, '--user-data-dir=C:\\u'], installed: looked })).toBe(false);
  });
});
