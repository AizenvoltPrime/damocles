<script setup lang="ts">
import { inject, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { editor as MonacoEditor, IDisposable } from 'monaco-editor/editor/editor.api';
import type { DamoclesShellApi, EditorMenuShortcut, ShellEditorSettings, ShellEditorTab } from '../../preload/shell-channels';
import { attachEditorContextMenu } from './context-menu';
import { EDITOR_STORE } from './editor-store';

// A diff tab: the original side is always read-only; the modified side is editable when main says the tab is (Compare from
// the conflict bar shows the dirty document there). Both sides share the models every other tab of those documents uses.
const props = defineProps<{
  api: DamoclesShellApi;
  tab: ShellEditorTab & { diff: NonNullable<ShellEditorTab['diff']> };
  menuShortcuts: Readonly<Record<EditorMenuShortcut, string>>;
}>();
const { t } = useI18n();
const store = inject(EDITOR_STORE)!;

const container = ref<HTMLElement | null>(null);
const editor = shallowRef<MonacoEditor.IStandaloneDiffEditor | null>(null);
const ready = ref(false);
const menus: IDisposable[] = [];
let stopFollowing: (() => void) | undefined;

function optionsFrom(settings: ShellEditorSettings | undefined): MonacoEditor.IDiffEditorOptions {
  return settings ? { fontSize: settings.fontSize, wordWrap: settings.wordWrap, renderWhitespace: settings.renderWhitespace } : {};
}

// The store moved a side's document to its new URI: the diff shows the new model, keeping its view state.
function takeModel(previous: MonacoEditor.ITextModel, next: MonacoEditor.ITextModel): void {
  const current = editor.value;
  const shown = current?.getModel();
  if (!current || !shown || (shown.original !== previous && shown.modified !== previous)) return;
  const viewState = current.saveViewState();
  current.setModel({ original: shown.original === previous ? next : shown.original, modified: shown.modified === previous ? next : shown.modified });
  if (viewState) current.restoreViewState(viewState);
}

onMounted(async () => {
  const [module, original, modified] = await Promise.all([store.monaco(), store.model(props.tab.diff.originalId), store.model(props.tab.diff.modifiedId)]);
  const host = container.value;
  if (!host) return;
  const monaco = module.useMonaco();
  const created = monaco.editor.createDiffEditor(host, {
    ...module.baseEditorOptions(),
    ...optionsFrom(store.settings.value),
    readOnly: props.tab.readOnly,
    originalEditable: false,
    renderSideBySide: true,
    useInlineViewWhenSpaceIsLimited: true,
    scrollBeyondLastLine: false,
    contextmenu: false,
  });
  created.setModel({ original, modified });
  // Where the reader was before another tab showed in this one's place.
  const viewState = store.viewStateOf(props.tab.id);
  if (viewState && 'modified' in viewState) created.restoreViewState(viewState);
  for (const side of [created.getOriginalEditor(), created.getModifiedEditor()]) {
    menus.push(attachEditorContextMenu(side, monaco, { api: props.api, t, shortcuts: () => props.menuShortcuts, hasGoToProvider: module.hasGoToProvider }));
  }
  editor.value = created;
  stopFollowing = store.onDidReplaceModel((_documentId, previous, next) => takeModel(previous, next));
  ready.value = true;
  if (store.takeFocus(props.tab.id)) created.getModifiedEditor().focus();
});

watch(() => props.tab.readOnly, (readOnly) => editor.value?.updateOptions({ readOnly }));
watch(() => store.settings.value, (settings) => editor.value?.updateOptions(optionsFrom(settings)), { deep: true });
watch(store.focusRequest, () => {
  if (editor.value && store.takeFocus(props.tab.id)) editor.value.getModifiedEditor().focus();
});

onBeforeUnmount(() => {
  if (editor.value) store.rememberViewState(props.tab.id, editor.value.saveViewState());
  stopFollowing?.();
  for (const menu of menus.splice(0)) menu.dispose();
  editor.value?.dispose();
});
</script>

<template>
  <div
    ref="container"
    data-testid="diff-editor"
    :data-monaco-ready="ready ? 'true' : undefined"
    class="absolute inset-0"
  />
</template>
