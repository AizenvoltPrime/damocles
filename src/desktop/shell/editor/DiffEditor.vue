<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ExternalLink } from 'lucide-vue-next';
import type { editor as MonacoEditor, IDisposable } from 'monaco-editor/editor/editor.api';
import { Button } from '@/components/ui/button';
import type { DamoclesShellApi, EditorMenuShortcut, ShellEditorSettings, ShellEditorTab } from '../../preload/shell-channels';
import { attachEditorContextMenu } from './context-menu';
import { EDITOR_STORE } from './editor-store';
import { attachDiffGit, type DiffGit } from './diff-git';
import { addEditorGitKeybindings, gitKeyLabels } from './editor-keys';
import NotDisplayedNotice from './NotDisplayedNotice.vue';
import LoadFailedNotice from './LoadFailedNotice.vue';

// A diff tab: the original side is always read-only; the modified side is editable when main says the tab is (Compare from
// the conflict bar shows the dirty document there). Both sides share the models every other tab of those documents uses.
// A side main sends no text for shows its placeholder, and a text side opposite it shows in a plain editor, as VS Code's
// side-by-side binary diff does.
const props = defineProps<{
  api: DamoclesShellApi;
  tab: ShellEditorTab & { diff: NonNullable<ShellEditorTab['diff']> };
  menuShortcuts: Readonly<Record<EditorMenuShortcut, string>>;
}>();
const { t } = useI18n();
const store = inject(EDITOR_STORE)!;

const container = ref<HTMLElement | null>(null);
const sideHost = ref<HTMLElement | null>(null);
const editor = shallowRef<MonacoEditor.IStandaloneDiffEditor | null>(null);
const single = shallowRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
const ready = ref(false);
const menus: IDisposable[] = [];
let stopFollowing: (() => void) | undefined;
let diffGit: DiffGit | undefined;
let stopCommands: (() => void) | undefined;

// Main sends sides only when one is not text, and never changes them for a tab.
const sides = props.tab.diff.sides;
const textSide = sides === undefined ? undefined : sides.original.kind === 'text' ? 'original' : sides.modified.kind === 'text' ? 'modified' : null;
const columns = sides ? (['original', 'modified'] as const).map((key) => ({ key, side: sides[key] })) : [];
const sideId = (side: 'original' | 'modified'): string => (side === 'original' ? props.tab.diff.originalId : props.tab.diff.modifiedId);
// The documents shown as text; a remount of the tab asks main again for one whose load failed.
const textIds = textSide === undefined ? [sideId('original'), sideId('modified')] : textSide === null ? [] : [sideId(textSide)];
const failed = computed(() => textIds.some((documentId) => store.loadFailed(documentId)));

function setSideHost(element: unknown): void {
  sideHost.value = element instanceof HTMLElement ? element : null;
}

function optionsFrom(settings: ShellEditorSettings | undefined): MonacoEditor.IDiffEditorOptions {
  return settings ? { fontSize: settings.fontSize, wordWrap: settings.wordWrap, renderWhitespace: settings.renderWhitespace } : {};
}

// The original side never takes edits; the modified one follows the tab.
const singleReadOnly = computed(() => textSide === 'original' || props.tab.readOnly);

// The store moved a side's document to its new URI: the diff shows the new model, keeping its view state.
function takeModel(previous: MonacoEditor.ITextModel, next: MonacoEditor.ITextModel): void {
  const current = editor.value;
  const shown = current?.getModel();
  if (!current || !shown || (shown.original !== previous && shown.modified !== previous)) return;
  const viewState = current.saveViewState();
  current.setModel({ original: shown.original === previous ? next : shown.original, modified: shown.modified === previous ? next : shown.modified });
  if (viewState) current.restoreViewState(viewState);
}

function takeSingleModel(previous: MonacoEditor.ITextModel, next: MonacoEditor.ITextModel): void {
  const current = single.value;
  if (!current || current.getModel() !== previous) return;
  const viewState = current.saveViewState();
  current.setModel(next);
  if (viewState) current.restoreViewState(viewState);
}

async function mountSingle(side: 'original' | 'modified'): Promise<void> {
  const [module, content] = await Promise.all([store.monaco(), store.loadShown(sideId(side))]);
  if (content?.kind !== 'text') return;
  const model = await store.model(sideId(side));
  const host = sideHost.value;
  if (!host) return;
  const monaco = module.useMonaco();
  const created = monaco.editor.create(host, {
    ...module.baseEditorOptions(),
    ...optionsFrom(store.settings.value),
    readOnly: singleReadOnly.value,
    scrollBeyondLastLine: false,
    contextmenu: false,
  });
  created.setModel(model);
  const viewState = store.viewStateOf(props.tab.id);
  if (viewState && !('modified' in viewState)) created.restoreViewState(viewState);
  menus.push(attachEditorContextMenu(created, monaco, { api: props.api, t, shortcuts: () => props.menuShortcuts, hasGoToProvider: module.hasGoToProvider }));
  single.value = created;
  stopFollowing = store.onDidReplaceModel((_documentId, previous, next) => takeSingleModel(previous, next));
  ready.value = true;
  if (store.takeFocus(props.tab.id)) created.focus();
}

async function mountDiff(): Promise<void> {
  const [module, ...contents] = await Promise.all([store.monaco(), store.loadShown(sideId('original')), store.loadShown(sideId('modified'))]);
  if (contents.some((content) => content?.kind !== 'text')) return;
  const [original, modified] = await Promise.all([store.model(sideId('original')), store.model(sideId('modified'))]);
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
    // Stage Block and Stage Selection sit in the glyph margin of a diff against the index
    glyphMargin: props.tab.diff.git?.group === 'workingTree',
  });
  created.setModel({ original, modified });
  const git = props.tab.diff.git;
  if (git) {
    diffGit = attachDiffGit(created, monaco, git, {
      api: props.api,
      t: (key) => t(key),
      flush: (documentId) => store.flush(documentId),
      documentId: props.tab.diff.modifiedId,
      readOnly: () => props.tab.readOnly,
    });
    menus.push(diffGit);
  }
  // Every diff moves between its changes; a diff of a git change also stages, unstages and reverts.
  for (const side of [created.getOriginalEditor(), created.getModifiedEditor()]) {
    menus.push(addEditorGitKeybindings(side as MonacoEditor.IStandaloneCodeEditor, monaco, gitKeyLabels(t), (command) => void store.runCommand(command)));
  }
  stopCommands = store.setCommandTarget(props.tab.id, async (command) => {
    if (command === 'nextChange' || command === 'previousChange') created.goToDiff(command === 'nextChange' ? 'next' : 'previous');
    else await diffGit?.run(command);
  });
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
}

onMounted(async () => {
  if (textSide === undefined) await mountDiff();
  else if (textSide !== null) await mountSingle(textSide);
  else ready.value = true;
});

watch(() => props.tab.readOnly, (readOnly) => {
  editor.value?.updateOptions({ readOnly });
  single.value?.updateOptions({ readOnly: singleReadOnly.value });
});
watch(() => store.settings.value, (settings) => {
  editor.value?.updateOptions(optionsFrom(settings));
  single.value?.updateOptions(optionsFrom(settings));
}, { deep: true });
watch(store.focusRequest, () => {
  if (!store.takeFocus(props.tab.id)) return;
  editor.value?.getModifiedEditor().focus();
  single.value?.focus();
});

onBeforeUnmount(() => {
  const current = editor.value ?? single.value;
  if (current) store.rememberViewState(props.tab.id, current.saveViewState());
  stopFollowing?.();
  stopCommands?.();
  for (const menu of menus.splice(0)) menu.dispose();
  editor.value?.dispose();
  single.value?.dispose();
});
</script>

<template>
  <div class="absolute inset-0">
    <div
      v-if="sides"
      data-testid="diff-editor"
      :data-monaco-ready="ready ? 'true' : undefined"
      class="absolute inset-0 grid grid-cols-2"
    >
      <div
        v-for="{ key, side } in columns"
        :key="key"
        :data-side="key"
        class="relative min-w-0"
        :class="key === 'modified' ? 'border-l border-(--d-border)' : ''"
      >
        <NotDisplayedNotice
          v-if="side.kind === 'notDisplayed'"
          data-testid="diff-not-displayed"
          :reason="side.reason"
          :bytes="side.bytes"
        >
          <Button
            v-if="side.openable"
            size="sm"
            variant="outline"
            data-testid="diff-open-anyway"
            class="d-press mt-1 h-7 gap-1.5 rounded-7 border-(--d-border2) bg-(--d-card) px-3 text-12 hover:border-(--d-accent) hover:bg-(--d-card) [&_svg]:size-3.5"
            @click="api.editorTab({ action: 'openFile', tabId: tab.id })"
          >
            <ExternalLink aria-hidden="true" />{{ t('editor.notDisplayed.openAnyway') }}
          </Button>
        </NotDisplayedNotice>
        <div
          v-else
          :ref="setSideHost"
          data-testid="diff-text-side"
          class="absolute inset-0"
        />
      </div>
    </div>
    <div
      v-else
      ref="container"
      data-testid="diff-editor"
      :data-monaco-ready="ready ? 'true' : undefined"
      class="absolute inset-0"
    />
    <LoadFailedNotice
      v-if="failed"
      :tab="tab"
      class="absolute inset-0 bg-(--d-bg)"
    />
  </div>
</template>
