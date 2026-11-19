import { describe, expect, it, vi } from 'vitest';
import type { RemoteHost } from '../../../platform/remote-host';
import type { PanelHost } from '../../../platform/window-service';
import { CLIENT_FEATURE_MISSING } from '../../../shared/remote-user';
import { relayedBrowserTools, REMOTE_TAB_FILE_REFUSAL } from '../../pi-session/tools/browser-relay';
import { buildBrowserPiTools } from '../../pi-session/tools/browser-tools';
import { ChatServedFiles, outsideRootsRefusal, SERVED_FILES_CLIENT_TOO_OLD, SERVED_FOLDERS_CLIENT_TOO_OLD, type ServedFileRoots } from '../served-files';

interface ToolLike {
  name: string;
  execute: (id: string, input: unknown, signal?: AbortSignal) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
}

const ROOTS: ServedFileRoots = { project: '/home/u/proj', designs: [{ designId: 'd1', folder: '/home/u/.damocles/designs/d1' }] };
const ORIGIN = 'http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:52341';
const textOf = (res: { content: Array<{ type: string; text?: string }> }): string => res.content.map((c) => c.text ?? '').join('\n');

describe('a local chat\'s browser tools', () => {
  function tools(served: ChatServedFiles) {
    let current = 'about:blank';
    const page = {
      waitForLoadState: async () => undefined,
      evaluate: async () => ({ snapshot: '', refCount: 0, title: 'T', url: current, belowFold: 0, scrollInfo: [], emptyFields: [] }),
      isClosed: () => false,
    };
    const scope = {
      open: vi.fn(async (url: string) => {
        current = url.includes('/__damocles_preview/open') ? `${ORIGIN}/docs/index.html` : url;
        return 200;
      }),
      openNewTab: vi.fn(async (url?: string) => {
        if (url !== undefined) current = url.includes('/__damocles_preview/open') ? `${ORIGIN}/docs/index.html` : url;
        return 200;
      }),
      waitForController: async () => false,
      getController: () => ({ captureScreenshot: async () => 'IMG', getPage: () => page }),
      getCurrentUrl: () => current,
      takeUnreportedDialogs: () => [],
    };
    const built = buildBrowserPiTools({ pi: { defineTool: (c: unknown) => c }, scope, served } as never) as unknown as ToolLike[];
    return { tools: new Map(built.map((tool) => [tool.name, tool])), scope };
  }

  it('opens a project file on its served URL and shows only the file:// address in every answer', async () => {
    const serve = vi.fn(async () => ({ url: `${ORIGIN}/__damocles_preview/open?t=TOKEN&p=docs%2Findex.html`, origin: ORIGIN }));
    const { tools: built, scope } = tools(new ChatServedFiles({ roots: () => ROOTS, serve }));
    const opened = await built.get('BrowserOpen')!.execute('t', { url: 'file:///home/u/proj/docs/index.html' });
    expect(scope.open).toHaveBeenCalledWith(`${ORIGIN}/__damocles_preview/open?t=TOKEN&p=docs%2Findex.html`, undefined);
    expect(textOf(opened)).toContain('Opened browser: file:///home/u/proj/docs/index.html');
    const shot = await built.get('BrowserScreenshot')!.execute('t', {});
    expect(shot.content[0]).toEqual({ type: 'text', text: 'Screenshot of: file:///home/u/proj/docs/index.html' });
  });

  it('holds the served origin before the page opens, so the page\'s network guard lets the chat\'s own pages through', async () => {
    const serve = vi.fn(async () => ({ url: `${ORIGIN}/__damocles_preview/open?t=TOKEN&p=docs%2Findex.html`, origin: ORIGIN }));
    const served = new ChatServedFiles({ roots: () => ROOTS, serve });
    const { tools: built, scope } = tools(served);
    const heldAtOpen: boolean[] = [];
    const open = scope.open.getMockImplementation()!;
    scope.open.mockImplementation(async (url: string) => {
      heldAtOpen.push(served.ownsOrigin(ORIGIN));
      return open(url);
    });
    expect(served.ownsOrigin(ORIGIN)).toBe(false);
    await built.get('BrowserOpen')!.execute('t', { url: 'file:///home/u/proj/docs/index.html' });
    expect(heldAtOpen).toEqual([true]);
    expect(served.ownsOrigin(ORIGIN)).toBe(true);
    expect(served.ownsOrigin(`http://${'b'.repeat(32)}.localhost:52341`)).toBe(false);
  });

  it('names another chat\'s served page in a BrowserDownloads answer without its host', async () => {
    const serve = vi.fn(async () => ({ url: `${ORIGIN}/__damocles_preview/open?t=TOKEN&p=docs%2Findex.html`, origin: ORIGIN }));
    const { tools: built, scope } = tools(new ChatServedFiles({ roots: () => ROOTS, serve }));
    await built.get('BrowserOpen')!.execute('t', { url: 'file:///home/u/proj/docs/index.html' });
    const other = `http://${'b'.repeat(32)}.localhost:52342/out/report.pdf`;
    Object.assign(scope, { getDownloads: () => [{ filename: 'report.pdf', savedPath: '/dl/report.pdf', url: other, state: 'completed' }, { filename: 'a.pdf', savedPath: '/dl/a.pdf', url: `${ORIGIN}/docs/a.pdf`, state: 'completed' }] });
    const text = textOf(await built.get('BrowserDownloads')!.execute('t', {}));
    expect(text).toContain('report.pdf — /dl/report.pdf — [a served page this chat cannot open] [completed]');
    expect(text).toContain('a.pdf — /dl/a.pdf — file:///home/u/proj/docs/a.pdf [completed]');
    expect(text).not.toContain('bbbb');
  });

  it('opens a root file with its query and fragment, and answers with them in file:// form', async () => {
    const serve = vi.fn(async () => ({ url: `${ORIGIN}/__damocles_preview/open?t=TOKEN&p=docs%2Findex.html`, origin: ORIGIN }));
    const { tools: built, scope } = tools(new ChatServedFiles({ roots: () => ROOTS, serve }));
    const opened = await built.get('BrowserOpen')!.execute('t', { url: 'file:///home/u/proj/docs/index.html?tab=2#intro' });
    expect(scope.open).toHaveBeenCalledWith(`${ORIGIN}/__damocles_preview/open?t=TOKEN&p=docs%2Findex.html&q=tab%3D2#intro`, undefined);
    expect(textOf(opened)).not.toContain('TOKEN');
  });

  it('refuses a root file when the server has none for the chat\'s project, opening nothing', async () => {
    const serve = vi.fn(async () => ({ refused: 'This chat\'s project is not open in Damocles on this computer, so its files are not served.' }));
    const { tools: built, scope } = tools(new ChatServedFiles({ roots: () => ROOTS, serve }));
    const opened = await built.get('BrowserOpen')!.execute('t', { url: 'file:///home/u/proj/docs/index.html' });
    expect(opened).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Error: This chat\'s project is not open in Damocles on this computer, so its files are not served.' }] });
    expect(scope.open).not.toHaveBeenCalled();
  });

  it('refuses a file outside the roots, naming them, and a file the server does not serve, opening nothing', async () => {
    const serve = vi.fn(async () => ({ refused: '.env is not opened: files and folders whose names start with a dot are never served.' }));
    const { tools: built, scope } = tools(new ChatServedFiles({ roots: () => ROOTS, serve }));
    for (const url of ['file:///tmp/fixture.html', '//192.0.2.1/s/x.html', 'view-source:file:///tmp/fixture.html']) {
      const outside = await built.get('BrowserNavigate')!.execute('t', { url });
      expect(outside, url).toMatchObject({ isError: true });
      expect(textOf(outside), url).toMatch(/^Error: This chat's browser opens files from its project \(\/home\/u\/proj\), its design folder \(\/home\/u\/\.damocles\/designs\/d1\) and folders the user allowed; .* is outside them\. Opening a page outside them asks the user to allow its folder for this chat; this one was not allowed\.$/);
    }
    const refused = await built.get('BrowserNavigate')!.execute('t', { url: 'file:///home/u/proj/.env' });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('.env is not opened');
    expect(scope.open).not.toHaveBeenCalled();
  });

  it('opens a new tab on a root file\'s served URL, refuses one outside the roots, and opens any other URL as given', async () => {
    const serve = vi.fn(async () => ({ url: `${ORIGIN}/__damocles_preview/open?t=TOKEN&p=docs%2Findex.html`, origin: ORIGIN }));
    const { tools: built, scope } = tools(new ChatServedFiles({ roots: () => ROOTS, serve }));
    const opened = await built.get('BrowserTabs')!.execute('t', { action: 'new', url: 'file:///home/u/proj/docs/index.html' });
    expect(scope.openNewTab).toHaveBeenLastCalledWith(`${ORIGIN}/__damocles_preview/open?t=TOKEN&p=docs%2Findex.html`);
    expect(textOf(opened)).toContain('Opened new tab: file:///home/u/proj/docs/index.html');
    expect(textOf(opened)).not.toContain('TOKEN');
    const outside = await built.get('BrowserTabs')!.execute('t', { action: 'new', url: 'file:///etc/hosts' });
    expect(outside).toMatchObject({ isError: true, content: [{ type: 'text', text: `Error: ${outsideRootsRefusal(ROOTS, '/etc/hosts')}` }] });
    await built.get('BrowserTabs')!.execute('t', { action: 'new', url: 'http://localhost:5173/' });
    expect(scope.openNewTab).toHaveBeenLastCalledWith('http://localhost:5173/');
    await built.get('BrowserTabs')!.execute('t', { action: 'new' });
    expect(scope.openNewTab).toHaveBeenLastCalledWith(undefined);
    expect(scope.openNewTab).toHaveBeenCalledTimes(3);
  });
});

describe('a remote chat\'s relayed browser tools', () => {
  const definitions = ['BrowserOpen', 'BrowserNavigate', 'BrowserTabs'].map((name) => ({ name, execute: vi.fn() })) as never[];
  const chat = {} as PanelHost;

  function relayed(browserTool: RemoteHost['browserTool']): Map<string, ToolLike> {
    const remote = { browserTool } as RemoteHost;
    return new Map((relayedBrowserTools(definitions, remote, chat, 'chat', new ChatServedFiles({ roots: () => ROOTS })) as unknown as ToolLike[]).map((tool) => [tool.name, tool]));
  }

  it('relays a root file with what it names, and a design screen with its design', async () => {
    const browserTool = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
    const tools = relayed(browserTool);
    await tools.get('BrowserOpen')!.execute('t', { url: 'file:///home/u/proj/docs/index.html' });
    expect(browserTool).toHaveBeenLastCalledWith(chat, 'chat', 'BrowserOpen', { url: 'file:///home/u/proj/docs/index.html' }, undefined, { kind: 'project', relPath: 'docs/index.html', displayRoot: '/home/u/proj' });
    await tools.get('BrowserNavigate')!.execute('t', { url: 'file:///home/u/.damocles/designs/d1/screens/S2.html' });
    expect(browserTool).toHaveBeenLastCalledWith(chat, 'chat', 'BrowserNavigate', expect.anything(), undefined, { kind: 'design', designId: 'd1', relPath: 'screens/S2.html', displayRoot: '/home/u/.damocles/designs/d1' });
    await tools.get('BrowserNavigate')!.execute('t', { url: 'http://localhost:5173/' });
    expect(browserTool).toHaveBeenLastCalledWith(chat, 'chat', 'BrowserNavigate', { url: 'http://localhost:5173/' }, undefined);
  });

  it('refuses a file URL no root can hold before relaying, naming the roots', async () => {
    const browserTool = vi.fn();
    const tools = relayed(browserTool);
    for (const [url, named] of [['file://192.0.2.2/share/index.html', '//192.0.2.2/share/index.html'], ['\\\\192.0.2.2\\share\\index.html', '//192.0.2.2/share/index.html'], ['file://ev il/x', 'file://ev il/x'], ['view-source:file:///etc/hosts', '/etc/hosts']] as const) {
      const answer = await tools.get('BrowserNavigate')!.execute('t', { url });
      expect(answer, url).toEqual(expect.objectContaining({ isError: true, content: [{ type: 'text', text: outsideRootsRefusal(ROOTS, named) }] }));
    }
    expect(browserTool).not.toHaveBeenCalled();
  });

  it('refuses a file outside the roots before relaying, naming the roots', async () => {
    const browserTool = vi.fn();
    const answer = await relayed(browserTool).get('BrowserOpen')!.execute('t', { url: 'file:///etc/hosts' });
    expect(answer).toEqual(expect.objectContaining({ isError: true, content: [{ type: 'text', text: outsideRootsRefusal(ROOTS, '/etc/hosts') }] }));
    expect(textOf(answer)).toBe("This chat's browser opens files from its project (/home/u/proj), its design folder (/home/u/.damocles/designs/d1) and folders the user allowed; /etc/hosts is outside them. Opening a page outside them asks the user to allow its folder for this chat; this one was not allowed.");
    expect(browserTool).not.toHaveBeenCalled();
  });

  it('refuses a new tab\'s file page before relaying: outside the roots naming them, a root file naming the tools that open it', async () => {
    const browserTool = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
    const tools = relayed(browserTool);
    const outside = await tools.get('BrowserTabs')!.execute('t', { action: 'new', url: 'file:///etc/hosts' });
    expect(outside).toMatchObject({ isError: true, content: [{ type: 'text', text: outsideRootsRefusal(ROOTS, '/etc/hosts') }] });
    const root = await tools.get('BrowserTabs')!.execute('t', { action: 'new', url: 'view-source:file:///home/u/proj/a.html' });
    expect(root).toMatchObject({ isError: true, content: [{ type: 'text', text: REMOTE_TAB_FILE_REFUSAL }] });
    expect(browserTool).not.toHaveBeenCalled();
    await tools.get('BrowserTabs')!.execute('t', { action: 'new', url: 'http://localhost:5173/' });
    await tools.get('BrowserTabs')!.execute('t', { action: 'select', index: 0, url: 'file:///etc/hosts' });
    expect(browserTool).toHaveBeenCalledTimes(2);
  });

  it('relays a granted folder\'s file with its folder, and asks to update an app too old to serve one', async () => {
    const files = new ChatServedFiles({ roots: () => ROOTS, relayed: true });
    files.grant('/home/u/reports');
    const browserTool = vi.fn(async () => { throw new Error(CLIENT_FEATURE_MISSING); });
    const tools = new Map((relayedBrowserTools(definitions, { browserTool } as unknown as RemoteHost, chat, 'chat', files) as unknown as ToolLike[]).map((tool) => [tool.name, tool]));
    const answer = await tools.get('BrowserNavigate')!.execute('t', { url: 'file:///home/u/reports/a.html' });
    expect(browserTool).toHaveBeenCalledWith(chat, 'chat', 'BrowserNavigate', { url: 'file:///home/u/reports/a.html' }, undefined, { kind: 'folder', folder: '/home/u/reports', relPath: 'a.html', displayRoot: '/home/u/reports' });
    expect(answer).toMatchObject({ isError: true, content: [{ type: 'text', text: SERVED_FOLDERS_CLIENT_TOO_OLD }] });
  });

  it('asks to update an app too old to serve root files', async () => {
    const answer = await relayed(vi.fn(async () => { throw new Error(CLIENT_FEATURE_MISSING); })).get('BrowserOpen')!.execute('t', { url: 'file:///home/u/proj/a.html' });
    expect(answer).toMatchObject({ isError: true, content: [{ type: 'text', text: SERVED_FILES_CLIENT_TOO_OLD }] });
    expect(SERVED_FILES_CLIENT_TOO_OLD).toBe('Update the Damocles app on the user\'s computer to open project and design files in this chat\'s browser.');
  });
});
