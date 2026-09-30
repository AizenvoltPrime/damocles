export interface PickFileOptions {
  readonly title?: string;
  // absolute path the dialog opens at
  readonly defaultPath?: string;
  // label to allowed extensions without the dot, e.g. { Markdown: ['md'] }
  readonly filters?: Readonly<Record<string, readonly string[]>>;
}

export interface InputBoxOptions {
  readonly prompt?: string;
  readonly placeholder?: string;
  readonly password?: boolean;
  readonly ignoreFocusOut?: boolean;
}

export interface QuickPickItem {
  // what quickPick resolves when this item is picked
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
}

export interface QuickPickOptions {
  readonly title?: string;
  readonly placeholder?: string;
}

export interface PickFolderOptions {
  readonly title?: string;
  // absolute path the dialog opens at
  readonly defaultPath?: string;
}

export interface DialogService {
  // Resolves the absolute path of one picked folder, or undefined when cancelled.
  pickFolder(opts: PickFolderOptions): Promise<string | undefined>;
  // Resolves the absolute path of one picked file, or undefined when cancelled.
  pickFile(opts: PickFileOptions): Promise<string | undefined>;
  // Aborting the signal dismisses the box, which then resolves undefined.
  inputBox(opts: InputBoxOptions, signal?: AbortSignal): Promise<string | undefined>;
  // Resolves the picked item's id, or undefined when dismissed; aborting the signal dismisses the list.
  quickPick(items: readonly QuickPickItem[], opts: QuickPickOptions, signal?: AbortSignal): Promise<string | undefined>;
}
