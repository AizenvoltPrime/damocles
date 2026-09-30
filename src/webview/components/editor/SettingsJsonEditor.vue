<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useEditorStore } from '@/stores/useEditorStore';
import type { SettingsFileOnDisk, SettingsFileScope, SettingsFileState } from '@shared/types/messages';
import settingsSchema from '@shared/generated/settings-schema.json';
import EditorOverlayFrame from './EditorOverlayFrame.vue';
import SettingsOverwriteConfirm from './SettingsOverwriteConfirm.vue';
import { baseEditorOptions, jsonDefaults, useMonaco, type Monaco } from './useMonaco';

const props = defineProps<{ scope: SettingsFileScope }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const { t } = useI18n();
const { postMessage } = usePlatformBridge();
const editorStore = useEditorStore();
const monaco = useMonaco();

type ReadyFile = Extract<SettingsFileState, { status: 'ready' }>;
type Marker = ReturnType<Monaco['editor']['getModelMarkers']>[number];
type Model = ReturnType<Monaco['editor']['createModel']>;

const modelUri = (scope: SettingsFileScope) => `inmemory://damocles/settings/${scope}.json`;

// The host parses these files with strict JSON.parse; project and local validate against the variant that flags user-only keys.
jsonDefaults.setDiagnosticsOptions({
  validate: true,
  allowComments: false,
  comments: 'error',
  trailingCommas: 'error',
  schemaValidation: 'error',
  enableSchemaRequest: false,
  schemas: [
    { uri: 'inmemory://damocles/schemas/settings-user.json', fileMatch: [modelUri('user')], schema: settingsSchema.user },
    { uri: 'inmemory://damocles/schemas/settings-project.json', fileMatch: [modelUri('project'), modelUri('local')], schema: settingsSchema.project },
  ],
});

const file = computed(() => editorStore.settingsFiles[props.scope]);
const readyFile = computed(() => (file.value?.status === 'ready' ? file.value : null));
const unavailableReason = computed(() => {
  const current = file.value;
  if (current?.status !== 'unavailable') return null;
  if (current.reason === 'unreadable') return t('settingsEditor.unreadable', { path: current.path, error: current.error });
  return current.reason === 'noProject' ? t('settings.jsonFiles.noProject') : t('settings.jsonFiles.untrusted');
});

const container = shallowRef<HTMLElement | null>(null);
const diffContainer = shallowRef<HTMLElement | null>(null);
const ready = ref(false);
const readOnly = ref(false);
const dirty = ref(false);
const saving = ref(false);
const savedNotice = ref(false);
const saveError = ref<string | null>(null);
const reloadOffered = ref(false);
const confirmingDiscard = ref(false);
const markers = shallowRef<Marker[]>([]);
/** The newer file a save conflicted with, until the user compares with it or overwrites it. */
const conflict = shallowRef<SettingsFileOnDisk | null>(null);
const comparing = ref(false);
const confirmingOverwrite = ref(false);

let model: Model | null = null;
let editor: ReturnType<Monaco['editor']['create']> | null = null;
const disposables: { dispose(): void }[] = [];
let diskModel: Model | null = null;
const compareDisposables: { dispose(): void }[] = [];
let baseVersion = '';
let savedContent = '';
let savingContent = '';
let reloadRequested = false;
let pendingChangedVersion: string | null = null;

function requestLoad(): void {
  postMessage({ type: 'settingsFileLoad', scope: props.scope });
}

function setContent(loaded: ReadyFile): void {
  if (!model) return;
  baseVersion = loaded.version;
  savedContent = loaded.content;
  if (model.getValue() !== loaded.content) model.setValue(loaded.content);
  dirty.value = false;
  readOnly.value = loaded.parseError !== undefined;
  editor?.updateOptions({ readOnly: readOnly.value });
}

function createEditor(loaded: ReadyFile): void {
  if (!container.value) throw new Error('SettingsJsonEditor received content before its container mounted');
  const uri = monaco.Uri.parse(modelUri(props.scope));
  model = monaco.editor.createModel(loaded.content, 'json', uri);
  editor = monaco.editor.create(container.value, { ...baseEditorOptions(), model, readOnly: loaded.parseError !== undefined });
  const current = model;
  disposables.push(
    editor,
    current,
    current.onDidChangeContent(() => {
      dirty.value = current.getValue() !== savedContent;
      savedNotice.value = false;
    }),
    monaco.editor.onDidChangeMarkers((uris) => {
      if (uris.some((changed) => changed.toString() === current.uri.toString())) markers.value = monaco.editor.getModelMarkers({ resource: current.uri });
    }),
  );
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, save);
  setContent(loaded);
  ready.value = true;
}

// A load answer replaces clean text; over unsaved edits it only offers a reload, unless the user asked for one.
watch(readyFile, (loaded) => {
  if (!loaded) return;
  if (!model) {
    createEditor(loaded);
    return;
  }
  if (reloadRequested || !dirty.value) {
    reloadRequested = false;
    reloadOffered.value = false;
    setContent(loaded);
    return;
  }
  if (loaded.version !== baseVersion) reloadOffered.value = true;
}, { flush: 'post' });

function handleDiskChange(): void {
  const version = pendingChangedVersion;
  pendingChangedVersion = null;
  if (version === null || version === baseVersion) return;
  if (dirty.value) reloadOffered.value = true;
  else requestLoad();
}

// A change notice during a save is held until the result names the version the save wrote.
watch(() => editorStore.changedVersions[props.scope], (changed) => {
  if (!changed) return;
  pendingChangedVersion = changed.version;
  if (!saving.value) handleDiskChange();
});

watch(() => editorStore.saveResults[props.scope], (result) => {
  if (!result || !saving.value) return;
  saving.value = false;
  if (result.ok) {
    baseVersion = result.version;
    savedContent = savingContent;
    dirty.value = model?.getValue() !== savedContent;
    savedNotice.value = true;
    endCompare();
  } else if (result.conflict && result.onDisk) {
    saveError.value = t('settingsEditor.conflict');
    conflict.value = result.onDisk;
  } else if (result.conflict) {
    saveError.value = result.error;
    reloadOffered.value = true;
  } else {
    saveError.value = result.error;
  }
  handleDiskChange();
});

const canSave = computed(() => ready.value && dirty.value && !readOnly.value && !saving.value);

function save(): void {
  if (!model || !canSave.value) return;
  savingContent = model.getValue();
  saving.value = true;
  saveError.value = null;
  conflict.value = null;
  savedNotice.value = false;
  postMessage({ type: 'settingsFileSave', scope: props.scope, content: savingContent, baseVersion });
}

// The user has seen the newer file, so saving from here on writes over it; the text in the editor stays theirs.
function adoptConflictBase(onDisk: SettingsFileOnDisk): void {
  baseVersion = onDisk.version;
  savedContent = onDisk.content;
  dirty.value = model?.getValue() !== savedContent;
  conflict.value = null;
  saveError.value = null;
  reloadOffered.value = false;
}

function compare(): void {
  const onDisk = conflict.value;
  if (!model || !onDisk) return;
  adoptConflictBase(onDisk);
  if (diskModel) {
    diskModel.setValue(onDisk.content);
    return;
  }
  if (!diffContainer.value) throw new Error('SettingsJsonEditor has no container for the comparison');
  diskModel = monaco.editor.createModel(onDisk.content, 'json');
  const diff = monaco.editor.createDiffEditor(diffContainer.value, { ...baseEditorOptions(), readOnly: false, originalEditable: false, renderSideBySide: true });
  // The diff editor is disposed first: it throws when a model it still shows is disposed.
  compareDisposables.push(diff, diskModel);
  diff.setModel({ original: diskModel, modified: model });
  diff.getModifiedEditor().addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, save);
  comparing.value = true;
}

function endCompare(): void {
  for (const d of compareDisposables) d.dispose();
  compareDisposables.length = 0;
  diskModel = null;
  comparing.value = false;
}

function overwrite(): void {
  const onDisk = conflict.value;
  confirmingOverwrite.value = false;
  if (!onDisk) return;
  adoptConflictBase(onDisk);
  save();
}

function reload(): void {
  reloadRequested = true;
  reloadOffered.value = false;
  saveError.value = null;
  conflict.value = null;
  endCompare();
  requestLoad();
}

function reveal(): void {
  postMessage({ type: 'revealSettingsFile', scope: props.scope });
}

const requestedTitle = computed(() => {
  const requested = editorStore.requestedSettingsScope;
  return requested === null ? null : t(`settingsEditor.title.${requested}`);
});

// Another settings file was asked for while this one is open: it replaces this one only once no edits would be lost.
watch(() => editorStore.requestedSettingsScope, (requested) => {
  if (requested === null) return;
  if (dirty.value) confirmingDiscard.value = true;
  else editorStore.switchToRequestedSettingsFile();
});

function keepEditing(): void {
  confirmingDiscard.value = false;
  editorStore.cancelSettingsFileRequest();
}

function discard(): void {
  if (editorStore.requestedSettingsScope !== null) editorStore.switchToRequestedSettingsFile();
  else emit('close');
}

function requestClose(): void {
  if (confirmingDiscard.value) {
    keepEditing();
    return;
  }
  if (dirty.value) {
    confirmingDiscard.value = true;
    return;
  }
  emit('close');
}

const status = computed(() => {
  if (saving.value) return t('settingsEditor.saving');
  if (dirty.value) return t('settingsEditor.unsaved');
  if (savedNotice.value) return t('settingsEditor.saved');
  return null;
});

onMounted(requestLoad);

onBeforeUnmount(() => {
  endCompare();
  for (const d of disposables) d.dispose();
  disposables.length = 0;
  editor = null;
  model = null;
});
</script>

<template>
  <EditorOverlayFrame
    :title="t(`settingsEditor.title.${scope}`)"
    :subtitle="readyFile?.path"
    close-test-id="settings-json-close"
    data-testid="settings-json-editor"
    :data-scope="scope"
    :data-dirty="dirty ? 'true' : 'false'"
    :data-comparing="comparing ? 'true' : 'false'"
    @close="requestClose"
  >
    <template #header-actions>
      <span
        v-if="status"
        class="text-xs text-muted-foreground shrink-0"
        aria-live="polite"
      >{{ status }}</span>
      <Button
        size="sm"
        :disabled="!canSave"
        data-testid="settings-json-save"
        @click="save"
      >
        {{ t('common.save') }}
      </Button>
    </template>

    <template #banner>
      <div
        v-if="confirmingDiscard"
        role="alert"
        data-testid="settings-json-discard-prompt"
        class="flex items-center gap-2 px-4 py-2 text-sm bg-muted border-b border-border/30"
      >
        <span class="flex-1">{{ requestedTitle ? t('settingsEditor.switchPrompt', { file: requestedTitle }) : t('settingsEditor.discardPrompt') }}</span>
        <Button
          size="sm"
          variant="secondary"
          data-testid="settings-json-keep-editing"
          @click="keepEditing"
        >
          {{ t('settingsEditor.keepEditing') }}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          data-testid="settings-json-discard"
          @click="discard"
        >
          {{ t('settingsEditor.discard') }}
        </Button>
      </div>
      <div
        v-if="readyFile?.parseError !== undefined"
        role="alert"
        class="flex items-center gap-2 px-4 py-2 border-b border-border/30"
      >
        <p
          data-testid="settings-json-parse-error"
          class="flex-1 text-sm text-destructive"
        >
          {{ t('settingsEditor.parseError', { error: readyFile?.parseError }) }}
        </p>
        <Button
          size="sm"
          variant="secondary"
          class="shrink-0"
          data-testid="settings-json-reveal"
          @click="reveal"
        >
          {{ t('settingsEditor.reveal') }}
        </Button>
      </div>
      <p
        v-else-if="readyFile && !readyFile.exists"
        class="px-4 py-2 text-xs text-muted-foreground border-b border-border/30"
      >
        {{ t('settingsEditor.notCreated') }}
      </p>
      <div
        v-if="conflict"
        role="alert"
        data-testid="settings-json-conflict"
        class="flex items-center gap-2 px-4 py-2 text-sm bg-muted border-b border-border/30"
      >
        <span
          data-testid="settings-json-error"
          class="flex-1 text-destructive"
        >{{ saveError }}</span>
        <Button
          size="sm"
          variant="secondary"
          data-testid="settings-json-compare"
          @click="compare"
        >
          {{ t('settingsEditor.compare') }}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          data-testid="settings-json-overwrite"
          @click="confirmingOverwrite = true"
        >
          {{ t('settingsEditor.overwrite') }}
        </Button>
      </div>
      <p
        v-else-if="saveError"
        role="alert"
        data-testid="settings-json-error"
        class="px-4 py-2 text-sm text-destructive border-b border-border/30"
      >
        {{ saveError }}
      </p>
      <div
        v-if="comparing"
        data-testid="settings-json-compare-banner"
        class="flex items-center gap-2 px-4 py-2 text-sm bg-muted border-b border-border/30"
      >
        <span class="flex-1">{{ t('settingsEditor.comparing') }}</span>
        <Button
          size="sm"
          variant="secondary"
          data-testid="settings-json-end-compare"
          @click="endCompare"
        >
          {{ t('settingsEditor.endCompare') }}
        </Button>
      </div>
      <div
        v-if="reloadOffered && !conflict"
        data-testid="settings-json-reload-prompt"
        class="flex items-center gap-2 px-4 py-2 text-sm bg-muted border-b border-border/30"
      >
        <span class="flex-1">{{ t('settingsEditor.changedOnDisk') }}</span>
        <Button
          size="sm"
          variant="secondary"
          data-testid="settings-json-reload"
          @click="reload"
        >
          {{ t('settingsEditor.reload') }}
        </Button>
      </div>
    </template>

    <div
      v-show="!comparing"
      ref="container"
      data-testid="settings-json-editor-monaco"
      :data-monaco-ready="ready ? 'true' : undefined"
      :data-marker-count="markers.length"
      class="absolute inset-0"
    />
    <div
      v-show="comparing"
      ref="diffContainer"
      data-testid="settings-json-compare-view"
      class="absolute inset-0"
    />
    <p
      v-if="unavailableReason"
      data-testid="settings-json-unavailable"
      class="absolute inset-0 p-4 text-sm text-muted-foreground bg-background break-words"
    >
      {{ unavailableReason }}
    </p>
    <p
      v-else-if="!file"
      class="absolute inset-0 p-4 text-sm text-muted-foreground bg-background"
    >
      {{ t('settingsEditor.loading') }}
    </p>

    <template #footer>
      <section
        data-testid="settings-json-diagnostics"
        class="shrink-0 max-h-32 overflow-y-auto px-4 py-2 border-t border-border/30 bg-muted text-xs"
      >
        <h3 class="font-medium text-foreground">
          {{ t('settingsEditor.problems', { count: markers.length }) }}
        </h3>
        <ul
          v-if="markers.length > 0"
          class="mt-1 space-y-0.5"
        >
          <li
            v-for="(marker, index) in markers"
            :key="index"
            class="text-muted-foreground"
          >
            {{ t('settingsEditor.problemLine', { line: marker.startLineNumber, message: marker.message }) }}
          </li>
        </ul>
      </section>
    </template>
  </EditorOverlayFrame>
  <SettingsOverwriteConfirm
    v-if="confirmingOverwrite && conflict"
    :path="readyFile?.path ?? ''"
    @confirm="overwrite"
    @cancel="confirmingOverwrite = false"
  />
</template>
