import { describe, expect, it, vi } from 'vitest';
import type { RemoteHost } from '../../../platform/remote-host';
import type { PanelHost } from '../../../platform/window-service';
import { CLIENT_FEATURE_MISSING } from '../../../shared/remote-user';
import { relayedBrowserTools } from '../../pi-session/tools/browser-relay';
import { buildBrowserPiTools } from '../../pi-session/tools/browser-tools';
import { ChatServedFiles, outsideRootsRefusal, SERVED_FILES_CLIENT_TOO_OLD, type ServedFileRoots } from '../served-files';

interface ToolLike {
  name: string;
  execute: (id: string, input: unknown, signal?: AbortSignal) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
}

const ROOTS: ServedFileRoots = { project: '/home/u/proj', designs: [{ designId: 'd1', folder: '/home/u/.damocles/designs/d1' }] };
const ORIGIN = 'http://127.0.0.1:52341';
const textOf = (res: { content: Array<{ type: string; text?: string }> }): string => res.content.map((c) => c.text ?? '').join('\n');

describe('a local desktop chat\'s browser tools', () => {
  function tools(served: ChatServedFiles) {
    let current = 'about:blank';
    const scope = {
      open: vi.fn(async (url: string) => {
        current = url.includes('/__damocles_preview/open') ? `${ORIGIN}/docs/index.html` : url;
        return 200;
      }),
      waitForController: async () => false,
      getController: () => ({ captureScreenshot: async () => 'IMG' }),
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

  it('opens a root file with its query and fragment, and answers with them in file:// form', async () => {
    const serve = vi.fn(async () => ({ url: `${ORIGIN}/__damocles_preview/open?t=TOKEN&p=docs%2Findex.html`, origin: ORIGIN }));
    const { tools: built, scope } = tools(new ChatServedFiles({ roots: () => ROOTS, serve }));
    const opened = await built.get('BrowserOpen')!.execute('t', { url: 'file:///home/u/proj/docs/index.html?tab=2#intro' });
    expect(scope.open).toHaveBeenCalledWith(`${ORIGIN}/__damocles_preview/open?t=TOKEN&p=docs%2Findex.html&q=tab%3D2#intro`, undefined);
    expect(textOf(opened)).not.toContain('TOKEN');
  });

  it('opens a root file from disk when main has no server for the chat\'s project', async () => {
    const serve = vi.fn(async () => ({ refused: 'This chat\'s project is not open in Damocles on this computer, so its files are not served.', unavailable: true }));
    const { tools: built, scope } = tools(new ChatServedFiles({ roots: () => ROOTS, serve }));
    const opened = await built.get('BrowserOpen')!.execute('t', { url: 'file:///home/u/proj/docs/index.html' });
    expect(opened.isError).toBeFalsy();
    expect(scope.open).toHaveBeenCalledWith('file:///home/u/proj/docs/index.html', undefined);
  });

  it('opens a file outside the roots from disk as before, and refuses a file main does not serve', async () => {
    const serve = vi.fn(async () => ({ refused: '.env is not opened: files and folders whose names start with a dot are never served.' }));
    const { tools: built, scope } = tools(new ChatServedFiles({ roots: () => ROOTS, serve }));
    await built.get('BrowserNavigate')!.execute('t', { url: 'file:///tmp/fixture.html' });
    expect(scope.open).toHaveBeenLastCalledWith('file:///tmp/fixture.html', undefined);
    const refused = await built.get('BrowserNavigate')!.execute('t', { url: 'file:///home/u/proj/.env' });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('.env is not opened');
    expect(scope.open).toHaveBeenCalledTimes(1);
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
    const answer = await relayed(browserTool).get('BrowserNavigate')!.execute('t', { url: 'file://server/share/index.html' });
    expect(answer).toEqual(expect.objectContaining({ isError: true, content: [{ type: 'text', text: outsideRootsRefusal(ROOTS, 'file://server/share/index.html') }] }));
    expect(browserTool).not.toHaveBeenCalled();
  });

  it('refuses a file outside the roots before relaying, naming the roots', async () => {
    const browserTool = vi.fn();
    const answer = await relayed(browserTool).get('BrowserOpen')!.execute('t', { url: 'file:///etc/hosts' });
    expect(answer).toEqual(expect.objectContaining({ isError: true, content: [{ type: 'text', text: outsideRootsRefusal(ROOTS, '/etc/hosts') }] }));
    expect(textOf(answer)).toBe("This chat's browser opens files only from its project (/home/u/proj) and its design folder (/home/u/.damocles/designs/d1); /etc/hosts is outside them.");
    expect(browserTool).not.toHaveBeenCalled();
  });

  it('asks to update an app too old to serve root files', async () => {
    const answer = await relayed(vi.fn(async () => { throw new Error(CLIENT_FEATURE_MISSING); })).get('BrowserOpen')!.execute('t', { url: 'file:///home/u/proj/a.html' });
    expect(answer).toMatchObject({ isError: true, content: [{ type: 'text', text: SERVED_FILES_CLIENT_TOO_OLD }] });
    expect(SERVED_FILES_CLIENT_TOO_OLD).toBe('Update the Damocles app on the user\'s computer to open project and design files in this chat\'s browser.');
  });
});
