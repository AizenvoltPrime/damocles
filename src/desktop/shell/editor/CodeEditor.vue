<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { editor as MonacoEditor, IDisposable } from 'monaco-editor/editor/editor.api';
import type { DamoclesShellApi, EditorMenuShortcut, EditorSelectionRange, SearchRange, ShellEditorSettings, ShellEditorTab } from '../../preload/shell-channels';
import { reducedMotion } from '../reduced-motion';
import { attachEditorContextMenu } from './context-menu';
import { EDITOR_STORE } from './editor-store';

// One Monaco editor for every text tab: switching tabs swaps the shared model and restores that tab's view state, which the
// store keeps per tab, so it outlives this editor while another kind of tab shows.
const props = defineProps<{ api: DamoclesShellApi; tab: ShellEditorTab; menuShortcuts: Readonly<Record<EditorMenuShortcut, string>> }>();
const { t } = useI18n();
const store = inject(EDITOR_STORE)!;

// ms between selection reports while the caret moves; the IDE context needs the settled selection, not every step.
const SELECTION_THROTTLE_MS = 150;

const container = ref<HTMLElement | null>(null);
const editor = shallowRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
const shownTabId = ref<string | null>(null);
const disposables: IDisposable[] = [];
let unmounted = false;
let modelListener: IDisposable | undefined;
let selectionTimer: ReturnType<typeof setTimeout> | undefined;

const isLog = computed(() => props.tab.kind === 'log');
// The tabs the context menu offers Format Document in; a Search Editor's results and a log are not source.
const FORMATTED_KINDS: ReadonlySet<ShellEditorTab['kind']> = new Set(['code', 'untitled', 'settings']);

function optionsFrom(settings: ShellEditorSettings | undefined): MonacoEditor.IEditorOptions {
  if (!settings) return {};
  return {
    fontSize: settings.fontSize,
    wordWrap: settings.wordWrap,
    minimap: { enabled: settings.minimap },
    renderWhitespace: settings.renderWhitespace,
  };
}

// D36 logs follow their end only while the reader is there (docs/invariants.md "Streaming views", through Monaco's
// scroll API): any upward scroll stops following, and scrolling back to the end resumes it.
let following = true;
let programmaticScroll = false;
let lastScrollTop = 0;

function followEnd(): void {
  const current = editor.value;
  if (!current || !following) return;
  programmaticScroll = true;
  current.setScrollTop(current.getScrollHeight());
}

function onScroll(event: { scrollTop: number; scrollHeight: number; scrollTopChanged: boolean }): void {
  const current = editor.value;
  if (!current || !event.scrollTopChanged) return;
  const atEnd = event.scrollTop + current.getLayoutInfo().height >= event.scrollHeight - 2;
  if (programmaticScroll) programmaticScroll = false;
  else if (event.scrollTop < lastScrollTop) following = atEnd;
  else if (atEnd) following = true;
  lastScrollTop = event.scrollTop;
}

// Puts the caret on the line main named, or selects search matches (several for Add Cursors), and centres the first,
// leaving focus where it is.
function reveal({ line, selections }: { line: number; selections?: readonly SearchRange[] }): void {
  const current = editor.value;
  const model = current?.getModel();
  if (!current || !model) return;
  if (selections && selections.length > 0) {
    const ranges = selections.map((selection) => model.validateRange({ startLineNumber: selection.startLine, startColumn: selection.startColumn, endLineNumber: selection.endLine, endColumn: selection.endColumn }));
    current.setSelections(ranges.map((range) => ({ selectionStartLineNumber: range.startLineNumber, selectionStartColumn: range.startColumn, positionLineNumber: range.endLineNumber, positionColumn: range.endColumn })));
    current.revealRangeInCenterIfOutsideViewport(ranges[0]!);
    return;
  }
  const target = Math.min(Math.max(1, Math.trunc(line)), model.getLineCount());
  current.setPosition({ lineNumber: target, column: 1 });
  current.revealLineInCenter(target);
}

function currentSelection(): EditorSelectionRange | null | undefined {
  const selection = editor.value?.getSelection();
  if (!selection) return undefined;
  return selection.isEmpty()
    ? null
    : { startLine: selection.selectionStartLineNumber, startColumn: selection.selectionStartColumn, endLine: selection.positionLineNumber, endColumn: selection.positionColumn };
}

// The store keeps every selection at once, for Find in Files' seed; main gets the settled one.
function reportSelection(): void {
  const documentId = props.tab.documentId;
  const now = currentSelection();
  const caret = editor.value?.getPosition();
  if (documentId !== undefined && now !== undefined && caret) store.noteSelection(documentId, now, { line: caret.lineNumber, column: caret.column });
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => {
    const selection = currentSelection();
    if (documentId === undefined || selection === undefined || props.tab.documentId !== documentId) return;
    props.api.reportSelection({ documentId, selection });
  }, SELECTION_THROTTLE_MS);
}

async function show(tab: ShellEditorTab): Promise<void> {
  const current = editor.value;
  const documentId = tab.documentId;
  if (!current || documentId === undefined) return;
  if (shownTabId.value !== null) store.rememberViewState(shownTabId.value, current.saveViewState());
  const model = await store.model(documentId);
  // While the model loaded, another tab's show started (it wins) or this editor unmounted.
  if (unmounted || props.tab.id !== tab.id || model.isDisposed()) return;
  modelListener?.dispose();
  current.setModel(model);
  current.updateOptions({ readOnly: tab.readOnly, readOnlyMessage: { value: t(`editor.readOnly.${tab.readOnlyReason ?? 'log'}`) } });
  shownTabId.value = tab.id;
  const viewState = store.viewStateOf(tab.id);
  const saved = viewState && !('modified' in viewState) ? viewState : undefined;
  if (saved) current.restoreViewState(saved);
  following = tab.kind === 'log' && (!saved || current.getScrollTop() + current.getLayoutInfo().height >= current.getScrollHeight() - 2);
  lastScrollTop = current.getScrollTop();
  if (tab.kind === 'log') {
    followEnd();
    modelListener = model.onDidChangeContent(followEnd);
  }
  const request = store.takeReveal(tab.id);
  if (request !== undefined) reveal(request);
  reportSelection();
  if (store.takeFocus(tab.id)) current.focus();
}

// The store moved the shown document's model to its new URI: the editor shows the new model where the reader was.
function takeModel(previous: MonacoEditor.ITextModel, next: MonacoEditor.ITextModel): void {
  const current = editor.value;
  if (!current || current.getModel() !== previous) return;
  const viewState = current.saveViewState();
  modelListener?.dispose();
  current.setModel(next);
  if (viewState) current.restoreViewState(viewState);
  if (props.tab.kind === 'log') modelListener = next.onDidChangeContent(followEnd);
}

onMounted(async () => {
  const module = await store.monaco();
  const host = container.value;
  if (!host) return;
  const monaco = module.useMonaco();
  const created = monaco.editor.create(host, {
    ...module.baseEditorOptions(),
    ...optionsFrom(store.settings.value),
    model: null,
    readOnly: props.tab.readOnly,
    scrollBeyondLastLine: false,
    smoothScrolling: !reducedMotion(),
    fixedOverflowWidgets: true,
    contextmenu: false,
  });
  editor.value = created;
  disposables.push(
    created,
    created.onDidScrollChange(onScroll),
    created.onDidChangeCursorSelection(reportSelection),
    // VS Code's editorAutoSave.ts saves on the editor control's blur; the store coalesces it with the pane's focusout.
    created.onDidBlurEditorWidget(() => store.saveOnFocusChange()),
    attachEditorContextMenu(created, monaco, {
      api: props.api,
      t,
      shortcuts: () => props.menuShortcuts,
      hasGoToProvider: module.hasGoToProvider,
      // runCommand formats the active tab, which is the one this editor shows
      formatDocument: { available: () => !props.tab.readOnly && FORMATTED_KINDS.has(props.tab.kind), run: () => store.runCommand('formatDocument') },
    }),
    { dispose: store.onDidReplaceModel((_documentId, previous, next) => takeModel(previous, next)) },
  );
  await show(props.tab);
});

watch(() => [props.tab.id, props.tab.documentId, props.tab.readOnly] as const, () => void show(props.tab));
watch(() => store.settings.value, (settings) => editor.value?.updateOptions(optionsFrom(settings)), { deep: true });
watch(store.revealRequest, () => {
  if (shownTabId.value !== props.tab.id) return;
  const request = store.takeReveal(props.tab.id);
  if (request !== undefined) reveal(request);
});
watch(store.focusRequest, () => {
  if (shownTabId.value === props.tab.id && store.takeFocus(props.tab.id)) editor.value?.focus();
});

onBeforeUnmount(() => {
  unmounted = true;
  if (editor.value && shownTabId.value !== null) store.rememberViewState(shownTabId.value, editor.value.saveViewState());
  clearTimeout(selectionTimer);
  modelListener?.dispose();
  // The editor goes before the models it showed, which the store keeps and disposes.
  for (const disposable of disposables) disposable.dispose();
  disposables.length = 0;
});

defineExpose({ focus: () => editor.value?.focus(), isLog, editor, shownTabId });
</script>

<template>
  <div
    ref="container"
    data-testid="code-editor"
    :data-monaco-ready="shownTabId === tab.id ? 'true' : undefined"
    :data-document-id="tab.documentId"
    class="absolute inset-0"
  />
</template>
