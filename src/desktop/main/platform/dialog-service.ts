import { dialog, type BrowserWindow, type OpenDialogOptions } from 'electron';
import type { DialogService } from '../../../platform/dialog-service';

async function pickOne(window: BrowserWindow | undefined, options: OpenDialogOptions): Promise<string | undefined> {
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  return result.canceled ? undefined : result.filePaths[0];
}

const inChat = (): Promise<never> => Promise.reject(new Error('Text input and quick picks render in a chat, which Damocles Core asks'));

// Folder and file pickers are native. Text input and quick picks render in a chat tab's webview, because Electron has no
// native prompt; core asks those itself (core-host/platform/proxied.ts), so main's own platform never does.
export function createDesktopDialogService(window: () => BrowserWindow | undefined): DialogService {
  return {
    pickFolder: (opts) => pickOne(window(), {
      properties: ['openDirectory', 'createDirectory'],
      ...(opts.title !== undefined ? { title: opts.title } : {}),
      ...(opts.defaultPath !== undefined ? { defaultPath: opts.defaultPath } : {}),
      ...(opts.buttonLabel !== undefined ? { buttonLabel: opts.buttonLabel } : {}),
    }),
    pickFile: (opts) => pickOne(window(), {
      properties: ['openFile'],
      ...(opts.title !== undefined ? { title: opts.title } : {}),
      ...(opts.defaultPath !== undefined ? { defaultPath: opts.defaultPath } : {}),
      ...(opts.filters ? { filters: Object.entries(opts.filters).map(([name, extensions]) => ({ name, extensions: [...extensions] })) } : {}),
    }),
    inputBox: inChat,
    quickPick: inChat,
  };
}
