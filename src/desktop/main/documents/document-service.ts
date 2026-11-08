import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { Disposable } from '../../../platform/disposable';
import { folderKeyOn } from '../../../core/workspace-folders/folder-key';
import { EDITOR_CONFIRM_DOCUMENT_BYTES, EDITOR_HARD_MAX_DOCUMENT_BYTES, type SettingsFileScope } from '../../../shared/types/messages';
import type { SettingsFileSaveOutcome } from '../../../core/chat-panel/settings-file-editor';
import { parseSettingsText, settingsFileVersion } from '../../../core/config/settings-file';
import type { EditorConflictResult, EditorEdit, EditorReadOnlyReason, EditorSaveResult, FilesMutationResult, NotDisplayedReason, SearchEditorConfig, SearchEditorMessage, ShellDocumentContent } from '../../preload/shell-channels';
import type { ScmMergeLabels } from '../../preload/scm-channels';
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
import { decodeDocument, encodeDocument, encodedLength, languageIdForName, majorityEol, withEol, type DecodedText } from '../platform/editor-document';
import { isRelativeFilePath } from '../../../shared/relative-path';
import { visibleText } from '../../../shared/visible-text';
import type { Project } from '../../local-services/confine';
import { authorityKeyOfProject, isAbsoluteOn, pathFor } from '../../../shared/project-location';
import type { FileBytes } from '../../local-services/file-bytes';
import { WriteRefusedError, type OutsideRefusal, type WatchEvent, type WorkspaceFileSystem, type WriteRefusal } from '../../workspace/file-system';
import type { ClosedFileRead, ClosedFileWrite, DiskState, TextEncoding } from '../../workspace/search/types';
import { NotConnectedError, type Workspaces } from '../workspace/workspaces';
import { OutsideFilesUnsupportedError } from '../workspace/remote-workspace';
import { EngineUnavailableError, type EngineAbsence, type SessionFileEngines } from './session-files';
import type { SessionFileRefusal, SessionFileWrite } from '../../../core/pi-session/session-store/session-file-write';
import type { RootSpellings } from '../workspace/root-spellings';
import { markerNames, mergeWithMarkers } from '../../../shared/scm/merge-markers';
import { applyTextChanges } from './text-changes';
import { LocalizedError, type LocalizedText } from '../../../shared/localized-text';
import { l } from '../../../core/l10n';

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

// acceptLarge: text the user took past the confirm threshold (Open Anyway, a restored text tab or backup, any read of an open document)
const readLimitOf = (name: string, acceptLarge: boolean): number => (imageMimeOf(name) ? MAX_IMAGE_BYTES : acceptLarge ? EDITOR_HARD_MAX_DOCUMENT_BYTES : EDITOR_CONFIRM_DOCUMENT_BYTES);

type FileContent =
  | { readonly kind: 'tooLarge'; readonly bytes: number }
  | { readonly kind: 'unreadable'; readonly error: string }
  | { readonly kind: 'image'; readonly mime: string; readonly bytes: Buffer }
  | { readonly kind: 'binary'; readonly bytes: number }
  // bytes: undefined for a missing file, which opens as empty text
  | { readonly kind: 'text'; readonly decoded: DecodedText; readonly bytes: Buffer | undefined };

// What the editor makes of a file named name: the one rule an open and a backup's adoption on connect both follow.
function fileContentOf(name: string, read: FileBytes | { readonly kind: 'outside' }): FileContent {
  if (read.kind === 'tooLarge') return { kind: 'tooLarge', bytes: read.bytes };
  if (read.kind === 'unreadable') return { kind: 'unreadable', error: read.error };
  if (read.kind === 'notAFile') return { kind: 'unreadable', error: 'it is not a file' };
  if (read.kind === 'outside') return { kind: 'unreadable', error: 'it leads outside the file it names' };
  const mime = imageMimeOf(name);
  if (mime && read.kind === 'bytes') return { kind: 'image', mime, bytes: read.bytes };
  const bytes = read.kind === 'bytes' ? read.bytes : undefined;
  const decoded = decodeDocument(bytes ?? Buffer.alloc(0));
  return decoded ? { kind: 'text', decoded, bytes } : { kind: 'binary', bytes: bytes?.length ?? 0 };
}

// A file the editor did not open for its size, which Open Anyway reads again up to the hard maximum; an image keeps its own bound,
// and only a project file or a file outside every project has a rule to read it again by.
function offersOpenAnyway(document: NotDisplayedDocument): boolean {
  const { location, bytes } = document;
  return document.reason === 'tooLarge' && bytes !== undefined && bytes <= EDITOR_HARD_MAX_DOCUMENT_BYTES && imageMimeOf(document.name) === undefined
    && location !== undefined && (location.outside === 'path' || (location.projectKey !== undefined && location.relativePath !== undefined));
}

type Eol = '\n' | '\r\n';

const MISSING: DiskState = { exists: false, mtimeMs: 0, size: 0, sha256: '' };

export interface Location {
  // the file's native realpath; for a missing file, the path it will be written to
  readonly path: string;
  // present when the file lies inside an open project
  readonly projectKey?: string;
  readonly relativePath?: string;
  // the authority key of the host holding a file outside every project, read and written only through that authority's
  // workspace, or its engine for one of that engine's session files; its path is native to that host
  readonly host?: string;
  // a file outside every project, editable, and the rule each read and write checks again on its own machine: settings, the
  // host's own settings file (HOST_SETTINGS_FILE); path, any other file, named by its native realpath on its authority, read
  // only through readOutside and written through writeOutside while that path is still its own realpath, except a session
  // file, which its engine writes (TextDocument.sessionFile)
  readonly outside?: 'settings' | 'path';
}

// What an offline placeholder stands for: a remote project's file, or a host's file outside every project, which reopens
// through openResolvedPath once its host connects.
export type HostFile = { readonly projectKey: string; readonly relativePath: string } | { readonly host: string; readonly path: string };

/** A path outside every project that the outside rule refuses (D27); its text names why. No document holds it. */
export class RefusedPathError extends LocalizedError {
  readonly path: string;
  readonly reason: OutsideRefusal;

  constructor(filePath: string, reason: OutsideRefusal) {
    super(reason === 'share'
      ? l('Damocles does not open {0}: it is on a network share or a device outside your projects.', visibleText(filePath))
      : l('Damocles does not open {0}: part of this path would be read differently than it is written, such as a trailing dot or space, a stream or a reserved device name.', visibleText(filePath)));
    this.name = 'RefusedPathError';
    this.path = filePath;
    this.reason = reason;
  }
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
  // main asked the shell for its whole buffer (editor:resync) and has applied no edit since
  resyncAsked?: true;
  readOnlyReason: EditorReadOnlyReason | undefined;
  // set when the disk changed under a dirty buffer or a save found the disk changed
  conflict: boolean;
  // no file yet: saving asks where
  untitled: boolean;
  // the file was deleted under the editor (VS Code's orphaned model): dirty only when edited, and a save recreates it
  orphaned: boolean;
  // a write failed (VS Code's error mode): dirty until a save lands or Revert, since the write may have torn the file
  saveFailed: boolean;
  // its machine's workspace read it as a session file of that machine's engine, which alone writes it (writeSessionFile)
  sessionFile?: true;
  // a .damocles settings file, saved through the settings file rules
  settingsScope: SettingsFileScope | undefined;
  // the hot-exit backup's file id
  backupId: string;
  watcher: Disposable | undefined;
  // a Search Editor: its text is the results body, its header lives here
  searchEditor: SearchEditorState | undefined;
  // a hot-exit backup of a remote file restored while its host was not connected: no disk text is known yet, and the location
  // is the project's folder joined with the relative path until the host connects and confines it
  awaitingHost?: true;
  // the connected host could not confine or read the awaiting file; the user was told once, and a save retries
  hostReadFailed?: true;
  // a remote file saved while its host was not connected: text is the buffer saved, kept in the backup until it uploads on
  // reconnect, which writes it only while the target still holds `disk`
  pendingUpload?: { readonly text: string };
  // the offline save found the target changed on reconnect: the merge editor's inputs until Complete Merge
  uploadConflict?: UploadConflict;
}

// base: the text last read from the target; current: the target's text on reconnect; incoming: the text saved offline
export interface UploadConflict {
  readonly base: string;
  readonly current: string;
  readonly incoming: string;
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
  readonly reason: NotDisplayedReason;
  readonly bytes?: number;
}

// A remote file whose host is not connected: its tab shows the offline placeholder, and the file opens once the host connects.
export interface OfflineDocument {
  readonly id: string;
  readonly kind: 'offline';
  location: Location;
  name: string;
  // its file opens as text up to the hard maximum once the host connects (a restored text tab)
  readonly acceptLarge?: true;
}

export type Document = TextDocument | ImageDocument | NotDisplayedDocument | OfflineDocument;

// A document that took another's place: an offline placeholder whose host connected.
export interface DocumentReplacement {
  readonly from: string;
  readonly to: string;
}

export type ShellEdit = EditorEdit;

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
  // written at once; resolves whether the write landed, and never rejects
  writeNow(document: TextDocument): Promise<boolean>;
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
  // the spellings of the local roots' folders, which a named or resolved path is matched against
  readonly spellings: Pick<RootSpellings, 'match' | 'confirms'>;
  readonly workspaces: Workspaces;
  // the OS whose path rules an authority's paths follow: this computer's, or the target's
  readonly authorityOs: (authority: string) => NodeJS.Platform;
  readonly ask: AskMessage;
  // core's text in main's language
  readonly render: (text: LocalizedText) => string;
  readonly t: (message: string, ...args: Array<string | number>) => string;
  readonly log: (line: string) => void;
  // the native Save As dialog; undefined when cancelled
  readonly pickSavePath: (defaultPath: string) => Promise<string | undefined>;
  readonly backups: Backups;
  readonly settings: SettingsFiles;
  // the engines that save their own session files (TextDocument.sessionFile)
  readonly sessionFiles: SessionFileEngines;
  // a remote authority's host as this computer names it, for the offline placeholder
  readonly hostLabel: (authority: string) => { readonly hostId: string; readonly name: string };
  // one reconnect's offline saves that found the target changed, each now holding its uploadConflict, all of one authority
  readonly uploadsConflicted: (authority: string, documents: readonly TextDocument[]) => void;
  // a warning toast: an offline save that did not upload, a restored backup its file cannot take
  readonly warn: (message: string) => void;
  // a pending upload whose last tab closed did not upload: it is dirty again, so a tab shows it
  readonly reopen: (document: TextDocument) => void;
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

// Why the settings reader refuses text, or undefined when it parses.
function settingsParseError(text: string, filePath: string): string | undefined {
  try {
    parseSettingsText(text, filePath);
    return undefined;
  } catch (err) {
    return errorText(err);
  }
}

function isDirty(document: TextDocument): boolean {
  if (document.readOnlyReason !== undefined) return false;
  if (document.saveFailed) return true;
  if (document.pendingUpload) return document.text !== document.pendingUpload.text;
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
  private readonly replacements = new Set<(replacement: DocumentReplacement) => void>();
  private readonly textListeners = new Set<(change: TextChange) => void>();
  private readonly saveListeners = new Set<(location: Location) => void>();
  // each document's last queued save, overwrite or revert, by document id
  private readonly turns = new Map<string, Promise<void>>();
  // documents whose file is being written; their backup stays until the write settles
  private readonly writing = new Set<TextDocument>();
  // file opens in flight, which a Files rename waits for; the rename in flight, which every file open waits for
  private readonly opening = new Set<Promise<void>>();
  private renaming: Promise<void> = Promise.resolve();
  // a read that makes a document, by the key openResolved matches documents on, so opens of one file share it
  private readonly resolving = new Map<string, { readonly read: Promise<Document>; callers: number }>();
  // how many opens openResolved handed each document it read to; an abandoned placeholder's open releases only its own
  private readonly handedOut = new WeakMap<Document, number>();
  // the file system each document's watcher runs on; a remote one's watch ends with its connection
  private readonly watchedOn = new WeakMap<TextDocument, WorkspaceFileSystem>();
  // pending uploads whose last tab closed: released once their upload lands
  private readonly tabless = new Set<TextDocument>();
  // offline placeholders whose file is opening
  private readonly placeholderOpens = new Set<OfflineDocument>();

  constructor(deps: DocumentServiceDeps) {
    this.deps = deps;
  }

  onDidChange(listener: (change: DocumentChange) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** An offline placeholder's host connected and its file opened as another document, which every tab of it now shows. */
  onDidReplace(listener: (replacement: DocumentReplacement) => void): Disposable {
    this.replacements.add(listener);
    return { dispose: () => this.replacements.delete(listener) };
  }

  /** Every change of a text document's buffer, a keystroke included; Search's live updates follow it. */
  onDidChangeText(listener: (change: TextChange) => void): Disposable {
    this.textListeners.add(listener);
    return { dispose: () => this.textListeners.delete(listener) };
  }

  /** A file a save wrote, once the write landed: Save, Save As, Overwrite and an offline save's upload alike. */
  onDidSave(listener: (location: Location) => void): Disposable {
    this.saveListeners.add(listener);
    return { dispose: () => this.saveListeners.delete(listener) };
  }

  get(id: string): Document | undefined {
    return this.documents.get(id);
  }

  all(): readonly Document[] {
    return [...this.documents.values()];
  }

  /**
   * A file a renderer named: confined to the project's realpath, links followed. With missing, a file that is gone opens as
   * an orphaned document in that format (a hot-exit backup's file deleted on disk). With acceptLarge, text past the confirm
   * threshold opens up to the hard maximum.
   */
  openProjectFile(projectKey: string, relativePath: string, opts: { readonly missing?: MissingFileFormat; readonly acceptLarge?: boolean } = {}): Promise<OpenProjectResult> {
    return this.outsideRenames(() => this.openProjectFileNow(projectKey, relativePath, opts));
  }

  private async openProjectFileNow(projectKey: string, relativePath: string, opts: { readonly missing?: MissingFileFormat; readonly acceptLarge?: boolean }): Promise<OpenProjectResult> {
    const project = this.deps.projects().find((candidate) => candidate.key === projectKey);
    // '' would name the project folder itself, which is no document.
    if (!project || !isRelativeFilePath(relativePath)) return { ok: false, reason: 'outside' };
    const confined = await this.files(project.key).confineExisting(project, relativePath);
    if (confined.ok) return { ok: true, document: await this.openResolved(confined.path, { projectKey: project.key, relativePath }, undefined, undefined, opts.acceptLarge === true) };
    return confined.reason === 'missing' && opts.missing ? this.openMissing(project, relativePath, opts.missing) : confined;
  }

  /** Whether a project's files, or a host's files outside every project, wait on a remote host that is not connected. */
  awaitsHost(location: Pick<Location, 'projectKey' | 'host'>): boolean {
    return this.authorityOf(location) !== 'local' && !this.connected(location);
  }

  /**
   * The offline placeholder of a remote file while its host is not connected: no content of this computer's disk shows, and
   * once the host connects the file opens by the rule it was opened with (connectionsChanged). A document of that file
   * already open (a backup restored into it) is that document.
   */
  openOffline(file: HostFile, acceptLarge = false): Document {
    const location = 'projectKey' in file ? this.awaitingLocation(file.projectKey, file.relativePath) : this.hostFileLocation(file);
    const existing = this.fileDocument(location);
    if (existing) return existing;
    const document: OfflineDocument = { id: randomUUID(), kind: 'offline', location, name: this.nameOf(location), ...(acceptLarge ? { acceptLarge: true as const } : {}) };
    this.documents.set(document.id, document);
    return document;
  }

  // A host's file outside every project as its placeholder names it, in the host's path rules.
  private hostFileLocation(file: Extract<HostFile, { readonly host: string }>): Location {
    if (file.host === 'local' || !isAbsoluteOn({ os: this.deps.authorityOs(file.host) }, file.path)) throw new Error(`${file.path} is not a file of a remote host`);
    return { path: file.path, host: file.host, outside: 'path' };
  }

  // The file's own name, as a project file's; its tab names the host apart (ShellEditorTab.host).
  private nameOf(location: Location): string {
    return this.flavorOf(location).basename(location.path);
  }

  /**
   * The document a hot-exit backup of a remote file restores into while its host is not connected: its text is the backup's,
   * so it opens dirty, and once the host connects the file's disk text becomes its baseline (connectionsChanged). A document
   * of that file already open (a backup restored first) is that document; an offline placeholder's tabs show the new one.
   */
  openAwaitingHost(projectKey: string, relativePath: string, format: MissingFileFormat): Document {
    const location = this.awaitingLocation(projectKey, relativePath);
    const existing = this.fileDocument(location);
    if (existing && existing.kind !== 'offline') return existing;
    const name = this.flavorOf(location).basename(location.path);
    const searchEditor = isSearchEditorPath(name);
    const document: TextDocument = {
      id: randomUUID(),
      kind: 'text',
      location,
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
      orphaned: false,
      saveFailed: false,
      settingsScope: undefined,
      backupId: randomUUID(),
      watcher: undefined,
      searchEditor: searchEditor ? { config: DEFAULT_SEARCH_EDITOR_CONFIG, dirty: false, projectKey, running: false, message: undefined } : undefined,
      awaitingHost: true,
    };
    this.documents.set(document.id, document);
    if (existing) {
      this.documents.delete(existing.id);
      this.replaced(existing.id, document.id);
    }
    return document;
  }

  // A remote project file's location before its host confines it: the project's folder joined in the target's flavor.
  private awaitingLocation(projectKey: string, relativePath: string): OfflineDocument['location'] {
    const project = this.deps.projects().find((candidate) => candidate.key === projectKey);
    if (!project || authorityKeyOfProject(projectKey) === 'local' || !isRelativeFilePath(relativePath)) throw new Error(`${relativePath} is not a file of an open remote project`);
    return { path: this.flavorOf({ projectKey }).join(project.fsPath, ...relativePath.split('/')), projectKey, relativePath };
  }

  // VS Code resolves a backup whose file is gone as an orphaned model (textFileEditorModel.ts doResolveFromBackup): the
  // document sits at the path the file had, under its deepest existing folder, and a save writes the file back.
  private async openMissing(project: Project, relativePath: string, format: MissingFileFormat): Promise<OpenProjectResult> {
    const confined = await this.files(project.key).confineMissing(project, relativePath);
    if (!confined.ok) return confined;
    return { ok: true, document: await this.openMissingAt(project, relativePath, confined.path, format) };
  }

  private async openMissingAt(project: Project, relativePath: string, confinedPath: string, format: MissingFileFormat): Promise<Document> {
    const location: Location = { path: confinedPath, projectKey: project.key, relativePath };
    return this.fileDocument(location) ?? (await this.orphaned(location, this.flavorOf(location).basename(confinedPath), format));
  }

  // A document of a file that is gone, which a save writes back; watched, since the file may come back meanwhile.
  private async orphaned(location: Location, name: string, format: MissingFileFormat): Promise<TextDocument> {
    const fileName = this.flavorOf(location).basename(location.path);
    const searchEditor = isSearchEditorPath(fileName);
    const document: TextDocument = {
      id: randomUUID(),
      kind: 'text',
      location,
      name,
      languageId: searchEditor ? SEARCH_RESULT_LANGUAGE_ID : languageIdForName(fileName),
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
      searchEditor: searchEditor ? { config: DEFAULT_SEARCH_EDITOR_CONFIG, dirty: false, projectKey: location.projectKey, running: false, message: undefined } : undefined,
    };
    this.documents.set(document.id, document);
    this.watch(document);
    // The file may have come back between the resolution and the watch.
    await this.reload(document, { force: false });
    return document;
  }

  // The document of a file on disk (not its settings or untitled documents), by its identity.
  private fileDocument(location: Location): Document | undefined {
    const key = this.identity(location);
    return [...this.documents.values()].find((document) => {
      if (document.kind === 'text' && (document.untitled || document.settingsScope !== undefined)) return false;
      return document.location !== undefined && document.location.outside !== 'settings' && this.identity(document.location) === key;
    });
  }

  // The authority a file is on: a host's file outside every project names it, and a project file's project key carries it.
  private authorityOf(location: Pick<Location, 'projectKey' | 'host'>): string {
    return location.host ?? (location.projectKey === undefined ? 'local' : authorityKeyOfProject(location.projectKey));
  }

  private flavorOf(location: Pick<Location, 'projectKey' | 'host'>): path.PlatformPath {
    return pathFor({ os: this.deps.authorityOs(this.authorityOf(location)) });
  }

  // A file's identity: its authority and its path by that host's rules, so the same path on two hosts is two files.
  private identity(location: Location): string {
    const authority = this.authorityOf(location);
    return `${authority}\0${folderKeyOn(this.deps.authorityOs(authority), location.path)}`;
  }

  /**
   * A project file no document holds, read for Search's replace: confined like openProjectFile, with its line endings as they
   * are on disk. A file the editor would open read-only (not valid UTF-8 without a BOM, binary, too large) is readOnly.
   */
  async readClosedFile(projectKey: string, relativePath: string): Promise<ClosedFileRead> {
    const project = this.deps.projects().find((candidate) => candidate.key === projectKey);
    if (!project || !isRelativeFilePath(relativePath)) return { kind: 'missing' };
    const files = this.files(projectKey);
    const confined = await files.confineExisting(project, relativePath);
    if (!confined.ok) return { kind: 'missing' };
    const read = await files.read(confined.path, EDITOR_HARD_MAX_DOCUMENT_BYTES);
    if (read.kind === 'missing') return { kind: 'missing' };
    if (read.kind !== 'bytes') return { kind: 'readOnly' };
    const decoded = decodeDocument(read.bytes);
    if (!decoded?.valid) return { kind: 'readOnly' };
    return {
      kind: 'text',
      location: { path: confined.path, projectKey, relativePath },
      text: decoded.text,
      eol: majorityEol(decoded.text, this.deps.authorityOs(authorityKeyOfProject(projectKey))),
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
    if (this.holdsFile(read.location)) return { ok: false, reason: 'openInEditor' };
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

  private holdsFile(location: Location): boolean {
    const key = this.identity(location);
    return [...this.documents.values()].some((document) => document.location !== undefined && this.identity(document.location) === key);
  }

  /**
   * A path someone named on authority (a core's openFile, a diff side, Source control, the damocles command), links followed:
   * a path a project of authority holds in any spelling of its folder opens as that project's file, a missing one as an empty
   * document its first save creates; any other opens editable outside every project (openOutsideNow). Throws RefusedPathError
   * for a path the outside rule refuses, NotConnectedError while a host is away, and OutsideFilesUnsupportedError for a daemon
   * without files.outside.
   */
  openNamedPath(authority: string, target: string): Promise<Document> {
    return this.outsideRenames(() => this.openNamedPathNow(authority, target));
  }

  private async openNamedPathNow(authority: string, target: string): Promise<Document> {
    const os = this.deps.authorityOs(authority);
    if (authority !== 'local' && !isAbsoluteOn({ os }, target)) throw new RefusedPathError(target, 'name');
    // '..' folds by text in the path's own flavor, as pi's file tools resolve it, so the editor opens the file a tool named
    const absolute = authority === 'local' ? path.resolve(target) : pathFor({ os }).resolve(target);
    // a project confines the paths it holds in any spelling before any outside rule, which refuses every path of a share
    const inRoot = await this.deps.spellings.match({ authority, os }, this.rootsOn(authority), absolute);
    if (inRoot) {
      const { root: project, relativePath } = inRoot;
      const files = this.files(project.key);
      const existing = await files.confineExisting(project, relativePath);
      const confined = !existing.ok && existing.reason === 'missing' ? await files.confineMissing(project, relativePath) : existing;
      if (confined.ok && this.deps.spellings.confirms(inRoot, confined.path)) return this.openResolved(confined.path, { projectKey: project.key, relativePath });
      if (!confined.ok && confined.reason === 'failed') throw new LocalizedError(l('{0} could not be opened.', visibleText(absolute)));
      // a path its project does not confine (a link out of it, its folder gone) or a remapped spelling is outside every project
    }
    return this.openOutsideNow(authority, absolute, { exact: false });
  }

  /** A file of Damocles' own logs folder, read-only, which main names itself and no outside rule decides. */
  openLog(filePath: string): Promise<Document> {
    return this.openResolved(filePath, {}, 'log');
  }

  /**
   * A path main resolved earlier (a Quick Open pick, a restored tab or backup, a placeholder's reopen), only while it is still
   * its own realpath: a file a project of authority holds in any spelling opens as that project's file, any other through
   * openOutsideNow.
   * missing: a file that is gone opens as an orphaned document in that format (a hot-exit backup's). Undefined when the path
   * no longer resolves to itself, or names a missing file without missing; throws as openNamedPath does. acceptLarge: as
   * openProjectFile.
   */
  openResolvedPath(authority: string, realPath: string, opts: { readonly missing?: MissingFileFormat; readonly acceptLarge?: boolean } = {}): Promise<Document | undefined> {
    return this.outsideRenames(() => this.openResolvedPathNow(authority, realPath, opts));
  }

  private async openResolvedPathNow(authority: string, realPath: string, opts: { readonly missing?: MissingFileFormat; readonly acceptLarge?: boolean }): Promise<Document | undefined> {
    const host = authority === 'local' ? {} : { host: authority };
    // a project confines the paths it holds in any spelling before any outside rule
    const inRoot = await this.deps.spellings.match({ authority, os: this.deps.authorityOs(authority) }, this.rootsOn(authority), realPath);
    if (inRoot) {
      const { root: project, relativePath } = inRoot;
      const confined = await this.files(project.key).confineExisting(project, relativePath);
      if (confined.ok) {
        if (!this.deps.spellings.confirms(inRoot, confined.path)) return this.openOutsideNow(authority, realPath, { exact: true, ...opts });
        return this.identity({ path: confined.path, ...host }) === this.identity({ path: realPath, ...host }) ? this.openResolved(confined.path, { projectKey: project.key, relativePath }, undefined, undefined, opts.acceptLarge === true) : undefined;
      }
      if (confined.reason !== 'missing' || !opts.missing) return undefined;
      const missing = await this.files(project.key).confineMissing(project, relativePath);
      if (!missing.ok) return undefined;
      if (!this.deps.spellings.confirms(inRoot, missing.path)) return this.openOutsideNow(authority, realPath, { exact: true, ...opts });
      return this.openMissingAt(project, relativePath, missing.path, opts.missing);
    }
    return this.openOutsideNow(authority, realPath, { exact: true, ...opts });
  }

  /**
   * A file outside every project of authority, editable, read only through readOutside and written only through writeOutside,
   * a session file excepted (write).
   * exact: undefined unless target is still its own realpath, a missing file included unless missing names its format, which
   * opens it orphaned. A path the outside rule refuses is the document of it already open by another rule (Damocles' log),
   * else RefusedPathError; a path whose realpath is a share (a mapped drive) opens only as the file of a project holding that
   * realpath. Without exact a missing file opens as an empty document whose first save creates it.
   */
  private async openOutsideNow(authority: string, target: string, opts: { readonly exact: false }): Promise<Document>;
  private async openOutsideNow(authority: string, target: string, opts: { readonly exact: true; readonly missing?: MissingFileFormat; readonly acceptLarge?: boolean }): Promise<Document | undefined>;
  private async openOutsideNow(authority: string, target: string, opts: { readonly exact: boolean; readonly missing?: MissingFileFormat; readonly acceptLarge?: boolean }): Promise<Document | undefined> {
    const host = authority === 'local' ? {} : { host: authority };
    const acceptLarge = opts.acceptLarge === true;
    const { files } = this.deps.workspaces.forAuthority(authority);
    // resolveOutside refuses a UNC, device or relative path before any file call, so nothing here reaches a share
    const resolved = await files.resolveOutside(target);
    if (resolved.kind === 'outside') {
      // a path refused for its name is read differently than it is written, so only a share path names a held one
      const held = resolved.reason === 'share' ? this.heldDocument(this.identity({ path: target, ...host }), undefined) : undefined;
      if (held) return held;
      throw new RefusedPathError(target, resolved.reason);
    }
    if (resolved.kind === 'share') {
      if (opts.exact && this.identity({ path: resolved.path, ...host }) !== this.identity({ path: target, ...host })) return undefined;
      const onShare = await this.projectFileOf(authority, resolved.path, 'existing');
      if (onShare) return this.openResolved(onShare.path, { projectKey: onShare.project.key, relativePath: onShare.relativePath }, undefined, undefined, acceptLarge);
      const held = this.heldDocument(this.identity({ path: target, ...host }), undefined);
      if (held) return held;
      throw new RefusedPathError(target, 'share');
    }
    if (resolved.kind === 'missing') {
      if (opts.exact) {
        if (!opts.missing) return undefined;
        const location: Location = { path: target, outside: 'path', ...host };
        return this.fileDocument(location) ?? (await this.orphaned(location, this.nameOf(location), opts.missing));
      }
      const created = await this.creationPath(files, authority, target);
      if (created.share) {
        const onShare = await this.projectFileOf(authority, created.path, 'missing');
        if (onShare) return this.openResolved(onShare.path, { projectKey: onShare.project.key, relativePath: onShare.relativePath });
        const held = this.heldDocument(this.identity({ path: target, ...host }), undefined);
        if (held) return held;
        throw new RefusedPathError(target, 'share');
      }
      // a folder a link leads into a project holds that project's new file
      const inProject = (await this.projectFileOf(authority, created.path, 'missing')) ?? (await this.hostProjectFileOf(authority, created.path, 'missing'));
      if (inProject) return this.openResolved(inProject.path, { projectKey: inProject.project.key, relativePath: inProject.relativePath });
      return this.openOutsideLocation(files, { path: created.path, outside: 'path', ...host });
    }
    if (opts.exact && this.identity({ path: resolved.path, ...host }) !== this.identity({ path: target, ...host })) return undefined;
    const inProject = (await this.projectFileOf(authority, resolved.path, 'existing')) ?? (await this.hostProjectFileOf(authority, resolved.path, 'existing'));
    if (inProject) return this.openResolved(inProject.path, { projectKey: inProject.project.key, relativePath: inProject.relativePath }, undefined, undefined, acceptLarge);
    return this.openOutsideLocation(files, { path: resolved.path, outside: 'path', ...host }, acceptLarge);
  }

  // Opens of one file share one read, whichever rule opened it.
  private openOutsideLocation(files: WorkspaceFileSystem, location: Location, acceptLarge = false): Promise<Document> {
    const key = this.identity(location);
    const existing = this.heldDocument(key, undefined);
    if (existing) return Promise.resolve(existing);
    const limitBytes = readLimitOf(this.flavorOf(location).basename(location.path), acceptLarge);
    return this.joined(`${key}\0`, async () => this.documentOf(location, await files.readOutside(location.path, limitBytes), undefined, undefined, this.nameOf(location)));
  }

  // A realpath's file only as the file of a project holding it in a spelling of its folder, confined and confirmed by that
  // project (an existing one to that very realpath), with no file system call naming the realpath, which may be a share's.
  private async projectFileOf(authority: string, realPath: string, state: 'existing' | 'missing'): Promise<{ readonly project: Project; readonly relativePath: string; readonly path: string } | undefined> {
    const inRoot = await this.deps.spellings.match({ authority, os: this.deps.authorityOs(authority) }, this.rootsOn(authority), realPath);
    if (!inRoot) return undefined;
    const { root: project, relativePath } = inRoot;
    const files = this.files(project.key);
    const confined = state === 'existing' ? await files.confineExisting(project, relativePath) : await files.confineMissing(project, relativePath);
    if (!confined.ok || !this.deps.spellings.confirms(inRoot, confined.path)) return undefined;
    const host = authority === 'local' ? {} : { host: authority };
    if (state === 'existing' && this.identity({ path: confined.path, ...host }) !== this.identity({ path: realPath, ...host })) return undefined;
    return { project, relativePath, path: confined.path };
  }

  // A host's roots have only their open path as a spelling here, so for a realpath none holds the host's own realpath of each
  // root decides, on the host; never for a share's realpath, which no call names.
  private async hostProjectFileOf(authority: string, realPath: string, state: 'existing' | 'missing'): Promise<{ readonly project: Project; readonly relativePath: string; readonly path: string } | undefined> {
    if (authority === 'local') return undefined;
    const found = await this.deps.workspaces.forAuthority(authority).files.projectOfPath(this.rootsOn(authority), realPath);
    if (!found) return undefined;
    const files = this.files(found.project.key);
    const confined = state === 'existing' ? await files.confineExisting(found.project, found.relativePath) : await files.confineMissing(found.project, found.relativePath);
    return confined.ok ? { project: found.project, relativePath: found.relativePath, path: confined.path } : undefined;
  }

  // The path a missing named file's first save writes: below its folder's realpath when that folder exists, since the save
  // creates the file only while its folder is its own realpath (a link on the way, such as macOS's /tmp, would fail it).
  // share: the deepest existing folder on its path resolves onto a share, which only a project holding it may create a file in.
  private async creationPath(files: WorkspaceFileSystem, authority: string, target: string): Promise<{ readonly path: string; readonly share: boolean }> {
    const flavor = pathFor({ os: this.deps.authorityOs(authority) });
    const below = [flavor.basename(target)];
    let folder = flavor.dirname(target);
    for (;;) {
      const answer = await files.resolveOutside(folder);
      if (answer.kind === 'share') return { path: flavor.join(answer.path, ...below), share: true };
      if (answer.kind === 'folder' && below.length === 1) return { path: flavor.join(answer.path, ...below), share: false };
      const parent = flavor.dirname(folder);
      if (answer.kind !== 'missing' || parent === folder) return { path: target, share: false };
      below.unshift(flavor.basename(folder));
      folder = parent;
    }
  }

  private rootsOn(authority: string): Project[] {
    return this.deps.projects().filter((project) => authorityKeyOfProject(project.key) === authority);
  }

  /**
   * Open Anyway (VS Code's large file confirmation): a file the editor did not open for its size reads again up to the hard
   * maximum into the same document id, which its tabs and diff sides keep.
   */
  openAnyway(id: string): Promise<void> {
    return this.outsideRenames(async () => {
      const document = this.documents.get(id);
      if (document?.kind !== 'notDisplayed' || !offersOpenAnyway(document)) return;
      const location = document.location!;
      const read = await this.readLocation(location);
      if (this.documents.get(id) !== document || document.location !== location) return;
      this.documentOf(location, read, undefined, undefined, document.name, id);
      this.emit(id, true);
    });
  }

  /** A .damocles settings file; its save follows the settings file editor's parse and version rules. */
  async openSettingsFile(scope: SettingsFileScope): Promise<Document | undefined> {
    const filePath = this.deps.settings.locate(scope);
    if (filePath === undefined) return undefined;
    return this.openResolved(filePath, {}, undefined, scope);
  }

  /** The settings file of a host's own ~/.damocles, named name, read and saved through the authority's workspace. */
  async openHostSettings(authority: string, name: string): Promise<Document> {
    const existing = [...this.documents.values()].find((document) => document.location?.outside === 'settings' && document.location.host === authority);
    if (existing) return existing;
    return this.joined(`${authority}\0host`, async () => {
      const { path: filePath, read } = await this.deps.workspaces.forAuthority(authority).files.readHostSettings();
      return this.documentOf({ path: filePath, host: authority, outside: 'settings' }, read, undefined, undefined, name);
    });
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
      readOnlyReason: opts.untitled ? undefined : 'snapshot',
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

  /** New text for a read-only in-memory document (a diff's git side that moved), as a new content version the shell applies. */
  replaceMemory(id: string, text: string): void {
    const document = this.text(id);
    if (!document || document.location !== undefined || document.untitled || document.readOnlyReason === undefined) throw new Error('Not a read-only in-memory document');
    const normalized = withEol(text, document.eol);
    if (normalized === document.text) return;
    document.diskText = normalized;
    this.replaceText(document, normalized);
  }

  /** A core-originated side the editor does not show (a git blob that is missing, too large or binary): its reason only, no bytes. */
  openPlaceholder(name: string, reason: NotDisplayedReason, bytes?: number): NotDisplayedDocument {
    const document: NotDisplayedDocument = { id: randomUUID(), kind: 'notDisplayed', location: undefined, name, reason, ...(bytes !== undefined ? { bytes } : {}) };
    this.documents.set(document.id, document);
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
  // A path on another host is never offered: its name goes into a local project instead (VS Code's suggestSavePath for a
  // scheme the dialog cannot show).
  private saveAsDefaultPath(document: TextDocument, local: readonly Project[]): string {
    const { location } = document;
    if (location && this.authorityOf(location) === 'local') return location.path;
    const searchEditor = document.untitled ? document.searchEditor : undefined;
    const folder = local.find((project) => project.key === searchEditor?.projectKey) ?? local[0];
    const name = location ? this.flavorOf(location).basename(location.path) : searchEditor ? suggestedFileName(searchEditor.config.query) : document.name;
    return path.join(folder?.fsPath ?? '', name);
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
    if (document.kind === 'offline') {
      const host = this.deps.hostLabel(this.authorityOf(document.location));
      return { kind: 'offline', documentId: id, hostId: host.hostId, hostName: host.name };
    }
    if (document.kind === 'image') return { kind: 'image', documentId: id, dataUrl: document.dataUrl, bytes: document.bytes };
    if (document.kind === 'notDisplayed') {
      return { kind: 'notDisplayed', documentId: id, reason: document.reason, ...(document.bytes !== undefined ? { bytes: document.bytes } : {}), ...(offersOpenAnyway(document) ? { openAnyway: true as const } : {}) };
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

  /**
   * The shell's edit: Monaco's changes since its last one, or its whole buffer (undefined: a report the shell boundary
   * refused). An edit for another version than main's is dropped, since main replaced that text, and the shell answers the
   * replacement with its whole buffer. True when main must ask the shell for its whole buffer (editor:resync): changes that
   * do not follow the last edit applied or do not fit the text, none of which is applied.
   */
  edit(id: string, edit: ShellEdit | undefined): boolean {
    const document = this.text(id);
    if (!document || document.readOnlyReason !== undefined) return false;
    if (edit === undefined) return this.askWholeBuffer(document);
    if (edit.version !== document.version) return false;
    if ('changes' in edit) {
      const text = edit.seq === document.editSeq + 1 ? applyTextChanges(document.text, edit.changes, EDITOR_HARD_MAX_DOCUMENT_BYTES) : undefined;
      if (text === undefined) return this.askWholeBuffer(document);
      document.editSeq = edit.seq;
      delete document.resyncAsked;
      if (this.takeText(document, text)) this.emit(id, false);
      return false;
    }
    document.editSeq = edit.seq;
    delete document.resyncAsked;
    // Typed over a reload that replaced the text before main saw them: the buffer keeps them, in conflict with the disk.
    const conflict = edit.overReload && !document.untitled && edit.text !== document.diskText && !document.conflict;
    if (conflict) document.conflict = true;
    if (this.takeText(document, edit.text) || conflict) this.emit(id, false);
    return false;
  }

  // Once until an edit applies: every change the shell sent meanwhile has a later seq, which the whole buffer covers.
  private askWholeBuffer(document: TextDocument): boolean {
    if (document.resyncAsked) return false;
    document.resyncAsked = true;
    return true;
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
    // its file is known only once the host confines it, so nothing is written to the path it was restored at
    if (document.awaitingHost) {
      const unadopted = await this.adoptBeforeSave(document);
      if (unadopted) return unadopted;
    }
    if (document.conflict) return this.refuseConflict(document);
    const refused = this.oversize(savedText(document), document);
    if (refused) return { ok: false, reason: 'failed', message: refused };
    if (document.settingsScope !== undefined) return this.saveSettings(document, this.settingsBaseVersion(document));
    const location = document.location!;
    if (!document.searchEditor && location.host === undefined && this.authorityOf(location) !== 'local' && !this.connected(location)) return this.saveOffline(document);
    const current = await this.readDiskState(location);
    if (!current.ok) return current;
    if (!sameDisk(current.disk, document.disk)) return this.refuseConflict(document);
    return this.write(document, location, document);
  }

  // A connected host takes the awaiting file first; the save goes on only once it did.
  private async adoptBeforeSave(document: TextDocument): Promise<EditorSaveResult | undefined> {
    const location = document.location!;
    if (this.connected(location)) {
      try {
        await this.adoptDisk(document);
      } catch (err) {
        if (!(err instanceof NotConnectedError)) throw err;
      }
    }
    // its text moved to an untitled buffer, whose warning says why
    if (this.documents.get(document.id) !== document) return { ok: false, reason: 'failed' };
    if (!document.awaitingHost) return undefined;
    const host = this.deps.hostLabel(this.authorityOf(location)).name;
    const message = this.connected(location)
      ? this.deps.t('{0} could not be read on {1}, so it was not saved. Its changes stay in the editor.', visibleText(document.name), host)
      : this.deps.t('{0} is not connected, so the file was not saved. Its changes stay in the editor.', host);
    return { ok: false, reason: 'failed', message };
  }

  // The buffer is kept in its backup, not written: the file uploads once its host reconnects (uploadPending), and disk and
  // diskText stay what was last read from the target, the base a changed target merges against.
  private async saveOffline(document: TextDocument): Promise<EditorSaveResult> {
    const previous = document.pendingUpload;
    document.pendingUpload = { text: document.text };
    if (!(await this.deps.backups.writeNow(document))) {
      if (previous) document.pendingUpload = previous;
      else delete document.pendingUpload;
      const host = this.deps.hostLabel(this.authorityOf(document.location!)).name;
      return { ok: false, reason: 'failed', message: this.saveFailure(document.location!, this.deps.t('{0} is not connected, and the copy on this computer could not be written.', host)) };
    }
    document.saveFailed = false;
    this.emit(document.id, false);
    return { ok: true };
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
    // the native dialog names this computer's paths, which only a local project holds
    const local = this.deps.projects().filter((project) => authorityKeyOfProject(project.key) === 'local');
    const chosen = await this.deps.pickSavePath(this.saveAsDefaultPath(document, local));
    if (chosen === undefined) return { ok: false, reason: 'cancelled' };
    const target = await this.deps.workspaces.local.files.projectOfPath(local, chosen);
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
    const name = document.location ? this.flavorOf(document.location).basename(document.location.path) : document.name;
    const choice = await this.deps.ask({
      severity: 'warning',
      message: this.deps.t('Overwrite {0}?', visibleText(name)),
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
        return { ok: false, reason: 'failed', message: this.deps.t('{0} cannot be read as text now, so the editor kept your text.', visibleText(document.name)) };
      }
      if (document.searchEditor) document.searchEditor.dirty = false;
      document.conflict = false;
      document.saveFailed = false;
      delete document.pendingUpload;
      delete document.uploadConflict;
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
      document.location = { path: this.flavorOf({ projectKey }).join(project.fsPath, ...relativePath.split('/')), projectKey, relativePath };
      if (document.kind === 'text') {
        document.watcher?.dispose();
        document.watcher = undefined;
      }
      moving.push({ document, relativePath });
    }
    for (const { document, relativePath } of moving) {
      const confined = await this.files(projectKey).confineExisting(project, relativePath);
      if (!confined.ok) {
        this.deps.log(`[documents] ${relativePath} is ${confined.reason} after a rename; its editor keeps the path`);
        continue;
      }
      document.location = { path: confined.path, projectKey, relativePath };
      document.name = this.flavorOf({ projectKey }).basename(confined.path);
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

  /**
   * Drops the document; its backup goes only when discard is set (the user chose Don't Save, or it is clean). A pending upload
   * stays held without a tab until it uploads, since its save already happened.
   */
  release(id: string, discard: boolean): void {
    const document = this.documents.get(id);
    if (!document) return;
    if (document.kind === 'text' && document.pendingUpload) {
      // Don't Save drops only the edits made after the offline save
      if (discard && isDirty(document)) {
        this.replaceText(document, document.pendingUpload.text);
        this.deps.backups.changed(document, true);
      }
      this.tabless.add(document);
      return;
    }
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

  private async openResolved(filePath: string, location: Omit<Location, 'path'>, readOnlyReason?: EditorReadOnlyReason, settingsScope?: SettingsFileScope, acceptLarge = false): Promise<Document> {
    const key = this.identity({ path: filePath, ...location });
    const log = readOnlyReason === 'log';
    const existing = this.heldDocument(key, settingsScope, log);
    if (existing) return existing;
    return this.joined(`${key}\0${settingsScope ?? ''}${log ? '\0log' : ''}`, async () => {
      const read = await this.files(location.projectKey).read(filePath, readLimitOf(this.flavorOf(location).basename(filePath), acceptLarge));
      return this.documentOf({ path: filePath, ...location }, read, readOnlyReason, settingsScope);
    });
  }

  // The open document of the file with identity key, handed to one more open. A settings file opened by Edit settings.json is
  // a document of its own, so its saves keep the settings file rules. An offline placeholder is no open file: the open
  // replaces it. log: only a read-only log document, so Show Log never hands out a tab that saves to the log.
  private heldDocument(key: string, settingsScope: SettingsFileScope | undefined, log = false): Document | undefined {
    for (const existing of this.documents.values()) {
      if (existing.kind === 'offline') continue;
      if (log && !(existing.kind === 'text' && existing.readOnlyReason === 'log')) continue;
      const scope = existing.kind === 'text' ? existing.settingsScope : undefined;
      if (existing.location && existing.location.outside !== 'settings' && this.identity(existing.location) === key && scope === settingsScope && !(existing.kind === 'text' && existing.untitled)) {
        if (existing.kind === 'text') this.tabless.delete(existing);
        const handed = this.handedOut.get(existing);
        if (handed !== undefined) this.handedOut.set(existing, handed + 1);
        return existing;
      }
    }
    return undefined;
  }

  // textFileEditorModelManager.ts joinPendingResolves: a second open of a file still being read gets the same document.
  // The count reaches the document before any caller resumes, so a release decided in one caller's continuation sees the others.
  private joined(resolvingKey: string, resolve: () => Promise<Document>): Promise<Document> {
    const pending = this.resolving.get(resolvingKey);
    if (pending) {
      pending.callers++;
      return pending.read;
    }
    const entry = {
      callers: 1,
      read: resolve().then((document) => {
        this.resolving.delete(resolvingKey);
        this.handedOut.set(document, entry.callers);
        return document;
      }, (err: unknown) => {
        this.resolving.delete(resolvingKey);
        throw err;
      }),
    };
    this.resolving.set(resolvingKey, entry);
    return entry.read;
  }

  private documentOf(
    location: Location,
    read: FileBytes | { readonly kind: 'outside' },
    readOnlyReason: EditorReadOnlyReason | undefined,
    settingsScope: SettingsFileScope | undefined,
    name: string = this.flavorOf(location).basename(location.path),
    id: string = randomUUID(),
  ): Document {
    const filePath = location.path;
    // name may carry a host's title; the kind and language follow the file's own name
    const fileName = this.flavorOf(location).basename(filePath);
    const content = fileContentOf(fileName, read);
    let document: Document;
    if (content.kind === 'tooLarge') {
      document = { id, kind: 'notDisplayed', location, name, reason: 'tooLarge', bytes: content.bytes };
    } else if (content.kind === 'unreadable') {
      this.deps.log(`[documents] cannot read ${filePath}: ${content.error}`);
      document = { id, kind: 'notDisplayed', location, name, reason: 'unreadable' };
    } else if (content.kind === 'image') {
      document = { id, kind: 'image', location, name, dataUrl: `data:${content.mime};base64,${content.bytes.toString('base64')}`, bytes: content.bytes.length };
    } else if (content.kind === 'binary') {
      document = { id, kind: 'notDisplayed', location, name, reason: 'binary', bytes: content.bytes };
    } else {
      const { decoded, bytes } = content;
      const parsed = settingsScope === undefined && readOnlyReason === undefined && decoded.valid && isSearchEditorPath(fileName) ? parseSearchEditor(decoded.text) : undefined;
      // a text with no line break takes the line ending of its file's machine
      const eol = parsed ? '\n' : majorityEol(decoded.text, this.deps.authorityOs(this.authorityOf(location)));
      const text = parsed ? parsed.body : withEol(decoded.text, eol);
      document = {
        id,
        kind: 'text',
        location,
        name,
        languageId: settingsScope !== undefined || location.outside === 'settings' ? 'json' : parsed ? SEARCH_RESULT_LANGUAGE_ID : languageIdForName(fileName),
        encoding: decoded.encoding,
        bom: decoded.bom,
        eol,
        diskText: text,
        text,
        disk: bytes && read.kind === 'bytes' ? { exists: true, mtimeMs: read.mtimeMs, size: bytes.length, sha256: sha256(bytes) } : MISSING,
        version: 1,
        editSeq: 0,
        readOnlyReason: readOnlyReason ?? (decoded.valid ? undefined : 'encoding'),
        conflict: false,
        untitled: false,
        orphaned: false,
        saveFailed: false,
        ...((read.kind === 'bytes' || read.kind === 'missing') && read.sessionFile ? { sessionFile: true as const } : {}),
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
    this.documents.set(id, document);
    return document;
  }

  private watch(document: TextDocument): void {
    document.watcher?.dispose();
    const location = document.location;
    if (!location) return;
    const key = this.identity(location);
    const files = this.filesAt(location);
    document.watcher = files.watch(this.flavorOf(location).dirname(location.path), '*', (event: WatchEvent) => {
      if (this.identity({ ...location, path: event.path }) !== key) return;
      this.reloadLogged(document);
    });
    this.watchedOn.set(document, files);
  }

  private reloadLogged(document: TextDocument): void {
    const filePath = document.location?.path;
    this.reload(document, { force: false }).catch((err: unknown) => this.deps.log(`[documents] reloading ${filePath} failed: ${errorText(err)}`));
  }

  /**
   * A host connected or went away: each watched document whose host now serves a new connection is watched over it and read
   * again, each offline placeholder of a connected host opens its file, and each backup awaiting its host takes the file's
   * disk text as its baseline.
   */
  connectionsChanged(): void {
    for (const document of [...this.documents.values()]) {
      if (document.kind === 'offline') {
        if (this.connected(document.location)) this.openFromPlaceholder(document);
        continue;
      }
      if (document.kind === 'text' && document.awaitingHost && document.location) {
        if (this.connected(document.location)) this.adoptLogged(document);
        continue;
      }
      if (document.kind !== 'text' || !document.watcher || !document.location) continue;
      let files: WorkspaceFileSystem;
      try {
        files = this.filesAt(document.location);
      } catch (err) {
        if (err instanceof NotConnectedError) continue;
        throw err;
      }
      if (this.watchedOn.get(document) === files) continue;
      this.watch(document);
      // what changed while the host was away was never reported
      this.reloadLogged(document);
    }
  }

  /**
   * The host is usable again (a resume inside the grace or a fresh attach): each offline save of its files uploads when the
   * target still holds the disk state it was saved over, else its document turns into an upload conflict, reported together
   * with the others of this pass; every other open file of the host reads its disk again.
   */
  hostConnected(authority: string): void {
    const pending: TextDocument[] = [];
    for (const document of this.documents.values()) {
      const location = document.location;
      if (document.kind !== 'text' || !location || location.outside === 'settings' || document.awaitingHost || this.authorityOf(location) !== authority) continue;
      if (document.pendingUpload) pending.push(document);
      else if (document.watcher) this.reloadLogged(document);
    }
    if (pending.length === 0) return;
    void Promise.all(pending.map((document) => this.inTurn(document, () => this.upload(document)).catch((err: unknown) => {
      this.uploadFailed(document, errorText(err));
      return false;
    }))).then((conflicted) => {
      const documents = pending.filter((_document, index) => conflicted[index]);
      // each opens in a merge tab, which holds it from now on
      for (const document of documents) this.tabless.delete(document);
      if (documents.length > 0) this.deps.uploadsConflicted(authority, documents);
    });
  }

  // Resolves whether the target changed under the offline save: the buffer then holds the three-way merge's markers.
  private async upload(document: TextDocument): Promise<boolean> {
    const pending = document.pendingUpload;
    const location = document.location;
    if (!pending || !location || this.documents.get(document.id) !== document || !this.connected(location)) return false;
    let read: Awaited<ReturnType<DocumentService['readLocation']>>;
    try {
      read = await this.readLocation(location);
    } catch (err) {
      // gone again: the next connection uploads it
      if (err instanceof NotConnectedError) return false;
      throw err;
    }
    if (document.location !== location || document.pendingUpload !== pending) return false;
    const disk = read.kind === 'bytes' ? { exists: true, mtimeMs: read.mtimeMs, size: read.bytes.length, sha256: sha256(read.bytes) } : MISSING;
    if ((read.kind === 'bytes' || read.kind === 'missing') && sameDisk(disk, document.disk)) {
      const result = await this.write(document, location, document, pending.text);
      if (!result.ok) this.uploadFailed(document, result.message ?? result.reason);
      else if (this.tabless.has(document)) this.finishRelease(document);
      return false;
    }
    const decoded = read.kind === 'bytes' ? decodeDocument(read.bytes) : undefined;
    if (read.kind !== 'missing' && !decoded?.valid) {
      this.uploadFailed(document, this.deps.t('The file on {0} is no longer text the editor can merge.', this.deps.hostLabel(this.authorityOf(location)).name));
      return false;
    }
    const current = decoded ? withEol(decoded.text, document.eol) : '';
    const base = document.diskText;
    const incoming = document.text;
    delete document.pendingUpload;
    document.disk = disk;
    document.diskText = current;
    document.orphaned = read.kind === 'missing';
    if (incoming === current) {
      this.deps.backups.remove(document.backupId);
      this.emit(document.id, false);
      if (this.tabless.has(document)) this.finishRelease(document);
      return false;
    }
    document.uploadConflict = { base, current, incoming };
    const labels = uploadMergeLabels(this.deps.hostLabel(this.authorityOf(location)).name, this.deps.t);
    const merged = mergeWithMarkers(base, current, incoming, markerNames(labels), document.eol);
    if (merged === null) this.deps.log(`[documents] ${location.path} is too long to merge line by line; its Result starts as the editor's text`);
    else if (merged !== document.text) this.replaceText(document, merged);
    this.deps.backups.changed(document, true);
    this.emit(document.id, false);
    return true;
  }

  // The upload did not land: the tab shows a failed save instead of the pending glyph, the backup keeps the text, and the
  // user is told, since the save they made offline is not on the host.
  private uploadFailed(document: TextDocument, reason: string): void {
    const location = document.location;
    this.deps.log(`[documents] uploading ${location?.path} failed: ${reason}`);
    delete document.pendingUpload;
    document.saveFailed = true;
    this.deps.backups.changed(document, true);
    this.emit(document.id, false);
    const host = location ? this.deps.hostLabel(this.authorityOf(location)).name : '';
    this.deps.warn(this.deps.t('{0} was saved on this computer while {1} was away and could not be uploaded: {2}', visibleText(document.name), host, reason));
    if (this.tabless.delete(document)) this.deps.reopen(document);
  }

  // A pending upload whose last tab closed has landed: it leaves as a clean document's release does.
  private finishRelease(document: TextDocument): void {
    this.tabless.delete(document);
    if (this.documents.get(document.id) !== document || isDirty(document)) return;
    this.documents.delete(document.id);
    document.watcher?.dispose();
    this.deps.backups.remove(document.backupId);
  }

  /** The Result was saved: its merge inputs go. */
  endUploadConflict(id: string): void {
    const document = this.text(id);
    if (document) delete document.uploadConflict;
  }

  private connected(location: Pick<Location, 'projectKey' | 'host'>): boolean {
    try {
      this.filesAt(location);
      return true;
    } catch (err) {
      if (err instanceof NotConnectedError) return false;
      throw err;
    }
  }

  // The placeholder stays in the map, which its tabs read, until the file replaces it; a second connect meanwhile opens nothing.
  // A placeholder released meanwhile (its tabs closed) replaces nothing, and its file goes unless another open took it too.
  private openFromPlaceholder(placeholder: OfflineDocument): void {
    if (this.placeholderOpens.has(placeholder)) return;
    this.placeholderOpens.add(placeholder);
    this.reopen(placeholder.location, placeholder.acceptLarge === true).then((opened) => {
      this.placeholderOpens.delete(placeholder);
      if (this.documents.get(placeholder.id) !== placeholder) {
        if (opened && this.handedOut.get(opened) === 1) this.release(opened.id, false);
        return;
      }
      if (!opened) this.deps.log(`[documents] ${placeholder.location.path} no longer opens as it did before its host went away`);
      this.documents.delete(placeholder.id);
      this.replaced(placeholder.id, (opened ?? this.notDisplayedAt(placeholder)).id);
    }, (err: unknown) => {
      this.placeholderOpens.delete(placeholder);
      this.deps.log(`[documents] opening ${placeholder.location.path} once its host connected failed: ${errorText(err)}`);
      // the host went away again, or its server opens no file outside its projects: the placeholder waits for the next connect
      if (err instanceof NotConnectedError || err instanceof OutsideFilesUnsupportedError || this.documents.get(placeholder.id) !== placeholder) return;
      this.documents.delete(placeholder.id);
      this.replaced(placeholder.id, this.notDisplayedAt(placeholder).id);
    });
  }

  // A placeholder's file, opened by the rule it was opened with before the relaunch; undefined when that rule refuses it now.
  private async reopen(location: Location, acceptLarge: boolean): Promise<Document | undefined> {
    if (location.outside === 'path' && location.host !== undefined) return this.openResolvedPath(location.host, location.path, { acceptLarge });
    if (location.projectKey === undefined || location.relativePath === undefined) throw new Error(`${location.path} names no rule to open it by`);
    const opened = await this.openProjectFile(location.projectKey, location.relativePath, { acceptLarge });
    return opened.ok ? opened.document : undefined;
  }

  private replaced(from: string, to: string): void {
    for (const listener of [...this.replacements]) listener({ from, to });
  }

  private notDisplayedAt(placeholder: OfflineDocument): NotDisplayedDocument {
    const document: NotDisplayedDocument = { id: randomUUID(), kind: 'notDisplayed', location: placeholder.location, name: placeholder.name, reason: 'unreadable' };
    this.documents.set(document.id, document);
    return document;
  }

  private adoptLogged(document: TextDocument): void {
    this.adoptDisk(document).catch((err: unknown) => this.deps.log(`[documents] reading ${document.location?.relativePath} once its host connected failed: ${errorText(err)}`));
  }

  // A backup restored while its host was away: the file, now confined on the host, gives its disk text as the baseline and the
  // buffer keeps the backup's text, as a backup restored into an open file does; a file that is gone leaves it orphaned. A file
  // the restore path would refuse (outside its project, its project folder gone, an image, binary, too large, not valid UTF-8) leaves the
  // text in an untitled buffer, as it does. A file the host fails to confine or read keeps the document awaiting.
  private async adoptDisk(document: TextDocument): Promise<void> {
    const location = document.location;
    const project = this.deps.projects().find((candidate) => candidate.key === location?.projectKey);
    if (!location || !project || location.relativePath === undefined || !document.awaitingHost) return;
    const files = this.files(project.key);
    const confined = await files.confineExisting(project, location.relativePath);
    if (!document.awaitingHost || this.documents.get(document.id) !== document) return;
    if (!confined.ok) {
      const missing = confined.reason === 'missing' ? await files.confineMissing(project, location.relativePath) : confined;
      if (!document.awaitingHost || this.documents.get(document.id) !== document) return;
      if (missing.ok) this.adoptMissing(document, missing.path);
      else if (missing.reason === 'outside') this.keepAsUntitled(document, this.deps.t('It is now outside its project.'));
      else if (missing.reason === 'missing') this.keepAsUntitled(document, this.deps.t('Its project folder is missing.'));
      else this.hostReadFailed(document, 'its path could not be resolved');
      return;
    }
    const name = this.flavorOf(location).basename(confined.path);
    const read = await files.read(confined.path, readLimitOf(name, true));
    if (!document.awaitingHost || this.documents.get(document.id) !== document) return;
    if (read.kind === 'missing' || read.kind === 'unreadable') {
      if (read.kind === 'missing') this.adoptMissing(document, confined.path);
      else this.hostReadFailed(document, read.error);
      return;
    }
    const content = fileContentOf(name, read);
    if (read.kind !== 'bytes' || content.kind !== 'text' || !content.decoded.valid) {
      this.keepAsUntitled(document, this.deps.t('The editor cannot change it as it is on disk now.'));
      return;
    }
    const { decoded } = content;
    delete document.awaitingHost;
    delete document.hostReadFailed;
    document.location = { ...location, path: confined.path };
    if (read.sessionFile) document.sessionFile = true;
    document.disk = { exists: true, mtimeMs: read.mtimeMs, size: read.bytes.length, sha256: sha256(read.bytes) };
    document.diskText = document.searchEditor ? parseSearchEditor(decoded.text).body : withEol(decoded.text, document.eol);
    document.encoding = decoded.encoding;
    document.bom = decoded.bom;
    if (!isDirty(document)) this.deps.backups.remove(document.backupId);
    this.watch(document);
    this.emit(document.id, false);
  }

  private adoptMissing(document: TextDocument, filePath: string): void {
    delete document.awaitingHost;
    delete document.hostReadFailed;
    document.location = { ...document.location!, path: filePath };
    document.orphaned = true;
    this.watch(document);
    this.emit(document.id, false);
  }

  // The document keeps awaiting, so a save is still refused; the user is told once, and a save or a connection change retries.
  private hostReadFailed(document: TextDocument, reason: string): void {
    this.deps.log(`[documents] ${document.location?.path} could not be read on its host (${reason}); the buffer keeps its text`);
    if (document.hostReadFailed) return;
    document.hostReadFailed = true;
    const host = this.deps.hostLabel(this.authorityOf(document.location!)).name;
    this.deps.warn(this.deps.t('{0} could not be read on {1}, so its unsaved changes stay in the editor. Saving it tries again.', visibleText(document.name), host));
  }

  // The awaiting document's text and backup move to an untitled buffer, which its tabs show (onDidReplace), and the user is told why.
  private keepAsUntitled(document: TextDocument, reason: string): void {
    const text = savedText(document);
    const untitled = this.openMemory(document.name, text, { untitled: true, languageId: document.languageId });
    this.restoreBuffer(untitled.id, text, document.backupId);
    this.documents.delete(document.id);
    document.watcher?.dispose();
    this.deps.log(`[documents] ${document.location?.path} cannot take its backup once its host connected: ${reason}`);
    this.deps.warn(this.deps.t('The unsaved changes to {0} are in an untitled editor: {1}', visibleText(document.name), reason));
    this.replaced(document.id, untitled.id);
  }

  // The watcher path (agent writes, checkpoint restores, git checkout, any editor): a clean buffer takes the disk text,
  // a dirty one is flagged; force (Revert) takes the disk text either way. A document moved meanwhile ignores the read.
  // Resolves whether the buffer took the disk text, or for Revert of a missing file kept its own as clean.
  private async reload(document: TextDocument, opts: { readonly force: boolean }): Promise<boolean> {
    const location = document.location;
    // the upload decides what a text saved offline meets on the target
    if (!location || this.documents.get(document.id) !== document || (document.pendingUpload && !opts.force)) return false;
    const read = await this.readLocation(location);
    if (document.location !== location) return false;
    if (read.kind === 'outside') {
      this.deps.log(`[documents] ${location.path} now resolves outside the file the editor opened; the buffer keeps its text`);
      return false;
    }
    if (read.kind === 'tooLarge' || read.kind === 'notAFile' || read.kind === 'unreadable') {
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
    // a pending upload's backup is the only copy of the text saved offline
    if (dirty || this.writing.has(document) || document.pendingUpload) this.deps.backups.changed(document);
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
  // buffer: the text written, the buffer unless an upload writes the text saved offline.
  private async write(document: TextDocument, location: Location, format: { readonly encoding: TextEncoding; readonly bom: boolean }, buffer: string = document.text): Promise<EditorSaveResult> {
    const unparsed = location.outside === 'settings' ? settingsParseError(savedText(document), location.path) : undefined;
    if (unparsed !== undefined) return { ok: false, reason: 'failed', message: this.deps.t('Not saved: the text is not valid JSON. {0}', unparsed) };
    if (isDirty(document)) await this.deps.backups.writeNow(document);
    const header = document.searchEditor ? serializeSearchConfiguration(document.searchEditor.config) : undefined;
    const text = document.searchEditor ? buffer : withEol(buffer, document.eol);
    const bytes = encodeDocument(document.searchEditor ? serializeSearchEditor(document.searchEditor.config, buffer) : text, format.encoding, format.bom);
    let written: number | EditorSaveResult;
    this.writing.add(document);
    try {
      // a Save As names a new location, which the workspace refuses when it is a session file
      written = location === document.location && document.sessionFile ? await this.writeSessionFile(document, location, bytes) : await this.writeConfined(location, bytes);
    } catch (err) {
      this.writing.delete(document);
      document.saveFailed = true;
      if (isDirty(document)) this.deps.backups.changed(document, true);
      this.emit(document.id, false);
      this.deps.log(`[documents] saving ${location.path} failed: ${errorText(err)}`);
      return { ok: false, reason: 'failed', message: this.saveFailure(location, this.writeFailureReason(err)) };
    }
    this.writing.delete(document);
    // refused before any byte was written, so the file is whole and the buffer stays dirty as it was
    if (typeof written !== 'number') return written;
    const mtimeMs = written;
    const unchanged = document.text === buffer && (!document.searchEditor || serializeSearchConfiguration(document.searchEditor.config) === header);
    if (location !== document.location) delete document.sessionFile;
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
    delete document.pendingUpload;
    if (document.searchEditor && unchanged) document.searchEditor.dirty = false;
    if (isDirty(document)) this.deps.backups.changed(document);
    else this.deps.backups.remove(document.backupId);
    this.emit(document.id, false);
    for (const listener of [...this.saveListeners]) listener(location);
    return { ok: true };
  }

  // A session file, of a project or outside every one, is written by its machine's engine alone, under the file's lease or its
  // run's ownership and only while its bytes are the ones last read. Resolves the written file's mtime, or the refusal.
  private async writeSessionFile(document: TextDocument, location: Location, bytes: Buffer): Promise<number | EditorSaveResult> {
    const authority = this.authorityOf(location);
    let written: SessionFileWrite;
    try {
      written = await this.deps.sessionFiles.write(authority, location.path, bytes, document.disk.exists ? document.disk.sha256 : null);
    } catch (err) {
      if (!(err instanceof EngineUnavailableError)) throw err;
      this.deps.log(`[documents] not saving ${location.path}: ${err.message}`);
      return { ok: false, reason: 'failed', message: this.saveFailure(location, this.engineAbsenceReason(err.absence, authority)) };
    }
    switch (written.kind) {
      case 'written': return written.mtimeMs;
      case 'changed': return this.refuseConflict(document);
      case 'outside': return { ok: false, reason: 'failed', message: this.saveFailure(location, this.refusalReason('outsideFile')) };
      case 'refused': return { ok: false, reason: 'failed', message: this.saveFailure(location, this.sessionFileRefusalReason(written.reason)) };
    }
  }

  private sessionFileRefusalReason(reason: SessionFileRefusal): string {
    return reason === 'held'
      ? this.deps.t('A chat, an agent run, or a rename, tag or delete of its conversation is using this session file. Wait for it to finish or close the chat, then save again.')
      : this.deps.t('Another Damocles window is using this session file. Close the chat there, then save again.');
  }

  private engineAbsenceReason(absence: EngineAbsence, authority: string): string {
    const host = this.deps.hostLabel(authority).name;
    switch (absence) {
      case 'stopped': return authority === 'local'
        ? this.deps.t('Saving this file needs this computer\'s Damocles engine, which is not running. Restart the engine, then save again.')
        : this.deps.t('Saving this file needs {0}\'s Damocles engine, which is not running. Restart the engine, then save again.', host);
      case 'notConnected': return this.deps.t('{0} is not connected.', host);
      case 'unsupported': return this.deps.t('The Damocles server on {0} is older than this app and cannot save this file.', host);
    }
  }

  // The in-place write of the workspace that holds the file (WorkspaceFileSystem.writeInPlace), only while the document's
  // project is still listed; every write names one, a host's own settings file, or a file outside every project while its
  // path still resolves to itself on its machine. Resolves the written file's mtime.
  private async writeConfined(location: Location, bytes: Buffer): Promise<number> {
    if (location.outside === 'settings') return this.filesAt(location).writeHostSettings(bytes);
    if (location.outside === 'path') return this.filesAt(location).writeOutside(location.path, bytes);
    if (location.projectKey === undefined || location.relativePath === undefined) throw new WriteRefused(`${location.path} is outside every project`, this.deps.t('Its path now leads outside the project.'));
    const project = this.deps.projects().find((candidate) => candidate.key === location.projectKey);
    if (!project) throw new WriteRefused(`${location.path}: its project is no longer in the project list`, this.deps.t('The project is no longer in the project list.'));
    return this.files(project.key).writeInPlace(project, { path: location.path, projectKey: location.projectKey, relativePath: location.relativePath }, bytes);
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
      return { ok: false, reason: 'failed', message: result.cause === undefined ? this.deps.render(result.error) : this.saveFailure(document.location!, this.errnoReason(errnoCode(result.cause))) };
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
      return { ok: true, version: settingsFileVersion(await this.deps.workspaces.local.files.readText(document.location!.path)) };
    } catch (err) {
      this.deps.log(`[documents] cannot read ${document.location!.path} before overwriting it: ${errorText(err)}`);
      return { ok: false, reason: 'failed', message: this.saveFailure(document.location!, this.errnoReason(errnoCode(err))) };
    }
  }

  // Bounded by the bytes the write produces, byte order mark included, as readFileBytes counts them, before anything is encoded.
  private oversize(text: string, format: { readonly encoding: TextEncoding; readonly bom: boolean }): string | undefined {
    const bytes = encodedLength(text, format.encoding, format.bom);
    if (bytes <= EDITOR_HARD_MAX_DOCUMENT_BYTES) return undefined;
    return this.deps.t('The text is {0} bytes, over the {1}-byte limit, so it was not saved.', bytes, EDITOR_HARD_MAX_DOCUMENT_BYTES);
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

  // A file that cannot be read now (grown past the limit, locked, replaced by a folder) fails the save with the reason, and so
  // does a host's settings file that does not parse, as saveSettingsFileText never overwrites one.
  private async readDiskState(location: Location): Promise<{ readonly ok: true; readonly disk: DiskState } | { readonly ok: false; readonly reason: 'failed'; readonly message: string }> {
    let read: Awaited<ReturnType<DocumentService['readLocation']>>;
    try {
      read = await this.readLocation(location);
    } catch (err) {
      // only a host's workspace rejects a read: not connected, or the connection ended during it
      this.deps.log(`[documents] cannot read ${location.path} before saving it: ${errorText(err)}`);
      return { ok: false, reason: 'failed', message: this.saveFailure(location, this.writeFailureReason(err)) };
    }
    if (read.kind === 'missing') return { ok: true, disk: MISSING };
    const unparsed = read.kind === 'bytes' && location.outside === 'settings' ? settingsParseError(read.bytes.toString('utf8'), location.path) : undefined;
    if (unparsed !== undefined) return { ok: false, reason: 'failed', message: this.deps.t('{0} does not parse, so it was not overwritten: {1}', location.path, unparsed) };
    if (read.kind === 'bytes') return { ok: true, disk: { exists: true, mtimeMs: read.mtimeMs, size: read.bytes.length, sha256: sha256(read.bytes) } };
    this.deps.log(`[documents] cannot read ${location.path} before saving it: ${read.kind === 'unreadable' ? read.error : read.kind === 'notAFile' ? 'it is not a file' : read.kind}`);
    const reason = read.kind === 'tooLarge'
      ? this.deps.t('The file on disk is too large for the editor.')
      : read.kind === 'outside' ? this.deps.t('Its path now leads outside the file the editor opened.')
        : read.kind === 'notAFile' ? this.notAFileReason(read.folder) : this.errnoReason(read.code);
    return { ok: false, reason: 'failed', message: this.saveFailure(location, reason) };
  }

  // VS Code's genericSaveError (textFileSaveErrorHandler.ts): the file's base name and a reason; the raw error and path go
  // only to the log.
  private saveFailure(location: Location, reason: string): string {
    return this.deps.t('Failed to save \'{0}\': {1}', visibleText(this.flavorOf(location).basename(location.path)), reason);
  }

  private writeFailureReason(err: unknown): string {
    if (err instanceof WriteRefused) return err.reason;
    if (err instanceof NotConnectedError) return err.message;
    if (err instanceof LocalizedError) return this.deps.render(err.text);
    return err instanceof WriteRefusedError ? this.refusalReason(err.refusal) : this.errnoReason(errnoCode(err));
  }

  private refusalReason(refusal: WriteRefusal): string {
    const t = this.deps.t;
    switch (refusal) {
      case 'outsideProject': return t('Its path now leads outside the project.');
      case 'outsideFile': return t('Its path now leads outside the file the editor opened.');
      case 'replaced': return t('The file was replaced while it was being saved.');
      case 'notAFile': return t('The path is not a file.');
      case 'diskFull': return t('The disk stopped accepting data.');
      case 'sessionFile': return t('It is a Damocles session file, which only the Damocles engine that owns it saves.');
    }
  }

  private notAFileReason(folder: boolean): string {
    return folder ? this.deps.t('The path is a folder.') : this.deps.t('The path is not a file.');
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
  // file outside every project reads only while its path is still its own realpath on its machine; the plain read is left
  // for Damocles' own log and settings file.
  private async readLocation(location: Location): Promise<FileBytes | { readonly kind: 'outside' }> {
    if (location.outside === 'settings') {
      const { path: filePath, read } = await this.filesAt(location).readHostSettings();
      return this.identity({ ...location, path: filePath }) === this.identity(location) ? read : { kind: 'outside' };
    }
    const limitBytes = readLimitOf(this.flavorOf(location).basename(location.path), true);
    if (location.outside === 'path') return this.filesAt(location).readOutside(location.path, limitBytes);
    if (location.projectKey !== undefined && location.relativePath !== undefined) {
      const project = this.deps.projects().find((candidate) => candidate.key === location.projectKey);
      if (!project) return { kind: 'outside' };
      const confined = await this.files(project.key).confineExisting(project, location.relativePath);
      if (!confined.ok) {
        if (confined.reason === 'missing') return { kind: 'missing' };
        return confined.reason === 'failed' ? { kind: 'unreadable', error: `${location.path} cannot be read` } : { kind: 'outside' };
      }
      if (this.identity({ ...location, path: confined.path }) !== this.identity(location)) return { kind: 'outside' };
    }
    return this.files(location.projectKey).read(location.path, limitBytes);
  }

  // The files of the workspace holding a project; this computer's for a path outside every project.
  private files(projectKey: string | undefined): WorkspaceFileSystem {
    return projectKey === undefined ? this.deps.workspaces.local.files : this.deps.workspaces.forProject(projectKey).files;
  }

  private filesAt(location: Pick<Location, 'projectKey' | 'host'>): WorkspaceFileSystem {
    return location.host !== undefined ? this.deps.workspaces.forAuthority(location.host).files : this.files(location.projectKey);
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

/** The upload merge's sides: Current is the target's, Incoming the text saved on this computer; each marker names its detail, the base its title. */
export function uploadMergeLabels(hostName: string, t: (message: string, ...args: Array<string | number>) => string): ScmMergeLabels {
  const saved = t('Saved on this computer');
  const base = t('Base');
  return { current: { title: t('Current'), detail: hostName, marker: hostName }, incoming: { title: t('Incoming'), detail: saved, marker: saved }, base: { title: base, marker: base } };
}

// The content decides: a touch that keeps the bytes is no change, and a rewrite with the same mtime is one.
function sameDisk(a: DiskState, b: DiskState): boolean {
  return a.exists === b.exists && a.sha256 === b.sha256;
}
