import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { DAMOCLES_HOME_DIR } from '../../paths';
import { fileUrlOfRoot, UNMAPPED_SERVED_PAGE } from '../../../shared/served-file-url';
import { dataStoresOf, type StoreHost } from '../../served-pages/data-stores';
import { ChatServedFiles, folderGrantRefusal, outsideRootsRefusal, type ServedFileRoots } from '../served-files';

// A file page outside a chat's project and design folders asks the user (the permission gate's outside-folder fact); the
// folder an approval grants is served to that chat only, for the chat's life (docs/invariants.md "Browser").

const PROJECT = path.join(os.tmpdir(), 'dm-served-folders', 'proj');
const OUTSIDE = path.join(os.tmpdir(), 'dm-served-folders', 'reports');
const ROOTS: ServedFileRoots = { project: PROJECT, designs: [] };
const fileUrl = (file: string): string => pathToFileURL(file).href;
const SERVED = { url: 'http://cccccccccccccccccccccccccccccccc.localhost:5002/__damocles_preview/open?t=x&p=week%2Fa.html', origin: 'http://cccccccccccccccccccccccccccccccc.localhost:5002' };

describe('ChatServedFiles granted folders', () => {
  it('asks for a file page outside the roots, naming the file and its folder, and never for one inside them or a web page', () => {
    const files = new ChatServedFiles({ roots: () => ROOTS, serve: vi.fn() });
    const page = path.join(OUTSIDE, 'a.html');
    expect(files.folderAsk('BrowserOpen', fileUrl(page))).toEqual({ file: page, folder: OUTSIDE });
    expect(files.folderAsk('BrowserNavigate', `${fileUrl(OUTSIDE)}/`)).toEqual({ file: path.join(OUTSIDE, 'index.html'), folder: OUTSIDE });
    expect(files.folderAsk('BrowserTabs', `view-source:${fileUrl(page)}`)).toEqual({ file: page, folder: OUTSIDE });
    expect(files.folderAsk('BrowserOpen', fileUrl(path.join(PROJECT, 'a.html')))).toBeUndefined();
    expect(files.folderAsk('BrowserOpen', 'https://example.com/')).toBeUndefined();
    expect(files.folderAsk('BrowserOpen', 'about:blank')).toBeUndefined();
  });

  it('serves a granted folder and its subfolders to that chat only, and keeps asking for anything else', async () => {
    const serve = vi.fn(async () => SERVED);
    const files = new ChatServedFiles({ roots: () => ROOTS, serve });
    files.grant(OUTSIDE);
    expect(files.folderAsk('BrowserOpen', fileUrl(path.join(OUTSIDE, 'week', 'a.html')))).toBeUndefined();
    expect(await files.localTarget(`${fileUrl(path.join(OUTSIDE, 'week', 'a.html'))}?x=1#top`)).toEqual({ url: `${SERVED.url}&q=x%3D1#top` });
    expect(serve).toHaveBeenCalledWith({ kind: 'folder', folder: OUTSIDE, relPath: 'week/a.html' }, OUTSIDE);
    expect(files.toFile(`[URL] ${SERVED.origin}/week/a.html`)).toBe(`[URL] ${fileUrlOfRoot(OUTSIDE)}/week/a.html`);
    // its pages' origin is the chat's, as a root's is
    expect(files.ownsOrigin(SERVED.origin)).toBe(true);
    // the folder's parent and a sibling are still outside: they ask, and the tool refuses them unasked
    const sibling = path.join(path.dirname(OUTSIDE), 'other', 'b.html');
    expect(files.folderAsk('BrowserOpen', fileUrl(sibling))).toEqual({ file: sibling, folder: path.dirname(sibling) });
    expect(await files.localTarget(fileUrl(sibling))).toMatchObject({ refused: expect.stringContaining('asks the user') });
    expect(serve).toHaveBeenCalledTimes(1);
    // a '..' that leaves the folder is resolved by the URL parser before the folder is matched
    expect(files.folderAsk('BrowserOpen', `${fileUrl(OUTSIDE)}/../x.html`)).toEqual({ file: path.join(path.dirname(OUTSIDE), 'x.html'), folder: path.dirname(OUTSIDE) });
    // another chat holds no grant of its own
    const other = new ChatServedFiles({ roots: () => ROOTS, serve });
    expect(other.folderAsk('BrowserOpen', fileUrl(path.join(OUTSIDE, 'week', 'a.html')))).toEqual({ file: path.join(OUTSIDE, 'week', 'a.html'), folder: path.join(OUTSIDE, 'week') });
    expect(await other.localTarget(fileUrl(path.join(OUTSIDE, 'week', 'a.html')))).toMatchObject({ refused: expect.stringContaining('asks the user') });
    expect(other.toFile(`[URL] ${SERVED.origin}/week/a.html`)).toBe(`[URL] ${UNMAPPED_SERVED_PAGE}`);
    expect(other.ownsOrigin(SERVED.origin)).toBe(false);
  });

  it('never reopens a saved page of a granted folder, since grants are not saved and saved addresses are page-controlled', async () => {
    const serve = vi.fn(async () => SERVED);
    const files = new ChatServedFiles({ roots: () => ROOTS, serve });
    files.grant(OUTSIDE);
    expect(await files.restoreTarget(fileUrl(path.join(OUTSIDE, 'a.html')))).toEqual({ refused: 'its address is outside the chat\'s project and design folders' });
    expect(await new ChatServedFiles({ roots: () => ROOTS, serve }).restoreTarget(fileUrl(path.join(OUTSIDE, 'a.html')))).toEqual({ refused: 'its address is outside the chat\'s project and design folders' });
    expect(serve).not.toHaveBeenCalled();
  });

  it('refuses to grant a root, the home folder or a folder holding it, and Damocles\' own folder, asking for a subfolder', () => {
    const files = new ChatServedFiles({ roots: () => ROOTS, serve: vi.fn() });
    const home = os.homedir();
    const root = path.parse(home).root;
    for (const folder of [root, home, path.dirname(home), DAMOCLES_HOME_DIR, path.join(DAMOCLES_HOME_DIR, 'sessions')]) {
      const page = path.join(folder, 'a.html');
      const ask = files.folderAsk('BrowserOpen', fileUrl(page));
      expect(ask, folder).toEqual({ refused: folderGrantRefusal(folder, true) });
      expect(folderGrantRefusal(folder, true), folder).toContain(folder);
    }
    expect(folderGrantRefusal(root, true)).toContain('subfolder');
    expect(folderGrantRefusal(home, true)).toContain('subfolder');
    expect(folderGrantRefusal(path.join(home, 'Downloads'), true)).toBeUndefined();
    expect(folderGrantRefusal(OUTSIDE, true)).toBeUndefined();
  });

  it('refuses a folder holding a data store this host\'s env names, the list the preview deny rule reads', () => {
    const holder = path.join(os.tmpdir(), 'dm-served-folders', 'stores');
    const store = path.join(holder, 'data');
    vi.stubEnv(process.platform === 'win32' ? 'ProgramData' : 'XDG_CONFIG_HOME', store);
    try {
      expect(folderGrantRefusal(holder, true)).toBe(`${holder} holds ${store}, where applications or the system keep their data, and a page there could read every file in it. Move the page into a subfolder and open it there.`);
      expect(folderGrantRefusal(path.join(holder, 'other'), true)).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('starts resolving this core\'s data stores when a chat\'s served files are built, before any grant is judged', async () => {
    const store = path.join(os.tmpdir(), 'dm-served-folders', 'stores', 'warmed');
    vi.stubEnv(process.platform === 'win32' ? 'ProgramData' : 'XDG_CONFIG_HOME', store);
    const realpath = vi.spyOn(fs, 'realpath');
    try {
      new ChatServedFiles({ roots: () => ROOTS, serve: vi.fn() });
      await vi.waitFor(() => expect(realpath).toHaveBeenCalledWith(store));
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });

  it('refuses a folder inside a data store this host\'s env names, unasked', () => {
    const store = path.join(os.tmpdir(), 'dm-served-folders', 'stores', 'data');
    vi.stubEnv(process.platform === 'win32' ? 'ProgramData' : 'XDG_CONFIG_HOME', store);
    try {
      const files = new ChatServedFiles({ roots: () => ROOTS, serve: vi.fn() });
      const inside = path.join(store, 'Damocles');
      const refused = `${inside} is or lies inside ${store}, where applications or the system keep their data, so it is not served. Move the page into a folder outside it and open it there.`;
      expect(files.folderAsk('BrowserOpen', fileUrl(path.join(inside, 'a.html')))).toEqual({ refused });
      expect(folderGrantRefusal(inside, true)).toBe(refused);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('refuses a folder inside a Windows host\'s application data, and grants its temp folder and pnpm store', () => {
    const windows: StoreHost = {
      platform: 'win32',
      home: 'C:\\Users\\me',
      env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', TEMP: 'C:\\Users\\me\\AppData\\Local\\Temp' },
      drives: [],
    };
    expect(folderGrantRefusal('C:\\Users\\me\\AppData\\Roaming\\Damocles', true, windows.home, dataStoresOf(windows))).toBe('C:\\Users\\me\\AppData\\Roaming\\Damocles is or lies inside C:\\Users\\me\\AppData\\Roaming, where applications or the system keep their data, so it is not served. Move the page into a folder outside it and open it there.');
    expect(folderGrantRefusal('c:\\users\\me\\appdata\\local\\Google', true, windows.home, dataStoresOf(windows))).toContain('lies inside C:\\Users\\me\\AppData\\Local,');
    expect(folderGrantRefusal('C:\\Users\\me\\AppData\\LocalLow\\x', true, windows.home, dataStoresOf(windows))).toContain('lies inside C:\\Users\\me\\AppData,');
    expect(folderGrantRefusal('C:\\Users\\me\\AppData\\Local\\Temp\\build', true, windows.home, dataStoresOf(windows))).toBeUndefined();
    expect(folderGrantRefusal('C:\\Users\\me\\AppData\\Local\\pnpm\\store\\v10', true, windows.home, dataStoresOf(windows))).toBeUndefined();
    expect(folderGrantRefusal('C:\\Users\\me\\src\\site', true, windows.home, dataStoresOf(windows))).toBeUndefined();
  });

  it('refuses a folder inside macOS\'s ~/Library, and grants its cloud folders', () => {
    const mac: StoreHost = { platform: 'darwin', home: '/Users/me', env: {}, drives: [] };
    expect(folderGrantRefusal('/Users/me/Library/Keychains', true, mac.home, dataStoresOf(mac))).toContain('lies inside /Users/me/Library,');
    expect(folderGrantRefusal('/Users/me/Library/CloudStorage/Dropbox/site', true, mac.home, dataStoresOf(mac))).toBeUndefined();
  });

  it('judges a WSL distro\'s Windows drives by their stores, with every 8.3 name refused there', () => {
    const wsl: StoreHost = { platform: 'linux', home: '/home/me', env: {}, drives: [{ mountPoint: '/mnt/c', prefix: [] }] };
    // drvfs answers a short name for any folder, and a Linux realpath leaves it as spelled
    expect(folderGrantRefusal('/mnt/c/Users/me/SSH~1', true, wsl.home, dataStoresOf(wsl))).toContain('hidden folder (SSH~1)');
    expect(folderGrantRefusal('/home/me/src/A~1', true, wsl.home, dataStoresOf(wsl))).toBeUndefined();
    expect(folderGrantRefusal('/mnt/c/Users/me/AppData/Roaming/x', true, wsl.home, dataStoresOf(wsl))).toContain('lies inside /mnt/c/Users/me/AppData,');
    expect(folderGrantRefusal('/mnt/c/WINDOWS/Temp', true, wsl.home, dataStoresOf(wsl))).toContain('lies inside /mnt/c/WINDOWS,');
    expect(folderGrantRefusal('/mnt/c/Users', true, wsl.home, dataStoresOf(wsl))).toBe('/mnt/c/Users holds /mnt/c/Users/<user>/AppData, a folder where Windows keeps application or system data, and a page there could read every file in it. Move the page into a subfolder and open it there.');
    expect(folderGrantRefusal('/mnt/c/users/me', true, wsl.home, dataStoresOf(wsl))).toContain('holds /mnt/c/users/me/AppData,');
    expect(folderGrantRefusal('/mnt/c', true, wsl.home, dataStoresOf(wsl))).toContain('holds /mnt/c/Windows,');
    expect(folderGrantRefusal('/mnt', true, wsl.home, dataStoresOf(wsl))).toContain('holds /mnt/c/Windows,');
    expect(folderGrantRefusal('/mnt/c/Users/me/AppData/Local/Temp/site', true, wsl.home, dataStoresOf(wsl))).toBeUndefined();
    expect(folderGrantRefusal('/mnt/c/Users/me/src/site', true, wsl.home, dataStoresOf(wsl))).toBeUndefined();
  });

  it('refuses a Windows host\'s fixed store names on every drive, and a drive\'s Users folder and profiles as holding them', () => {
    const windows: StoreHost = { platform: 'win32', home: 'C:\\Users\\me', env: {}, drives: [] };
    const refusal = (folder: string): string | undefined => folderGrantRefusal(folder, true, windows.home, dataStoresOf(windows));
    expect(refusal('C:\\Users\\me\\AppData')).toBe('C:\\Users\\me\\AppData is or lies inside C:\\Users\\me\\AppData, where applications or the system keep their data, so it is not served. Move the page into a folder outside it and open it there.');
    for (const [folder, store] of [['C:\\Users\\Other\\AppData\\Roaming\\x', 'C:\\Users\\Other\\AppData'], ['D:\\Windows\\System32', 'D:\\Windows'], ['D:\\ProgramData\\x', 'D:\\ProgramData'], ['E:\\data\\AppData\\z', 'E:\\data\\AppData']] as const) {
      expect(refusal(folder), folder).toContain(`is or lies inside ${store},`);
    }
    expect(refusal('D:\\Users')).toBe('D:\\Users holds D:\\Users\\<user>\\AppData, a folder where Windows keeps application or system data, and a page there could read every file in it. Move the page into a subfolder and open it there.');
    expect(refusal('D:\\Users\\x')).toContain('holds D:\\Users\\x\\AppData,');
    expect(refusal('D:\\Users\\x\\src')).toBeUndefined();
    expect(refusal('E:\\data\\AppData\\Local\\Temp\\site')).toBeUndefined();
  });

  it('judges a Windows host\'s path into a WSL drive mount as that drive\'s, with every 8.3 name refused there', () => {
    const windows: StoreHost = { platform: 'win32', home: 'C:\\Users\\me', env: {}, drives: [] };
    const refusal = (folder: string): string | undefined => folderGrantRefusal(folder, true, windows.home, dataStoresOf(windows));
    expect(refusal('\\\\wsl$\\Ubuntu\\mnt\\c\\Users\\me\\AppData\\Roaming\\x')).toContain('is or lies inside C:\\Users\\me\\AppData,');
    expect(refusal('\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Users\\me\\SSH~1')).toContain('hidden folder (SSH~1)');
    expect(refusal('\\\\wsl$\\Ubuntu\\home\\me\\A~1')).toBeUndefined();
    expect(refusal('\\\\wsl$\\Ubuntu\\mnt\\c')).toContain('is the root of a drive');
    expect(refusal('\\\\wsl$\\Ubuntu\\mnt\\c\\Users\\me')).toContain('is the user\'s home folder or holds it');
    expect(refusal('\\\\wsl$\\Ubuntu\\mnt\\d\\Users')).toContain('holds \\\\wsl$\\Ubuntu\\mnt\\d\\Users\\<user>\\AppData,');
    expect(refusal('\\\\wsl$\\Ubuntu\\mnt')).toContain('holds \\\\wsl$\\Ubuntu\\mnt\\<drive>\\Windows,');
    expect(refusal('\\\\wsl$\\Ubuntu\\mnt\\c\\Users\\me\\src\\site')).toBeUndefined();
  });

  it('refuses a share\'s root and a drive\'s root by their spelling on Windows', () => {
    if (process.platform !== 'win32') return;
    for (const folder of ['\\\\192.0.2.10\\share', '\\\\192.0.2.10\\share\\', 'Z:\\', 'z:']) expect(folderGrantRefusal(folder), folder).toContain('subfolder');
    expect(folderGrantRefusal('\\\\192.0.2.10\\share\\reports')).toBeUndefined();
  });

  it('asks nothing where no server can serve a folder, so the tool refuses the page as before', () => {
    const files = new ChatServedFiles({ roots: () => ROOTS });
    expect(files.folderAsk('BrowserOpen', fileUrl(path.join(OUTSIDE, 'a.html')))).toBeUndefined();
  });

  it('relays a granted folder\'s file for a remote chat, and asks nothing for a remote new tab, which opens no file', () => {
    const files = new ChatServedFiles({ roots: () => ROOTS, relayed: true });
    const page = path.join(OUTSIDE, 'week', 'a.html');
    expect(files.folderAsk('BrowserTabs', fileUrl(page))).toBeUndefined();
    expect(files.folderAsk('BrowserNavigate', fileUrl(page))).toEqual({ file: page, folder: path.join(OUTSIDE, 'week') });
    expect(files.relayed(fileUrl(page))).toMatchObject({ refused: expect.stringContaining('asks the user') });
    files.grant(OUTSIDE);
    expect(files.relayed(fileUrl(page))).toEqual({ kind: 'folder', folder: OUTSIDE, relPath: 'week/a.html', displayRoot: OUTSIDE });
  });

  it('says the user is asked when it refuses a page outside the roots', () => {
    expect(outsideRootsRefusal(ROOTS, '/tmp/a.html')).toContain('asks the user to allow its folder');
  });
});
