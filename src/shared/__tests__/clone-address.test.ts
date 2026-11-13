import { describe, expect, it } from 'vitest';
import { cloneAddressOf, isLocalPath, isRemoteUrl } from '../clone-address';

describe('clone addresses', () => {
  it('accepts a URL or path, a local path with spaces included, never a leading dash, a control character, a remote helper or whitespace in a URL', () => {
    const accepted = ['https://example.com/a.git', 'git@example.com:a/b.git', 'ssh://example.com/a', '../local.git', 'C:/repos/a.git', 'C:\\Users\\John Doe\\repo', '/home/john doe/r', '\\\\srv\\share\\a b', '../my repo.git'];
    for (const url of accepted) expect(isRemoteUrl(url), url).toBe(true);
    const refused = ['', '-uhttps://x', '--upload-pack=touch', '-x', ' -oProxyCommand=x:p', ' /home/x', '\u00a0../x', 'ext::sh -c x', 'EXT::a b', 'ext::x', 'fd::17', 'fd::0', 'a+b.c::x', 'https://a b', 'https://h/a b', 'host:a b', 'https://a\tb', 'https://a\u0007b', 'a\nb', 'a\rb', 'a\tb', 'a\u0085b', '/a\u2028b', 'x'.repeat(2049)];
    for (const url of refused) expect(isRemoteUrl(url), JSON.stringify(url)).toBe(false);
  });

  it('reads a path as local the way git does: no colon, a slash before the first colon, or a drive', () => {
    for (const url of ['repo', './a:b', 'C:\\My Repos\\tool', 'd:/x', '/srv/git/a.git']) expect(isLocalPath(url), url).toBe(true);
    for (const url of ['host:path', 'git@host:a/b', 'https://host/a']) expect(isLocalPath(url), url).toBe(false);
  });

  it('drops a leading git clone and the surrounding whitespace, and nothing else', () => {
    expect(cloneAddressOf('  git clone  https://example.org/a/b.git \n')).toBe('https://example.org/a/b.git');
    expect(cloneAddressOf('git clone C:\\My Repos\\tool')).toBe('C:\\My Repos\\tool');
    expect(cloneAddressOf('git cloned https://x/y')).toBe('git cloned https://x/y');
    expect(cloneAddressOf('  intra ')).toBe('intra');
  });
});
