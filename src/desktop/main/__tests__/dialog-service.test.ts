import { beforeEach, describe, expect, it, vi } from 'vitest';

const dialog = vi.hoisted(() => ({ showOpenDialog: vi.fn() }));
vi.mock('electron', () => ({ dialog }));

import { createDesktopDialogService } from '../platform/dialog-service';
import { englishText } from '../../../shared/localized-text';

const window = { id: 'main-window' };

beforeEach(() => {
  dialog.showOpenDialog.mockReset();
});

describe('desktop dialog service', () => {
  it('picks a folder in a native dialog on the window, and answers undefined when cancelled', async () => {
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/w/alpha'] }).mockResolvedValueOnce({ canceled: true, filePaths: [] });
    const dialogs = createDesktopDialogService(() => window as never, englishText);

    await expect(dialogs.pickFolder({ title: { message: 'Add Project' }, defaultPath: '/w' })).resolves.toBe('/w/alpha');
    await expect(dialogs.pickFolder({})).resolves.toBeUndefined();
    expect(dialog.showOpenDialog).toHaveBeenNthCalledWith(1, window, { properties: ['openDirectory', 'createDirectory'], title: 'Add Project', defaultPath: '/w' });
  });

  it('names the folder picker\'s confirm button as Electron\'s buttonLabel', async () => {
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/w/clones'] });
    const dialogs = createDesktopDialogService(() => window as never, englishText);

    await dialogs.pickFolder({ title: { message: 'Choose a folder' }, defaultPath: '/w', buttonLabel: { message: 'Select as Repository Destination' } });
    expect(dialog.showOpenDialog).toHaveBeenCalledWith(window, { properties: ['openDirectory', 'createDirectory'], title: 'Choose a folder', defaultPath: '/w', buttonLabel: 'Select as Repository Destination' });
  });

  it('passes file filters as Electron filter entries, and opens unparented with no window', async () => {
    dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/w/key.json'] });
    const dialogs = createDesktopDialogService(() => undefined, englishText);

    await expect(dialogs.pickFile({ filters: { JSON: ['json'], All: ['*'] } })).resolves.toBe('/w/key.json');
    expect(dialog.showOpenDialog).toHaveBeenCalledWith({ properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }, { name: 'All', extensions: ['*'] }] });
  });

  it('leaves text input and quick picks to core, which renders them in a chat', async () => {
    const dialogs = createDesktopDialogService(() => undefined, englishText);
    await expect(dialogs.inputBox({ prompt: 'Key' })).rejects.toThrow('Damocles Core asks');
    await expect(dialogs.quickPick([], {})).rejects.toThrow('Damocles Core asks');
  });
});
