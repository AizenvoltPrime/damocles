import { dialog, type BrowserWindow, type OpenDialogOptions } from 'electron';
import type { WebviewPrompts } from '../../../core/chat-panel/webview-prompts';
import type { DialogService } from '../../../platform/dialog-service';

async function pickOne(window: BrowserWindow | undefined, options: OpenDialogOptions): Promise<string | undefined> {
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  return result.canceled ? undefined : result.filePaths[0];
}

// Folder and file pickers are native; text input and quick picks render in a chat tab's webview, because Electron has no native prompt.
export function createDesktopDialogService(
  window: () => BrowserWindow | undefined,
  prompts: () => WebviewPrompts | undefined,
): DialogService {
  const requirePrompts = (): WebviewPrompts => {
    const service = prompts();
    if (!service) throw new Error('A prompt was requested while the core services were not running');
    return service;
  };
  return {
    pickFolder: (opts) => pickOne(window(), {
      properties: ['openDirectory', 'createDirectory'],
      ...(opts.title !== undefined ? { title: opts.title } : {}),
      ...(opts.defaultPath !== undefined ? { defaultPath: opts.defaultPath } : {}),
    }),
    pickFile: (opts) => pickOne(window(), {
      properties: ['openFile'],
      ...(opts.title !== undefined ? { title: opts.title } : {}),
      ...(opts.defaultPath !== undefined ? { defaultPath: opts.defaultPath } : {}),
      ...(opts.filters ? { filters: Object.entries(opts.filters).map(([name, extensions]) => ({ name, extensions: [...extensions] })) } : {}),
    }),
    inputBox: async (opts, signal) => requirePrompts().inputBox(opts, signal),
    quickPick: async (items, opts, signal) => requirePrompts().quickPick(items, opts, signal),
  };
}
