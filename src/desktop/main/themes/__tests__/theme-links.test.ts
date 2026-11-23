import { describe, expect, it } from 'vitest';
import { parsePastedInstallUrl, parseThemeLink } from '../../../../shared/themes/theme-links';
import { themeLinkInArgv } from '../theme-links';

const TARGET = 'https://themes.example.com/aurora.damocles-theme';
const link = (url: string): string => `damocles://theme/install?url=${encodeURIComponent(url)}`;
const accepted = (raw: unknown): string | undefined => {
  const parsed = parseThemeLink(raw);
  return parsed.ok ? parsed.url : undefined;
};

describe('theme install links', () => {
  it('opens exactly damocles://theme/install with one https url, and names that url', () => {
    expect(accepted(link(TARGET))).toBe(TARGET);
    expect(accepted(`damocles://theme/install?url=${TARGET}`)).toBe(TARGET);
    // the scheme is case-insensitive in URLs; the target's own query survives when encoded
    expect(accepted(`DAMOCLES://theme/install?url=${encodeURIComponent(`${TARGET}?v=2&x=1`)}`)).toBe(`${TARGET}?v=2&x=1`);
    expect(accepted(link('https://themes.example.com:8443/a.damocles-theme'))).toBe('https://themes.example.com:8443/a.damocles-theme');
    // the fragment is never sent, so it is dropped and two links differing only there are one
    expect(accepted(link(`${TARGET}#top`))).toBe(TARGET);
  });

  // a link's query is read as a form's, where an unencoded + is a space: the target must be percent-encoded
  it('keeps a + of the target only when the link encodes it, and opens nothing for one it does not', () => {
    const plus = 'https://themes.example.com/my+theme.damocles-theme';
    expect(accepted(link(plus))).toBe(plus);
    expect(accepted(`damocles://theme/install?url=${plus}`)).toBeUndefined();
  });

  it('opens nothing for a target that is not https', () => {
    for (const target of ['http://themes.example.com/a.damocles-theme', 'javascript:alert(1)', 'data:application/zip;base64,UEsDBA==', 'file:///C:/Users/me/a.damocles-theme', 'file:///etc/passwd', 'ftp://themes.example.com/a', 'damocles://theme/install', 'ws://themes.example.com/', 'blob:https://themes.example.com/1']) {
      expect(accepted(link(target)), target).toBeUndefined();
    }
  });

  it('opens nothing for a target with credentials, encoded or not', () => {
    expect(accepted(link('https://user:secret@themes.example.com/a'))).toBeUndefined();
    expect(accepted(link('https://user@themes.example.com/a'))).toBeUndefined();
    // the classic spoof: what reads as the trusted host is the user name
    expect(accepted(link('https://themes.example.com@evil.example/a'))).toBeUndefined();
    expect(accepted('damocles://theme/install?url=https%3A%2F%2Fuser%3Apw%40themes.example.com%2Fa')).toBeUndefined();
  });

  it('opens nothing without exactly one url parameter', () => {
    expect(accepted('damocles://theme/install')).toBeUndefined();
    expect(accepted('damocles://theme/install?')).toBeUndefined();
    expect(accepted('damocles://theme/install?url=')).toBeUndefined();
    expect(accepted('damocles://theme/install?href=https://themes.example.com/a')).toBeUndefined();
    expect(accepted(`${link(TARGET)}&url=${encodeURIComponent('https://evil.example/a')}`)).toBeUndefined();
    expect(accepted(`${link(TARGET)}&silent=1`)).toBeUndefined();
    // an unencoded target query becomes a second parameter
    expect(accepted(`damocles://theme/install?url=${TARGET}?a=1&b=2`)).toBeUndefined();
  });

  it('opens nothing for another scheme, host or path', () => {
    for (const raw of [
      `damocles://themes/install?url=${TARGET}`,
      `damocles://Theme/install?url=${TARGET}`,
      `damocles://theme.evil/install?url=${TARGET}`,
      `damocles://user@theme/install?url=${TARGET}`,
      `damocles://theme:1/install?url=${TARGET}`,
      `damocles://theme/install/?url=${TARGET}`,
      `damocles://theme/Install?url=${TARGET}`,
      `damocles://theme/install/../install?url=${TARGET}`,
      `damocles://theme/apply?url=${TARGET}`,
      `damocles:theme/install?url=${TARGET}`,
      `damocles:///theme/install?url=${TARGET}`,
      `damocles://theme/install?url=${TARGET}#x`,
      `damocles-dev://theme/install?url=${TARGET}`,
      `https://theme/install?url=${TARGET}`,
      `vscode://theme/install?url=${TARGET}`,
    ]) {
      expect(accepted(raw), raw).toBeUndefined();
    }
  });

  it('opens nothing for encoding tricks the URL parser would rewrite', () => {
    for (const raw of [
      // whitespace and control characters the parser strips or folds
      ` ${link(TARGET)}`,
      `${link(TARGET)}\n`,
      `damocles://theme/install?url=https://themes.exa\tmple.com/a`,
      `damocles://theme/install?url=${encodeURIComponent('https://themes.example.com/a\u0000.damocles-theme')}`,
      `damocles://theme/install?url=${encodeURIComponent(' https://themes.example.com/a')}`,
      // backslashes, which an https parser reads as slashes
      `damocles://theme/install?url=${encodeURIComponent('https:\\\\evil.example\\a')}`,
      `damocles://theme/install?url=https:\\\\evil.example\\a`,
      // a quote that would end a Windows argument early
      `damocles://theme/install?url=https://themes.example.com/a" --inspect`,
      `damocles://theme/install?url=${encodeURIComponent('https://themes.example.com/a"')}`,
      // double encoding leaves a target that is not an https URL
      `damocles://theme/install?url=${encodeURIComponent(encodeURIComponent(TARGET))}`,
      `damocles://theme/install?url=https%3A%2F%2F`,
      `damocles://theme/install?url=https://`,
    ]) {
      expect(accepted(raw), JSON.stringify(raw)).toBeUndefined();
    }
  });

  it('opens nothing for oversized or non-text input', () => {
    expect(accepted(link(`https://themes.example.com/${'a'.repeat(2100)}`))).toBeUndefined();
    expect(accepted(`${link(TARGET)}${'%20'.repeat(2000)}`)).toBeUndefined();
    expect(accepted(undefined)).toBeUndefined();
    expect(accepted(42)).toBeUndefined();
    expect(accepted({ href: link(TARGET) })).toBeUndefined();
  });

  it('reads the open-url form macOS delivers, which is the link itself', () => {
    expect(parseThemeLink(link(TARGET))).toEqual({ ok: true, url: TARGET });
    expect(parseThemeLink('damocles://theme/install?url=http://themes.example.com/a').ok).toBe(false);
  });
});

describe('a URL pasted in Install from link', () => {
  it('is an https URL or a whole theme link, under the same rules', () => {
    expect(parsePastedInstallUrl(TARGET)).toEqual({ ok: true, url: TARGET });
    expect(parsePastedInstallUrl(link(TARGET))).toEqual({ ok: true, url: TARGET });
    for (const raw of ['http://themes.example.com/a', ` ${TARGET}`, 'https://user:pw@themes.example.com/a', 'themes.example.com/a', 'javascript:alert(1)', link('http://themes.example.com/a'), 'damocles://theme/other?url=https://x.example/a', 42]) {
      expect(parsePastedInstallUrl(raw).ok, String(raw)).toBe(false);
    }
  });
});

describe('theme links on a command line', () => {
  const exe = 'C:\\Users\\me\\AppData\\Local\\Programs\\Damocles\\Damocles.exe';

  it('finds the link after the -- of the registered command, whatever switches Chromium put before it', () => {
    // the registered command line is "<exe>" "--" "%1"
    expect(themeLinkInArgv([exe, '--', link(TARGET)], 'win32')).toEqual({ kind: 'link', ok: true, url: TARGET });
    expect(themeLinkInArgv([exe, '--allow-file-access-from-files', '--original-process-start-time=13372963500000000', '--', link(TARGET)], 'win32')).toEqual({ kind: 'link', ok: true, url: TARGET });
    // the development app as e2e starts it
    expect(themeLinkInArgv([exe, 'C:\\repo\\dist\\desktop\\main.js', '--user-data-dir', 'C:\\tmp\\u', '--', link(TARGET)], 'win32')).toEqual({ kind: 'link', ok: true, url: TARGET });
    // words a crafted link added after itself are not links
    expect(themeLinkInArgv([exe, '--', link(TARGET), '--cli-path', 'remove'], 'win32')).toEqual({ kind: 'link', ok: true, url: TARGET });
  });

  it('reads no link placed among the options on Windows, where the registration always passes --', () => {
    expect(themeLinkInArgv([exe, link(TARGET)], 'win32')).toEqual({ kind: 'none' });
    expect(themeLinkInArgv([exe, link(TARGET), '--disable-gpu-sandbox'], 'win32')).toEqual({ kind: 'none' });
    expect(themeLinkInArgv([exe, link(TARGET), '--', '--flag'], 'win32')).toEqual({ kind: 'none' });
  });

  it('reads a bare link on Linux, whose desktop entry passes it through %U, and only after -- when there is one', () => {
    expect(themeLinkInArgv(['/opt/Damocles/damocles', link(TARGET)], 'linux')).toEqual({ kind: 'link', ok: true, url: TARGET });
    expect(themeLinkInArgv(['/opt/Damocles/damocles', '--no-sandbox', link(TARGET)], 'linux')).toEqual({ kind: 'link', ok: true, url: TARGET });
    expect(themeLinkInArgv(['/opt/Damocles/damocles', '--', link(TARGET)], 'linux')).toEqual({ kind: 'link', ok: true, url: TARGET });
    expect(themeLinkInArgv(['/opt/Damocles/damocles', link(TARGET), '--'], 'linux')).toEqual({ kind: 'none' });
  });

  it('reads nothing from a command line without a link', () => {
    expect(themeLinkInArgv([exe], 'win32')).toEqual({ kind: 'none' });
    expect(themeLinkInArgv([exe, '--'], 'win32')).toEqual({ kind: 'none' });
    expect(themeLinkInArgv([exe, '--damocles-cli=e30', '--user-data-dir', 'C:\\x'], 'linux')).toEqual({ kind: 'none' });
    // a quoted argument the OS left quoted is not a link
    expect(themeLinkInArgv([exe, '--', `"${link(TARGET)}"`], 'win32')).toEqual({ kind: 'none' });
    expect(themeLinkInArgv([exe, '--', `--url=${link(TARGET)}`], 'win32')).toEqual({ kind: 'none' });
  });

  it('opens nothing for a refused link or for more than one link', () => {
    expect(themeLinkInArgv([exe, '--', link('http://themes.example.com/a')], 'win32')).toMatchObject({ kind: 'link', ok: false });
    expect(themeLinkInArgv([exe, '--', `${link(TARGET)}" --inspect=9229`], 'win32')).toMatchObject({ kind: 'link', ok: false });
    expect(themeLinkInArgv([exe, '--', link(TARGET), link('https://other.example/b.damocles-theme')], 'win32')).toMatchObject({ kind: 'link', ok: false });
    expect(themeLinkInArgv([exe, '--', 'Damocles://theme/install?url=http://x.example/a'], 'win32')).toMatchObject({ kind: 'link', ok: false });
    expect(themeLinkInArgv(['/opt/Damocles/damocles', link(TARGET), link('https://other.example/b.damocles-theme')], 'linux')).toMatchObject({ kind: 'link', ok: false });
  });
});
