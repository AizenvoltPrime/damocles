<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, shallowRef, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { editor as MonacoEditor, IDisposable } from 'monaco-editor/editor/editor.api';
import { BookOpen, CaseSensitive, Ellipsis, ListFilter, Regex, TextQuote, WholeWord } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { DamoclesShellApi, EditorMenuShortcut, SearchCommandMessage, SearchEditorCommand, SearchEditorConfig, ShellEditorTab, ShellPlatform, ShellSearchSettings } from '../../preload/shell-channels';
import type { Monaco } from './monaco';
import { MAX_CONTEXT_LINES, MAX_SEARCH_GLOBS_LENGTH, MAX_SEARCH_PATTERN_LENGTH } from '../../../shared/text-search';
import SearchField from '../search/SearchField.vue';
import SearchOption from '../search/SearchOption.vue';
import CodeEditor from './CodeEditor.vue';
import { EDITOR_STORE } from './editor-store';

// VS Code's Search Editor (contrib/searchEditor/browser/searchEditor.ts): the query header over the results body, which is a
// text document main owns and rewrites on each run. Main resolves every result line to its file; the shell sends positions only.
const props = defineProps<{
  api: DamoclesShellApi;
  tab: ShellEditorTab & { searchEditor: NonNullable<ShellEditorTab['searchEditor']> };
  platform: ShellPlatform;
  settings: ShellSearchSettings;
  // Toggle Query Details' accelerator label, empty when it has none
  detailsShortcut: string;
  menuShortcuts: Readonly<Record<EditorMenuShortcut, string>>;
}>();
const { t } = useI18n();
const store = inject(EDITOR_STORE)!;

const code = ref<InstanceType<typeof CodeEditor> | null>(null);
const queryField = ref<InstanceType<typeof SearchField> | null>(null);
const includeField = ref<InstanceType<typeof SearchField> | null>(null);
const excludeField = ref<InstanceType<typeof SearchField> | null>(null);
const announced = ref('');
const messageId = useId();
const isMac = computed(() => props.platform === 'darwin');
const optionShortcut = (key: string): string => (isMac.value ? `⌥⌘${key}` : `Alt+${key}`);
const withShortcut = (label: string, shortcut: string): string => t('search.withShortcut', { label, shortcut });

// The header's inputs as typed; main's config replaces them whenever no change of ours is waiting to be sent.
const draft = shallowRef<SearchEditorConfig>({ ...props.tab.searchEditor.config });
// The context lines a toggle restores (VS Code keeps its number input while the toggle is off).
const contextCount = ref(String(props.tab.searchEditor.config.contextLines || 1));
let sendTimer: ReturnType<typeof setTimeout> | undefined;
watch(() => [props.tab.id, props.tab.searchEditor.config] as const, ([, config], previous) => {
  const switched = previous !== undefined && previous[0] !== props.tab.id;
  if (!switched && sendTimer !== undefined) return;
  clearTimeout(sendTimer);
  sendTimer = undefined;
  draft.value = { ...config };
  if (config.contextLines > 0) contextCount.value = String(config.contextLines);
});

const documentId = computed(() => props.tab.documentId!);
const running = computed(() => props.tab.searchEditor.running);
// The sweep starts with a run and stops once the line has faded out, as the Search section's does.
const sweeping = ref(false);
watch(running, (now) => {
  if (now) sweeping.value = true;
}, { immediate: true });
const message = computed(() => props.tab.searchEditor.message);

/** Sends the draft to main and, when `run`, searches with it; a typed change waits for search.searchOnTypeDebouncePeriod. */
function send(patch: Partial<SearchEditorConfig>, mode: 'now' | 'typed' | 'configOnly'): void {
  draft.value = { ...draft.value, ...patch };
  clearTimeout(sendTimer);
  sendTimer = undefined;
  const flush = async (run: boolean): Promise<void> => {
    sendTimer = undefined;
    await props.api.setSearchEditorConfig(documentId.value, draft.value);
    if (run) await rerun();
  };
  if (mode === 'typed') {
    if (!props.settings.searchOnType) return void (sendTimer = setTimeout(() => void flush(false), props.settings.searchOnTypeDebouncePeriod));
    sendTimer = setTimeout(() => void flush(true), props.settings.searchOnTypeDebouncePeriod);
  } else void flush(mode === 'now');
}

async function rerun(): Promise<void> {
  clearTimeout(sendTimer);
  if (sendTimer !== undefined) {
    sendTimer = undefined;
    await props.api.setSearchEditorConfig(documentId.value, draft.value);
  }
  store.flush(documentId.value);
  await props.api.runSearchEditor(documentId.value);
}

async function submit(): Promise<void> {
  await rerun();
  if (props.settings.searchEditor.focusResultsOnSearch) code.value?.focus();
}

// --- context lines (VS Code's showContextToggle and its number input) ---------------------------------------------------

function contextLinesOf(raw: string): number {
  const value = Math.trunc(Number(raw));
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), MAX_CONTEXT_LINES) : 0;
}

function toggleContextLines(): void {
  send({ contextLines: draft.value.contextLines > 0 ? 0 : Math.max(1, contextLinesOf(contextCount.value)) }, 'now');
}

function setContextCount(raw: string | number): void {
  contextCount.value = String(raw);
  // A negative number reads as 0, as VS Code's onContextLinesChanged writes it back.
  if (String(raw).includes('-')) contextCount.value = '0';
  send({ contextLines: contextLinesOf(contextCount.value) }, 'now');
}

function stepContextLines(step: 1 | -1): void {
  const next = Math.min(Math.max(contextLinesOf(contextCount.value) + step, 0), MAX_CONTEXT_LINES);
  contextCount.value = String(next);
  send({ contextLines: next }, 'now');
}

// --- keys in the header ---------------------------------------------------------------------------------------------

function onOptionKey(event: KeyboardEvent): boolean {
  if (!event.altKey || event.shiftKey || (isMac.value ? !event.metaKey : event.ctrlKey || event.metaKey)) return false;
  const option = ({ KeyC: 'matchCase', KeyW: 'wholeWord', KeyR: 'isRegex' } as const)[event.code as 'KeyC' | 'KeyW' | 'KeyR'];
  if (!option) return false;
  event.preventDefault();
  send({ [option]: !draft.value[option] }, 'now');
  return true;
}

// VS Code's SearchEditor.focusNextInput / focusPrevInput (Ctrl+Down / Ctrl+Up): query, include, exclude, results.
function onFocusKey(event: KeyboardEvent, from: 'query' | 'include' | 'exclude'): boolean {
  const ctrl = isMac.value ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!ctrl || event.altKey || event.shiftKey || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return false;
  event.preventDefault();
  const shows = draft.value.showIncludesExcludes;
  if (event.key === 'ArrowDown') {
    if (from === 'query' && shows) includeField.value?.focus();
    else if (from === 'include') excludeField.value?.focus();
    else code.value?.focus();
  } else if (from === 'query') code.value?.focus();
  else if (from === 'include') queryField.value?.focus();
  else includeField.value?.focus();
  return true;
}

function onInputKeydown(event: KeyboardEvent, from: 'query' | 'include' | 'exclude'): void {
  if (onOptionKey(event) || onFocusKey(event, from)) return;
  if (event.key === 'Enter' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    event.preventDefault();
    void submit();
  }
}

function toggleDetails(moveFocus: boolean): void {
  const show = !draft.value.showIncludesExcludes;
  send({ showIncludesExcludes: show }, 'configOnly');
  if (moveFocus) void nextTick(() => (show ? includeField.value?.focus() : queryField.value?.focus()));
}

function focusDetail(field: 'include' | 'exclude'): void {
  if (!draft.value.showIncludesExcludes) send({ showIncludesExcludes: true }, 'configOnly');
  void nextTick(() => (field === 'include' ? includeField : excludeField).value?.focus());
}

// --- the results body: highlights, opening a result, VS Code's editor actions ----------------------------------------

let highlightIds: string[] = [];
const disposables: IDisposable[] = [];
let monacoApi: Monaco | undefined;
const monacoEditor = computed(() => (code.value?.shownTabId === props.tab.id ? code.value.editor : null));

function applyHighlights(): void {
  const instance = monacoEditor.value;
  const model = instance?.getModel();
  if (!instance || !model) return;
  const pushed = store.searchHighlights.value.get(documentId.value);
  if (pushed && pushed.version !== store.documentVersion(documentId.value)) return;
  highlightIds = model.deltaDecorations(highlightIds, (pushed?.ranges ?? []).map((range) => ({
    range: { startLineNumber: range.startLine, startColumn: range.startColumn, endLineNumber: range.endLine, endColumn: range.endColumn },
    options: { description: 'search-editor-match', className: 'search-editor-match', stickiness: 1 },
  })));
}
watch([monacoEditor, store.searchHighlights], applyHighlights);
watch(() => props.tab.id, () => (highlightIds = []));
// A renamed .code-search file's model moves; its highlights go onto the new model once the editor shows it.
const stopFollowing = store.onDidReplaceModel((movedId) => {
  if (movedId !== documentId.value) return;
  highlightIds = [];
  void nextTick(applyHighlights);
});

const highlightRanges = (): MonacoEditor.IModelDecoration['range'][] => {
  const model = monacoEditor.value?.getModel();
  return model ? highlightIds.flatMap((id) => model.getDecorationRange(id) ?? []) : [];
};

async function openResult(position: { lineNumber: number; column: number }, toSide: boolean): Promise<void> {
  store.flush(documentId.value);
  await props.api.openSearchEditorResult({ documentId: documentId.value, line: position.lineNumber, column: position.column, toSide });
}

// VS Code's deleteResultBlock: every selection's whole file block goes as one undoable edit.
function deleteFileResults(): void {
  const instance = monacoEditor.value;
  const model = instance?.getModel();
  const selections = instance?.getSelections();
  if (!instance || !model || !selections) return;
  const remove = new Set<number>();
  const last = model.getLineCount();
  const startsBlock = (line: string): boolean => line[0] !== undefined && line[0] !== ' ';
  const endings: number[] = [];
  for (const selection of selections) {
    const start = selection.startLineNumber;
    remove.add(start);
    let ending: number | undefined;
    for (let line = start + 1; line <= last; line++) {
      if (startsBlock(model.getLineContent(line))) {
        ending = line;
        break;
      }
      remove.add(line);
    }
    if (ending !== undefined) endings.push(ending);
    for (let line = start; line >= 1; line--) {
      remove.add(line);
      if (startsBlock(model.getLineContent(line))) break;
    }
    for (let line = selection.startLineNumber; line <= selection.endLineNumber; line++) remove.add(line);
  }
  model.pushEditOperations(
    selections,
    [...remove].map((line) => ({ range: { startLineNumber: line, startColumn: 1, endLineNumber: line + 1, endColumn: 1 }, text: '' })),
    () => (monacoApi ? endings.map((line) => new monacoApi!.Selection(line, 1, line, 1)) : null),
  );
}

function selectAllMatches(): void {
  const instance = monacoEditor.value;
  const ranges = highlightRanges();
  if (!instance || ranges.length === 0) return;
  instance.setSelections(ranges.map((range) => ({ selectionStartLineNumber: range.startLineNumber, selectionStartColumn: range.startColumn, positionLineNumber: range.endLineNumber, positionColumn: range.endColumn })));
  instance.focus();
}

// VS Code's iterateThroughMatches: the next (or previous) highlight after the caret, wrapping, announced with its file.
function stepMatch(step: 1 | -1): void {
  const instance = monacoEditor.value;
  const model = instance?.getModel();
  const ranges = highlightRanges();
  if (!instance || !model || ranges.length === 0) return;
  const at = instance.getSelection()?.getStartPosition() ?? { lineNumber: step === 1 ? 1 : model.getLineCount(), column: 1 };
  const after = (range: SearchRangeLike): boolean => range.startLineNumber > at.lineNumber || (range.startLineNumber === at.lineNumber && range.startColumn > at.column);
  const before = (range: SearchRangeLike): boolean => range.startLineNumber < at.lineNumber || (range.startLineNumber === at.lineNumber && range.startColumn < at.column);
  const target = step === 1 ? ranges.find(after) ?? ranges[0]! : [...ranges].reverse().find(before) ?? ranges[ranges.length - 1]!;
  instance.setSelection(target);
  instance.revealLineInCenterIfOutsideViewport(target.startLineNumber);
  instance.focus();
  let file = '';
  for (let line = target.startLineNumber; line >= 1; line--) {
    const text = model.getLineContent(line);
    if (text[0] !== ' ') {
      file = text.slice(0, -1);
      break;
    }
  }
  announced.value = t('searchEditor.matched', { match: model.getValueInRange(target), line: model.getLineContent(target.startLineNumber), file });
}
type SearchRangeLike = { startLineNumber: number; startColumn: number };

watch(monacoEditor, async (instance) => {
  for (const disposable of disposables.splice(0)) disposable.dispose();
  if (!instance) return;
  const monaco = (await store.monaco()).useMonaco();
  monacoApi = monaco;
  disposables.push(
    instance.onMouseUp((event) => {
      const position = event.target.position;
      if (event.event.detail !== 2 || !position || props.settings.searchEditor.doubleClickBehaviour === 'selectWord') return;
      void openResult(position, props.settings.searchEditor.doubleClickBehaviour === 'openLocationToSide');
    }),
    // Go to Definition on a result line opens the match (the search-result extension's definition provider).
    instance.addAction({ id: 'damocles.searchEditor.openResult', label: t('searchEditor.goToResult'), keybindings: [monaco.KeyCode.F12], run: (current) => {
      const position = current.getPosition();
      if (position) void openResult(position, false);
    } }),
    instance.addAction({ id: 'damocles.searchEditor.openResultToSide', label: t('searchEditor.goToResultToSide'), keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.F12], run: (current) => {
      const position = current.getPosition();
      if (position) void openResult(position, true);
    } }),
    // Escape: VS Code's Focus Search Editor Input, unless a Monaco widget takes it first.
    instance.addAction({ id: 'damocles.searchEditor.focusInput', label: t('searchEditor.focusInput'), keybindings: [monaco.KeyCode.Escape], precondition: '!suggestWidgetVisible && !findWidgetVisible && !editorHasMultipleSelections', run: () => queryField.value?.focus() }),
  );
  applyHighlights();
}, { flush: 'post' });

function runCommand(command: SearchEditorCommand): void {
  switch (command) {
    case 'rerun': void rerun(); break;
    case 'focusInput': queryField.value?.focus(); break;
    case 'focusIncludes': focusDetail('include'); break;
    case 'focusExcludes': focusDetail('exclude'); break;
    case 'toggleMatchCase': send({ matchCase: !draft.value.matchCase }, 'now'); break;
    case 'toggleWholeWord': send({ wholeWord: !draft.value.wholeWord }, 'now'); break;
    case 'toggleRegex': send({ isRegex: !draft.value.isRegex }, 'now'); break;
    case 'toggleContextLines': toggleContextLines(); break;
    case 'increaseContextLines': stepContextLines(1); break;
    case 'decreaseContextLines': stepContextLines(-1); break;
    case 'selectAllMatches': selectAllMatches(); break;
    case 'deleteFileResults': deleteFileResults(); break;
    case 'toggleQueryDetails': toggleDetails(true); break;
    case 'focusNextResult': stepMatch(1); break;
    case 'focusPreviousResult': stepMatch(-1); break;
  }
}

const stopCommands = props.api.onSearchCommand((message: SearchCommandMessage) => {
  if (message.target === 'editor' && message.tabId === props.tab.id) runCommand(message.command);
});

onBeforeUnmount(() => {
  stopCommands();
  stopFollowing();
  clearTimeout(sendTimer);
  for (const disposable of disposables.splice(0)) disposable.dispose();
});

const messageText = computed(() => {
  const current = message.value;
  if (!current || current.kind === 'stale') return '';
  if (current.kind === 'error') return t('search.error', { message: current.text });
  if (current.kind === 'invalidGlob') return t('search.invalidGlob', { glob: current.glob });
  if (current.kind === 'noProject') return t('search.noProject');
  return t('searchEditor.headerError', { message: current.text });
});
</script>

<template>
  <div
    data-testid="search-editor"
    class="absolute inset-0 flex flex-col"
  >
    <!-- VS Code's query-container: the Search section's fields, without replace, plus the context lines control. -->
    <div class="@container flex shrink-0 flex-col gap-1 border-b border-(--d-border) bg-(--d-bg) py-2 pr-3.5 pl-3">
      <div class="flex items-start gap-1.5">
        <SearchField
          ref="queryField"
          multiline
          class="min-w-0 flex-1"
          testid="search-editor-query"
          :model-value="draft.query"
          :maxlength="MAX_SEARCH_PATTERN_LENGTH"
          :label="t('search.queryAria')"
          :placeholder="t('search.query')"
          :is-mac="isMac"
          :controls="messageId"
          @update:model-value="send({ query: $event }, 'typed')"
          @keydown="onInputKeydown($event, 'query')"
        >
          <SearchOption
            :model-value="draft.matchCase"
            testid="search-editor-option-matchCase"
            :label="t('search.matchCase')"
            :title="withShortcut(t('search.matchCase'), optionShortcut('C'))"
            :icon="CaseSensitive"
            @update:model-value="send({ matchCase: $event }, 'now')"
          />
          <SearchOption
            :model-value="draft.wholeWord"
            testid="search-editor-option-wholeWord"
            :label="t('search.wholeWord')"
            :title="withShortcut(t('search.wholeWord'), optionShortcut('W'))"
            :icon="WholeWord"
            @update:model-value="send({ wholeWord: $event }, 'now')"
          />
          <SearchOption
            :model-value="draft.isRegex"
            testid="search-editor-option-isRegex"
            :label="t('search.regex')"
            :title="withShortcut(t('search.regex'), optionShortcut('R'))"
            :icon="Regex"
            @update:model-value="send({ isRegex: $event }, 'now')"
          />
          <SearchOption
            :model-value="draft.contextLines > 0"
            testid="search-editor-option-context"
            :label="t('searchEditor.toggleContextLines')"
            :title="withShortcut(t('searchEditor.toggleContextLines'), isMac ? '⌥⌘L' : 'Alt+L')"
            :icon="TextQuote"
            @update:model-value="toggleContextLines"
          />
        </SearchField>
        <Input
          type="number"
          min="0"
          :max="MAX_CONTEXT_LINES"
          data-testid="search-editor-context-lines"
          :model-value="contextCount"
          :aria-label="t('searchEditor.contextLines')"
          :title="t('searchEditor.contextLines')"
          class="h-7 w-14 shrink-0 rounded-7 border-(--d-border2) bg-(--d-input) px-2 text-12 tabular-nums"
          @update:model-value="setContextCount"
        />
      </div>
      <div class="flex justify-end">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-testid="search-editor-toggle-details"
          class="h-4.5 w-6 rounded-md text-(--d-faint) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-3.5"
          :aria-label="t('search.toggleDetails')"
          :title="detailsShortcut === '' ? t('search.toggleDetails') : withShortcut(t('search.toggleDetails'), detailsShortcut)"
          :aria-expanded="draft.showIncludesExcludes"
          @click="toggleDetails(false)"
        >
          <Ellipsis aria-hidden="true" />
        </Button>
      </div>
      <Transition name="search-replace">
        <div
          v-if="draft.showIncludesExcludes"
          class="grid grid-cols-1 gap-1 @min-[40rem]:grid-cols-2 @min-[40rem]:gap-3"
        >
          <div class="flex flex-col gap-0.5">
            <span class="text-11 text-(--d-muted)">{{ t('search.include') }}</span>
            <SearchField
              ref="includeField"
              testid="search-editor-include"
              :model-value="draft.include"
              :maxlength="MAX_SEARCH_GLOBS_LENGTH"
              :label="t('searchEditor.includeAria')"
              :placeholder="t('search.includePlaceholder')"
              :invalid="message?.kind === 'invalidGlob'"
              :is-mac="isMac"
              @update:model-value="send({ include: $event }, 'typed')"
              @keydown="onInputKeydown($event, 'include')"
            >
              <SearchOption
                :model-value="draft.onlyOpenEditors"
                testid="search-editor-option-onlyOpenEditors"
                :label="t('search.onlyOpenEditors')"
                :title="t('search.onlyOpenEditors')"
                :icon="BookOpen"
                @update:model-value="send({ onlyOpenEditors: $event }, 'now')"
              />
            </SearchField>
          </div>
          <div class="flex flex-col gap-0.5">
            <span class="text-11 text-(--d-muted)">{{ t('search.exclude') }}</span>
            <SearchField
              ref="excludeField"
              testid="search-editor-exclude"
              :model-value="draft.exclude"
              :maxlength="MAX_SEARCH_GLOBS_LENGTH"
              :label="t('searchEditor.excludeAria')"
              :placeholder="t('search.excludePlaceholder')"
              :invalid="message?.kind === 'invalidGlob'"
              :is-mac="isMac"
              @update:model-value="send({ exclude: $event }, 'typed')"
              @keydown="onInputKeydown($event, 'exclude')"
            >
              <SearchOption
                :model-value="draft.useExcludeSettingsAndIgnoreFiles"
                testid="search-editor-option-useExclude"
                :label="t('search.useExclude')"
                :title="t('search.useExclude')"
                :icon="ListFilter"
                @update:model-value="send({ useExcludeSettingsAndIgnoreFiles: $event }, 'now')"
              />
            </SearchField>
          </div>
        </div>
      </Transition>
      <p
        :id="messageId"
        class="min-h-4.5 text-11.5/4.5 wrap-break-word"
      >
        <!-- An inline text link, which Button variant="link" (an inline-flex box with padding) cannot be. -->
        <button
          v-if="message?.kind === 'stale'"
          type="button"
          data-testid="search-editor-run"
          class="cursor-pointer font-medium text-(--d-accent) underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
          @click="rerun().then(() => code?.focus())"
        >
          {{ t('searchEditor.runSearch') }}
        </button>
        <span
          v-else-if="messageText !== ''"
          role="alert"
          data-testid="search-editor-message"
          class="text-(--d-danger-text)"
        >{{ messageText }}</span>
      </p>
    </div>
    <!-- The same indeterminate line as the Search section, holding its height while idle. -->
    <div
      class="h-0.5 shrink-0 transition-opacity duration-200"
      :class="running ? 'opacity-100' : 'opacity-0'"
      @transitionend.self="sweeping = running"
      @transitioncancel.self="sweeping = running"
    >
      <div
        v-if="sweeping"
        :role="running ? 'progressbar' : undefined"
        :data-testid="running ? 'search-editor-progress' : undefined"
        :aria-label="running ? t('search.searching') : undefined"
        class="d-sweep-bar h-full text-(--d-accent)"
      />
    </div>
    <div class="relative min-h-0 flex-1">
      <CodeEditor
        ref="code"
        :api="api"
        :tab="tab"
        :menu-shortcuts="menuShortcuts"
      />
    </div>
    <p
      role="alert"
      class="sr-only"
    >
      {{ announced }}
    </p>
  </div>
</template>
