import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { DAMOCLES_HOME_DIR } from '../../paths';
import { fileUrlOfRoot, UNMAPPED_SERVED_PAGE } from '../../../shared/served-file-url';
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
