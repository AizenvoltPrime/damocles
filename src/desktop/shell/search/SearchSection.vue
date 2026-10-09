<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useVirtualList } from '@vueuse/core';
import { BookOpen, CaseSensitive, CaseUpper, ChevronRight, CircleStop, CopyMinus, CopyPlus, Ellipsis, FilePlus, List, ListFilter, ListTree, Regex, RefreshCw, ReplaceAll, SearchX, TriangleAlert, WholeWord } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { remPx } from '@/composables/useRemPx';
import type { OverlayMenuItem } from '../../preload/overlay-channels';
import type { DamoclesShellApi, FileRef, SearchCommandMessage, SearchViewState, ShellPlatform, ShellSearchSettings, ShellState } from '../../preload/shell-channels';
import { MAX_REPLACEMENT_LENGTH, MAX_SEARCH_GLOBS_LENGTH, MAX_SEARCH_PATTERN_LENGTH, folderGlob } from '../../../shared/text-search';
import { EDITOR_STORE } from '../editor/editor-store';
import { tidyMenu } from '../../preload/overlay-channels';
import SidebarSection from '../components/SidebarSection.vue';
import SearchField from './SearchField.vue';
import SearchOption from './SearchOption.vue';
import SearchResultRow from './SearchResultRow.vue';
import { fileTypeGlob, mergeGlob } from './search-globs';
import { createSearchStore, insertedText, type BufferSkip, type HistoryField, type ResultRow } from './search-store';

const props = defineProps<{
  api: DamoclesShellApi;
  projectKey: string | undefined;
  projectName: string;
  platform: ShellPlatform;
  // the project's saved query, toggles and histories from the window layout
  saved: SearchViewState | undefined;
  settings: ShellSearchSettings;
  shortcuts: ShellState['shortcuts'];
  collapsed: boolean;
  bodySize?: number | undefined;
}>();
const emit = defineEmits<{ toggle: []; expand: []; viewState: [state: SearchViewState]; revealInFiles: [file: FileRef] }>();
const { t, locale } = useI18n();
const editor = inject(EDITOR_STORE)!;
const store = createSearchStore(props.api, editor, () => props.settings);
const { view, replacement, status, rows, openedKey } = store;

// rem of a result row (VS Code's 22px tree rows).
const ROW_REM = 1.375;
// ms the view state waits before it is reported, so typing writes the layout once it settles
const PERSIST_DELAY_MS = 400;

const treeId = useId();
const helpId = useId();
const queryField = ref<InstanceType<typeof SearchField> | null>(null);
const replaceField = ref<InstanceType<typeof SearchField> | null>(null);
const includeField = ref<InstanceType<typeof SearchField> | null>(null);
const excludeField = ref<InstanceType<typeof SearchField> | null>(null);
// what a replace or preview could not do that no notification reports: buffers the shell skipped, previews main refused
const notices = ref<string[]>([]);
const focusedKey = ref<string | null>(null);
let focusedHint = 0;

const { list: visibleRows, containerProps, wrapperProps, scrollTo } = useVirtualList(rows, { itemHeight: () => remPx(ROW_REM), overscan: 10 });

const isMac = computed(() => props.platform === 'darwin');
const optionShortcut = (key: string): string => (isMac.value ? `⌥⌘${key}` : `Alt+${key}`);
const withShortcut = (label: string, shortcut: string): string => (shortcut === '' ? label : t('search.withShortcut', { label, shortcut }));
const replaceAllShortcut = computed(() => (isMac.value ? '⌥⌘Enter' : 'Ctrl+Alt+Enter'));

const searching = computed(() => status.value.kind === 'searching');
// The sweep starts with a search and stops once the line has faded out, so no animation runs while Search is idle.
const sweeping = ref(false);
watch(searching, (now) => {
  if (now) sweeping.value = true;
});
const hasResults = computed(() => store.resultCount.value > 0);
const summary = computed(() => t('search.summary', {
  results: t('search.results', store.resultCount.value, { named: { count: store.resultCount.value.toLocaleString(locale.value) } }),
  files: t('search.files', store.fileCount.value, { named: { count: store.fileCount.value.toLocaleString(locale.value) } }),
}));
const done = computed(() => (status.value.kind === 'done' ? status.value : undefined));
const limitHit = computed(() => done.value?.limitHit === true);
const replaceMode = computed(() => view.value.replaceOpen);
// VS Code shows the struck match and its replacement only once a replacement is typed.
const replacing = computed(() => replaceMode.value && replacement.value !== '');

// VS Code's onSearchComplete message when nothing was found, with the link it offers.
const emptyMessage = computed<{ text: string; link: 'searchAgain' | 'searchAgainInAll' | 'openSettings' } | undefined>(() => {
  const finished = done.value;
  if (!finished || finished.error !== undefined || hasResults.value) return undefined;
  if (finished.cancelled) return { text: t('search.canceled'), link: 'searchAgain' };
  const { include, exclude, onlyOpenEditors } = store.activeQuery.value ?? view.value;
  const scope = onlyOpenEditors ? 'openEditors' : 'files';
  const text = include !== '' && exclude !== ''
    ? t(`search.noResults.${scope}.includesExcludes`, { include, exclude })
    : include !== '' ? t(`search.noResults.${scope}.includes`, { include })
      : exclude !== '' ? t(`search.noResults.${scope}.excludes`, { exclude })
        : t(`search.noResults.${scope}.none`);
  return { text, link: include !== '' || exclude !== '' ? 'searchAgainInAll' : 'openSettings' };
});
const announcement = computed(() => {
  if (!done.value || done.value.error !== undefined) return '';
  if (emptyMessage.value) return emptyMessage.value.text;
  const result = t('search.ariaDone', { results: store.resultCount.value, files: store.fileCount.value });
  return limitHit.value ? `${result}. ${t('search.limitHit')}` : result;
});
const treeLabel = computed(() => (hasResults.value ? t('search.treeLabel', { summary: summary.value, pattern: store.activeQuery.value?.pattern ?? '' }) : t('search.emptySearch')));

// --- the view state: query changes search on type (main debounces), toggles and Enter search at once ------------------

let persistTimer: ReturnType<typeof setTimeout> | undefined;
function persist(): void {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => emit('viewState', store.persistedView()), PERSIST_DELAY_MS);
}
watch(() => view.value.history, persist);

function update(patch: Partial<SearchViewState>): void {
  view.value = { ...view.value, ...patch };
  persist();
}

/** A typed query, include or exclude: searches as you type while search.searchOnType is on. */
function setText(key: 'pattern' | 'include' | 'exclude', value: string): void {
  if (view.value[key] === value) return;
  update({ [key]: value });
  if (props.settings.searchOnType) void store.run(false);
}

/** An option toggle: VS Code re-runs the query at once. */
function setOption(key: 'matchCase' | 'wholeWord' | 'isRegex' | 'useExcludeSettingsAndIgnoreFiles' | 'onlyOpenEditors', value: boolean): void {
  update({ [key]: value });
  void store.run(true);
}

function submit(): void {
  store.addToHistory('query', view.value.pattern);
  void store.run(true);
}

const historyOf = (field: HistoryField) => ({
  previous: (value: string) => store.historyPrevious(field, value),
  next: (value: string) => store.historyNext(field, value),
});
const queryPlaceholder = computed(() => (store.hasHistory('query') ? t('search.queryPlaceholderHistory') : t('search.query')));

// VS Code's option keys while a Search input has focus: Alt+C/W/R/P (Cmd+Alt on macOS).
function onOptionKey(event: KeyboardEvent): boolean {
  if (!event.altKey || event.shiftKey || (isMac.value ? !event.metaKey : event.ctrlKey || event.metaKey)) return false;
  const option = ({ KeyC: 'matchCase', KeyW: 'wholeWord', KeyR: 'isRegex', KeyP: 'preserveCase' } as const)[event.code as 'KeyC' | 'KeyW' | 'KeyR' | 'KeyP'];
  if (!option) return false;
  event.preventDefault();
  if (option === 'preserveCase') update({ preserveCase: !view.value.preserveCase });
  else setOption(option, !view.value[option]);
  return true;
}

// Ctrl+Down / Ctrl+Up: VS Code's Focus Next / Previous Input, in the order query, replace, include, exclude, results.
function onFocusKey(event: KeyboardEvent, from: 'query' | 'replace' | 'include' | 'exclude'): boolean {
  const ctrl = isMac.value ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!ctrl || event.altKey || event.shiftKey || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return false;
  event.preventDefault();
  if (event.key === 'ArrowDown') focusNextInput(from);
  else focusPreviousInput(from);
  return true;
}

function focusNextInput(from: 'query' | 'replace' | 'include' | 'exclude'): void {
  if (from === 'query' && view.value.replaceOpen) replaceField.value?.focus();
  else if (from === 'query' || from === 'replace') {
    if (view.value.detailsOpen) focusDetail(includeField);
    else selectTree();
  } else if (from === 'include') focusDetail(excludeField);
  else selectTree();
}

function focusPreviousInput(from: 'query' | 'replace' | 'include' | 'exclude' | 'tree'): void {
  if (from === 'replace') queryField.value?.focus();
  else if (from === 'include') (view.value.replaceOpen ? replaceField : queryField).value?.focus();
  else if (from === 'exclude') focusDetail(includeField);
  else if (from === 'tree') {
    if (view.value.detailsOpen) focusDetail(excludeField);
    else (view.value.replaceOpen ? replaceField : queryField).value?.focus();
  }
}

function focusDetail(field: typeof includeField): void {
  field.value?.focus();
  field.value?.select();
}

function selectTree(): void {
  const first = rows.value[0];
  if (first) void focusRow(focusedKey.value ?? first.key);
}

function onQueryKeydown(event: KeyboardEvent): void {
  if (onOptionKey(event) || onFocusKey(event, 'query')) return;
  if (event.key === 'Enter' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    event.preventDefault();
    submit();
  } else if (event.key === 'Escape') {
    // VS Code's onSearchCancel: the run stops, the input keeps its text and focus.
    event.preventDefault();
    void store.cancel();
  } else if (event.key === 'Enter' && event.altKey && !isMac.value) {
    event.preventDefault();
    void store.openInEditor();
  }
}

function onReplaceKeydown(event: KeyboardEvent): void {
  if (onOptionKey(event) || onFocusKey(event, 'replace')) return;
  const replaceAllKeys = event.key === 'Enter' && event.altKey && (isMac.value ? event.metaKey : event.ctrlKey);
  if (replaceAllKeys) {
    event.preventDefault();
    void replaceAll();
  } else if (event.key === 'Enter' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    event.preventDefault();
    submit();
  } else if (event.key === 'Escape') {
    // Close Replace Widget
    event.preventDefault();
    update({ replaceOpen: false });
    queryField.value?.focus();
  }
}

function onGlobKeydown(event: KeyboardEvent, from: 'include' | 'exclude'): void {
  if (onOptionKey(event) || onFocusKey(event, from)) return;
  if (event.key === 'Enter' && !event.altKey && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    submit();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    void store.cancel();
  }
}

async function clearAll(): Promise<void> {
  update({ pattern: '' });
  notices.value = [];
  await store.clear();
  queryField.value?.focus();
}

function toggleDetails(moveFocus: boolean): void {
  const open = !view.value.detailsOpen;
  update({ detailsOpen: open });
  if (!moveFocus) return;
  void nextTick(() => (open ? focusDetail(includeField) : queryField.value?.focus()));
}

async function replaceAll(): Promise<void> {
  notices.value = [];
  showSkips((await store.replaceAll())?.bufferSkipped ?? []);
}

// Main posts its own notice for the files it skipped; the buffers the shell could not replace are listed here.
function showSkips(skipped: readonly BufferSkip[]): void {
  notices.value = skipped.map((skip) => t(`search.skipped.${skip.reason}`, { name: skip.name }));
}

// The message line's links (VS Code's SearchLinkButton targets).
function enableExcludes(): void {
  update({ detailsOpen: true });
  setOption('useExcludeSettingsAndIgnoreFiles', true);
}

function disableOpenEditors(): void {
  update({ detailsOpen: true });
  setOption('onlyOpenEditors', false);
}

function searchAgainInAll(): void {
  update({ include: '', exclude: '', onlyOpenEditors: false });
  void store.run(true);
}

// --- glob edits from the results (VS Code's searchActionsFind.ts) ------------------------------------------------------

/** Restrict Search to Folder / Exclude Folder from Search: the folder replaces the include or exclude text. */
function searchInFolder(path: string, include: boolean): void {
  const glob = folderGlob(path);
  update({ [include ? 'include' : 'exclude']: glob, detailsOpen: true });
  void store.run(true);
}

/** Exclude / Include File Type: `*.ext` joins the list unless it is there. */
function addFileType(fileName: string, exclude: boolean): void {
  const key = exclude ? 'exclude' : 'include';
  const merged = mergeGlob(view.value[key], fileTypeGlob(fileName));
  if (merged === view.value[key]) return;
  update({ [key]: merged, detailsOpen: true });
  void store.run(true);
}

// --- project switch, Find in Files, main's commands ------------------------------------------------------------------

watch(() => props.projectKey, (key) => {
  store.setProject(key, props.saved);
  notices.value = [];
  focusedKey.value = null;
}, { immediate: true });
// Clear Search History empties every project's history in main.
watch(() => props.saved?.history, () => {
  if (props.saved) store.syncHistories(props.saved);
});

function seedFromEditor(): boolean {
  const seed = editor.activeSelectionText(props.settings.seedWithNearestWord);
  if (seed === undefined || seed === view.value.pattern) return false;
  setText('pattern', seed.slice(0, MAX_SEARCH_PATTERN_LENGTH));
  return true;
}

function onQueryFocus(): void {
  if (props.settings.seedOnFocus) seedFromEditor();
}

function runCommand(message: SearchCommandMessage): void {
  if (message.target !== 'view') return;
  switch (message.command) {
    case 'focusNextResult': stepResult(1); break;
    case 'focusPreviousResult': stepResult(-1); break;
    case 'toggleQueryDetails': toggleDetails(true); break;
    case 'refresh': void store.run(true); break;
    case 'clearResults': void clearAll(); break;
    case 'collapseAll': collapseAll(); break;
    case 'expandAll': store.expandAll(); break;
    case 'viewAsTree': update({ viewMode: 'tree' }); break;
    case 'viewAsList': update({ viewMode: 'list' }); break;
    case 'openNewSearchEditor': void store.openNewEditor(); break;
  }
}

const stops: Array<() => void> = [];
onMounted(() => {
  store.start();
  stops.push(props.api.onSearchFocus(({ replace, include }) => {
    emit('expand');
    if (replace && !view.value.replaceOpen) update({ replaceOpen: true });
    if (include !== undefined) {
      update({ include, detailsOpen: true });
      if (view.value.pattern !== '') void store.run(true);
    } else seedFromEditor();
    void nextTick(() => {
      queryField.value?.focus();
      queryField.value?.select();
    });
  }));
  stops.push(props.api.onSearchCommand(runCommand));
});

onBeforeUnmount(() => {
  for (const stop of stops) stop();
  store.stop();
  clearTimeout(persistTimer);
});

// --- the result tree: keyboard and focus -----------------------------------------------------------------------------

const focusedIndex = computed(() => {
  const index = rows.value.findIndex((row) => row.key === focusedKey.value);
  return index >= 0 ? index : Math.min(focusedHint, rows.value.length - 1);
});
watch(focusedIndex, (index) => {
  if (index >= 0) focusedHint = index;
});

const rowElement = (key: string): HTMLElement | null =>
  containerProps.ref.value?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(key)}"] [role="treeitem"]`) ?? null;

function revealIndex(index: number): void {
  const container = containerProps.ref.value;
  if (!container || index < 0) return;
  const height = remPx(ROW_REM);
  const top = index * height;
  if (top < container.scrollTop) container.scrollTop = top;
  else if (top + height > container.scrollTop + container.clientHeight) container.scrollTop = top + height - container.clientHeight;
}

async function focusRow(key: string): Promise<void> {
  focusedKey.value = key;
  revealIndex(rows.value.findIndex((row) => row.key === key));
  await nextTick();
  rowElement(key)?.focus({ preventScroll: true });
}

// A focused row the list scrolls out of view unmounts; the tree keeps focus so the keys still reach it.
watch(visibleRows, () => {
  const container = containerProps.ref.value;
  const key = focusedKey.value;
  if (!container || key === null || !container.contains(document.activeElement)) return;
  if (!rowElement(key) && document.activeElement !== container) container.focus({ preventScroll: true });
});

function moveFocus(index: number): void {
  const row = rows.value[Math.min(Math.max(index, 0), rows.value.length - 1)];
  if (row) void focusRow(row.key);
}

// A click shows a match with focus kept in the results; a folder or file row expands or collapses (VS Code's tree).
function activate(row: ResultRow): void {
  focusedKey.value = row.key;
  if (row.kind === 'match') void openRow(row, { focus: false, toSide: false });
  else store.toggleCollapsed(row.key);
}

async function openRow(row: Extract<ResultRow, { kind: 'file' | 'match' }>, options: { focus: boolean; toSide: boolean }): Promise<void> {
  const reason = await store.open(row, options);
  notices.value = reason === undefined ? [] : [t(`search.previewSkipped.${reason}`, { name: row.file.relativePath })];
}

async function replaceRow(row: ResultRow): Promise<void> {
  notices.value = [];
  showSkips((await store.replaceRow(row)).bufferSkipped);
}

/** F4 / Shift+F4: the next match is selected and shown, focus stays where it is (VS Code's selectNextMatch). */
function stepResult(step: 1 | -1): void {
  const target = store.stepMatch(focusedKey.value, step);
  if (!target) return;
  focusedKey.value = target.key;
  void nextTick(() => revealIndex(rows.value.findIndex((row) => row.key === target.key)));
  void openRow(target, { focus: false, toSide: false });
}

function collapseAll(): void {
  store.collapseAll();
  scrollTo(0);
}

const ctrlOrCmd = (event: KeyboardEvent): boolean => (isMac.value ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);

// VS Code's Copy Path: Shift+Alt+C on Windows, Ctrl+Alt+C on Linux, Cmd+Alt+C on macOS.
const copyPathKeys = (event: KeyboardEvent): boolean => event.code === 'KeyC' && event.altKey && (props.platform === 'win32'
  ? event.shiftKey && !event.ctrlKey && !event.metaKey
  : !event.shiftKey && (isMac.value ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey));
const copyPathLabel = computed(() => (props.platform === 'win32' ? 'Shift+Alt+C' : isMac.value ? '⌥⌘C' : 'Ctrl+Alt+C'));

function onRowShortcut(event: KeyboardEvent, row: ResultRow): boolean {
  const key = event.key.toLowerCase();
  const pathRow = row.kind === 'folder' || !row.file.untitled;
  // Ctrl+Enter (macOS Ctrl+Enter): Open Match To Side
  if (event.key === 'Enter' && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && row.kind !== 'folder') void openRow(row, { focus: true, toSide: true });
  else if (event.key === 'Enter' && (isMac.value ? event.metaKey : event.altKey) && !event.shiftKey) void store.openInEditor();
  else if (replaceMode.value && ctrlOrCmd(event) && event.shiftKey && (event.code === 'Digit1' || (event.key === 'Enter' && row.kind !== 'match'))) void replaceRow(row);
  else if (ctrlOrCmd(event) && event.shiftKey && key === 'l' && row.kind !== 'folder') void store.addCursors(row);
  else if (row.kind !== 'folder' && ctrlOrCmd(event) && !event.shiftKey && !event.altKey && key === 'c') void store.copy(row);
  else if (pathRow && copyPathKeys(event)) void copyPath(row, false);
  else if (row.kind === 'folder' && event.shiftKey && event.altKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyF') searchInFolder(row.node.path, true);
  else if (isMac.value && event.metaKey && event.key === 'Backspace') void store.dismiss(row);
  else if (ctrlOrCmd(event) && event.key === 'ArrowUp' && rows.value[0]?.key === row.key) focusPreviousInput('tree');
  else return false;
  return true;
}

// The row's parent: the nearest row above it one level up (0 for a top-level row, which has none).
function parentIndex(index: number): number {
  const level = rows.value[index]?.level ?? 1;
  for (let candidate = index - 1; candidate >= 0; candidate--) if (rows.value[candidate]!.level < level) return candidate;
  return index;
}

function onKeydown(event: KeyboardEvent): void {
  const index = focusedIndex.value;
  const row = rows.value[index];
  if (!row) return;
  if (onRowShortcut(event, row)) {
    event.preventDefault();
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const page = Math.max(1, Math.floor((containerProps.ref.value?.clientHeight ?? 0) / remPx(ROW_REM)) - 1);
  switch (event.key) {
    case 'ArrowDown': moveFocus(index + 1); break;
    case 'ArrowUp': moveFocus(index - 1); break;
    case 'PageDown': moveFocus(index + page); break;
    case 'PageUp': moveFocus(index - page); break;
    case 'Home': moveFocus(0); break;
    case 'End': moveFocus(rows.value.length - 1); break;
    case 'ArrowRight':
      if (row.kind === 'match') return;
      if (!row.expanded) store.toggleCollapsed(row.key);
      else moveFocus(index + 1);
      break;
    case 'ArrowLeft':
      if (row.kind !== 'match' && row.expanded) store.toggleCollapsed(row.key);
      else moveFocus(parentIndex(index));
      break;
    case 'Enter':
      if (row.kind === 'folder') store.toggleCollapsed(row.key);
      else void openRow(row, { focus: true, toSide: false });
      break;
    case ' ':
      activate(row);
      break;
    case 'Delete': void store.dismiss(row); break;
    case 'Escape': void store.cancel(); break;
    case 'ContextMenu': void openMenu(row, rowElement(row.key)?.getBoundingClientRect()); break;
    case 'F10':
      if (!event.shiftKey) return;
      void openMenu(row, rowElement(row.key)?.getBoundingClientRect());
      break;
    default:
      return;
  }
  event.preventDefault();
}

// --- the result context menu (VS Code's MenuId.SearchContext, plus Damocles' Mention, Open to the Side, Reveal) ---------

const fileRefOf = (row: ResultRow): FileRef | undefined => {
  const key = props.projectKey;
  if (key === undefined) return undefined;
  if (row.kind === 'folder') return { projectKey: key, relativePath: row.node.path };
  return row.file.untitled ? undefined : { projectKey: key, relativePath: row.file.relativePath };
};

async function copyPath(row: ResultRow, relative: boolean): Promise<void> {
  const file = fileRefOf(row);
  if (file) await props.api.copyFilePath(file, relative);
}

type Icon = Extract<OverlayMenuItem, { kind: 'item' }>['icon'];
const item = (id: string, label: string, icon: Icon, shortcut?: string): OverlayMenuItem => ({ kind: 'item', id, label, ...(icon ? { icon } : {}), ...(shortcut ? { shortcut } : {}) });
const separator: OverlayMenuItem = { kind: 'separator' };

function menuItems(row: ResultRow): OverlayMenuItem[] {
  const file = fileRefOf(row);
  const mod = isMac.value ? '⌘' : 'Ctrl+';
  const replaceItems = replaceMode.value
    ? [row.kind === 'match' ? item('replace', t('search.replaceOne'), 'replace', `${mod}Shift+1`) : item('replace', t('search.replaceAll'), 'replace-all', `${mod}Shift+1`)]
    : [];
  const open = row.kind === 'folder'
    ? []
    : [item('open', t('search.menu.open'), 'file', 'Enter'), item('openToSide', t('search.menu.openToSide'), 'panel-right', isMac.value ? '⌃Enter' : 'Ctrl+Enter'), ...(file ? [item('mention', t('files.menu.mention'), 'at-sign')] : []), separator];
  const scope = !file
    ? []
    : row.kind === 'folder'
      ? [item('restrict', t('search.menu.restrict'), 'search', isMac.value ? '⇧⌥F' : 'Shift+Alt+F'), item('excludeFolder', t('search.menu.excludeFolder'), 'folder-minus'), item('expandRecursively', t('search.menu.expandRecursively'), 'chevrons-up-down')]
      : row.kind === 'file'
        ? [item('excludeType', t('search.menu.excludeType'), 'filter-x'), item('includeType', t('search.menu.includeType'), 'filter')]
        : [];
  const copyPaths = file ? [item('copyPath', t('search.menu.copyPath'), 'copy', copyPathLabel.value), item('copyRelativePath', t('search.menu.copyRelativePath'), 'copy')] : [];
  const reveal = file ? [item('revealInFiles', t('search.menu.revealInFiles'), 'list-tree'), item('reveal', t('files.menu.reveal'), 'folder-search')] : [];
  return tidyMenu([
    ...open,
    ...replaceItems,
    item('dismiss', t('search.dismiss'), 'x', isMac.value ? '⌘⌫' : 'Del'),
    ...scope,
    separator,
    // VS Code's Copy is for files and matches only (FileMatchOrMatchFocusKey).
    ...(row.kind === 'folder' ? [] : [item('copy', t('search.menu.copy'), 'copy', `${mod}C`)]),
    ...copyPaths,
    item('copyAll', t('search.menu.copyAll'), 'copy'),
    separator,
    ...reveal,
  ]);
}

async function openMenu(row: ResultRow, rect: DOMRect | { left: number; top: number; width: number; height: number } | undefined): Promise<void> {
  if (props.projectKey === undefined || !rect) return;
  focusedKey.value = row.key;
  const file = fileRefOf(row);
  const caption = row.kind === 'folder' ? row.node.path : row.file.relativePath;
  const answer = await props.api.requestOverlay({
    kind: 'menu',
    label: t('files.menu.label', { name: caption.slice(caption.lastIndexOf('/') + 1) }),
    caption,
    anchor: { x: Math.max(0, rect.left), y: Math.max(0, rect.top), width: rect.width, height: rect.height },
    items: menuItems(row),
  });
  if (answer.kind !== 'menu') return;
  switch (answer.itemId) {
    case 'open': if (row.kind !== 'folder') await openRow(row, { focus: true, toSide: false }); break;
    case 'openToSide': if (row.kind !== 'folder') await openRow(row, { focus: true, toSide: true }); break;
    case 'mention': if (file) await props.api.mentionFile(file); break;
    case 'replace': await replaceRow(row); break;
    case 'dismiss': await store.dismiss(row); break;
    case 'restrict': if (row.kind === 'folder') searchInFolder(row.node.path, true); break;
    case 'excludeFolder': if (row.kind === 'folder') searchInFolder(row.node.path, false); break;
    case 'expandRecursively': if (row.kind === 'folder') store.expandRecursively(row); break;
    case 'excludeType': if (row.kind === 'file') addFileType(row.file.relativePath.slice(row.file.relativePath.lastIndexOf('/') + 1), true); break;
    case 'includeType': if (row.kind === 'file') addFileType(row.file.relativePath.slice(row.file.relativePath.lastIndexOf('/') + 1), false); break;
    case 'copy': await store.copy(row); break;
    case 'copyPath': await copyPath(row, false); break;
    case 'copyRelativePath': await copyPath(row, true); break;
    case 'copyAll': await store.copy('all'); break;
    case 'revealInFiles': if (file) emit('revealInFiles', file); break;
    case 'reveal': if (file) await props.api.revealFile(file); break;
  }
}

function onRowMenu(event: MouseEvent, row: ResultRow): void {
  void openMenu(row, { left: event.clientX, top: event.clientY, width: 0, height: 0 });
}

// Only a row that shows a replacement needs the query's RegExp, which the store compiles once per search.
const inserted = (row: ResultRow): string | undefined => {
  const query = store.replaceQuery.value;
  return replacing.value && row.kind === 'match' && query ? insertedText(query, row.match, replacement.value, view.value.preserveCase, store.previewRegExp.value) : undefined;
};

const toolbarButton = 'size-5.5 rounded-md text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-3.25';
</script>

<template>
  <SidebarSection
    :title="t('search.heading')"
    :collapsed="collapsed"
    :body-size="bodySize"
    data-testid="search-section"
    @toggle="emit('toggle')"
  >
    <template #actions>
      <!-- VS Code's title bar: Refresh (Cancel Search while running), Clear, Open New Search Editor, View as Tree/List, Collapse/Expand All. -->
      <Button
        v-if="searching"
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="search-cancel"
        :class="toolbarButton"
        :aria-label="t('search.cancel')"
        :title="t('search.cancel')"
        @click="store.cancel()"
      >
        <CircleStop aria-hidden="true" />
      </Button>
      <Button
        v-else
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="search-refresh"
        :class="toolbarButton"
        :disabled="view.pattern === '' || projectKey === undefined"
        :aria-label="t('search.refresh')"
        :title="t('search.refresh')"
        @click="store.run(true)"
      >
        <RefreshCw aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="search-clear"
        :class="toolbarButton"
        :disabled="view.pattern === '' && !hasResults"
        :aria-label="t('search.clear')"
        :title="t('search.clear')"
        @click="clearAll"
      >
        <SearchX aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="search-new-editor"
        :class="toolbarButton"
        :disabled="projectKey === undefined"
        :aria-label="t('search.openNewEditor')"
        :title="t('search.openNewEditor')"
        @click="store.openNewEditor()"
      >
        <FilePlus aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="search-view-mode"
        :data-view-mode="view.viewMode"
        :class="toolbarButton"
        :aria-label="view.viewMode === 'list' ? t('search.viewAsTree') : t('search.viewAsList')"
        :title="view.viewMode === 'list' ? t('search.viewAsTree') : t('search.viewAsList')"
        @click="update({ viewMode: view.viewMode === 'list' ? 'tree' : 'list' })"
      >
        <ListTree
          v-if="view.viewMode === 'list'"
          aria-hidden="true"
        />
        <List
          v-else
          aria-hidden="true"
        />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="search-collapse-all"
        :data-action="store.anyExpanded.value || !hasResults ? 'collapse' : 'expand'"
        :class="toolbarButton"
        :disabled="!hasResults"
        :aria-label="store.anyExpanded.value || !hasResults ? t('search.collapseAll') : t('search.expandAll')"
        :title="store.anyExpanded.value || !hasResults ? t('search.collapseAll') : t('search.expandAll')"
        @click="store.anyExpanded.value ? collapseAll() : store.expandAll()"
      >
        <CopyMinus
          v-if="store.anyExpanded.value || !hasResults"
          aria-hidden="true"
        />
        <CopyPlus
          v-else
          aria-hidden="true"
        />
      </Button>
    </template>

    <div
      class="flex shrink-0 flex-col gap-1 pt-0.5 pr-2.5 pb-1.5 pl-1"
      @keydown.esc.stop
    >
      <!-- The replace chevron spans the query and replace fields, as in VS Code. -->
      <div class="flex gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-testid="search-toggle-replace"
          class="h-auto w-4.5 shrink-0 self-stretch rounded-md text-(--d-faint) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-3.25"
          :aria-label="t('search.toggleReplace')"
          :title="t('search.toggleReplace')"
          :aria-expanded="view.replaceOpen"
          @click="update({ replaceOpen: !view.replaceOpen })"
        >
          <ChevronRight
            aria-hidden="true"
            class="transition-transform duration-200 ease-out"
            :class="view.replaceOpen ? 'rotate-90' : ''"
          />
        </Button>
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <SearchField
            ref="queryField"
            multiline
            testid="search-query"
            :model-value="view.pattern"
            :maxlength="MAX_SEARCH_PATTERN_LENGTH"
            :label="t('search.queryAria')"
            :placeholder="queryPlaceholder"
            :controls="treeId"
            :history="historyOf('query')"
            :is-mac="isMac"
            @update:model-value="setText('pattern', $event)"
            @keydown="onQueryKeydown"
            @focusin="onQueryFocus"
          >
            <SearchOption
              :model-value="view.matchCase"
              testid="search-option-matchCase"
              :label="t('search.matchCase')"
              :title="withShortcut(t('search.matchCase'), optionShortcut('C'))"
              :icon="CaseSensitive"
              @update:model-value="setOption('matchCase', $event)"
            />
            <SearchOption
              :model-value="view.wholeWord"
              testid="search-option-wholeWord"
              :label="t('search.wholeWord')"
              :title="withShortcut(t('search.wholeWord'), optionShortcut('W'))"
              :icon="WholeWord"
              @update:model-value="setOption('wholeWord', $event)"
            />
            <SearchOption
              :model-value="view.isRegex"
              testid="search-option-isRegex"
              :label="t('search.regex')"
              :title="withShortcut(t('search.regex'), optionShortcut('R'))"
              :icon="Regex"
              @update:model-value="setOption('isRegex', $event)"
            />
          </SearchField>
          <Transition name="search-replace">
            <div
              v-if="view.replaceOpen"
              class="flex items-start gap-1"
            >
              <SearchField
                ref="replaceField"
                v-model="replacement"
                multiline
                class="min-w-0 flex-1"
                testid="search-replace"
                :maxlength="MAX_REPLACEMENT_LENGTH"
                :label="t('search.replaceAria')"
                :placeholder="t('search.replace')"
                :history="historyOf('replace')"
                :is-mac="isMac"
                @keydown="onReplaceKeydown"
              >
                <SearchOption
                  :model-value="view.preserveCase"
                  testid="search-option-preserveCase"
                  :label="t('search.preserveCase')"
                  :title="withShortcut(t('search.preserveCase'), optionShortcut('P'))"
                  :icon="CaseUpper"
                  @update:model-value="update({ preserveCase: $event })"
                />
              </SearchField>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                data-testid="search-replace-all"
                class="size-7 shrink-0 rounded-md text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-3.5"
                :disabled="!hasResults"
                :aria-label="t('search.replaceAll')"
                :title="hasResults ? withShortcut(t('search.replaceAll'), replaceAllShortcut) : t('search.replaceAllDisabled')"
                @click="replaceAll"
              >
                <ReplaceAll aria-hidden="true" />
              </Button>
            </div>
          </Transition>
        </div>
      </div>
      <div class="flex flex-col gap-1 pl-5.5">
        <div class="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-testid="search-toggle-details"
            class="h-4.5 w-6 rounded-md text-(--d-faint) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-3.5"
            :aria-label="t('search.toggleDetails')"
            :title="withShortcut(t('search.toggleDetails'), shortcuts.toggleQueryDetails)"
            :aria-expanded="view.detailsOpen"
            @click="toggleDetails(false)"
          >
            <Ellipsis aria-hidden="true" />
          </Button>
        </div>
        <Transition name="search-replace">
          <div
            v-if="view.detailsOpen"
            class="flex flex-col gap-1"
          >
            <div class="flex flex-col gap-0.5">
              <span class="text-11 text-(--d-muted)">{{ t('search.include') }}</span>
              <SearchField
                ref="includeField"
                testid="search-include"
                :model-value="view.include"
                :maxlength="MAX_SEARCH_GLOBS_LENGTH"
                :label="t('search.include')"
                :placeholder="t('search.includePlaceholder')"
                :invalid="status.kind === 'invalidGlob'"
                :history="historyOf('include')"
                :is-mac="isMac"
                @update:model-value="setText('include', $event)"
                @keydown="onGlobKeydown($event, 'include')"
              >
                <SearchOption
                  :model-value="view.onlyOpenEditors"
                  testid="search-option-onlyOpenEditors"
                  :label="t('search.onlyOpenEditors')"
                  :title="t('search.onlyOpenEditors')"
                  :icon="BookOpen"
                  @update:model-value="setOption('onlyOpenEditors', $event)"
                />
              </SearchField>
            </div>
            <div class="flex flex-col gap-0.5">
              <span class="text-11 text-(--d-muted)">{{ t('search.exclude') }}</span>
              <SearchField
                ref="excludeField"
                testid="search-exclude"
                :model-value="view.exclude"
                :maxlength="MAX_SEARCH_GLOBS_LENGTH"
                :label="t('search.exclude')"
                :placeholder="t('search.excludePlaceholder')"
                :invalid="status.kind === 'invalidGlob'"
                :history="historyOf('exclude')"
                :is-mac="isMac"
                @update:model-value="setText('exclude', $event)"
                @keydown="onGlobKeydown($event, 'exclude')"
              >
                <SearchOption
                  :model-value="view.useExcludeSettingsAndIgnoreFiles"
                  testid="search-option-useExclude"
                  :label="t('search.useExclude')"
                  :title="t('search.useExclude')"
                  :icon="ListFilter"
                  @update:model-value="setOption('useExcludeSettingsAndIgnoreFiles', $event)"
                />
              </SearchField>
            </div>
          </div>
        </Transition>
      </div>
    </div>

    <!-- The indeterminate line holds its height while idle and fades out with its sweep, so a search moves nothing below it. -->
    <div
      data-testid="search-progress-track"
      class="h-0.5 shrink-0 transition-opacity duration-200"
      :class="searching ? 'opacity-100' : 'opacity-0'"
      @transitionend.self="sweeping = searching"
      @transitioncancel.self="sweeping = searching"
    >
      <div
        v-if="sweeping"
        :role="searching ? 'progressbar' : undefined"
        :aria-label="searching ? t('search.searching') : undefined"
        :data-testid="searching ? 'search-progress' : undefined"
        class="d-sweep-bar h-full text-(--d-accent)"
      />
    </div>

    <div class="flex shrink-0 flex-col gap-0.5 px-3 py-1 text-11.5">
      <!-- The first line is always there, so the tree's top stays put between idle, searching and done. Its links are bare
           buttons because they run inline in a sentence, where Button variant="link" (an inline-flex box with padding) cannot sit. -->
      <p class="min-h-4.5 leading-4.5 wrap-break-word">
        <span
          v-if="projectKey === undefined || status.kind === 'noProject'"
          class="text-(--d-faint-text)"
        >{{ t('search.noProject') }}</span>
        <span
          v-else-if="emptyMessage"
          data-testid="search-no-results"
          class="text-(--d-muted)"
        >{{ emptyMessage.text }} - <button
          type="button"
          data-testid="search-message-link"
          class="cursor-pointer text-(--d-accent) underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
          @click="emptyMessage.link === 'searchAgain' ? store.run(true) : emptyMessage.link === 'searchAgainInAll' ? searchAgainInAll() : api.openSettings('files')"
        >{{ t(`search.link.${emptyMessage.link}`) }}</button></span>
        <span
          v-else-if="hasResults"
          data-testid="search-summary"
          class="text-(--d-muted) tabular-nums"
        >{{ summary }}<template v-if="hasResults && store.activeQuery.value && !store.activeQuery.value.useExcludeSettingsAndIgnoreFiles">{{ ` - ${t('search.excludesDisabled')} (` }}<button
          type="button"
          data-testid="search-enable-excludes"
          class="cursor-pointer text-(--d-accent) underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
          :title="t('search.useExclude')"
          @click="enableExcludes"
        >{{ t('search.link.enable') }}</button>)</template><template v-if="hasResults && store.activeQuery.value?.onlyOpenEditors">{{ ` - ${t('search.searchingOpenFiles')} (` }}<button
          type="button"
          data-testid="search-disable-open-editors"
          class="cursor-pointer text-(--d-accent) underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
          :title="t('search.searchWorkspace')"
          @click="disableOpenEditors"
        >{{ t('search.link.disable') }}</button>)</template><template v-if="hasResults"> - <button
          type="button"
          data-testid="search-open-in-editor"
          class="cursor-pointer text-(--d-accent) underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
          :title="withShortcut(t('search.openInEditorTooltip'), isMac ? '⌘Enter' : 'Alt+Enter')"
          @click="store.openInEditor()"
        >{{ t('search.openInEditor') }}</button></template></span>
      </p>
      <p
        v-if="status.kind === 'invalidGlob'"
        role="alert"
        data-testid="search-invalid-glob"
        class="wrap-break-word text-(--d-danger-text)"
      >
        {{ t('search.invalidGlob', { glob: status.glob }) }}
      </p>
      <p
        v-else-if="done?.error !== undefined"
        role="alert"
        data-testid="search-error"
        class="wrap-break-word text-(--d-danger-text)"
      >
        {{ t('search.error', { message: done.error }) }}
      </p>
      <p
        v-if="limitHit"
        data-testid="search-limit"
        class="flex items-start gap-1.25 text-(--d-warning-text)"
      >
        <TriangleAlert
          aria-hidden="true"
          class="mt-0.5 size-3 shrink-0"
        />{{ t('search.limitHit') }}
      </p>
      <p
        v-if="done?.bufferWarning"
        data-testid="search-buffer-warning"
        class="flex items-start gap-1.25 text-(--d-warning-text)"
      >
        <TriangleAlert
          aria-hidden="true"
          class="mt-0.5 size-3 shrink-0"
        />{{ t(`search.bufferWarning.${done.bufferWarning}`) }}
      </p>
      <p
        v-for="skip in notices"
        :key="skip"
        role="status"
        class="text-(--d-warning-text)"
      >
        {{ skip }}
      </p>
      <!-- Announced once a search settles, not on every streamed batch. -->
      <p
        role="status"
        class="sr-only"
      >
        {{ announcement }}
      </p>
    </div>

    <div
      v-bind="containerProps"
      :id="treeId"
      role="tree"
      tabindex="-1"
      data-testid="search-tree"
      :data-view-mode="view.viewMode"
      :aria-label="treeLabel"
      :aria-describedby="helpId"
      :aria-busy="searching || undefined"
      class="@container/results min-h-0 flex-1 overflow-x-hidden pb-2 outline-none"
      @keydown="onKeydown"
    >
      <div v-bind="wrapperProps">
        <div
          v-for="{ data: row, index } in visibleRows"
          :key="row.key"
          role="none"
          :data-row-key="row.key"
        >
          <SearchResultRow
            :id="`${treeId}-${index}`"
            :row="row"
            :current="index === focusedIndex"
            :selected="row.key === openedKey"
            :height="remPx(ROW_REM)"
            :replace-mode="replaceMode"
            :replacing="replacing"
            :show-line-numbers="settings.showLineNumbers"
            :inline-actions="settings.actionsPosition === 'auto'"
            :show-folder="view.viewMode === 'list'"
            :inserted="inserted(row)"
            @activate="activate(row)"
            @open="row.kind !== 'folder' && openRow(row, { focus: true, toSide: false })"
            @focus="focusedKey = row.key"
            @replace="replaceRow(row)"
            @dismiss="store.dismiss(row)"
            @menu="onRowMenu($event, row)"
          />
        </div>
      </div>
    </div>
    <p
      :id="helpId"
      class="sr-only"
    >
      {{ t('search.keyboardHelp') }}
    </p>
  </SidebarSection>
</template>
