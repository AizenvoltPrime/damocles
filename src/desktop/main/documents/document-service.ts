import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Disposable } from '../../../platform/disposable';
import type { FileWatcherFactory } from '../../../platform/file-watcher';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { EDITOR_MAX_DOCUMENT_BYTES, type SettingsFileScope } from '../../../shared/types/messages';
import type { SettingsFileSaveOutcome } from '../../../core/chat-panel/settings-file-editor';
import { settingsFileVersion } from '../../../core/config/settings-file';
import type { EditorConflictResult, EditorEditReport, EditorReadOnlyReason, EditorSaveResult, FilesMutationResult, SearchEditorConfig, SearchEditorMessage, ShellDocumentContent } from '../../preload/shell-channels';
import {
  DEFAULT_SEARCH_EDITOR_CONFIG,
  parseSearchEditor,
  SEARCH_EDITOR_EXTENSION,
  SEARCH_RESULT_LANGUAGE_ID,
  serializeSearchConfiguration,
  serializeSearchEditor,
  suggestedFileName,
} from '../search/search-editor-format';
import type { AskMessage } from '../message-dialog';
import {
  decodeDocument,
  encodeDocument,
  encodedLength,
  languageIdForName,
  majorityEol,
  readFileBytes,
  withEol,
  type FileBytes,
  type TextEncoding,
} from '../platform/editor-document';
import { isRelativeFilePath } from '../../../shared/relative-path';
import { confineExisting, confineMissing, confineOrCreateFolder, followsLocalLinksOnly, projectOfPath, type Project } from './confine';

// Images preview from a data: URL of at most this many bytes; a larger one is not displayed.
export const MAX_IMAGE_BYTES: number = 10 * 1024 * 1024;

// SVG renders through <img> only, which runs no script and loads nothing.
const IMAGE_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

export function imageMimeOf(name: string): string | undefined {
  const extension = path.extname(name).toLowerCase();
  return Object.hasOwn(IMAGE_MIME, extension) ? IMAGE_MIME[extension] : undefined;
}

type Eol = '\n' | '\r\n';

interface DiskState {
  readonly exists: boolean;
  readonly mtimeMs: number;
  readonly size: number;
  readonly sha256: string;
}

const MISSING: DiskState = { exists: false, mtimeMs: 0, size: 0, sha256: '' };

interface Location {
  // the file's native realpath; for a missing file, the path it will be written to
  readonly path: string;
  // present when the file lies inside an open project
  readonly projectKey?: string;
  readonly relativePath?: string;
}

export interface TextDocument {
  readonly id: string;
  readonly kind: 'text';
  location: Location | undefined;
  name: string;
  languageId: string;
  encoding: TextEncoding;
  bom: boolean;
  eol: Eol;
  // the text on disk and in the buffer, both with eol line endings
  diskText: string;
  text: string;
  disk: DiskState;
  version: number;
  // the seq of the last shell edit applied (EditorEditReport)
  editSeq: number;
  readOnlyReason: EditorReadOnlyReason | undefined;
  // set when the disk changed under a dirty buffer or a save found the disk changed
  conflict: boolean;
  // no file yet: saving asks where
  untitled: boolean;
  // the file was deleted under the editor (VS Code's orphaned model): dirty only when edited, and a save recreates it
  orphaned: boolean;
  // a write failed (VS Code's error mode): dirty until a save lands or Revert, since the write may have torn the file
  saveFailed: boolean;
  // a .damocles settings file, saved through the settings file rules
  settingsScope: SettingsFileScope | undefined;
  // the hot-exit backup's file id
  backupId: string;
  watcher: Disposable | undefined;
  // a Search Editor: its text is the results body, its header lives here
  searchEditor: SearchEditorState | undefined;
}

// VS Code's SearchEditorInput state beside the body.
export interface SearchEditorState {
  config: SearchEditorConfig;
  // VS Code's explicit dirty flag: a body edit, or a run or config change of a saved editor
  dirty: boolean;
  // the project its results and opens resolve in; undefined for a .code-search file outside every project
  projectKey: string | undefined;
  running: boolean;
  message: SearchEditorMessage | undefined;
}

export interface ImageDocument {
  readonly id: string;
  readonly kind: 'image';
  location: Location;
  name: string;
  readonly dataUrl: string;
  readonly bytes: number;
}

export interface NotDisplayedDocument {
  readonly id: string;
  readonly kind: 'notDisplayed';
  location: Location | undefined;
  name: string;
  readonly reason: 'binary' | 'tooLarge' | 'unreadable';
  readonly bytes?: number;
}

export type Document = TextDocument | ImageDocument | NotDisplayedDocument;

export type ShellEdit = Omit<EditorEditReport, 'documentId'>;

export type ClosedFileRead =
  | {
      readonly kind: 'text';
      readonly location: Required<Location>;
      // decoded, with the line endings the file has
      readonly text: string;
      readonly eol: Eol;
      readonly encoding: TextEncoding;
      readonly bom: boolean;
      readonly disk: DiskState;
    }
  | { readonly kind: 'readOnly' | 'missing' };

export type ClosedFileWrite = { readonly ok: true } | { readonly ok: false; readonly reason: 'openInEditor' | 'conflict' | 'failed'; readonly message?: string };

export type OpenProjectResult = { readonly ok: true; readonly document: Document } | { readonly ok: false; readonly reason: 'outside' | 'missing' | 'failed' };

// How a missing file's text is written back: a hot-exit backup's record of the buffer it kept.
export interface MissingFileFormat {
  readonly encoding: TextEncoding;
  readonly bom: boolean;
  readonly eol: Eol;
}

export interface TextChange {
  readonly documentId: string;
}

export interface DocumentChange {
  readonly documentId: string;
  // the text was replaced by main (reload, revert); the shell applies the new content
  readonly content: boolean;
}

export interface Backups {
  // the buffer changed while dirty; written after the debounce, or at once when now is set
  changed(document: TextDocument, now?: boolean): void;
  // written at once; settles once the write landed or failed, and never rejects
  writeNow(document: TextDocument): Promise<void>;
  // the buffer became clean or the document closed with the user's consent
  remove(backupId: string): void;
}

export interface SettingsFiles {
  locate(scope: SettingsFileScope): string | undefined;
  // filePath: the file the document opened; the save is refused when the scope names another file now (the default project moved)
  save(scope: SettingsFileScope, filePath: string, content: string, baseVersion: string): Promise<SettingsFileSaveOutcome>;
}

export interface DocumentServiceDeps {
  readonly projects: () => readonly Project[];
  readonly watchers: FileWatcherFactory;
  readonly ask: AskMessage;
  readonly t: (message: string, ...args: Array<string | number>) => string;
  readonly log: (line: string) => void;
  // the native Save As dialog; undefined when cancelled
  readonly pickSavePath: (defaultPath: string) => Promise<string | undefined>;
  readonly backups: Backups;
  readonly settings: SettingsFiles;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// A write Damocles refuses itself: `reason` is the localized text the tab shows, and the message, with the path, is logged.
class WriteRefused extends Error {
  readonly reason: string;

  constructor(message: string, reason: string) {
    super(message);
    this.reason = reason;
  }
}

function errnoCode(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

function isDirty(document: TextDocument): boolean {
  if (document.readOnlyReason !== undefined) return false;
  if (document.saveFailed) return true;
  if (document.searchEditor) return document.searchEditor.dirty;
  return document.untitled ? document.text.length > 0 : document.text !== document.diskText;
}

export function isDocumentDirty(document: Document): boolean {
  return document.kind === 'text' && isDirty(document);
}

/** What a save writes and a backup keeps: a Search Editor's header and body, any other document's text in its line endings. */
export function savedText(document: TextDocument): string {
  return document.searchEditor ? serializeSearchEditor(document.searchEditor.config, document.text) : withEol(document.text, document.eol);
}

/** Where a rename of `from` to `to` (a file or a folder, '/' separated) puts relativePath; undefined when it is not at or under from. */
export function movedPath(relativePath: string, from: string, to: string): string | undefined {
  if (relativePath === from) return to;
  return relativePath.startsWith(`${from}/`) ? to + relativePath.slice(from.length) : undefined;
}

function isSearchEditorPath(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === SEARCH_EDITOR_EXTENSION;
}

/** Owns every editor read and write: renderers hold only the ids it issues. */
export class DocumentService {
  private readonly deps: DocumentServiceDeps;
  private readonly documents = new Map<string, Document>();
  private readonly listeners = new Set<(change: DocumentChange) => void>();
  private readonly textListeners = new Set<(change: TextChange) => void>();
  // each document's last queued save, overwrite or revert, by document id
  private readonly turns = new Map<string, Promise<void>>();
  // documents whose file is being written; their backup stays until the write settles
  private readonly writing = new Set<TextDocument>();
  // file opens in flight, which a Files rename waits for; the rename in flight, which every file open waits for
  private readonly opening = new Set<Promise<void>>();
  private renaming: Promise<void> = Promise.resolve();
  // a read that makes a document, by the key openResolved matches documents on, so opens of one file share it
  private readonly resolving = new Map<string, Promise<Document>>();

  constructor(deps: DocumentServiceDeps) {
    this.deps = deps;
  }

  onDidChange(listener: (change: DocumentChange) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Every change of a text document's buffer, a keystroke included; Search's live updates follow it. */
  onDidChangeText(listener: (change: TextChange) => void): Disposable {
    this.textListeners.add(listener);
    return { dispose: () => this.textListeners.delete(listener) };
  }

  get(id: string): Document | undefined {
    return this.documents.get(id);
  }

  all(): readonly Document[] {
    return [...this.documents.values()];
  }

  /**
   * A file a renderer named: confined to the project's realpath, links followed. With missing, a file that is gone opens as
   * an orphaned document in that format (a hot-exit backup's file deleted on disk).
   */
  openProjectFile(projectKey: string, relativePath: string, opts: { readonly missing?: MissingFileFormat } = {}): Promise<OpenProjectResult> {
    return this.outsideRenames(() => this.openProjectFileNow(projectKey, relativePath, opts));
  }

  private async openProjectFileNow(projectKey: string, relativePath: string, opts: { readonly missing?: MissingFileFormat }): Promise<OpenProjectResult> {
    const project = this.deps.projects().find((candidate) => candidate.key === projectKey);
    // '' would name the project folder itself, which is no document.
    if (!project || !isRelativeFilePath(relativePath)) return { ok: false, reason: 'outside' };
    const confined = await confineExisting(project, relativePath);
    if (confined.ok) return { ok: true, document: await this.openResolved(confined.path, { projectKey: project.key, relativePath }) };
    return confined.reason === 'missing' && opts.missing ? this.openMissing(project, relativePath, opts.missing) : confined;
  }

  // VS Code resolves a backup whose file is gone as an orphaned model (textFileEditorModel.ts doResolveFromBackup): the
  // document sits at the path the file had, under its deepest existing folder, and a save writes the file back.
  private async openMissing(project: Project, relativePath: string, format: MissingFileFormat): Promise<OpenProjectResult> {
    const confined = await confineMissing(project, relativePath);
    if (!confined.ok) return confined;
    const existing = this.fileDocument(confined.path);
    if (existing) return { ok: true, document: existing };
    const name = path.basename(confined.path);
    const searchEditor = isSearchEditorPath(name);
    const document: TextDocument = {
      id: randomUUID(),
      kind: 'text',
      location: { path: confined.path, projectKey: project.key, relativePath },
      name,
      languageId: searchEditor ? SEARCH_RESULT_LANGUAGE_ID : languageIdForName(name),
      encoding: format.encoding,
      bom: format.bom,
      eol: searchEditor ? '\n' : format.eol,
      diskText: '',
      text: '',
      disk: MISSING,
      version: 1,
      editSeq: 0,
      readOnlyReason: undefined,
      conflict: false,
      untitled: false,
      orphaned: true,
      saveFailed: false,
      settingsScope: undefined,
      backupId: randomUUID(),
      watcher: undefined,
      searchEditor: searchEditor ? { config: DEFAULT_SEARCH_EDITOR_CONFIG, dirty: false, projectKey: project.key, running: false, message: undefined } : undefined,
    };
    this.documents.set(document.id, document);
    this.watch(document);
    // The file may have come back between the confinement and the watch.
    await this.reload(document, { force: false });
    return { ok: true, document };
  }

  // The document of a file on disk (not its settings or untitled documents), by native path.
  private fileDocument(filePath: string): Document | undefined {
    const key = folderKey(filePath);
    return [...this.documents.values()].find((document) => {
      if (document.kind === 'text' && (document.untitled || document.settingsScope !== undefined)) return false;
      return document.location !== undefined && folderKey(document.location.path) === key;
    });
  }

  /**
   * A project file no document holds, read for Search's replace: confined like openProjectFile, with its line endings as they
   * are on disk. A file the editor would open read-only (not valid UTF-8 without a BOM, binary, too large) is readOnly.
   */
  async readClosedFile(projectKey: string, relativePath: string): Promise<ClosedFileRead> {
    const project = this.deps.projects().find((candidate) => candidate.key === projectKey);
    if (!project || !isRelativeFilePath(relativePath)) return { kind: 'missing' };
    const confined = await confineExisting(project, relativePath);
    if (!confined.ok) return { kind: 'missing' };
    const read = await readFileBytes(confined.path);
    if (read.kind === 'missing') return { kind: 'missing' };
    if (read.kind !== 'bytes') return { kind: 'readOnly' };
    const decoded = decodeDocument(read.bytes);
    if (!decoded?.valid) return { kind: 'readOnly' };
    return {
      kind: 'text',
      location: { path: confined.path, projectKey, relativePath },
      text: decoded.text,
      eol: majorityEol(decoded.text),
      encoding: decoded.encoding,
      bom: decoded.bom,
      disk: { exists: true, mtimeMs: read.mtimeMs, size: read.bytes.length, sha256: sha256(read.bytes) },
    };
  }

  /**
   * Writes text over a file readClosedFile read, in its encoding and byte order mark, through the confined in-place write;
   * refused when a document opened the file since or its bytes changed since the read.
   */
  async writeClosedFile(read: Extract<ClosedFileRead, { kind: 'text' }>, text: string): Promise<ClosedFileWrite> {
    if (this.holdsPath(read.location.path)) return { ok: false, reason: 'openInEditor' };
    const refused = this.oversize(text, read);
    if (refused) return { ok: false, reason: 'failed', message: refused };
    const current = await this.readDiskState(read.location);
    // A file that cannot be read now (grown past the limit, locked, replaced by a folder) changed since the read.
    if (!current.ok || !sameDisk(current.disk, read.disk)) return { ok: false, reason: 'conflict' };
    try {
      await this.writeConfined(read.location, encodeDocument(text, read.encoding, read.bom));
    } catch (err) {
      this.deps.log(`[documents] replacing in ${read.location.path} failed: ${errorText(err)}`);
      return { ok: false, reason: 'failed', message: this.writeFailureReason(err) };
    }
    return { ok: true };
  }

  /** The text of the open document of a project file (the buffer as the shell last reported it), or undefined. */
  openText(projectKey: string, relativePath: string): { readonly text: string; readonly eol: Eol } | undefined {
    for (const document of this.documents.values()) {
      if (document.kind !== 'text' || document.settingsScope !== undefined || document.untitled || document.searchEditor) continue;
      if (document.location?.projectKey === projectKey && document.location.relativePath === relativePath) return { text: document.text, eol: document.eol };
    }
    return undefined;
  }

  private holdsPath(filePath: string): boolean {
    const key = folderKey(filePath);
    return [...this.documents.values()].some((document) => document.location !== undefined && folderKey(document.location.path) === key);
  }

  /** A path core named (the agent's openFile, a plan file, a checkpoint side): read-only unless it lies inside an open project. */
  openPath(filePath: string, opts: { readonly readOnlyReason?: EditorReadOnlyReason } = {}): Promise<Document> {
    return this.outsideRenames(() => this.openPathNow(filePath, opts));
  }

  private async openPathNow(filePath: string, opts: { readonly readOnlyReason?: EditorReadOnlyReason }): Promise<Document> {
    const absolute = path.resolve(filePath);
    let real: string;
    try {
      real = await fs.realpath(absolute);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      real = absolute;
    }
    const inProject = await projectOfPath(this.deps.projects(), real);
    const location = inProject ? { projectKey: inProject.project.key, relativePath: inProject.relativePath } : {};
    return this.openResolved(real, location, opts.readOnlyReason ?? (inProject ? undefined : 'outsideProject'));
  }

  /** A .damocles settings file; its save follows the settings file editor's parse and version rules. */
  async openSettingsFile(scope: SettingsFileScope): Promise<Document | undefined> {
    const filePath = this.deps.settings.locate(scope);
    if (filePath === undefined) return undefined;
    return this.openResolved(filePath, {}, undefined, scope);
  }

  /** In-memory text: a read-only diff side, or an editable untitled buffer. */
  openMemory(name: string, text: string, opts: { readonly untitled: boolean; readonly languageId?: string }): TextDocument {
    const eol = majorityEol(text);
    const normalized = withEol(text, eol);
    const document: TextDocument = {
      id: randomUUID(),
      kind: 'text',
      location: undefined,
      name,
      languageId: opts.languageId ?? languageIdForName(name),
      encoding: 'utf8',
      bom: false,
      eol,
      diskText: opts.untitled ? '' : normalized,
      text: normalized,
      disk: MISSING,
      version: 1,
      editSeq: 0,
      readOnlyReason: opts.untitled ? undefined : 'outsideProject',
      conflict: false,
      untitled: opts.untitled,
      orphaned: false,
      saveFailed: false,
      settingsScope: undefined,
      backupId: randomUUID(),
      watcher: undefined,
      searchEditor: undefined,
    };
    this.documents.set(document.id, document);
    if (isDirty(document)) this.deps.backups.changed(document);
    return document;
  }

  /** A new untitled Search Editor of projectKey with its header and body; dirty only when restored from a dirty backup. */
  openSearchEditor(projectKey: string | undefined, config: SearchEditorConfig, body: string, opts: { readonly dirty: boolean; readonly message?: SearchEditorMessage }): TextDocument {
    const document: TextDocument = {
      id: randomUUID(),
      kind: 'text',
      location: undefined,
      name: suggestedFileName(config.query),
      languageId: SEARCH_RESULT_LANGUAGE_ID,
      encoding: 'utf8',
      bom: false,
      eol: '\n',
      diskText: '',
      text: body,
      disk: MISSING,
      version: 1,
      editSeq: 0,
      readOnlyReason: undefined,
      conflict: false,
      untitled: true,
      orphaned: false,
      saveFailed: false,
      settingsScope: undefined,
      backupId: randomUUID(),
      watcher: undefined,
      searchEditor: { config, dirty: opts.dirty, projectKey, running: false, message: opts.message },
    };
    this.documents.set(document.id, document);
    if (opts.dirty) this.deps.backups.changed(document);
    return document;
  }

  /** The Search Editor's new header, from its query inputs; a saved editor turns dirty when the header changes. */
  setSearchEditorConfig(id: string, config: SearchEditorConfig): void {
    const document = this.searchEditorDocument(id);
    const state = document.searchEditor!;
    const changed = serializeSearchConfiguration(config) !== serializeSearchConfiguration(state.config);
    state.config = config;
    if (document.untitled) document.name = suggestedFileName(config.query);
    if (changed && !document.untitled) this.markSearchEditorDirty(document);
    this.emit(id, false);
  }

  /** A run's results replace the body (a new content version); as in VS Code a saved editor turns dirty, an untitled one does not. */
  setSearchEditorResults(id: string, body: string): void {
    const document = this.searchEditorDocument(id);
    if (document.untitled) {
      document.searchEditor!.dirty = false;
      this.deps.backups.remove(document.backupId);
    } else {
      this.markSearchEditorDirty(document);
    }
    this.replaceText(document, body);
  }

  /** The Search Editor's running flag and message line, published with the editor state. */
  setSearchEditorStatus(id: string, running: boolean, message: SearchEditorMessage | undefined): void {
    const state = this.searchEditorDocument(id).searchEditor!;
    state.running = running;
    state.message = message;
    this.emit(id, false);
  }

  // The default Save As path of an untitled Search Editor: <query>.code-search in its project, as VS Code suggests.
  private searchEditorDefaultPath(document: TextDocument): string | undefined {
    const state = document.searchEditor;
    if (!state || !document.untitled) return undefined;
    const project = this.deps.projects().find((candidate) => candidate.key === state.projectKey) ?? this.deps.projects()[0];
    return path.join(project?.fsPath ?? '', suggestedFileName(state.config.query));
  }

  private searchEditorDocument(id: string): TextDocument {
    const document = this.text(id);
    if (!document?.searchEditor) throw new Error('Unknown Search Editor');
    return document;
  }

  private markSearchEditorDirty(document: TextDocument): void {
    document.searchEditor!.dirty = true;
    this.deps.backups.changed(document);
  }

  content(id: string): ShellDocumentContent {
    const document = this.require(id);
    if (document.kind === 'image') return { kind: 'image', documentId: id, dataUrl: document.dataUrl, bytes: document.bytes };
    if (document.kind === 'notDisplayed') {
      return { kind: 'notDisplayed', documentId: id, reason: document.reason, ...(document.bytes !== undefined ? { bytes: document.bytes } : {}) };
    }
    return {
      kind: 'text',
      documentId: id,
      version: document.version,
      editSeq: document.editSeq,
      text: document.text,
      languageId: document.languageId,
      eol: document.eol,
      encoding: document.encoding,
      bom: document.bom,
    };
  }

  /** The shell's buffer; an edit for another version than main's is dropped, since main replaced that text. */
  edit(id: string, edit: ShellEdit): void {
    const document = this.text(id);
    if (!document || document.readOnlyReason !== undefined || edit.version !== document.version) return;
    document.editSeq = edit.seq;
    // Typed over a reload that replaced the text before main saw them: the buffer keeps them, in conflict with the disk.
    const conflict = edit.overReload && !document.untitled && edit.text !== document.diskText && !document.conflict;
    if (conflict) document.conflict = true;
    if (this.takeText(document, edit.text) || conflict) this.emit(id, false);
  }

  // The text joins the buffer in the order it arrived among the shell's edits; the write takes the buffer as it is once its
  // turn comes, so an edit that arrived meanwhile is saved too.
  async save(id: string, version: number, text: string): Promise<EditorSaveResult> {
    const document = this.text(id);
    if (!document) return { ok: false, reason: 'failed' };
    if (document.untitled) return this.saveAs(id, version, text);
    if (document.readOnlyReason !== undefined) return { ok: false, reason: 'readOnly' };
    if (version !== document.version || document.conflict) return this.refuseConflict(document);
    if (this.takeText(document, text)) this.emit(id, false);
    return this.inTurn(document, () => this.saveInTurn(document));
  }

  private async saveInTurn(document: TextDocument): Promise<EditorSaveResult> {
    if (document.readOnlyReason !== undefined) return { ok: false, reason: 'readOnly' };
    if (document.conflict) return this.refuseConflict(document);
    const refused = this.oversize(savedText(document), document);
    if (refused) return { ok: false, reason: 'failed', message: refused };
    if (document.settingsScope !== undefined) return this.saveSettings(document, this.settingsBaseVersion(document));
    const location = document.location!;
    const current = await this.readDiskState(location);
    if (!current.ok) return current;
    if (!sameDisk(current.disk, document.disk)) return this.refuseConflict(document);
    return this.write(document, location, document);
  }

  /** Save As through the native dialog, confined to an open project; the document moves to the new path. */
  async saveAs(id: string, version: number, text: string): Promise<EditorSaveResult> {
    const document = this.text(id);
    if (!document) return { ok: false, reason: 'failed' };
    if (version !== document.version) {
      // A buffer with no file has no disk to conflict with: main replaced its text (a Search Editor run), and the shell's is stale.
      if (document.untitled) return { ok: false, reason: 'failed', message: this.deps.t('The text changed while it was being saved, so it was not saved. Save it again.') };
      return this.refuseConflict(document);
    }
    if (document.readOnlyReason === undefined && this.takeText(document, text)) this.emit(id, false);
    return this.inTurn(document, () => this.saveAsInTurn(document));
  }

  private async saveAsInTurn(document: TextDocument): Promise<EditorSaveResult> {
    const id = document.id;
    const defaultPath = document.location?.path ?? this.searchEditorDefaultPath(document) ?? path.join(this.deps.projects()[0]?.fsPath ?? '', document.name);
    const chosen = await this.deps.pickSavePath(defaultPath);
    if (chosen === undefined) return { ok: false, reason: 'cancelled' };
    const target = await projectOfPath(this.deps.projects(), chosen);
    if (!target) return { ok: false, reason: 'failed', message: this.deps.t('Save As saves only inside an open project.') };
    // A copy of a read-only document is a new file of the user's; text that was not valid UTF-8 is written as UTF-8.
    const format = document.readOnlyReason === 'encoding' ? { encoding: 'utf8' as const, bom: false } : document;
    const refused = this.oversize(savedText(document), format);
    if (refused) return { ok: false, reason: 'failed', message: refused };
    const absolute = target.path;
    const result = await this.write(document, { path: absolute, projectKey: target.project.key, relativePath: target.relativePath }, format);
    if (!result.ok) return result;
    document.untitled = false;
    document.settingsScope = undefined;
    document.name = path.basename(absolute);
    // A Search Editor stays one under any name, as VS Code's saveAs reopens it as a search editor.
    if (!document.searchEditor) document.languageId = languageIdForName(absolute);
    else document.searchEditor.projectKey = target.project.key;
    this.watch(document);
    this.emit(id, false);
    return result;
  }

  /** The user's choice on the conflict bar; Compare is the caller's (a diff tab against diskText()). */
  async overwrite(id: string): Promise<EditorConflictResult> {
    const document = this.text(id);
    if (!document || document.readOnlyReason !== undefined || document.untitled) return { ok: false, reason: 'failed' };
    return this.inTurn(document, () => this.overwriteInTurn(document));
  }

  private async overwriteInTurn(document: TextDocument): Promise<EditorConflictResult> {
    if (document.readOnlyReason !== undefined || document.untitled) return { ok: false, reason: 'failed' };
    const name = document.location?.path ?? document.name;
    const choice = await this.deps.ask({
      severity: 'warning',
      message: this.deps.t('Overwrite {0}?', path.basename(name)),
      detail: this.deps.t('The file changed on disk. Overwriting replaces those changes with the text in the editor.'),
      actions: [this.deps.t('Overwrite')],
      cancelLabel: this.deps.t('Cancel'),
    });
    if (choice !== 0) return { ok: false, reason: 'cancelled' };
    const refused = this.oversize(savedText(document), document);
    if (refused) return { ok: false, reason: 'failed', message: refused };
    let result: EditorSaveResult;
    if (document.settingsScope !== undefined) {
      const current = await this.currentSettingsVersion(document);
      if (!current.ok) return current;
      result = await this.saveSettings(document, current.version);
    } else {
      const current = await this.readDiskState(document.location!);
      if (!current.ok) return current;
      document.disk = current.disk;
      result = await this.write(document, document.location!, document);
    }
    return result.ok ? { ok: true } : { ok: false, reason: 'failed', ...(result.message !== undefined ? { message: result.message } : {}) };
  }

  /** Revert: the buffer takes the disk text, the backup goes; a file the buffer cannot take now leaves both as they are. */
  async revert(id: string): Promise<EditorConflictResult> {
    const document = this.text(id);
    if (!document) return { ok: false, reason: 'failed' };
    return this.inTurn(document, async (): Promise<EditorConflictResult> => {
      if (!document.location) this.replaceText(document, document.diskText);
      else if (!(await this.reload(document, { force: true }))) {
        return { ok: false, reason: 'failed', message: this.deps.t('{0} cannot be read as text now, so the editor kept your text.', document.name) };
      }
      if (document.searchEditor) document.searchEditor.dirty = false;
      document.conflict = false;
      document.saveFailed = false;
      this.deps.backups.remove(document.backupId);
      this.emit(id, false);
      return { ok: true };
    });
  }

  /** The disk text now, for Compare; '' for a file that is gone. */
  async diskText(id: string): Promise<string> {
    const document = this.text(id);
    if (!document?.location) return '';
    const read = await this.readLocation(document.location);
    if (read.kind !== 'bytes') return '';
    const text = decodeDocument(read.bytes)?.text ?? '';
    return document.searchEditor ? parseSearchEditor(text).body : withEol(text, document.eol);
  }

  /**
   * A Files rename of `from` (workingCopyFileService.ts move): `renameOnDisk` runs once no file open is in flight, and a file
   * open waits until the documents it moved follow it, so no open reads the old path after the rename or makes a second
   * document of a moved file.
   */
  rename(projectKey: string, from: string, renameOnDisk: () => Promise<FilesMutationResult>): Promise<FilesMutationResult> {
    const previous = this.renaming;
    const run = (async () => {
      await previous;
      await Promise.all(this.opening);
      const result = await renameOnDisk();
      if (result.ok && result.relativePath !== from) await this.moved(projectKey, from, result.relativePath);
      return result;
    })();
    this.renaming = run.then(() => undefined, () => undefined);
    return run;
  }

  // Waits for the renames in flight and counts the open as in flight until it settles, so a later rename waits for it.
  private async outsideRenames<T>(open: () => Promise<T>): Promise<T> {
    await this.renaming;
    const run = open();
    const settled = run.then(() => undefined, () => undefined);
    this.opening.add(settled);
    void settled.then(() => this.opening.delete(settled));
    return run;
  }

  /**
   * `from` (a file or a folder) moved to `to` in the project: each document at or under it follows with its id, buffer and
   * backup, so its tabs, unsaved text and undo stay (editorService.ts handleMovedFile). A settings file's document keeps its
   * scope's path.
   */
  private async moved(projectKey: string, from: string, to: string): Promise<void> {
    const project = this.deps.projects().find((candidate) => candidate.key === projectKey);
    if (!project) return;
    const moving: Array<{ document: Document; relativePath: string }> = [];
    for (const document of this.documents.values()) {
      const location = document.location;
      if (location?.projectKey !== projectKey || location.relativePath === undefined) continue;
      if (document.kind === 'text' && document.settingsScope !== undefined) continue;
      const relativePath = movedPath(location.relativePath, from, to);
      if (relativePath === undefined) continue;
      // A new location object before any await, so a watcher read of the old path in flight is ignored (reload).
      document.location = { path: path.join(project.fsPath, ...relativePath.split('/')), projectKey, relativePath };
      if (document.kind === 'text') {
        document.watcher?.dispose();
        document.watcher = undefined;
      }
      moving.push({ document, relativePath });
    }
    for (const { document, relativePath } of moving) {
      const confined = await confineExisting(project, relativePath);
      if (!confined.ok) {
        this.deps.log(`[documents] ${relativePath} is ${confined.reason} after a rename; its editor keeps the path`);
        continue;
      }
      document.location = { path: confined.path, projectKey, relativePath };
      document.name = path.basename(confined.path);
      if (document.kind !== 'text') {
        this.emit(document.id, false);
        continue;
      }
      if (!document.searchEditor) document.languageId = languageIdForName(document.name);
      if (isDirty(document)) this.deps.backups.changed(document, true);
      this.watch(document);
      // A watcher read that saw the old path gone before the move was known: the file is back under its new name.
      if (document.orphaned) await this.reload(document, { force: false });
      this.emit(document.id, false);
    }
  }

  /** A hot-exit backup's text as the buffer of an opened document; it is dirty unless it equals the disk. */
  restoreBuffer(id: string, text: string, backupId: string): void {
    const document = this.text(id);
    if (!document || document.readOnlyReason !== undefined) return;
    this.deps.backups.remove(document.backupId);
    document.backupId = backupId;
    if (document.searchEditor) {
      const parsed = parseSearchEditor(text);
      document.searchEditor.config = parsed.config;
      document.searchEditor.dirty = true;
      document.text = parsed.body;
      this.deps.backups.changed(document);
      this.emit(id, true);
      return;
    }
    document.text = withEol(text, document.eol);
    if (isDirty(document)) this.deps.backups.changed(document);
    else this.deps.backups.remove(backupId);
    this.emit(id, true);
  }

  /** A log tab's timer: the clean-buffer reload path, without a watcher event per logged line. */
  async reloadLog(id: string): Promise<void> {
    const document = this.text(id);
    if (document?.readOnlyReason === 'log') await this.reload(document, { force: false });
  }

  /** Drops the document; its backup goes only when discard is set (the user chose Don't Save, or it is clean). */
  release(id: string, discard: boolean): void {
    const document = this.documents.get(id);
    if (!document) return;
    this.documents.delete(id);
    if (document.kind !== 'text') return;
    document.watcher?.dispose();
    if (discard || !isDirty(document)) this.deps.backups.remove(document.backupId);
  }

  dispose(): void {
    for (const document of this.documents.values()) if (document.kind === 'text') document.watcher?.dispose();
    this.documents.clear();
    this.listeners.clear();
    this.textListeners.clear();
  }

  private async openResolved(filePath: string, location: Omit<Location, 'path'>, readOnlyReason?: EditorReadOnlyReason, settingsScope?: SettingsFileScope): Promise<Document> {
    const key = folderKey(filePath);
    // A settings file opened by Edit settings.json is a document of its own, so its saves keep the settings file rules.
    for (const existing of this.documents.values()) {
      const scope = existing.kind === 'text' ? existing.settingsScope : undefined;
      if (existing.location && folderKey(existing.location.path) === key && scope === settingsScope && !(existing.kind === 'text' && existing.untitled)) return existing;
    }
    // textFileEditorModelManager.ts joinPendingResolves: a second open of a file still being read gets the same document.
    const resolvingKey = `${key}\0${settingsScope ?? ''}`;
    const pending = this.resolving.get(resolvingKey);
    if (pending) return pending;
    const read = this.readDocument(filePath, location, readOnlyReason, settingsScope);
    this.resolving.set(resolvingKey, read);
    try {
      return await read;
    } finally {
      this.resolving.delete(resolvingKey);
    }
  }

  private async readDocument(filePath: string, location: Omit<Location, 'path'>, readOnlyReason: EditorReadOnlyReason | undefined, settingsScope: SettingsFileScope | undefined): Promise<Document> {
    const name = path.basename(filePath);
    const fullLocation: Location = { path: filePath, ...location };
    const id = randomUUID();
    const mime = imageMimeOf(name);
    const read = await readFileBytes(filePath, mime ? MAX_IMAGE_BYTES : EDITOR_MAX_DOCUMENT_BYTES);
    let document: Document;
    if (read.kind === 'tooLarge') {
      document = { id, kind: 'notDisplayed', location: fullLocation, name, reason: 'tooLarge', bytes: read.bytes };
    } else if (read.kind === 'unreadable') {
      this.deps.log(`[documents] cannot read ${filePath}: ${read.error}`);
      document = { id, kind: 'notDisplayed', location: fullLocation, name, reason: 'unreadable' };
    } else if (mime && read.kind === 'bytes') {
      document = { id, kind: 'image', location: fullLocation, name, dataUrl: `data:${mime};base64,${read.bytes.toString('base64')}`, bytes: read.bytes.length };
    } else {
      const bytes = read.kind === 'bytes' ? read.bytes : Buffer.alloc(0);
      const decoded = decodeDocument(bytes);
      if (!decoded) {
        document = { id, kind: 'notDisplayed', location: fullLocation, name, reason: 'binary', bytes: bytes.length };
      } else {
        const parsed = settingsScope === undefined && readOnlyReason === undefined && decoded.valid && isSearchEditorPath(filePath) ? parseSearchEditor(decoded.text) : undefined;
        const eol = parsed ? '\n' : majorityEol(decoded.text);
        const text = parsed ? parsed.body : withEol(decoded.text, eol);
        document = {
          id,
          kind: 'text',
          location: fullLocation,
          name,
          languageId: settingsScope !== undefined ? 'json' : parsed ? SEARCH_RESULT_LANGUAGE_ID : languageIdForName(name),
          encoding: decoded.encoding,
          bom: decoded.bom,
          eol,
          diskText: text,
          text,
          disk: read.kind === 'bytes' ? { exists: true, mtimeMs: read.mtimeMs, size: bytes.length, sha256: sha256(bytes) } : MISSING,
          version: 1,
          editSeq: 0,
          readOnlyReason: readOnlyReason ?? (decoded.valid ? undefined : 'encoding'),
          conflict: false,
          untitled: false,
          orphaned: false,
          saveFailed: false,
          settingsScope,
          backupId: randomUUID(),
          watcher: undefined,
          searchEditor: parsed
            ? {
              config: parsed.config,
              dirty: false,
              projectKey: location.projectKey,
              running: false,
              message: parsed.headerError
                ? { kind: 'headerError', text: this.deps.t('All backslashes in Query string must be escaped ({0})', '\\\\') }
                : parsed.config.query !== '' && parsed.body === '' ? { kind: 'stale' } : undefined,
            }
            : undefined,
        };
        // The log changes on every logged line; its tab re-reads it on a timer instead (reloadLog).
        if (readOnlyReason !== 'log') this.watch(document);
      }
    }
    this.documents.set(id, document);
    return document;
  }

  private watch(document: TextDocument): void {
    document.watcher?.dispose();
    const location = document.location;
    if (!location) return;
    const key = folderKey(location.path);
    const watcher = this.deps.watchers.watch(path.dirname(location.path), '*');
    const changed = (fsPath: string): void => {
      if (folderKey(fsPath) !== key) return;
      this.reload(document, { force: false }).catch((err: unknown) => this.deps.log(`[documents] reloading ${location.path} failed: ${errorText(err)}`));
    };
    watcher.onDidCreate(changed);
    watcher.onDidChange(changed);
    watcher.onDidDelete(changed);
    document.watcher = watcher;
  }

  // The watcher path (agent writes, checkpoint restores, git checkout, any editor): a clean buffer takes the disk text,
  // a dirty one is flagged; force (Revert) takes the disk text either way. A document moved meanwhile ignores the read.
  // Resolves whether the buffer took the disk text, or for Revert of a missing file kept its own as clean.
  private async reload(document: TextDocument, opts: { readonly force: boolean }): Promise<boolean> {
    const location = document.location;
    if (!location || this.documents.get(document.id) !== document) return false;
    const read = await this.readLocation(location);
    if (document.location !== location) return false;
    if (read.kind === 'outside') {
      this.deps.log(`[documents] ${location.path} now resolves outside the file the editor opened; the buffer keeps its text`);
      return false;
    }
    if (read.kind === 'tooLarge' || read.kind === 'unreadable') {
      this.deps.log(`[documents] ${location.path} changed into something the editor cannot show; the buffer keeps its text`);
      return false;
    }
    const disk = read.kind === 'bytes' ? { exists: true, mtimeMs: read.mtimeMs, size: read.bytes.length, sha256: sha256(read.bytes) } : MISSING;
    if (!opts.force && sameDisk(disk, document.disk)) return false;
    if (read.kind === 'missing') {
      // VS Code's orphaned model (textFileEditorModel.ts setOrphaned) keeps the text and dirty state; its revert ignores
      // FILE_NOT_FOUND and only makes the buffer clean.
      document.disk = MISSING;
      document.orphaned = true;
      if (opts.force) document.diskText = document.text;
      this.emit(document.id, false);
      return opts.force;
    }
    const decoded = decodeDocument(read.bytes);
    if (!decoded) {
      this.deps.log(`[documents] ${location.path} changed into a binary file; the buffer keeps its text`);
      return false;
    }
    const parsed = document.searchEditor ? parseSearchEditor(decoded.text) : undefined;
    const diskText = parsed ? parsed.body : withEol(decoded.text, document.eol);
    const dirty = isDirty(document);
    if (dirty && !opts.force) {
      document.orphaned = false;
      if (diskText === document.text) {
        document.disk = disk;
        document.diskText = diskText;
        document.conflict = false;
        document.saveFailed = false;
        this.deps.backups.remove(document.backupId);
      } else {
        document.conflict = true;
      }
      this.emit(document.id, false);
      return false;
    }
    document.disk = disk;
    document.encoding = decoded.encoding;
    document.bom = decoded.bom;
    if (document.readOnlyReason === 'encoding' && decoded.valid) document.readOnlyReason = undefined;
    else if (document.readOnlyReason === undefined && !decoded.valid) document.readOnlyReason = 'encoding';
    document.diskText = diskText;
    document.conflict = false;
    document.orphaned = false;
    if (parsed && document.searchEditor) {
      document.searchEditor.config = parsed.config;
      document.searchEditor.dirty = false;
    }
    this.replaceText(document, diskText);
    return true;
  }

  // Resolves whether the buffer's dirty state changed. While the file is being written, text equal to the old disk text is
  // backed up too, since the backup is then the only whole copy of it.
  private takeText(document: TextDocument, text: string): boolean {
    if (document.text === text) return false;
    const wasDirty = isDirty(document);
    document.text = text;
    if (document.searchEditor) document.searchEditor.dirty = true;
    const dirty = isDirty(document);
    this.emitText(document.id);
    if (dirty || this.writing.has(document)) this.deps.backups.changed(document);
    else this.deps.backups.remove(document.backupId);
    return dirty !== wasDirty;
  }

  private replaceText(document: TextDocument, text: string): void {
    document.text = text;
    document.version++;
    this.emit(document.id, true);
    this.emitText(document.id);
  }

  // format: the encoding and byte order mark the bytes are written in; the document takes them, and the location, only once
  // the write landed. A dirty buffer's backup lands first, so a write torn by a crash leaves the text in the backup. As in
  // VS Code's doSave, handleSaveSuccess and handleSaveError (textFileEditorModel.ts:769, :959, :973), the buffer stays dirty
  // when it changed while the write ran, and after a failed write, which may have torn the file.
  private async write(document: TextDocument, location: Location, format: { readonly encoding: TextEncoding; readonly bom: boolean }): Promise<EditorSaveResult> {
    if (isDirty(document)) await this.deps.backups.writeNow(document);
    const buffer = document.text;
    const header = document.searchEditor ? serializeSearchConfiguration(document.searchEditor.config) : undefined;
    const text = document.searchEditor ? buffer : withEol(buffer, document.eol);
    const bytes = encodeDocument(savedText(document), format.encoding, format.bom);
    let mtimeMs: number;
    this.writing.add(document);
    try {
      mtimeMs = await this.writeConfined(location, bytes);
    } catch (err) {
      this.writing.delete(document);
      document.saveFailed = true;
      if (isDirty(document)) this.deps.backups.changed(document, true);
      this.emit(document.id, false);
      this.deps.log(`[documents] saving ${location.path} failed: ${errorText(err)}`);
      return { ok: false, reason: 'failed', message: this.saveFailure(location.path, this.writeFailureReason(err)) };
    }
    this.writing.delete(document);
    const unchanged = document.text === buffer && (!document.searchEditor || serializeSearchConfiguration(document.searchEditor.config) === header);
    document.location = location;
    document.encoding = format.encoding;
    document.bom = format.bom;
    document.readOnlyReason = undefined;
    document.disk = { exists: true, mtimeMs, size: bytes.length, sha256: sha256(bytes) };
    document.diskText = text;
    if (unchanged) document.text = text;
    document.conflict = false;
    document.orphaned = false;
    document.saveFailed = false;
    if (document.searchEditor && unchanged) document.searchEditor.dirty = false;
    if (isDirty(document)) this.deps.backups.changed(document);
    else this.deps.backups.remove(document.backupId);
    this.emit(document.id, false);
    return { ok: true };
  }

  // A pwrite may take fewer bytes than asked (a nearly full disk); the rest follows from where it stopped.
  private async writeAll(handle: fs.FileHandle, filePath: string, bytes: Buffer): Promise<void> {
    for (let offset = 0; offset < bytes.length;) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
      if (bytesWritten === 0) throw new WriteRefused(`${filePath} was not written in full`, this.deps.t('The disk stopped accepting data.'));
      offset += bytesWritten;
    }
  }

  // In place, so the file keeps its mode, hardlinks and ACLs. The handle must be the file confinement resolved: an existing
  // file's identity (bigint dev and ino, which NTFS ids need) is taken from the confined realpath before the open and
  // compared with the opened handle; a new file's realpath is checked after its exclusive create. A junction or link swapped
  // in between the check and the open fails either way. Resolves the written file's mtime.
  private async writeConfined(location: Location, bytes: Buffer): Promise<number> {
    const identity = await this.reconfine(location);
    if (identity) {
      const handle = await fs.open(location.path, 'r+');
      try {
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile() || opened.dev !== identity.dev || opened.ino !== identity.ino) throw new WriteRefused(`${location.path} changed while it was being saved`, this.deps.t('The file was replaced while it was being saved.'));
        await this.writeAll(handle, location.path, bytes);
        await handle.truncate(bytes.length);
        await handle.sync();
        return Number((await handle.stat({ bigint: true })).mtimeMs);
      } finally {
        await handle.close();
      }
    }
    const handle = await fs.open(location.path, 'wx');
    const made = await handle.stat({ bigint: true });
    let misplaced = true;
    try {
      if (folderKey(await fs.realpath(location.path)) !== folderKey(location.path)) throw new WriteRefused(`${location.path} changed while it was being saved`, this.deps.t('The file was replaced while it was being saved.'));
      misplaced = false;
      await this.writeAll(handle, location.path, bytes);
      await handle.sync();
      return Number((await handle.stat({ bigint: true })).mtimeMs);
    } finally {
      await handle.close();
      if (misplaced) await this.removeCreated(location.path, made);
    }
  }

  // The exclusive create landed somewhere confinement never approved: the empty file is removed, but only while the path
  // still names that same file, so a swapped-in link never deletes a file the editor did not create.
  private async removeCreated(filePath: string, made: { readonly dev: bigint; readonly ino: bigint }): Promise<void> {
    const now = await fs.stat(filePath, { bigint: true });
    if (now.dev === made.dev && now.ino === made.ino) await fs.rm(filePath);
    else this.deps.log(`[documents] left ${filePath} alone: it is no longer the file a refused save created`);
  }

  // A project file is written only while its path still resolves inside that project; every write names one. Resolves the
  // existing file's identity, or undefined when the file is to be created in its confined parent.
  private async reconfine(location: Location): Promise<{ readonly dev: bigint; readonly ino: bigint } | undefined> {
    if (location.projectKey === undefined || location.relativePath === undefined) throw new WriteRefused(`${location.path} is outside every project`, this.deps.t('Its path now leads outside the project.'));
    const project = this.deps.projects().find((candidate) => candidate.key === location.projectKey);
    if (!project) throw new WriteRefused(`${location.path}: its project is no longer in the project list`, this.deps.t('The project is no longer in the project list.'));
    // The walk comes first, so the stat never follows a link to a share. The identity is taken before the realpath check, so
    // one swap at any point fails: before the stat or between the stat and the realpath, the realpath leaves the file; after
    // it, the opened handle differs.
    if (!(await this.followsLocalLinks(project, location.relativePath))) throw new WriteRefused(`${location.relativePath} is outside the project`, this.deps.t('Its path now leads outside the project.'));
    const identity = await this.identityOf(location.path);
    const existing = await confineExisting(project, location.relativePath);
    if (existing.ok) {
      if (folderKey(existing.path) !== folderKey(location.path)) throw new WriteRefused(`${location.relativePath} now resolves outside the file the editor opened`, this.deps.t('Its path now leads outside the file the editor opened.'));
      if (!identity) throw new WriteRefused(`${location.relativePath} changed while it was being saved`, this.deps.t('The file was replaced while it was being saved.'));
      return identity;
    }
    if (existing.reason !== 'missing') throw new WriteRefused(`${location.relativePath} is outside the project`, this.deps.t('Its path now leads outside the project.'));
    const parent = path.posix.dirname(location.relativePath);
    // A file whose folder was deleted too is written back with its folders (fileService.ts writeFile's mkdirp).
    const confinedParent = await confineOrCreateFolder(project, parent === '.' ? '' : parent);
    if (!confinedParent.ok || folderKey(path.join(confinedParent.path, path.basename(location.path))) !== folderKey(location.path)) {
      throw new WriteRefused(`${location.relativePath} is outside the project`, this.deps.t('Its path now leads outside the project.'));
    }
    return undefined;
  }

  // A missing segment ends the walk with nothing left to follow, as for a file a save creates.
  private async followsLocalLinks(project: Project, relativePath: string): Promise<boolean> {
    try {
      return await followsLocalLinksOnly(project.fsPath, relativePath.split('/'));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return true;
      throw err;
    }
  }

  private async identityOf(filePath: string): Promise<{ readonly dev: bigint; readonly ino: bigint } | undefined> {
    try {
      const stat = await fs.stat(filePath, { bigint: true });
      if (!stat.isFile()) throw new WriteRefused(`${filePath} is not a file`, this.deps.t('The path is not a file.'));
      return { dev: stat.dev, ino: stat.ino };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  // The buffer stays dirty when it changed while the settings writer ran, as write() keeps it.
  private async saveSettings(document: TextDocument, baseVersion: string): Promise<EditorSaveResult> {
    const scope = document.settingsScope!;
    const buffer = document.text;
    const text = withEol(buffer, document.eol);
    const raw = (document.bom ? '\uFEFF' : '') + text;
    const result = await this.deps.settings.save(scope, document.location!.path, raw, baseVersion);
    if (!result.ok) {
      if (result.conflict) return this.refuseConflict(document);
      return { ok: false, reason: 'failed', message: result.cause === undefined ? result.error : this.saveFailure(document.location!.path, this.errnoReason(errnoCode(result.cause))) };
    }
    // The writer reports the sha256 of the bytes it wrote; the mtime only orders Search's results.
    document.disk = { exists: true, mtimeMs: Date.now(), size: Buffer.byteLength(raw, 'utf8'), sha256: result.version };
    document.diskText = text;
    if (document.text === buffer) document.text = text;
    document.conflict = false;
    if (isDirty(document)) this.deps.backups.changed(document);
    else this.deps.backups.remove(document.backupId);
    this.emit(document.id, false);
    return { ok: true };
  }

  // The settings file editor's version: the sha256 of the file read as UTF-8, which for valid UTF-8 is the sha256 of its bytes.
  private settingsBaseVersion(document: TextDocument): string {
    return document.disk.exists ? document.disk.sha256 : settingsFileVersion(undefined);
  }

  private async currentSettingsVersion(document: TextDocument): Promise<{ readonly ok: true; readonly version: string } | { readonly ok: false; readonly reason: 'failed'; readonly message: string }> {
    try {
      return { ok: true, version: settingsFileVersion(await fs.readFile(document.location!.path, 'utf8')) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, version: settingsFileVersion(undefined) };
      this.deps.log(`[documents] cannot read ${document.location!.path} before overwriting it: ${errorText(err)}`);
      return { ok: false, reason: 'failed', message: this.saveFailure(document.location!.path, this.errnoReason(errnoCode(err))) };
    }
  }

  // Bounded by the bytes the write produces, byte order mark included, as readFileBytes counts them, before anything is encoded.
  private oversize(text: string, format: { readonly encoding: TextEncoding; readonly bom: boolean }): string | undefined {
    const bytes = encodedLength(text, format.encoding, format.bom);
    if (bytes <= EDITOR_MAX_DOCUMENT_BYTES) return undefined;
    return this.deps.t('The text is {0} bytes, over the {1}-byte limit, so it was not saved.', bytes, EDITOR_MAX_DOCUMENT_BYTES);
  }

  private refuseConflict(document: TextDocument): EditorSaveResult {
    document.conflict = true;
    this.emit(document.id, false);
    return { ok: false, reason: 'conflict' };
  }

  // One document's saves, overwrites and reverts run one at a time, in the order asked (textFileEditorModel.ts:106,
  // saveSequentializer), so none reads the disk while another writes it.
  private inTurn<T>(document: TextDocument, task: () => Promise<T>): Promise<T> {
    const previous = this.turns.get(document.id) ?? Promise.resolve();
    const result = previous.then(task);
    const settled = result.then(() => undefined, () => undefined);
    this.turns.set(document.id, settled);
    void settled.then(() => {
      if (this.turns.get(document.id) === settled) this.turns.delete(document.id);
    });
    return result;
  }

  // A file that cannot be read now (grown past the limit, locked, replaced by a folder) fails the save with the reason.
  private async readDiskState(location: Location): Promise<{ readonly ok: true; readonly disk: DiskState } | { readonly ok: false; readonly reason: 'failed'; readonly message: string }> {
    const read = await this.readLocation(location);
    if (read.kind === 'missing') return { ok: true, disk: MISSING };
    if (read.kind === 'bytes') return { ok: true, disk: { exists: true, mtimeMs: read.mtimeMs, size: read.bytes.length, sha256: sha256(read.bytes) } };
    this.deps.log(`[documents] cannot read ${location.path} before saving it: ${read.kind === 'unreadable' ? read.error : read.kind}`);
    const reason = read.kind === 'tooLarge'
      ? this.deps.t('The file on disk is too large for the editor.')
      : read.kind === 'outside' ? this.deps.t('Its path now leads outside the file the editor opened.') : this.errnoReason(read.code);
    return { ok: false, reason: 'failed', message: this.saveFailure(location.path, reason) };
  }

  // VS Code's genericSaveError (textFileSaveErrorHandler.ts): the file's base name and a reason; the raw error and path go
  // only to the log.
  private saveFailure(filePath: string, reason: string): string {
    return this.deps.t('Failed to save \'{0}\': {1}', path.basename(filePath), reason);
  }

  private writeFailureReason(err: unknown): string {
    return err instanceof WriteRefused ? err.reason : this.errnoReason(errnoCode(err));
  }

  private errnoReason(code: string | undefined): string {
    const t = this.deps.t;
    switch (code) {
      case 'ENOSPC': return t('There is not enough space on the disk.');
      case 'EACCES':
      case 'EPERM': return t('Insufficient permissions.');
      case 'EROFS': return t('The file system is read-only.');
      case 'EBUSY':
      case 'EAGAIN': return t('The file is in use or locked by another program.');
      case 'EISDIR': return t('The path is a folder.');
      case 'ENOENT': return t('Its folder no longer exists.');
      case 'ENAMETOOLONG': return t('The path is too long.');
      case 'EMFILE': return t('Too many files are open.');
      default: return t('An unexpected error occurred. The log has the details.');
    }
  }

  // An open project file is read only while its path still confines to the file the editor opened, by confineExisting's
  // walk before anything follows a link, so a file replaced by a link to a share or out of the project is never opened. A
  // file outside every project reads as it opened.
  private async readLocation(location: Location): Promise<FileBytes | { readonly kind: 'outside' }> {
    if (location.projectKey !== undefined && location.relativePath !== undefined) {
      const project = this.deps.projects().find((candidate) => candidate.key === location.projectKey);
      if (!project) return { kind: 'outside' };
      const confined = await confineExisting(project, location.relativePath);
      if (!confined.ok) {
        if (confined.reason === 'missing') return { kind: 'missing' };
        return confined.reason === 'failed' ? { kind: 'unreadable', error: `${location.path} cannot be read` } : { kind: 'outside' };
      }
      if (folderKey(confined.path) !== folderKey(location.path)) return { kind: 'outside' };
    }
    return readFileBytes(location.path);
  }

  private text(id: string): TextDocument | undefined {
    const document = this.documents.get(id);
    return document?.kind === 'text' ? document : undefined;
  }

  private require(id: string): Document {
    const document = this.documents.get(id);
    if (!document) throw new Error('Unknown document');
    return document;
  }

  private emit(documentId: string, content: boolean): void {
    for (const listener of [...this.listeners]) listener({ documentId, content });
  }

  private emitText(documentId: string): void {
    for (const listener of [...this.textListeners]) listener({ documentId });
  }
}

// The content decides: a touch that keeps the bytes is no change, and a rewrite with the same mtime is one.
function sameDisk(a: DiskState, b: DiskState): boolean {
  return a.exists === b.exists && a.sha256 === b.sha256;
}
