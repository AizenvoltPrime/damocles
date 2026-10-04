<script setup lang="ts">
import { ref, watch, computed, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { AlertDialog, AlertDialogContent } from '@/components/ui/alert-dialog';
import { ChevronRight, RotateCcw, TriangleAlert } from 'lucide-vue-next';
import ConfirmDialogLayout from './ConfirmDialogLayout.vue';
import RewindCheckpointNotes from '@/components/RewindCheckpointNotes.vue';
import type { RewindOption, RewindHistoryItem, SkippedFilesTarget } from '@shared/types/session';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useEditorStore } from '@/stores/useEditorStore';

const { t } = useI18n();
const settingsStore = useSettingsStore();
const editorStore = useEditorStore();
// A modal dialog traps focus and pointer events, so it steps aside (keeping its state) while an editor overlay is open over it.
const suspended = computed(() => editorStore.hasOpenOverlay);

const props = defineProps<{
  visible: boolean;
  canFork: boolean;
  kind?: RewindHistoryItem['kind'];
  messagePreview?: string | undefined;
  filesAffected?: number | undefined;
  files?: Array<{ path: string; displayName: string }> | undefined;
  linesChanged?: { added: number; removed: number } | undefined;
  loadingMetadata?: boolean | undefined;
  skipped?: RewindHistoryItem['skipped'] | undefined;
  notRewindable?: RewindHistoryItem['notRewindable'] | undefined;
  /** The checkpoint's key, so the full "not restored" list can be loaded on demand. */
  checkpointId?: string | undefined;
}>();

const emit = defineEmits<{
  confirm: [option: RewindOption];
  cancel: [];
  openRewindDiff: [path: string];
}>();

type ModalView = 'options' | 'confirm-rewind';

const selectedIndex = ref(-1);
const filesExpanded = ref(false);
const view = ref<ModalView>('options');
const pendingFileRewindOption = ref<RewindOption | null>(null);
const hasFileList = computed(() => !!props.files && props.files.length > 0);
const skippedTarget = computed<SkippedFilesTarget | undefined>(() => (props.checkpointId ? { kind: 'turn', userEntryId: props.checkpointId } : undefined));

interface Option {
  key: RewindOption;
  label: string;
  description: string;
  shortcut: string;
  needsCodeConfirm: boolean;
  requiresFork: boolean;
}

const options = computed<Option[]>(() => [
  {
    key: 'fork-conversation',
    label: t('rewind.options.forkConversation.label'),
    description: t('rewind.options.forkConversation.description'),
    shortcut: '1',
    needsCodeConfirm: false,
    requiresFork: true,
  },
  {
    key: 'code-only',
    label: t('rewind.options.codeOnly.label'),
    description: t('rewind.options.codeOnly.description'),
    shortcut: '2',
    needsCodeConfirm: true,
    requiresFork: false,
  },
  {
    key: 'fork-and-rewind-code',
    label: t('rewind.options.forkAndRewindCode.label'),
    description: t('rewind.options.forkAndRewindCode.description'),
    shortcut: '3',
    needsCodeConfirm: true,
    requiresFork: true,
  },
  {
    key: 'cancel',
    label: t('rewind.options.cancel.label'),
    description: t('rewind.options.cancel.description'),
    shortcut: '4',
    needsCodeConfirm: false,
    requiresFork: false,
  },
]);

// A turn with no usable checkpoint can still be forked, but its files cannot be restored.
function isDisabled(option: Option): boolean {
  return (option.requiresFork && !props.canFork) || (option.needsCodeConfirm && !!props.notRewindable);
}

watch(() => props.visible, (visible) => {
  if (visible) {
    selectedIndex.value = -1;
    filesExpanded.value = false;
    view.value = 'options';
    pendingFileRewindOption.value = null;
  }
});

function handleDialogOpenUpdate(open: boolean) {
  if (open) return;
  if (view.value === 'confirm-rewind') {
    view.value = 'options';
    pendingFileRewindOption.value = null;
    return;
  }
  emit('cancel');
}

function handleKeyDown(event: KeyboardEvent) {
  if (!props.visible || suspended.value) return;

  const target = event.target as HTMLElement;
  if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable) return;
  if (target.closest('[data-no-keyboard-shortcuts]')) return;

  if (view.value === 'confirm-rewind') {
    if (event.key === 'Escape') {
      event.preventDefault();
      backToOptions();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      confirmFileRewind();
    }
    return;
  }

  switch (event.key) {
    case '1':
    case '2':
    case '3':
    case '4': {
      event.preventDefault();
      const index = parseInt(event.key) - 1;
      selectOption(index);
      break;
    }
    case 'ArrowUp':
      event.preventDefault();
      selectedIndex.value = previousEnabledIndex(selectedIndex.value);
      break;
    case 'ArrowDown':
      event.preventDefault();
      selectedIndex.value = nextEnabledIndex(selectedIndex.value);
      break;
    case 'Enter':
      event.preventDefault();
      if (selectedIndex.value >= 0) {
        selectOption(selectedIndex.value);
      }
      break;
    case 'Escape':
      event.preventDefault();
      emit('cancel');
      break;
  }
}

function nextEnabledIndex(current: number): number {
  const len = options.value.length;
  for (let step = 1; step <= len; step++) {
    const candidate = (current < 0 ? -1 : current) + step;
    const wrapped = ((candidate % len) + len) % len;
    if (!isDisabled(options.value[wrapped]!)) return wrapped;
  }
  return current;
}

function previousEnabledIndex(current: number): number {
  const len = options.value.length;
  for (let step = 1; step <= len; step++) {
    const start = current < 0 ? len : current;
    const candidate = start - step;
    const wrapped = ((candidate % len) + len) % len;
    if (!isDisabled(options.value[wrapped]!)) return wrapped;
  }
  return current;
}

function selectOption(index: number) {
  const option = options.value[index];
  if (!option) return;
  if (isDisabled(option)) return;

  if (option.key === 'cancel') {
    emit('cancel');
    return;
  }

  if (option.needsCodeConfirm) {
    pendingFileRewindOption.value = option.key;
    view.value = 'confirm-rewind';
    return;
  }

  emit('confirm', option.key);
}

function confirmFileRewind() {
  const option = pendingFileRewindOption.value;
  if (!option) return;
  emit('confirm', option);
}

function backToOptions() {
  pendingFileRewindOption.value = null;
  view.value = 'options';
}

onMounted(() => {
  document.addEventListener('keydown', handleKeyDown);
});

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeyDown);
});
</script>

<template>
  <AlertDialog
    :open="visible && !suspended"
    @update:open="handleDialogOpenUpdate"
  >
    <AlertDialogContent class="max-h-[90vh] max-w-lg gap-0 overflow-hidden p-0">
      <ConfirmDialogLayout
        v-if="view === 'options'"
        :icon="RotateCcw"
        :title="t('rewind.title')"
        :description="t('rewind.description')"
      >
        <div
          v-if="kind === 'compaction'"
          class="rounded-10 border border-(--d-border) bg-(--d-bg) px-3 py-2 text-12.5"
        >
          <div class="mb-1 text-10.5 font-semibold tracking-[.06em] text-(--d-info) uppercase">
            {{ t('rewindBrowser.compactionPoint') }}
          </div>
          <div
            v-if="messagePreview"
            class="wrap-break-word text-(--d-muted) italic"
          >
            {{ messagePreview }}
          </div>
          <div class="mt-2 text-xs text-(--d-warning)">
            {{ t('rewind.compactionCaveat') }}
          </div>
        </div>
        <div
          v-else-if="messagePreview"
          class="rounded-10 border border-(--d-border) bg-(--d-bg) px-3 py-2 text-12.5"
        >
          <div class="mb-1 text-10.5 font-semibold tracking-[.06em] text-(--d-faint) uppercase">
            {{ t('rewind.rewindToAfter') }}
          </div>
          <div class="line-clamp-3 wrap-break-word">
            “{{ messagePreview }}”
          </div>
        </div>

        <div
          v-if="loadingMetadata || filesAffected"
          data-no-keyboard-shortcuts
          class="text-xs text-(--d-muted)"
        >
          <span
            v-if="loadingMetadata"
            role="status"
          >{{ t('rewind.loadingMetadata') }}</span>
          <template v-else>
            <div class="flex items-center gap-3">
              <button
                v-if="hasFileList"
                type="button"
                class="flex items-center gap-1 rounded text-(--d-accent) focus:outline-none focus-visible:ring-1 focus-visible:ring-(--d-accent)"
                :aria-expanded="filesExpanded"
                :aria-label="t('rewind.toggleFileList')"
                @click="filesExpanded = !filesExpanded"
              >
                <ChevronRight
                  class="size-3 transition-transform duration-200 ease-out"
                  :class="filesExpanded ? 'rotate-90' : ''"
                  aria-hidden="true"
                />
                <span>{{ t('rewind.filesAffected', { n: filesAffected }, filesAffected!) }}</span>
              </button>
              <span v-else>{{ t('rewind.filesAffected', { n: filesAffected }, filesAffected!) }}</span>
              <template v-if="linesChanged">
                <span class="font-mono text-(--d-success)">{{ t('diff.linesAdded', { n: linesChanged.added }) }}</span>
                <span class="font-mono text-(--d-danger)">{{ t('diff.linesRemoved', { n: linesChanged.removed }) }}</span>
              </template>
            </div>
            <div
              v-if="hasFileList && filesExpanded"
              class="mt-2 max-h-40 overflow-y-auto rounded-lg border border-(--d-border) bg-(--d-bg)"
            >
              <template
                v-for="file in files"
                :key="file.path"
              >
                <button
                  v-if="settingsStore.hostCapabilities.diffReview"
                  type="button"
                  class="w-full truncate px-3 py-1.5 text-left font-mono text-xs text-(--d-text) hover:bg-(--d-hover) focus:outline-none focus-visible:bg-(--d-hover)"
                  :title="t('rewind.openDiffTooltip', { path: file.path })"
                  @click="emit('openRewindDiff', file.path)"
                >
                  {{ file.displayName }}
                </button>
                <div
                  v-else
                  class="truncate px-3 py-1.5 font-mono text-xs text-(--d-text)"
                  :title="file.path"
                >
                  {{ file.displayName }}
                </div>
              </template>
            </div>
          </template>
        </div>

        <RewindCheckpointNotes
          v-if="!loadingMetadata"
          :skipped="skipped"
          :not-rewindable="notRewindable"
          :target="skippedTarget"
        />

        <div
          class="-mx-1.5 flex flex-col"
          role="listbox"
          :aria-label="t('rewind.title')"
        >
          <button
            v-for="(option, index) in options"
            :key="option.key"
            type="button"
            role="option"
            :aria-selected="index === selectedIndex"
            class="group flex items-start gap-2.5 rounded-9 px-2.5 py-1.75 text-left transition-colors disabled:opacity-40"
            :class="index === selectedIndex && !isDisabled(option) ? 'bg-(--d-accent-soft) text-(--d-accent-text)' : ''"
            :disabled="isDisabled(option)"
            @click="selectOption(index)"
            @mouseenter="!isDisabled(option) && (selectedIndex = index)"
          >
            <span
              class="mt-px flex size-5 flex-none items-center justify-center rounded-md border font-mono text-11"
              :class="index === selectedIndex && !isDisabled(option) ? 'border-(--d-accent)' : 'border-(--d-border2)'"
              aria-hidden="true"
            >{{ option.shortcut }}</span>
            <span class="min-w-0 flex-1">
              <span class="block font-medium">{{ option.label }}</span>
              <span class="block text-xs text-(--d-muted)">{{ option.description }}</span>
            </span>
          </button>
        </div>

        <p class="flex items-start gap-2 rounded-10 bg-[color-mix(in_srgb,var(--d-warning)_10%,transparent)] px-3 py-2.25 text-xs text-(--d-warning-text)">
          <TriangleAlert
            class="size-3.25 mt-0.5 flex-none"
            aria-hidden="true"
          />
          <span class="text-pretty">{{ t('rewind.checkpointWarning') }}</span>
        </p>

        <template #footer>
          <span
            class="flex flex-1 items-center gap-1.5 font-mono text-11 text-(--d-faint)"
            aria-hidden="true"
          >
            <kbd>1-4</kbd>
            <span class="font-sans">{{ t('common.or') }}</span>
            <kbd>↑↓</kbd>
            <kbd>Enter</kbd>
          </span>
        </template>
      </ConfirmDialogLayout>

      <ConfirmDialogLayout
        v-else
        :icon="TriangleAlert"
        tone="danger"
        :title="t('rewind.confirmCodeRewind.title')"
        :description="t('rewind.confirmCodeRewind.description')"
        :cancel-label="t('rewind.confirmCodeRewind.cancel')"
        :confirm-label="t('rewind.confirmCodeRewind.confirm')"
        danger
        @cancel="backToOptions"
        @confirm="confirmFileRewind"
      />
    </AlertDialogContent>
  </AlertDialog>
</template>
