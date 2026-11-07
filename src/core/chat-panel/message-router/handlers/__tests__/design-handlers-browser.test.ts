import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createFakePlatform, type FakePlatform } from '../../../../../__mocks__/fake-platform';
import { designRuleSet } from '../../../../design/rule-set';
import { createDesignHandlers } from '../design-handlers';
import type { HandlerContext, HandlerDependencies } from '../../types';
import type { ExtensionToWebviewMessage } from '../../../../../shared/types/messages';

vi.mock('../../../../logger', () => ({ log: vi.fn() }));

const DESIGN = 'contacts-1a2b3c4d';
const FOLDER = '/home/u/.damocles/designs/contacts-1a2b3c4d';

function setup(platform: FakePlatform): { posted: ExtensionToWebviewMessage[]; open: (designId: string, relPath: string) => Promise<void> } {
  const posted: ExtensionToWebviewMessage[] = [];
  const handlers = createDesignHandlers({ platform, postMessage: (_to: unknown, message: ExtensionToWebviewMessage) => posted.push(message) } as unknown as HandlerDependencies);
  // The chat's own design is the only one it resolves a folder for.
  const design = { hostRuleSet: () => designRuleSet(platform.capabilities), servedFolderOf: (designId: string) => (designId === DESIGN ? FOLDER : undefined) };
  const ctx = { reply: {}, panelId: 'p1', session: { design } } as unknown as HandlerContext;
  return { posted, open: async (designId, relPath) => { await handlers.openDesignInBrowser!({ type: 'openDesignInBrowser', designId, relPath }, ctx); } };
}

describe('openDesignInBrowser', () => {
  it('serves a file of the chat\'s own design through the host and names the URL in a toast', async () => {
    const platform = createFakePlatform();
    const { posted, open } = setup(platform);

    await open(DESIGN, 'screens/S1-contacts.html');

    expect(platform.design!.opened).toEqual([{ designId: DESIGN, folder: FOLDER, relPath: 'screens/S1-contacts.html' }]);
    expect(posted).toEqual([{ type: 'notification', notificationType: 'info', message: { message: 'Opened {0} in the browser.', args: [`http://127.0.0.1/d/${DESIGN}/screens/S1-contacts.html`] } }]);
  });

  it('refuses another chat\'s design and a path that is not a relative file path, opening nothing', async () => {
    const platform = createFakePlatform();
    const { posted, open } = setup(platform);

    await open('billing-9f8e7d6c', 'screens/S1.html');
    await open(DESIGN, '../secrets.txt');
    await open(DESIGN, 'screens\\S1.html');
    await open('../etc', 'screens/S1.html');

    expect(platform.design!.opened).toEqual([]);
    expect(platform.shell.openedExternal).toEqual([]);
    expect(posted.map((message) => message.type === 'notification' && message.notificationType)).toEqual(['error', 'error', 'error']);
  });

  it('opens nothing on a FULL host, which opens designs from its own UI only (PD-35)', async () => {
    const platform = createFakePlatform({ capabilities: { designPreview: true } });
    const { posted, open } = setup(platform);

    await open(DESIGN, 'screens/S1-contacts.html');

    expect(platform.design).toBeUndefined();
    expect(platform.shell.openedExternal).toEqual([]);
    expect(posted).toEqual([{ type: 'notification', notificationType: 'warning', message: { message: 'This window does not open designs in the browser.' } }]);
  });

  it('says so when the host declines or fails', async () => {
    const platform = createFakePlatform();
    const { posted, open } = setup(platform);
    const opened = vi.spyOn(platform.design!, 'openInBrowser').mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('no forward'));

    await open(DESIGN, 'screens/S1-contacts.html');
    await open(DESIGN, 'screens/S1-contacts.html');

    expect(opened).toHaveBeenCalledTimes(2);
    expect(posted).toEqual([
      { type: 'notification', notificationType: 'error', message: { message: 'Could not open {0} in the browser.', args: ['screens/S1-contacts.html'] } },
      { type: 'notification', notificationType: 'error', message: { message: 'Could not open {0} in the browser: {1}', args: ['screens/S1-contacts.html', expect.anything()] } },
    ]);
  });
});

describe('openDesignPreview', () => {
  function previewSetup(opens: boolean) {
    const platform = createFakePlatform({ capabilities: { designPreview: true } });
    const posted: ExtensionToWebviewMessage[] = [];
    const handlers = createDesignHandlers({ platform, postMessage: (_to: unknown, message: ExtensionToWebviewMessage) => posted.push(message) } as unknown as HandlerDependencies);
    const openPreview = vi.fn(async () => opens);
    const design = { folderOf: (designId: string) => (designId === DESIGN ? FOLDER : undefined), openPreview };
    const ctx = { reply: {}, panelId: 'p1', session: { design } } as unknown as HandlerContext;
    const open = async (designId: string, relPath: string): Promise<void> => {
      await handlers.openDesignPreview!({ type: 'openDesignPreview', designId, relPath }, ctx);
    };
    return { platform, posted, openPreview, open };
  }

  it('opens the preview of the chat\'s own design in its design chat, never a browser', async () => {
    const { platform, posted, openPreview, open } = previewSetup(true);
    await open(DESIGN, 'screens/S1-contacts.html');
    expect(openPreview).toHaveBeenCalledWith(DESIGN, 'screens/S1-contacts.html');
    expect(posted).toEqual([]);
    expect(platform.shell.openedExternal).toEqual([]);
  });

  it('refuses another chat\'s design and a path that is not a relative file path, and says when no design chat can show it', async () => {
    const { posted, openPreview, open } = previewSetup(false);
    await open('billing-9f8e7d6c', 'screens/S1.html');
    await open(DESIGN, '../secrets.txt');
    await open('../etc', 'screens/S1.html');
    expect(openPreview).not.toHaveBeenCalled();
    await open(DESIGN, 'screens/S1.html');
    expect(posted.map((message) => message.type === 'notification' && message.notificationType)).toEqual(['error', 'error', 'warning']);
  });

  it('refuses a device name, as the other design file buttons do', async () => {
    const { openPreview, open } = previewSetup(true);
    await open(DESIGN, 'screens/CON');
    expect(openPreview).not.toHaveBeenCalled();
  });
});

describe('openDesignFile', () => {
  function fileSetup() {
    const platform = createFakePlatform();
    const handleOpenFile = vi.fn(async () => undefined);
    const handlers = createDesignHandlers({ platform, postMessage: () => undefined, workspaceManager: { handleOpenFile } } as unknown as HandlerDependencies);
    const design = { folderOf: (designId: string) => (designId === DESIGN ? FOLDER : undefined) };
    const ctx = { reply: {}, panelId: 'p1', session: { design } } as unknown as HandlerContext;
    const open = async (file: unknown): Promise<void> => {
      await handlers.openDesignFile!({ type: 'openDesignFile', designId: DESIGN, file } as never, ctx);
    };
    return { platform, handleOpenFile, open };
  }

  it('opens a file of the chat\'s own design folder', async () => {
    const { handleOpenFile, open } = fileSetup();
    await open('design.md');
    expect(handleOpenFile).toHaveBeenCalledWith('p1', path.join(path.resolve(FOLDER), 'design.md'), undefined, undefined);
  });

  it('refuses a value that is not a string, a device name and a path that is not a relative file path, opening nothing', async () => {
    const { platform, handleOpenFile, open } = fileSetup();
    for (const file of [42, { message: 'design.md' }, 'screens/CON', 'screens/nul.html', 'design.md.', './design.md', 'screens\\S1.html', '../secrets.txt']) await open(file);
    expect(handleOpenFile).not.toHaveBeenCalled();
    expect(platform.notifications.calls.map((call) => call.level)).toEqual(Array(8).fill('error'));
  });
});
