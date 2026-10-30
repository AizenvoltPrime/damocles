import { dialog, type BrowserWindow, type OpenDialogOptions } from 'electron';
import type { DialogService } from '../../../platform/dialog-service';
import type { LocalizedText } from '../../../shared/localized-text';

async function pickOne(window: BrowserWindow | undefined, options: OpenDialogOptions): Promise<string | undefined> {
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  return result.canceled ? undefined : result.filePaths[0];
}

const inChat = (): Promise<never> => Promise.reject(new Error('Text input and quick picks render in a chat, which Damocles Core asks'));

/** A picker's options as main words them itself. */
export interface NativePickOptions {
  readonly title?: string;
  // absolute path the dialog opens at
  readonly defaultPath?: string;
  readonly buttonLabel?: string;
  // label to allowed extensions without the dot
  readonly filters?: Readonly<Record<string, readonly string[]>>;
}

export interface NativeDialogs {
  pickFolder(opts: NativePickOptions): Promise<string | undefined>;
  pickFile(opts: NativePickOptions): Promise<string | undefined>;
}

export function createNativeDialogs(window: () => BrowserWindow | undefined): NativeDialogs {
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
  };
}

// Folder and file pickers are native, their titles rendered in main's language. Text input and quick picks render in a chat
// tab's webview, because Electron has no native prompt; core asks those itself (core-host/platform/proxied.ts), so main's own
// platform never does.
export function createDesktopDialogService(window: () => BrowserWindow | undefined, render: (text: LocalizedText) => string): DialogService {
  const native = createNativeDialogs(window);
  return {
    pickFolder: (opts) => native.pickFolder({
      ...(opts.title !== undefined ? { title: render(opts.title) } : {}),
      ...(opts.defaultPath !== undefined ? { defaultPath: opts.defaultPath } : {}),
      ...(opts.buttonLabel !== undefined ? { buttonLabel: render(opts.buttonLabel) } : {}),
    }),
    pickFile: (opts) => native.pickFile({
      ...(opts.title !== undefined ? { title: render(opts.title) } : {}),
      ...(opts.defaultPath !== undefined ? { defaultPath: opts.defaultPath } : {}),
      ...(opts.filters ? { filters: opts.filters } : {}),
    }),
    inputBox: inChat,
    quickPick: inChat,
  };
}
