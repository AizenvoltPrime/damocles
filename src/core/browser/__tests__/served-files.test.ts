import { describe, expect, it, vi } from 'vitest';
import { ChatServedFiles, outsideRootsRefusal, resolveServedFile, type ServedFileRoots } from '../served-files';

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
      'file://server/home/u/proj/a.html',
    ]) expect(resolveServedFile(url, POSIX), url).toBe('outside');
    expect(resolveServedFile('file:///D:/Users/u/proj/a.html', WINDOWS)).toBe('outside');
    expect(resolveServedFile('file:///home/u/proj/a.html', { designs: [] })).toBe('outside');
  });
});

describe('outsideRootsRefusal', () => {
  it('names the roots and the path', () => {
    expect(outsideRootsRefusal(POSIX, '/etc/hosts')).toBe("This chat's browser opens files only from its project (/home/u/proj) and its design folder (/home/u/.damocles/designs/d1); /etc/hosts is outside them.");
    expect(outsideRootsRefusal(WINDOWS, 'D:/x')).toBe("This chat's browser opens files only from its project (C:\\Users\\u\\proj); D:/x is outside it.");
  });
});

describe('ChatServedFiles', () => {
  it('opens a local root file over its served URL and maps the answers back', async () => {
    const serve = vi.fn(async () => ({ url: 'http://127.0.0.1:5000/__damocles_preview/open?t=x&p=docs%2Fa.html', origin: 'http://127.0.0.1:5000' }));
    const files = new ChatServedFiles({ roots: () => POSIX, serve });
    expect(await files.localTarget('file:///home/u/proj/docs/a.html')).toEqual({ url: 'http://127.0.0.1:5000/__damocles_preview/open?t=x&p=docs%2Fa.html' });
    expect(serve).toHaveBeenCalledWith({ kind: 'project', relPath: 'docs/a.html' });
    expect(files.toFile('[URL] http://127.0.0.1:5000/docs/a.html')).toBe('[URL] file:///home/u/proj/docs/a.html');
    // the root's server restarted on another port: the old port is no longer the root's
    serve.mockResolvedValueOnce({ url: 'http://127.0.0.1:5001/__damocles_preview/open?t=y&p=b.html', origin: 'http://127.0.0.1:5001' });
    await files.localTarget('file:///home/u/proj/b.html');
    expect(files.toFile('http://127.0.0.1:5000/a http://127.0.0.1:5001/b')).toBe('http://127.0.0.1:5000/a file:///home/u/proj/b');
  });

  it('carries the address\'s query into the one-time open and its fragment onto it', async () => {
    const serve = vi.fn(async () => ({ url: 'http://127.0.0.1:5000/__damocles_preview/open?t=x&p=docs%2Findex.html', origin: 'http://127.0.0.1:5000' }));
    const files = new ChatServedFiles({ roots: () => POSIX, serve });
    const target = await files.localTarget('file:///home/u/proj/docs/?tab=2&q=a%20b#intro');
    expect(serve).toHaveBeenCalledWith({ kind: 'project', relPath: 'docs/index.html' });
    expect(target).toEqual({ url: 'http://127.0.0.1:5000/__damocles_preview/open?t=x&p=docs%2Findex.html&q=tab%3D2%26q%3Da%2520b#intro' });
    expect(files.toFile(`Opened browser: ${(target as { url: string }).url}`)).toBe('Opened browser: file:///home/u/proj/docs/index.html?tab=2&q=a%20b#intro');
    expect(files.toFile('[URL] http://127.0.0.1:5000/docs/index.html?tab=2&q=a%20b#intro')).toBe('[URL] file:///home/u/proj/docs/index.html?tab=2&q=a%20b#intro');
  });

  it('opens a root file from disk when main has no server for the chat\'s root, and never one main refuses', async () => {
    const serve = vi.fn(async () => ({ refused: 'This chat\'s project is not open in Damocles on this computer, so its files are not served.', unavailable: true }));
    const files = new ChatServedFiles({ roots: () => POSIX, serve });
    expect(await files.localTarget('file:///home/u/proj/docs/a.html#x')).toEqual({ url: 'file:///home/u/proj/docs/a.html#x' });
    serve.mockResolvedValueOnce({ refused: '.env is not opened.', unavailable: false });
    expect(await files.localTarget('file:///home/u/proj/.env')).toEqual({ refused: '.env is not opened.' });
  });

  it('opens a local file outside the roots from disk, and passes main\'s refusal on', async () => {
    const serve = vi.fn(async () => ({ refused: '.env is not served.' }));
    const files = new ChatServedFiles({ roots: () => POSIX, serve });
    expect(await files.localTarget('file:///tmp/a.html')).toEqual({ url: 'file:///tmp/a.html' });
    expect(await files.localTarget('https://example.com/')).toEqual({ url: 'https://example.com/' });
    expect(serve).not.toHaveBeenCalled();
    expect(await files.localTarget('file:///home/u/proj/.env')).toEqual({ refused: '.env is not served.' });
  });

  it('opens every file from disk where no server is (VS Code)', async () => {
    expect(await new ChatServedFiles({ roots: () => POSIX }).localTarget('file:///home/u/proj/a.html')).toEqual({ url: 'file:///home/u/proj/a.html' });
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
    for (const url of ['file://server/share/a.html', 'file:///home/u/proj/docs%2Fx.html', 'file:///home/u/proj/a%5cb.html', 'file:///home/u/proj/a%00b', 'file:///home/u/proj/%E0%A4%A', 'FILE://server/x']) {
      expect(files.relayed(url), url).toEqual({ refused: outsideRootsRefusal(POSIX, url) });
    }
    expect(outsideRootsRefusal(POSIX, 'file://server/share/a.html')).toContain('its project (/home/u/proj) and its design folder (/home/u/.damocles/designs/d1)');
  });
});
