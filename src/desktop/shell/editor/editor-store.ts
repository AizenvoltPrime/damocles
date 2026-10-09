import { computed, nextTick, shallowRef, triggerRef, type InjectionKey } from 'vue';
import type { editor as MonacoEditor, Uri } from 'monaco-editor/editor/editor.api';
import {
  EDITOR_EDIT_THROTTLE_MS,
  EDITOR_FORMAT_TIMEOUT_MS,
  MAX_FORMAT_ERROR_CHARS,
  type DamoclesShellApi,
  type EditorCommand,
  type EditorDocumentChange,
  type EditorFlushRequest,
  type EditorFormatReason,
  type EditorFormatReply,
  type EditorSaveResult,
  type EditorSelectionRange,
  type SearchQuery,
  type SearchRange,
  type ShellDocumentContent,
  type ShellEditorState,
  type ShellEditorTab,
} from '../../preload/shell-channels';
import { replaceRegExp, replacementAt } from '../../../shared/text-search';
import { shellI18n } from '../i18n';
import type { FormatEdit } from './format-edits';

export type ShellMonacoModule = typeof import('./monaco');
type TextContent = Extract<ShellDocumentContent, { kind: 'text' }>;

// VS Code's files.autoSaveDelay default.
export const AUTO_SAVE_DELAY_MS = 1000;
// The Formatting… indicator shows only for a format that takes longer, so a fast one never flickers it.
export const FORMATTING_INDICATOR_DELAY_MS = 300;
export interface BufferReplaceTarget {
  readonly range: SearchRange;
  // the decoration tracking the range since the search, when the buffer was open then
  readonly decorationId?: string;
  // the text the search recorded at an untracked range, which must still be there
  readonly text?: string;
}

export type BufferReplaceResult = { readonly ok: true; readonly replaced: number } | { readonly ok: false; readonly reason: 'changed' | 'unsupportedRegex' | 'readOnly' };

interface TextBuffer {
  model: MonacoEditor.ITextModel;
  // main's content version, bumped only when main replaces the text (reload, log growth, revert); echoed on every edit and save
  version: number;
  // the seq of the last edit sent; main echoes the last one it applied as the content's editSeq
  seq: number;
  throttle: ReturnType<typeof setTimeout> | undefined;
  lastSent: number;
  autoSave: ReturnType<typeof setTimeout> | undefined;
  // the version and seq of the text the last successful save sent
  saved: { readonly version: number; readonly seq: number } | undefined;
}

type SaveRun = () => Promise<EditorSaveResult | undefined>;

/**
 * The editor pane's state: main's tab list and settings, rendered as they come (main owns tabs, dirty and conflict), plus
 * the Monaco model of each open text document, which holds the unsaved text and reports it to main.
 */
export function createEditorStore(api: DamoclesShellApi, loadMonaco: () => Promise<ShellMonacoModule> = () => import('./monaco')) {
  const state = shallowRef<ShellEditorState | null>(null);
  const contents = shallowRef(new Map<string, ShellDocumentContent>());
  const loading = new Map<string, Promise<ShellDocumentContent>>();
  const buffers = new Map<string, TextBuffer>();
  const creating = new Map<string, Promise<MonacoEditor.ITextModel>>();
  // a tab the user opened, which its editor focuses once it shows; the counter repeats a request for the same tab
  const focusRequest = shallowRef<{ tabId: string; serial: number } | null>(null);
  const saveError = shallowRef<{ tabId: string; message: string } | null>(null);
  // a line main asked to show (Quick Open's :line, a tool card's line, a settings key), or a search match the shell selects;
  // it moves the caret, never focus
  const revealRequest = shallowRef<{ tabId: string; line: number; selections?: readonly SearchRange[]; serial: number } | null>(null);
  // each text document's latest selection in its editor, for Find in Files' seed
  const selections = new Map<string, EditorSelectionRange | null>();
  const carets = new Map<string, { line: number; column: number }>();
  // a Search Editor body's match ranges from main's last run, valid while the body is at that content version
  const searchHighlights = shallowRef(new Map<string, { version: number; ranges: readonly SearchRange[] }>());
  // the decorations tracking search matches per document, so a later replace uses the ranges as the user edited around them
  const searchDecorations = new Map<string, Set<string>>();
  // AD1 focus overlay: the editor covers the window and main hides the chat view meanwhile
  const focusOverlay = shallowRef(false);
  // documents whose format has run past FORMATTING_INDICATOR_DELAY_MS, which their editor marks
  const formatting = shallowRef<ReadonlySet<string>>(new Set());
  let focusSerial = 0;
  let applyingRemote = false;
  let monacoModule: Promise<ShellMonacoModule> | undefined;
  // set once the first model exists, so a model moves within the state push that renamed its document
  let loadedModule: ShellMonacoModule | undefined;
  // VS Code's TaskSequentializer per document (src/vs/base/common/async.ts:1694, as textFileEditorModel.ts:809 queues a
  // save): one save runs at a time, and every save asked for meanwhile joins the one queued save, which runs the latest ask
  const runningSaves = new Map<string, Promise<EditorSaveResult | undefined>>();
  const queuedSaves = new Map<string, { run: SaveRun; readonly promise: Promise<EditorSaveResult | undefined>; readonly settle: (result: Promise<EditorSaveResult | undefined>) => void }>();
  const modelReplacedListeners = new Set<(documentId: string, previous: MonacoEditor.ITextModel, next: MonacoEditor.ITextModel) => void>();
  // Bumped whenever a document's model is created, moved or disposed, so bufferModel's readers follow it.
  const modelRevision = shallowRef(0);
  // Each tab's editor view state (caret, selections, scroll, folding) while the tab is open, as VS Code's editor memento keeps
  // one per editor input (editorWithViewState.ts updateEditorViewState on clearInput; EditorMemento in editorPane.ts).
  const viewStates = new Map<string, MonacoEditor.IEditorViewState>();

  const tabs = computed<readonly ShellEditorTab[]>(() => state.value?.tabs ?? []);
  const activeTab = computed(() => tabs.value.find((tab) => tab.id === state.value?.activeTabId) ?? null);
  const settings = computed(() => state.value?.settings);

  const monaco = (): Promise<ShellMonacoModule> => (monacoModule ??= loadMonaco());

  function documentIdsOf(tab: ShellEditorTab): string[] {
    if (tab.diff) return [tab.diff.originalId, tab.diff.modifiedId];
    return tab.documentId === undefined ? [] : [tab.documentId];
  }

  // The document a tab saves, formats and resolves conflicts of: its own, or an editable diff's modified side.
  function editedDocumentOf(tab: ShellEditorTab): string | undefined {
    return tab.documentId ?? (tab.diff && !tab.readOnly ? tab.diff.modifiedId : undefined);
  }

  function setContent(content: ShellDocumentContent): void {
    contents.value.set(content.documentId, content);
    triggerRef(contents);
  }

  /** The document's content, fetched once; later changes arrive as document-changed. */
  function load(documentId: string): Promise<ShellDocumentContent> {
    const known = contents.value.get(documentId);
    if (known) return Promise.resolve(known);
    let pending = loading.get(documentId);
    if (!pending) {
      pending = api.getDocument(documentId).then((content) => {
        loading.delete(documentId);
        setContent(content);
        return content;
      });
      loading.set(documentId, pending);
    }
    return pending;
  }

  /** The text document's Monaco model, shared by every tab that shows it. */
  function model(documentId: string): Promise<MonacoEditor.ITextModel> {
    const buffer = buffers.get(documentId);
    if (buffer) return Promise.resolve(buffer.model);
    let pending = creating.get(documentId);
    if (!pending) {
      pending = Promise.all([load(documentId), monaco()]).then(([content, module]) => {
        creating.delete(documentId);
        if (content.kind !== 'text') throw new Error(`document ${documentId} is not text`);
        return createModel(module, content);
      });
      creating.set(documentId, pending);
    }
    return pending;
  }

  // A document's model lives at the URI of what it is now: a settings file's schema URI, else the document's id with its file's
  // path (or its name), so the language services and every URI-keyed lookup see the file's current name.
  function modelUri(module: ShellMonacoModule, documentId: string): Uri {
    const monacoApi = module.useMonaco();
    const settingsScope = tabs.value.find((candidate) => candidate.kind === 'settings' && candidate.documentId === documentId)?.settingsScope;
    if (settingsScope) return monacoApi.Uri.parse(module.settingsModelUri(settingsScope, documentId));
    const document = state.value?.documents[documentId];
    const path = document?.path !== undefined ? monacoApi.Uri.file(document.path).path : `/${document?.name ?? 'untitled'}`;
    return monacoApi.Uri.from({ scheme: 'damocles-document', authority: documentId, path });
  }

  function createModel(module: ShellMonacoModule, content: TextContent): MonacoEditor.ITextModel {
    loadedModule = module;
    const monacoApi = module.useMonaco();
    const created = monacoApi.editor.createModel(content.text, content.languageId, modelUri(module, content.documentId));
    created.setEOL(content.eol === '\r\n' ? monacoApi.editor.EndOfLineSequence.CRLF : monacoApi.editor.EndOfLineSequence.LF);
    applyIndentation(created);
    const buffer: TextBuffer = { model: created, version: content.version, seq: content.editSeq, throttle: undefined, lastSent: 0, autoSave: undefined, saved: undefined };
    buffers.set(content.documentId, buffer);
    listenForEdits(content.documentId, buffer);
    modelRevision.value++;
    return created;
  }

  function listenForEdits(documentId: string, buffer: TextBuffer): void {
    const own = buffer.model;
    own.onDidChangeContent(() => {
      if (!applyingRemote && buffer.model === own) onLocalEdit(documentId, buffer);
    });
  }

  /**
   * A rename or Save As moved the document: its model is replaced by one at the new URI holding the same text, EOL and
   * indentation, as VS Code resolves the target model with the source's contents (textFileEditorModelManager.ts
   * onDidRunWorkingCopyFileOperation). Undo starts afresh there, as VS Code's undo stack is kept per URI. The editors showing
   * the old model take the new one, keeping their view state, before the old one is disposed.
   */
  function moveModel(module: ShellMonacoModule, documentId: string, buffer: TextBuffer, uri: Uri, languageId: string): void {
    const monacoApi = module.useMonaco();
    const previous = buffer.model;
    const moved = monacoApi.editor.createModel(previous.getValue(), languageId, uri);
    moved.setEOL(previous.getEndOfLineSequence());
    const { tabSize, indentSize, insertSpaces } = previous.getOptions();
    moved.updateOptions({ tabSize, indentSize, insertSpaces });
    buffer.model = moved;
    listenForEdits(documentId, buffer);
    // Decorations belong to a model; a later replace finds the tracked range gone and reports the match changed.
    searchDecorations.delete(documentId);
    for (const listener of [...modelReplacedListeners]) listener(documentId, previous, moved);
    previous.dispose();
    modelRevision.value++;
  }

  /** The document's model while it has one, reactively: its text holds the unsaved edits main has not been told of yet. */
  function bufferModel(documentId: string): MonacoEditor.ITextModel | undefined {
    void modelRevision.value;
    return buffers.get(documentId)?.model;
  }

  function rememberViewState(tabId: string, viewState: MonacoEditor.IEditorViewState | null): void {
    if (viewState) viewStates.set(tabId, viewState);
  }

  function viewStateOf(tabId: string): MonacoEditor.IEditorViewState | undefined {
    return viewStates.get(tabId);
  }

  /** Fires when a document's model is replaced (moveModel); every editor showing previous must show next. */
  function onDidReplaceModel(listener: (documentId: string, previous: MonacoEditor.ITextModel, next: MonacoEditor.ITextModel) => void): () => void {
    modelReplacedListeners.add(listener);
    return () => modelReplacedListeners.delete(listener);
  }

  function applyIndentation(target: MonacoEditor.ITextModel): void {
    const current = settings.value;
    if (!current) return;
    target.updateOptions({ tabSize: current.tabSize, indentSize: current.tabSize });
    if (current.detectIndentation) target.detectIndentation(true, current.tabSize);
  }

  function sendEdit(documentId: string, buffer: TextBuffer, overReload = false): void {
    clearTimeout(buffer.throttle);
    buffer.throttle = undefined;
    buffer.lastSent = Date.now();
    api.reportEdit({ documentId, version: buffer.version, seq: ++buffer.seq, text: buffer.model.getValue(), overReload });
  }

  // Leading and trailing: the first keystroke after a pause tells main at once that the buffer is dirty, so main never
  // reloads it as clean; later ones go at most once per EDITOR_EDIT_THROTTLE_MS.
  function onLocalEdit(documentId: string, buffer: TextBuffer): void {
    const wait = buffer.lastSent + EDITOR_EDIT_THROTTLE_MS - Date.now();
    if (wait <= 0 && buffer.throttle === undefined) sendEdit(documentId, buffer);
    else buffer.throttle ??= setTimeout(() => sendEdit(documentId, buffer), Math.max(0, wait));
    scheduleAutoSave(documentId, buffer);
  }

  function scheduleAutoSave(documentId: string, buffer: TextBuffer): void {
    clearTimeout(buffer.autoSave);
    buffer.autoSave = undefined;
    if (settings.value?.autoSave !== 'afterDelay') return;
    buffer.autoSave = setTimeout(() => {
      buffer.autoSave = undefined;
      const tab = tabs.value.find((candidate) => editedDocumentOf(candidate) === documentId && autoSaves(candidate));
      // Auto save after a delay never formats, as VS Code's SaveReason.AUTO does not: it would rewrite the text under the caret.
      if (tab) void save(tab, { format: false });
    }, AUTO_SAVE_DELAY_MS);
  }

  // Auto save never saves an untitled buffer or Search Editor (that asks for a path), a read-only one or one in conflict.
  const autoSaves = (tab: ShellEditorTab): boolean => tab.dirty && !tab.readOnly && !tab.conflict && tab.kind !== 'untitled' && tab.searchEditor?.untitled !== true;

  /** Sends the document's unsent edit now, so main holds the buffer before a save, a conflict action or quit. */
  function flush(documentId: string): void {
    const buffer = buffers.get(documentId);
    if (buffer?.throttle !== undefined) sendEdit(documentId, buffer);
  }

  function flushAll(): void {
    for (const documentId of buffers.keys()) flush(documentId);
  }

  function applyChange({ documentId, content }: EditorDocumentChange): void {
    const buffer = buffers.get(documentId);
    if (!buffer || content.kind !== 'text') {
      setContent(content);
      return;
    }
    const current = buffer.model.getValue();
    const unseen = buffer.throttle !== undefined || buffer.seq > content.editSeq;
    buffer.version = content.version;
    setContent(content);
    if (unseen) {
      // Keystrokes main had not seen when it replaced the text stay in the buffer; main keeps them and flags the conflict.
      sendEdit(documentId, buffer, true);
      return;
    }
    if (current === content.text) return;
    applyingRemote = true;
    try {
      // A grown log only appends; any other change replaces the text as one undoable edit that keeps the view in place.
      const appended = content.text.startsWith(current) ? content.text.slice(current.length) : null;
      const end = buffer.model.getFullModelRange();
      const range = appended === null ? end : { startLineNumber: end.endLineNumber, startColumn: end.endColumn, endLineNumber: end.endLineNumber, endColumn: end.endColumn };
      buffer.model.pushEditOperations([], [{ range, text: appended ?? content.text }], () => null);
    } finally {
      applyingRemote = false;
    }
  }

  function setFormatting(documentId: string, on: boolean): void {
    if (formatting.value.has(documentId) === on) return;
    const next = new Set(formatting.value);
    if (on) next.add(documentId);
    else next.delete(documentId);
    formatting.value = next;
  }

  // The built-in formatter's edits within the budget; a failure or a timeout is main's to log and tell, and formats nothing.
  async function builtinWithin(documentId: string, target: MonacoEditor.ITextModel, options: { tabSize: number; insertSpaces: boolean }, reason: EditorFormatReason): Promise<FormatEdit[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), EDITOR_FORMAT_TIMEOUT_MS)));
    try {
      const edits = await Promise.race([monaco().then((module) => module.builtinEdits(module.builtinWorkers, target, options)), timeout]);
      if (edits !== 'timeout') return edits;
      api.reportFormatFailure({ documentId, reason, timedOut: true, message: '' });
    } catch (err) {
      api.reportFormatFailure({ documentId, reason, timedOut: false, message: (err instanceof Error ? err.message : String(err)).slice(0, MAX_FORMAT_ERROR_CHARS) });
    } finally {
      clearTimeout(timer);
    }
    return [];
  }

  /**
   * Formats the buffer through main (D29) and applies the result as one undoable edit. A keystroke, reload or revert while
   * the formatter ran makes the result stale, and it is dropped, as VS Code drops a format whose model changed: the edit
   * sequence (seq), main's content version and an unsent edit are what tell.
   */
  async function format(documentId: string, reason: EditorFormatReason): Promise<void> {
    const target = await model(documentId);
    const buffer = buffers.get(documentId);
    if (!buffer || buffer.model !== target || target.isDisposed()) return;
    flush(documentId);
    const { seq, version } = buffer;
    const text = target.getValue();
    const { tabSize, insertSpaces } = target.getOptions();
    const indicator = setTimeout(() => setFormatting(documentId, true), FORMATTING_INDICATOR_DELAY_MS);
    try {
      // Main logs a handler that throws before the rejection arrives here; the save goes on unformatted.
      const reply = await api.formatDocument({ documentId, text, options: { tabSize, insertSpaces }, reason }).catch((): EditorFormatReply => ({ kind: 'failed' }));
      const edits = reply.kind === 'formatted' ? (await monaco()).lineEdits(text, reply.text) : reply.kind === 'builtin' ? await builtinWithin(documentId, target, { tabSize, insertSpaces }, reason) : [];
      const stale = target.isDisposed() || buffers.get(documentId) !== buffer || buffer.seq !== seq || buffer.version !== version || buffer.throttle !== undefined;
      if (edits.length === 0 || stale) return;
      // Stack elements on both sides make the format one undo step, apart from the typing around it.
      target.pushStackElement();
      target.pushEditOperations([], edits.map((edit) => ({ range: edit.range, text: edit.text })), () => null);
      target.pushStackElement();
    } finally {
      clearTimeout(indicator);
      setFormatting(documentId, false);
    }
  }

  /**
   * Saves the tab's buffer. format: Ctrl+S, Save As and auto save on focus change format first while format on save is on;
   * auto save after a delay passes false.
   */
  function save(tab: ShellEditorTab, opts: { readonly as?: boolean; readonly format?: boolean } = {}): Promise<EditorSaveResult | undefined> {
    const documentId = editedDocumentOf(tab);
    if (documentId === undefined) return Promise.resolve(undefined);
    if (!runningSaves.has(documentId)) return startSave(documentId, () => saveNow(tab, documentId, opts, false));
    const run: SaveRun = () => saveNow(tab, documentId, opts, true);
    const queued = queuedSaves.get(documentId);
    if (queued) {
      queued.run = run;
      return queued.promise;
    }
    let settle: (result: Promise<EditorSaveResult | undefined>) => void = () => undefined;
    const promise = new Promise<EditorSaveResult | undefined>((resolve) => { settle = resolve; });
    queuedSaves.set(documentId, { run, promise, settle });
    return promise;
  }

  function startSave(documentId: string, run: SaveRun): Promise<EditorSaveResult | undefined> {
    const running = run();
    runningSaves.set(documentId, running);
    const next = (): void => {
      runningSaves.delete(documentId);
      const queued = queuedSaves.get(documentId);
      if (!queued) return;
      queuedSaves.delete(documentId);
      queued.settle(startSave(documentId, queued.run));
    };
    running.then(next, next);
    return running;
  }

  async function saveNow(asked: ShellEditorTab, documentId: string, opts: { readonly as?: boolean; readonly format?: boolean }, queued: boolean): Promise<EditorSaveResult | undefined> {
    // A queued save runs on the tab as main shows it now: a Save As before it may have given an untitled buffer its file.
    const tab = tabs.value.find((candidate) => candidate.id === asked.id) ?? asked;
    const as = opts.as === true;
    flush(documentId);
    // Nothing changed since the save it waited for wrote this text, formatted (textFileEditorModel.ts:795 returns when not dirty).
    const waitedFor = buffers.get(documentId);
    if (queued && !as && waitedFor && waitedFor.saved?.version === waitedFor.version && waitedFor.saved.seq === waitedFor.seq) return { ok: true };
    if (opts.format !== false && settings.value?.formatOnSave === true && !tab.readOnly && buffers.has(documentId)) await format(documentId, 'save');
    const buffer = buffers.get(documentId);
    if (!buffer) return undefined;
    flush(documentId);
    clearTimeout(buffer.autoSave);
    buffer.autoSave = undefined;
    const sent = { version: buffer.version, seq: buffer.seq };
    const request = { documentId, version: buffer.version, text: buffer.model.getValue() };
    let result: EditorSaveResult;
    try {
      result = await (as || tab.kind === 'untitled' || tab.searchEditor?.untitled === true ? api.saveDocumentAs(request) : api.saveDocument(request));
    } catch (err) {
      // The renderer and main boundary: a rejected invoke (main logged its handler's throw) is a failed save the tab names.
      console.error(`[editor] saving ${documentId} failed`, err);
      const name = state.value?.documents[documentId]?.name ?? tab.title;
      result = { ok: false, reason: 'failed', message: shellI18n.global.t('editor.saveFailed', { name }) };
    }
    if (result.ok) buffer.saved = sent;
    saveError.value = !result.ok && result.reason === 'failed' && result.message ? { tabId: tab.id, message: result.message } : null;
    return result;
  }

  function activate(tabId: string): Promise<void> {
    return api.editorTab({ action: 'activate', tabId });
  }

  function neighbour(step: 1 | -1): ShellEditorTab | undefined {
    const list = tabs.value;
    const index = list.findIndex((tab) => tab.id === state.value?.activeTabId);
    return list.length === 0 || index < 0 ? undefined : list[(index + step + list.length) % list.length];
  }

  async function runCommand(command: EditorCommand): Promise<void> {
    const tab = activeTab.value;
    if (!tab) return;
    if (command === 'save' || command === 'saveAs') await save(tab, { as: command === 'saveAs' });
    else if (command === 'formatDocument') {
      const documentId = editedDocumentOf(tab);
      if (documentId !== undefined && !tab.readOnly && buffers.has(documentId)) await format(documentId, 'command');
    } else if (command === 'close') await api.editorTab({ action: 'close', tabId: tab.id });
    else {
      const next = neighbour(command === 'next' ? 1 : -1);
      if (next) {
        await activate(next.id);
        requestFocus(next.id);
      }
    }
  }

  function requestFocus(tabId: string): void {
    focusRequest.value = { tabId, serial: ++focusSerial };
  }

  /** True once for a fresh user request to focus `tabId`; the editor showing it consumes it, so showing the tab again later does not. */
  function takeFocus(tabId: string): boolean {
    if (focusRequest.value?.tabId !== tabId) return false;
    focusRequest.value = null;
    return true;
  }

  /** The line (or range) to show in `tabId`, once; a later switch back to the tab keeps where the reader left it. */
  function takeReveal(tabId: string): { line: number; selections?: readonly SearchRange[] } | undefined {
    const reveal = revealRequest.value;
    if (reveal?.tabId !== tabId) return undefined;
    revealRequest.value = null;
    return reveal.selections ? { line: reveal.line, selections: reveal.selections } : { line: reveal.line };
  }

  /** Add Cursors at Search Results: every range selected at once, the first revealed. */
  function selectRanges(tabId: string, ranges: readonly SearchRange[]): void {
    const first = ranges[0];
    if (first) revealRequest.value = { tabId, line: first.startLine, selections: ranges, serial: ++focusSerial };
  }

  /** Selects `range` in the tab's editor and scrolls it into view, as a search result click does; a tracked range wins. */
  function revealRange(tabId: string, range: SearchRange, decorationId?: string): void {
    let selection = range;
    if (decorationId !== undefined) {
      // Monaco's decoration ids carry their model's instance, so at most one buffer knows this one.
      for (const buffer of buffers.values()) {
        const tracked = buffer.model.getDecorationRange(decorationId);
        if (tracked) selection = toSearchRange(tracked);
      }
    }
    revealRequest.value = { tabId, line: selection.startLine, selections: [selection], serial: ++focusSerial };
  }

  function noteSelection(documentId: string, selection: EditorSelectionRange | null, caret: { line: number; column: number }): void {
    selections.set(documentId, selection);
    carets.set(documentId, caret);
  }

  /**
   * The search seed from the active text editor: its selection when it lies on one line, else with `nearestWord` (VS Code's
   * search.seedWithNearestWord) the word at the caret.
   */
  function activeSelectionText(nearestWord: boolean): string | undefined {
    const documentId = activeTab.value?.documentId;
    const buffer = documentId === undefined ? undefined : buffers.get(documentId);
    if (documentId === undefined || !buffer) return undefined;
    const selection = selections.get(documentId);
    if (selection) {
      if (selection.startLine !== selection.endLine) return undefined;
      const [start, end] = [selection.startColumn, selection.endColumn].sort((a, b) => a - b);
      return buffer.model.getLineContent(selection.startLine).slice(start! - 1, end! - 1);
    }
    const caret = carets.get(documentId);
    return nearestWord && caret ? buffer.model.getWordAtPosition({ lineNumber: caret.line, column: caret.column })?.word : undefined;
  }

  /** A tab showing the document as text (code, untitled, markdown source or preview), for a search result from its buffer. */
  function tabOfDocument(documentId: string): ShellEditorTab | undefined {
    return tabs.value.find((tab) => tab.documentId === documentId && tab.kind !== 'diff');
  }

  /** The text tab of a project file, for a result found on disk before the file was opened. */
  function tabOfFile(projectKey: string, relativePath: string): ShellEditorTab | undefined {
    return tabs.value.find((tab) => tab.projectKey === projectKey && tab.relativePath === relativePath && tab.documentId !== undefined && (tab.kind === 'code' || tab.kind === 'markdownPreview'));
  }

  function toSearchRange(range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }): SearchRange {
    return { startLine: range.startLineNumber, startColumn: range.startColumn, endLine: range.endLineNumber, endColumn: range.endColumn };
  }

  function toMonacoRange(range: SearchRange): { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number } {
    return { startLineNumber: range.startLine, startColumn: range.startColumn, endLineNumber: range.endLine, endColumn: range.endColumn };
  }

  /**
   * Decorations that follow `ranges` in the document's buffer while the user edits, one per range in order; undefined when
   * no editable tab shows it. The model is created if no editor has shown the tab yet.
   */
  async function trackSearchRanges(documentId: string, ranges: readonly SearchRange[]): Promise<string[] | undefined> {
    const tab = tabOfDocument(documentId);
    if (!tab || tab.readOnly) return undefined;
    const target = await model(documentId);
    if (target.isDisposed()) return undefined;
    // NeverGrowsWhenTypingAtEdges: text typed right before or after a match stays outside it.
    const ids = target.deltaDecorations([], ranges.map((range) => ({ range: toMonacoRange(range), options: { description: 'search-match', stickiness: 1 } })));
    const owned = searchDecorations.get(documentId) ?? new Set<string>();
    for (const id of ids) owned.add(id);
    searchDecorations.set(documentId, owned);
    return ids;
  }

  /** Drops every search decoration, when a search is cleared or replaced by a new one. */
  function clearSearchTracking(): void {
    for (const [documentId, ids] of searchDecorations) {
      const buffer = buffers.get(documentId);
      if (buffer && !buffer.model.isDisposed()) buffer.model.deltaDecorations([...ids], []);
    }
    searchDecorations.clear();
  }

  /**
   * Replaces the targets in the file's buffer as ONE undoable edit, leaving it dirty, as VS Code replaces in an open editor.
   * A tracked range wins over the recorded one. The replacement goes through the one expansion main uses (`$1`, Preserve
   * Case); a target the query no longer matches leaves the whole buffer untouched.
   */
  async function replaceInBuffer(documentId: string, targets: readonly BufferReplaceTarget[], replacement: string, query: SearchQuery, preserveCase: boolean): Promise<BufferReplaceResult> {
    const tab = tabOfDocument(documentId);
    if (!tab) return { ok: false, reason: 'changed' };
    if (tab.readOnly) return { ok: false, reason: 'readOnly' };
    const target = await model(documentId);
    const regExp = replaceRegExp(query);
    if (!regExp) return { ok: false, reason: 'unsupportedRegex' };
    const edits: Array<{ range: ReturnType<typeof toMonacoRange>; text: string }> = [];
    for (const { range, decorationId, text: recorded } of targets) {
      const tracked = decorationId === undefined ? null : target.getDecorationRange(decorationId);
      if (decorationId !== undefined && !tracked) return { ok: false, reason: 'changed' };
      if (!tracked && recorded !== undefined && target.getValueInRange(toMonacoRange(range)) !== recorded) return { ok: false, reason: 'changed' };
      const at = tracked ? toSearchRange(tracked) : range;
      // The match's whole lines, '\n'-joined as ripgrep's --crlf reads them, so lookarounds see their context.
      const lines: string[] = [];
      for (let line = at.startLine; line <= at.endLine; line++) lines.push(target.getLineContent(line));
      const end = lines.slice(0, -1).reduce((sum, line) => sum + line.length + 1, 0) + at.endColumn - 1;
      const text = replacementAt(regExp, query.isRegex, lines.join('\n'), at.startColumn - 1, end, replacement, preserveCase);
      if (text === null) return { ok: false, reason: 'changed' };
      edits.push({ range: toMonacoRange(at), text });
    }
    // Stack elements on both sides keep the replace one undo step, apart from the typing around it.
    target.pushStackElement();
    target.pushEditOperations([], edits, () => null);
    target.pushStackElement();
    const owned = searchDecorations.get(documentId);
    const used = targets.flatMap((item) => (item.decorationId === undefined ? [] : [item.decorationId]));
    if (owned && used.length > 0) {
      target.deltaDecorations(used, []);
      for (const id of used) owned.delete(id);
    }
    return { ok: true, replaced: edits.length };
  }

  // Documents no tab shows any more: their models go after the editors showing them unmounted, and after main has every keystroke.
  function release(): void {
    const open = new Set(tabs.value.map((tab) => tab.id));
    for (const tabId of viewStates.keys()) if (!open.has(tabId)) viewStates.delete(tabId);
    const shown = new Set(tabs.value.flatMap(documentIdsOf));
    let disposed = false;
    for (const [documentId, buffer] of buffers) {
      if (shown.has(documentId)) continue;
      flush(documentId);
      clearTimeout(buffer.autoSave);
      buffers.delete(documentId);
      searchDecorations.delete(documentId);
      selections.delete(documentId);
      carets.delete(documentId);
      buffer.model.dispose();
      disposed = true;
    }
    if (disposed) modelRevision.value++;
    let dropped = false;
    for (const documentId of contents.value.keys()) {
      if (shown.has(documentId)) continue;
      contents.value.delete(documentId);
      dropped = true;
    }
    if (dropped) triggerRef(contents);
    if ([...searchHighlights.value.keys()].some((documentId) => !shown.has(documentId))) {
      searchHighlights.value = new Map([...searchHighlights.value].filter(([documentId]) => shown.has(documentId)));
    }
  }

  /** Main's content version of the document's buffer, which a Search Editor highlight push names. */
  function documentVersion(documentId: string): number | undefined {
    return buffers.get(documentId)?.version;
  }

  function applyState(next: ShellEditorState): void {
    const settingsChanged = state.value !== null && JSON.stringify(state.value.settings) !== JSON.stringify(next.settings);
    state.value = next;
    void nextTick(release);
    if (settingsChanged) for (const buffer of buffers.values()) applyIndentation(buffer.model);
    if (loadedModule) for (const [documentId, buffer] of buffers) followDocument(loadedModule, documentId, buffer);
    if (saveError.value && !next.tabs.some((tab) => tab.id === saveError.value?.tabId)) saveError.value = null;
    if (next.tabs.length === 0) void setFocusOverlay(false);
  }

  // A rename or Save As moves the model to the document's new path, or a language change alone sets it on the model. A
  // document with no file keeps its URI while its name changes (an untitled Search Editor is named after its query).
  function followDocument(module: ShellMonacoModule, documentId: string, buffer: TextBuffer): void {
    const document = state.value?.documents[documentId];
    if (!document || buffer.model.isDisposed()) return;
    const languageId = document.languageId ?? buffer.model.getLanguageId();
    const uri = document.path === undefined ? buffer.model.uri : modelUri(module, documentId);
    if (uri.toString() !== buffer.model.uri.toString()) moveModel(module, documentId, buffer, uri, languageId);
    else if (buffer.model.getLanguageId() !== languageId) module.useMonaco().editor.setModelLanguage(buffer.model, languageId);
  }

  // The control that opened the focus overlay, which takes focus back when it closes.
  let focusOverlayOpener: HTMLElement | null = null;

  async function setFocusOverlay(open: boolean): Promise<void> {
    if (focusOverlay.value === open) return;
    if (open) focusOverlayOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    focusOverlay.value = open;
    if (!open && focusOverlayOpener?.isConnected) focusOverlayOpener.focus();
    if (!open) focusOverlayOpener = null;
    await api.setFocusOverlay(open);
  }

  /** Sends the unsent edit first, so main compares, overwrites or reverts the buffer the user sees; a diff tab's is its modified side. */
  async function resolveConflict(tab: ShellEditorTab, action: 'compare' | 'overwrite' | 'revert'): Promise<void> {
    const documentId = editedDocumentOf(tab);
    if (documentId === undefined) return;
    flush(documentId);
    const result = await api.resolveConflict({ documentId, action });
    saveError.value = !result.ok && result.reason === 'failed' && result.message ? { tabId: tab.id, message: result.message } : null;
  }

  // On focus change, auto save writes every dirty buffer it may, once however many tabs show it (VS Code's onFocusChange).
  function saveOnFocusChange(): void {
    if (settings.value?.autoSave !== 'onFocusChange') return;
    const asked = new Set<string>();
    for (const tab of tabs.value) {
      const documentId = editedDocumentOf(tab);
      if (documentId === undefined || asked.has(documentId) || !autoSaves(tab)) continue;
      asked.add(documentId);
      void save(tab);
    }
  }

  // Quit, window close and the Save of their prompts: the named documents format one at a time, as each Ctrl+S would. A
  // format that fails leaves its buffer as it is; main gets every edit and its answer either way.
  async function flushFor({ requestId, format: documentIds }: EditorFlushRequest): Promise<void> {
    try {
      for (const documentId of documentIds) {
        try {
          await format(documentId, 'save');
        } catch {
          // saved unformatted
        }
      }
    } finally {
      flushAll();
      api.editorFlushed(requestId);
    }
  }

  const stops: Array<() => void> = [];
  async function start(): Promise<void> {
    stops.push(api.onEditorState(applyState));
    stops.push(api.onDocumentChanged(applyChange));
    stops.push(api.onEditorCommand((command) => void runCommand(command)));
    stops.push(api.onEditorFlush((request) => void flushFor(request)));
    stops.push(api.onEditorFocus(requestFocus));
    stops.push(api.onSearchEditorHighlights(({ documentId, version, ranges }) => {
      searchHighlights.value = new Map(searchHighlights.value).set(documentId, { version, ranges });
    }));
    stops.push(api.onEditorReveal(({ tabId, line, range }) => {
      revealRequest.value = { tabId, line, ...(range === undefined ? {} : { selections: [range] }), serial: ++focusSerial };
    }));
    applyState(await api.getEditorState());
  }

  function stop(): void {
    for (const unsubscribe of stops) unsubscribe();
    stops.length = 0;
    flushAll();
    for (const buffer of buffers.values()) {
      clearTimeout(buffer.autoSave);
      buffer.model.dispose();
    }
    buffers.clear();
    searchDecorations.clear();
    viewStates.clear();
    modelRevision.value++;
  }

  return {
    state,
    tabs,
    activeTab,
    settings,
    contents,
    focusRequest,
    revealRequest,
    saveError,
    focusOverlay,
    formatting,
    setFocusOverlay,
    resolveConflict,
    monaco,
    load,
    model,
    bufferModel,
    rememberViewState,
    viewStateOf,
    onDidReplaceModel,
    flush,
    save,
    activate,
    runCommand,
    requestFocus,
    takeFocus,
    takeReveal,
    revealRange,
    selectRanges,
    noteSelection,
    activeSelectionText,
    tabOfDocument,
    tabOfFile,
    documentVersion,
    searchHighlights,
    flushAll,
    trackSearchRanges,
    clearSearchTracking,
    replaceInBuffer,
    saveOnFocusChange,
    documentIdsOf,
    start,
    stop,
  };
}

export type EditorStore = ReturnType<typeof createEditorStore>;
export const EDITOR_STORE: InjectionKey<EditorStore> = Symbol('editor-store');
