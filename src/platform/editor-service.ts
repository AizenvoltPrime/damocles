import type { Disposable } from './disposable';

export interface OpenFileOptions {
  // 1-based; the cursor goes to the start of the line
  readonly line?: number;
  // false opens a pinned tab
  readonly preview?: boolean;
  // 'text' forces the text editor; absent opens the host's default editor for the file type (an image preview for an image)
  readonly editor?: 'text';
  // Chat panel the request came from; a host that renders editors inside the chat panel shows it there.
  readonly panelId?: string;
}

export interface EditorSelection {
  // 1-based, inclusive
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

export interface ActiveEditorContext {
  // undefined when the editor shows a document that is not a file on disk
  readonly filePath: string | undefined;
  // undefined when the selection is empty
  readonly selection: EditorSelection | undefined;
}

// In-memory text is shown under name, whose extension picks the language mode.
export type DiffSide = { readonly path: string } | { readonly name: string; readonly content: string };

export interface DiffRequest {
  readonly title: string;
  readonly left: DiffSide;
  readonly right: DiffSide;
  // proposal: in-memory text lives until DiffView.close(); checkpoint: until its tab closes (VS Code keeps a URI scheme per purpose)
  readonly purpose: 'proposal' | 'checkpoint';
  readonly column?: number;
  readonly preserveFocus?: boolean;
  readonly preview?: boolean;
  // Chat panel the request came from; a host that renders editors inside the chat panel shows it there.
  readonly panelId?: string;
  // proposal only: the tool use id that keys the pending permission prompt (requestPermission.toolUseId) the diff belongs to.
  readonly approvalId?: string;
}

export interface OpenUntitledOptions {
  // Chat panel the request came from; a host that renders editors inside the chat panel shows it there.
  readonly panelId?: string;
}

export interface DiffView {
  // Closes the diff if it is still open and releases its in-memory text.
  close(): Promise<void>;
}

export interface EditorService {
  openFile(path: string, opts?: OpenFileOptions): Promise<void>;
  // untitled document with this language, opened as a preview tab
  openUntitled(content: string, language: string, opts?: OpenUntitledOptions): Promise<void>;
  // Text of the file as the editor holds it, unsaved edits included, without a byte order mark; rejects when it cannot be
  // opened as text (missing, binary, or over the host's document size limit).
  readText(path: string): Promise<string>;
  showDiff(req: DiffRequest): Promise<DiffView>;
  showMarkdownPreview(path: string): Promise<void>;
  // context of the focused text editor; undefined when none has focus
  getActiveContext(): ActiveEditorContext | undefined;
  // fires when the focused text editor changes or any text editor's selection changes, with that editor's context (undefined: no editor)
  onDidChangeActiveContext(listener: (context: ActiveEditorContext | undefined) => void): Disposable;
  // query filters the settings view, e.g. a setting key
  openHostSettings(query?: string): Promise<void>;
  // installed and activated
  isHostExtensionActive(id: string): boolean;
  searchHostExtensions(query: string): Promise<void>;
}
