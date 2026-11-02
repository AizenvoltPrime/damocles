import { describe, expect, it } from 'vitest';
import { argErrorText, joinPosition, openItem, parseArgs, switchWarningText, usageText } from '../args';

const english = (message: string, ...args: string[]): string => message.replace(/\{(\d+)\}/g, (_match, index: string) => args[Number(index)] ?? '');

describe('the damocles command\'s arguments', () => {
  it('splits path:line:column by its form, and joins it back to what was typed', () => {
    expect(openItem('src/app.ts:42')).toEqual({ path: 'src/app.ts', line: 42 });
    expect(openItem('src/app.ts:42:7')).toEqual({ path: 'src/app.ts', line: 42, column: 7 });
    expect(openItem('C:\\work\\app.ts:3')).toEqual({ path: 'C:\\work\\app.ts', line: 3 });
    // no position: a plain path, a zero or a padded number, a trailing colon
    expect(openItem('src/app.ts')).toEqual({ path: 'src/app.ts' });
    expect(openItem('src/app.ts:0')).toEqual({ path: 'src/app.ts:0' });
    expect(openItem('src/app.ts:042')).toEqual({ path: 'src/app.ts:042' });
    expect(openItem('src/app.ts:')).toEqual({ path: 'src/app.ts:' });
    for (const typed of ['src/app.ts:42', 'src/app.ts:42:7', 'notes:1:2:3']) expect(joinPosition(openItem(typed))).toBe(typed);
  });

  it('reads paths, --wait and its short form, and -- before a path that starts with a dash', () => {
    expect(parseArgs(['.', 'src/app.ts:42'], 'remote')).toEqual({ kind: 'open', paths: ['.', 'src/app.ts:42'], wait: false });
    expect(parseArgs(['--wait', 'COMMIT_EDITMSG'], 'remote')).toEqual({ kind: 'open', paths: ['COMMIT_EDITMSG'], wait: true });
    expect(parseArgs(['-w', 'a'], 'local')).toEqual({ kind: 'open', paths: ['a'], wait: true });
    expect(parseArgs(['--', '--wait', '-'], 'remote')).toEqual({ kind: 'open', paths: ['--wait', '-'], wait: false });
    expect(parseArgs([], 'remote')).toEqual({ kind: 'open', paths: [], wait: false });
  });

  it('reads --diff with exactly two files, with or without --wait', () => {
    expect(parseArgs(['--diff', 'a.txt', 'b.txt'], 'remote')).toEqual({ kind: 'diff', left: 'a.txt', right: 'b.txt', wait: false });
    expect(parseArgs(['-d', 'a', 'b', '--wait'], 'local')).toEqual({ kind: 'diff', left: 'a', right: 'b', wait: true });
    expect(parseArgs(['--diff', 'a'], 'remote')).toEqual({ kind: 'error', error: { kind: 'diffNeedsTwo' } });
    expect(parseArgs(['--diff', 'a', 'b', 'c'], 'remote')).toEqual({ kind: 'error', error: { kind: 'diffWithPaths' } });
  });

  it('reads each --remote form on this computer, with absolute paths of the host', () => {
    expect(parseArgs(['--remote', 'ssh+prod-1', '/srv/app'], 'local')).toEqual({ kind: 'open', paths: ['/srv/app'], wait: false, remote: 'ssh+prod-1' });
    expect(parseArgs(['--remote', 'ssh+deploy@10.0.7.12:2222', '/srv'], 'local')).toMatchObject({ remote: 'ssh+deploy@10.0.7.12:2222' });
    expect(parseArgs(['--remote', 'wsl+Ubuntu-24.04', '/home/ada/notes'], 'local')).toMatchObject({ remote: 'wsl+Ubuntu-24.04' });
    expect(parseArgs(['--remote', 'loopback', 'C:\\work'], 'local')).toMatchObject({ remote: 'loopback' });
    expect(parseArgs(['--remote', 'prod-1', '/srv'], 'local')).toEqual({ kind: 'error', error: { kind: 'remoteForm', value: 'prod-1' } });
    expect(parseArgs(['--remote', 'ssh+', '/srv'], 'local')).toEqual({ kind: 'error', error: { kind: 'remoteForm', value: 'ssh+' } });
    expect(parseArgs(['--remote'], 'local')).toEqual({ kind: 'error', error: { kind: 'needsValue', option: '--remote' } });
    expect(parseArgs(['--remote', 'loopback', '--remote', 'loopback'], 'local')).toEqual({ kind: 'error', error: { kind: 'twice', option: '--remote' } });
    expect(parseArgs(['--remote', 'ssh+prod-1', 'src'], 'local')).toEqual({ kind: 'error', error: { kind: 'remoteRelative', path: 'src' } });
  });

  it('refuses --remote in a target\'s terminal, and --open-external on this computer', () => {
    expect(parseArgs(['--remote', 'ssh+prod-1', '/srv'], 'remote')).toEqual({ kind: 'error', error: { kind: 'remoteHere' } });
    expect(parseArgs(['--open-external', 'https://example.test'], 'local')).toEqual({ kind: 'error', error: { kind: 'unknownOption', option: '--open-external' } });
    expect(parseArgs(['--user-data-dir', '/tmp/x'], 'remote')).toEqual({ kind: 'error', error: { kind: 'unknownOption', option: '--user-data-dir' } });
  });

  it('reads the BROWSER helper\'s --open-external with its one address', () => {
    expect(parseArgs(['--open-external', 'http://localhost:8123/cb'], 'remote')).toEqual({ kind: 'openExternal', url: 'http://localhost:8123/cb' });
    expect(parseArgs(['--open-external', 'https://a.test', 'b'], 'remote')).toEqual({ kind: 'error', error: { kind: 'openExternalAlone' } });
  });

  it('answers --help and --version before anything else, and refuses an unknown option', () => {
    expect(parseArgs(['--help'], 'remote')).toEqual({ kind: 'help' });
    expect(parseArgs(['a', '-h'], 'local')).toEqual({ kind: 'help' });
    expect(parseArgs(['--version'], 'remote')).toEqual({ kind: 'version' });
    expect(parseArgs(['-v'], 'local')).toEqual({ kind: 'version' });
    expect(parseArgs(['--goto', 'a'], 'remote')).toEqual({ kind: 'error', error: { kind: 'unknownOption', option: '--goto' } });
  });

  it('keeps --user-data-dir for the app on this computer, in its separate and = forms', () => {
    expect(parseArgs(['--user-data-dir', 'profile', 'a'], 'local')).toEqual({ kind: 'open', paths: ['a'], wait: false, userDataDir: 'profile' });
    expect(parseArgs(['--user-data-dir=C:\\p q', 'a'], 'local')).toEqual({ kind: 'open', paths: ['a'], wait: false, userDataDir: 'C:\\p q' });
    expect(parseArgs(['--user-data-dir='], 'local')).toEqual({ kind: 'error', error: { kind: 'needsValue', option: '--user-data-dir' } });
    expect(parseArgs(['--user-data-dir=a', '--user-data-dir', 'b'], 'local')).toEqual({ kind: 'error', error: { kind: 'twice', option: '--user-data-dir' } });
    expect(parseArgs(['--user-data-dir=/tmp/x'], 'remote')).toEqual({ kind: 'error', error: { kind: 'unknownOption', option: '--user-data-dir=/tmp/x' } });
  });

  it('passes an unknown --switch to the app when the command carries no request, as VS Code\'s CLI passes it to Electron', () => {
    expect(parseArgs(['--ozone-platform=wayland', '--disable-gpu'], 'local')).toEqual({ kind: 'open', paths: [], wait: false, switches: ['--ozone-platform=wayland', '--disable-gpu'] });
    expect(parseArgs(['--password-store=gnome-libsecret', '--user-data-dir', 'p'], 'local')).toEqual({ kind: 'open', paths: [], wait: false, userDataDir: 'p', switches: ['--password-store=gnome-libsecret'] });
    // a request's options are all the command's, so an unknown one there is a mistake
    expect(parseArgs(['--disable-gpu', 'a.txt'], 'local')).toEqual({ kind: 'error', error: { kind: 'unknownOption', option: '--disable-gpu' } });
    expect(parseArgs(['--disable-gpu', '--diff', 'a', 'b'], 'local')).toEqual({ kind: 'error', error: { kind: 'unknownOption', option: '--disable-gpu' } });
    expect(parseArgs(['--remote', 'loopback', '--disable-gpu'], 'local')).toEqual({ kind: 'error', error: { kind: 'unknownOption', option: '--disable-gpu' } });
    // a single-dash option, the command's own options in a = form, and any unknown option in a target's terminal stay refused
    expect(parseArgs(['-x'], 'local')).toEqual({ kind: 'error', error: { kind: 'unknownOption', option: '-x' } });
    expect(parseArgs(['--remote=ssh+prod-1'], 'local')).toEqual({ kind: 'error', error: { kind: 'unknownOption', option: '--remote=ssh+prod-1' } });
    expect(parseArgs(['--wait=1'], 'local')).toEqual({ kind: 'error', error: { kind: 'unknownOption', option: '--wait=1' } });
    expect(parseArgs(['--disable-gpu'], 'remote')).toEqual({ kind: 'error', error: { kind: 'unknownOption', option: '--disable-gpu' } });
    expect(switchWarningText('--disable-gpu', english)).toBe('damocles: --disable-gpu is not an option of the command, so it is passed to the app as it is.');
  });

  it('prints the usage the mockup shows, and one line per argument error', () => {
    expect(usageText(english)).toBe([
      'Usage: damocles [options] [paths...]',
      '',
      '  damocles .                 Open this folder',
      '  damocles file[:line[:col]] Open a file',
      '  damocles --diff a b        Compare two files',
      '  damocles --wait file       Wait until the tab closes',
      '  damocles --remote ssh+prod-1 /srv/app',
    ].join('\n'));
    expect(argErrorText({ kind: 'remoteHere' }, english)).toBe('damocles: --remote works only on this computer.');
    expect(argErrorText({ kind: 'unknownOption', option: '--goto' }, english)).toBe('damocles: unknown option --goto. Run damocles --help for the options.');
    expect(argErrorText({ kind: 'remoteRelative', path: 'src' }, english)).not.toContain('\n');
  });
});
