import { beforeEach, describe, expect, it, vi } from 'vitest';

const dialog = vi.hoisted(() => ({ showOpenDialog: vi.fn() }));
vi.mock('electron', () => ({ dialog }));

import type { WebviewPrompts } from '../../../core/chat-panel/webview-prompts';
import { createDesktopDialogService } from '../platform/dialog-service';

const window = { id: 'main-window' };

beforeEach(() => {
  dialog.showOpenDialog.mockReset();
});

describe('desktop dialog service', () => {
  it('picks a folder in a native dialog on the window, and answers undefined when cancelled', async () => {
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/w/alpha'] }).mockResolvedValueOnce({ canceled: true, filePaths: [] });
    const dialogs = createDesktopDialogService(() => window as never, () => undefined);

    await expect(dialogs.pickFolder({ title: 'Add Project', defaultPath: '/w' })).resolves.toBe('/w/alpha');
    await expect(dialogs.pickFolder({})).resolves.toBeUndefined();
    expect(dialog.showOpenDialog).toHaveBeenNthCalledWith(1, window, { properties: ['openDirectory', 'createDirectory'], title: 'Add Project', defaultPath: '/w' });
  });

  it('passes file filters as Electron filter entries, and opens unparented with no window', async () => {
    dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/w/key.json'] });
    const dialogs = createDesktopDialogService(() => undefined, () => undefined);

    await expect(dialogs.pickFile({ filters: { JSON: ['json'], All: ['*'] } })).resolves.toBe('/w/key.json');
    expect(dialog.showOpenDialog).toHaveBeenCalledWith({ properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }, { name: 'All', extensions: ['*'] }] });
  });

  it('asks for text in a chat tab, and refuses while the core services are not running', async () => {
    const inputBox = vi.fn(async () => 'sk-typed');
    const prompts = { inputBox, quickPick: vi.fn() } as unknown as WebviewPrompts;
    const signal = new AbortController().signal;

    await expect(createDesktopDialogService(() => undefined, () => prompts).inputBox({ prompt: 'Key', password: true }, signal)).resolves.toBe('sk-typed');
    expect(inputBox).toHaveBeenCalledWith({ prompt: 'Key', password: true }, signal);
    await expect(createDesktopDialogService(() => undefined, () => undefined).inputBox({ prompt: 'Key' })).rejects.toThrow('core services were not running');
  });
});
