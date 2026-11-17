import { describe, expect, it, vi } from 'vitest';
import { UNMAPPED_SERVED_PAGE } from '../../../shared/served-file-url';
import { ChatServedFiles, NO_SERVED_FILES_SERVER, outsideRootsRefusal, resolveServedFile, type ServedFileRoots } from '../served-files';

const POSIX: ServedFileRoots = { project: '/home/u/proj', designs: [{ designId: 'd1', folder: '/home/u/.damocles/designs/d1' }] };
const WINDOWS: ServedFileRoots = { project: 'C:\\Users\\u\\proj', designs: [] };

describe('resolveServedFile', () => {
  it('names the project or design root a file URL is in', () => {
    expect(resolveServedFile('file:///home/u/proj/docs/index.html', POSIX)).toEqual({ kind: 'project', relPath: 'docs/index.html' });
    expect(resolveServedFile('file:///home/u/.damocles/designs/d1/screens/S2.html', POSIX)).toEqual({ kind: 'design', designId: 'd1', relPath: 'screens/S2.html' });
    expect(resolveServedFile('file:///c:/users/U/Proj/a%20b.html', WINDOWS)).toEqual({ kind: 'project', relPath: 'a b.html' });
    // the file the browser would load
    expect(resolveServedFile('file:///home/u/proj/docs/../x.html', POSIX)).toEqual({ kind: 'project', relPath: 'x.html' });
    expect(resolveServedFile('file:///home/u/proj/a/./b.html', POSIX)).toEqual({ kind: 'project', relPath: 'a/b.html' });
  });

  it('reads a folder named with its trailing slash, and the root itself, as the folder\'s index.html', () => {
    for (const url of ['file:///home/u/proj', 'file:///home/u/proj/', 'file:///home/u/proj?x=1#top']) expect(resolveServedFile(url, POSIX), url).toEqual({ kind: 'project', relPath: 'index.html' });
    expect(resolveServedFile('file:///home/u/proj/docs/', POSIX)).toEqual({ kind: 'project', relPath: 'docs/index.html' });
    expect(resolveServedFile('file:///home/u/.damocles/designs/d1/', POSIX)).toEqual({ kind: 'design', designId: 'd1', relPath: 'index.html' });
    expect(resolveServedFile('file:///C:/Users/u/proj/', WINDOWS)).toEqual({ kind: 'project', relPath: 'index.html' });
    // a folder named without its slash is a path the server redirects to the folder
    expect(resolveServedFile('file:///home/u/proj/docs', POSIX)).toEqual({ kind: 'project', relPath: 'docs' });
    expect(resolveServedFile('file:///home/u/proj//', POSIX)).toBe('outside');
    expect(resolveServedFile('file:///home/u/pro/', POSIX)).toBe('outside');
  });

  it('checks a design folder before a project that holds it', () => {
    const nested: ServedFileRoots = { project: '/home/u', designs: [{ designId: 'd1', folder: '/home/u/.damocles/designs/d1' }] };
    expect(resolveServedFile('file:///home/u/.damocles/designs/d1/tokens.css', nested)).toEqual({ kind: 'design', designId: 'd1', relPath: 'tokens.css' });
  });

  it('answers outside for another folder, a sibling sharing a prefix, a dot segment and a Windows-unsafe name', () => {
    for (const url of [
      'file:///etc/hosts',
      'file:///home/u/project2/a.html',
      'file:///home/u/proj/../x',
      'file:///home/u/proj/docs/..%2f..%2fx',
      'file:///home/u/proj/a%5cb.html',
      'file:///home/u/proj/docs%2Fx.html',
      'file:///home/u/proj/con.txt',
      'file:///Home/u/proj/a.html',
      'file://192.0.2.2/home/u/proj/a.html',
    ]) expect(resolveServedFile(url, POSIX), url).toBe('outside');
    expect(resolveServedFile('file:///D:/Users/u/proj/a.html', WINDOWS)).toBe('outside');
    expect(resolveServedFile('file:///home/u/proj/a.html', { designs: [] })).toBe('outside');
  });
});

describe('outsideRootsRefusal', () => {
  it('names the roots and the path', () => {
    expect(outsideRootsRefusal(POSIX, '/etc/hosts')).toBe("This chat's browser opens files from its project (/home/u/proj), its design folder (/home/u/.damocles/designs/d1) and folders the user allowed; /etc/hosts is outside them. Opening a page outside them asks the user to allow its folder for this chat; this one was not allowed.");
    expect(outsideRootsRefusal(WINDOWS, 'D:/x')).toBe("This chat's browser opens files from its project (C:\\Users\\u\\proj) and folders the user allowed; D:/x is outside them. Opening a page outside them asks the user to allow its folder for this chat; this one was not allowed.");
  });
});

describe('ChatServedFiles', () => {
  it('opens a local root file over its served URL and maps the answers back', async () => {
    const serve = vi.fn(async () => ({ url: 'http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:5000/__damocles_preview/open?t=x&p=docs%2Fa.html', origin: 'http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:5000' }));
    const files = new ChatServedFiles({ roots: () => POSIX, serve });
    expect(await files.localTarget('file:///home/u/proj/docs/a.html')).toEqual({ url: 'http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:5000/__damocles_preview/open?t=x&p=docs%2Fa.html' });
    expect(serve).toHaveBeenCalledWith({ kind: 'project', relPath: 'docs/a.html' }, '/home/u/proj');
    expect(files.toFile('[URL] http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:5000/docs/a.html')).toBe('[URL] file:///home/u/proj/docs/a.html');
    // the root's server restarted on another port: the old port is no longer the root's
    serve.mockResolvedValueOnce({ url: 'http://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.localhost:5001/__damocles_preview/open?t=y&p=b.html', origin: 'http://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.localhost:5001' });
    await files.localTarget('file:///home/u/proj/b.html');
    expect(files.toFile('http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:5000/a http://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.localhost:5001/b')).toBe(`${UNMAPPED_SERVED_PAGE} file:///home/u/proj/b`);
  });

  it('carries the address\'s query into the one-time open and its fragment onto it', async () => {
    const serve = vi.fn(async () => ({ url: 'http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:5000/__damocles_preview/open?t=x&p=docs%2Findex.html', origin: 'http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:5000' }));
    const files = new ChatServedFiles({ roots: () => POSIX, serve });
    const target = await files.localTarget('file:///home/u/proj/docs/?tab=2&q=a%20b#intro');
    expect(serve).toHaveBeenCalledWith({ kind: 'project', relPath: 'docs/index.html' }, '/home/u/proj');
    expect(target).toEqual({ url: 'http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:5000/__damocles_preview/open?t=x&p=docs%2Findex.html&q=tab%3D2%26q%3Da%2520b#intro' });
    expect(files.toFile(`Opened browser: ${(target as { url: string }).url}`)).toBe('Opened browser: file:///home/u/proj/docs/index.html?tab=2&q=a%20b#intro');
    expect(files.toFile('[URL] http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:5000/docs/index.html?tab=2&q=a%20b#intro')).toBe('[URL] file:///home/u/proj/docs/index.html?tab=2&q=a%20b#intro');
  });

  it('refuses a root file the server is unavailable for with its reason, and never opens it from disk', async () => {
    const serve = vi.fn(async () => ({ refused: 'This chat\'s project is not open in Damocles on this computer, so its files are not served.' }));
    const files = new ChatServedFiles({ roots: () => POSIX, serve });
    expect(await files.localTarget('file:///home/u/proj/docs/a.html#x')).toEqual({ refused: 'This chat\'s project is not open in Damocles on this computer, so its files are not served.' });
    serve.mockResolvedValueOnce({ refused: '.env is not opened.' });
    expect(await files.localTarget('file:///home/u/proj/.env')).toEqual({ refused: '.env is not opened.' });
  });

  it('refuses a file outside the roots with the reason naming them, as a remote chat does, and passes any other URL on', async () => {
    const serve = vi.fn(async () => ({ refused: '.env is not served.' }));
    const files = new ChatServedFiles({ roots: () => POSIX, serve });
    expect(await files.localTarget('file:///tmp/a.html')).toEqual({ refused: outsideRootsRefusal(POSIX, '/tmp/a.html') });
    expect(await files.localTarget('file://192.0.2.1/share/a.html')).toEqual({ refused: outsideRootsRefusal(POSIX, '//192.0.2.1/share/a.html') });
    expect(await files.localTarget('https://example.com/')).toEqual({ url: 'https://example.com/' });
    expect(await files.localTarget('about:blank')).toEqual({ url: 'about:blank' });
    expect(serve).not.toHaveBeenCalled();
    expect(await files.localTarget('file:///home/u/proj/.env')).toEqual({ refused: '.env is not served.' });
  });

  it('refuses every file where no server serves the chat\'s roots', async () => {
    const files = new ChatServedFiles({ roots: () => POSIX });
    expect(await files.localTarget('file:///home/u/proj/a.html')).toEqual({ refused: NO_SERVED_FILES_SERVER });
    expect(await files.localTarget('file:///tmp/a.html')).toEqual({ refused: outsideRootsRefusal(POSIX, '/tmp/a.html') });
    expect(await new ChatServedFiles({ roots: () => ({ designs: [] }) }).localTarget('file:///tmp/a.html')).toEqual({ refused: "This chat's browser opens files from a project, a design folder or a folder the user allowed; /tmp/a.html is outside them. Opening a page outside them asks the user to allow its folder for this chat; this one was not allowed." });
  });

  it('reads a Windows path, a UNC path and view-source: as the file Chrome loads for them, as the permission gate does', async () => {
    const serve = vi.fn(async () => ({ url: 'http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:5000/__damocles_preview/open?t=x&p=a.html', origin: 'http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:5000' }));
    const files = new ChatServedFiles({ roots: () => WINDOWS, serve });
    for (const url of ['C:\\Users\\u\\proj\\a.html', 'c|/Users/u/proj/a.html', ' view-source:file:///C:/Users/u/proj/a.html', 'view-source:C:\\Users\\u\\proj\\a.html', '\tfile:///C:/Users/u/proj/a.html\n']) {
      expect(await files.localTarget(url), url).toEqual({ url: 'http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:5000/__damocles_preview/open?t=x&p=a.html' });
    }
    expect(serve).toHaveBeenCalledTimes(5);
    expect(serve).toHaveBeenLastCalledWith({ kind: 'project', relPath: 'a.html' }, 'C:\\Users\\u\\proj');
    for (const [url, path] of [['D:\\secret.html', 'D:/secret.html'], ['\\\\192.0.2.1\\s\\x.html', '//192.0.2.1/s/x.html'], ['//192.0.2.1/s/x.html', '//192.0.2.1/s/x.html'], ['\\/192.0.2.1/s/x.html', '//192.0.2.1/s/x.html'], ['view-source:file://192.0.2.1/s/x.html', '//192.0.2.1/s/x.html']] as const) {
      expect(await files.localTarget(url), url).toEqual({ refused: outsideRootsRefusal(WINDOWS, path) });
    }
    // a file: text the URL parser rejects names no path a root can hold
    expect(await files.localTarget('file://ev il/x')).toEqual({ refused: outsideRootsRefusal(WINDOWS, 'file://ev il/x') });
    expect(serve).toHaveBeenCalledTimes(5);
  });

  it('serves a file of a project on a share from that project', async () => {
    const serve = vi.fn(async () => ({ url: 'http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:5000/__damocles_preview/open?t=x&p=docs%2Fa.html', origin: 'http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:5000' }));
    const share: ServedFileRoots = { project: '\\\\192.0.2.10\\team\\proj', designs: [] };
    const files = new ChatServedFiles({ roots: () => share, serve });
    expect(await files.localTarget('file://192.0.2.10/team/proj/docs/a.html')).toEqual({ url: 'http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:5000/__damocles_preview/open?t=x&p=docs%2Fa.html' });
    expect(await files.localTarget('\\\\192.0.2.10\\team\\proj\\docs\\a.html')).toEqual({ url: 'http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:5000/__damocles_preview/open?t=x&p=docs%2Fa.html' });
    expect(serve).toHaveBeenCalledWith({ kind: 'project', relPath: 'docs/a.html' }, '\\\\192.0.2.10\\team\\proj');
    expect(files.toFile('[URL] http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:5000/docs/a.html')).toBe('[URL] file://192.0.2.10/team/proj/docs/a.html');
    expect(await files.localTarget('file://192.0.2.10/team/other/a.html')).toEqual({ refused: outsideRootsRefusal(share, '//192.0.2.10/team/other/a.html') });
  });

  it('reopens a saved root page at its one-time served URL with its query and fragment, and maps the answers back', async () => {
    const serve = vi.fn(async () => ({ url: 'http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:5000/__damocles_preview/open?t=x&p=screens%2FS2.html', origin: 'http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:5000' }));
    const files = new ChatServedFiles({ roots: () => POSIX, serve });
    expect(await files.restoreTarget('file:///home/u/.damocles/designs/d1/screens/S2.html?state=empty#list')).toEqual({ url: 'http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:5000/__damocles_preview/open?t=x&p=screens%2FS2.html&q=state%3Dempty#list' });
    expect(serve).toHaveBeenCalledWith({ kind: 'design', designId: 'd1', relPath: 'screens/S2.html' }, '/home/u/.damocles/designs/d1');
    expect(files.toFile('[URL] http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:5000/screens/S2.html?state=empty')).toBe('[URL] file:///home/u/.damocles/designs/d1/screens/S2.html?state=empty');
  });

  it('never reopens a saved page outside the roots, one no root can hold, or one main does not serve, and never from disk', async () => {
    const serve = vi.fn(async () => ({ refused: 'This chat\'s project is not open in Damocles on this computer, so its files are not served.' }));
    const files = new ChatServedFiles({ roots: () => POSIX, serve });
    for (const url of ['file:///etc/passwd', 'file:///home/u/proj/../.ssh/id_rsa', 'file:///home/u/proj/docs%2F..%2F..%2Fx', 'file://192.0.2.2/share/a.html', 'file:///c:/secret']) {
      expect(await files.restoreTarget(url), url).toEqual({ refused: 'its address is outside the chat\'s project and design folders' });
    }
    const windows = new ChatServedFiles({ roots: () => WINDOWS, serve });
    for (const url of ['file:///c:/secret', 'file:///C:/Users/u/proj/a%5c..%5c..%5csecret', 'file://./C:/Users/u/proj/a.html', 'file:////192.0.2.2/share/a.html', 'file:///C:/Users/u/proj/con.txt']) {
      expect(await windows.restoreTarget(url), url).toEqual({ refused: 'its address is outside the chat\'s project and design folders' });
    }
    expect(serve).not.toHaveBeenCalled();
    expect(await files.restoreTarget('file:///home/u/proj/a.html')).toEqual({ refused: 'This chat\'s project is not open in Damocles on this computer, so its files are not served.' });
    serve.mockResolvedValueOnce({ refused: '.env is not opened.' });
    expect(await files.restoreTarget('file:///home/u/proj/.env')).toEqual({ refused: '.env is not opened.' });
    expect(await new ChatServedFiles({ roots: () => POSIX }).restoreTarget('file:///home/u/proj/a.html')).toEqual({ refused: NO_SERVED_FILES_SERVER });
  });

  it('names what a remote chat relays, or refuses a path outside the roots', () => {
    const files = new ChatServedFiles({ roots: () => POSIX });
    expect(files.relayed('file:///home/u/.damocles/designs/d1/screens/S2.html')).toEqual({ kind: 'design', designId: 'd1', relPath: 'screens/S2.html', displayRoot: '/home/u/.damocles/designs/d1' });
    expect(files.relayed('file:///etc/hosts')).toEqual({ refused: outsideRootsRefusal(POSIX, '/etc/hosts') });
    expect(files.relayed('http://localhost:5173/')).toBeUndefined();
    expect(files.relayed('not a url')).toBeUndefined();
  });

  it('refuses a remote chat\'s file URL no root can hold, naming the roots, rather than relay it', () => {
    const files = new ChatServedFiles({ roots: () => POSIX });
    for (const url of ['file:///home/u/proj/docs%2Fx.html', 'file:///home/u/proj/a%5cb.html', 'file:///home/u/proj/a%00b', 'file:///home/u/proj/%E0%A4%A']) {
      expect(files.relayed(url), url).toEqual({ refused: outsideRootsRefusal(POSIX, url) });
    }
    for (const [url, path] of [['file://192.0.2.2/share/a.html', '//192.0.2.2/share/a.html'], ['FILE://192.0.2.2/x', '//192.0.2.2/x'], ['//192.0.2.2/share/a.html', '//192.0.2.2/share/a.html'], ['view-source:file:///etc/hosts', '/etc/hosts']] as const) {
      expect(files.relayed(url), url).toEqual({ refused: outsideRootsRefusal(POSIX, path) });
    }
    expect(files.relayed('view-source:file:///home/u/proj/a.html')).toEqual({ kind: 'project', relPath: 'a.html', displayRoot: '/home/u/proj' });
    expect(outsideRootsRefusal(POSIX, '//192.0.2.2/share/a.html')).toContain('its project (/home/u/proj), its design folder (/home/u/.damocles/designs/d1)');
  });
});
