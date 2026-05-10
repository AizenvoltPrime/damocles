<script setup lang="ts">
import { ref, watch, computed, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { IconWarning, IconChevronRight } from '@/components/icons';
import type { RewindOption } from '@shared/types/session';

const { t } = useI18n();

const props = defineProps<{
  visible: boolean;
  canFork: boolean;
  messagePreview?: string;
  filesAffected?: number;
  files?: Array<{ path: string; displayName: string }>;
  linesChanged?: { added: number; removed: number };
  loadingMetadata?: boolean;
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

function isDisabled(option: Option): boolean {
  return option.requiresFork && !props.canFork;
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
  if (!props.visible) return;

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
  <AlertDialog :open="visible" @update:open="handleDialogOpenUpdate">
    <AlertDialogContent class="bg-card border-border max-w-md">
      <template v-if="view === 'options'">
        <AlertDialogHeader>
          <AlertDialogTitle class="flex items-center gap-2">
            {{ t('rewind.title') }}
          </AlertDialogTitle>
          <AlertDialogDescription>
            <div class="flex items-start gap-3 mt-2">
              <IconWarning :size="24" class="shrink-0 text-warning" />
              <div>
                <p class="mb-2 text-foreground">
                  {{ t('rewind.description') }}
                </p>
              </div>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div v-if="messagePreview" class="p-3 rounded bg-muted text-sm">
          <div class="text-xs text-muted-foreground mb-1">{{ t('rewind.rewindToAfter') }}</div>
          <div class="italic break-words">"{{ messagePreview }}"</div>
        </div>

        <div
          v-if="loadingMetadata || filesAffected"
          data-no-keyboard-shortcuts
          class="px-1 text-xs text-muted-foreground"
        >
          <span v-if="loadingMetadata" class="animate-pulse">
            {{ t('rewind.loadingMetadata') }}
          </span>
          <template v-else>
            <div class="flex items-center gap-3">
              <button
                v-if="hasFileList"
                type="button"
                class="flex items-center gap-1 text-primary hover:text-primary/80 transition-colors cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-primary rounded"
                :aria-expanded="filesExpanded"
                :aria-label="t('rewind.toggleFileList')"
                @click="filesExpanded = !filesExpanded"
              >
                <IconChevronRight
                  :size="12"
                  class="transition-transform"
                  :class="filesExpanded ? 'rotate-90' : ''"
                />
                <span>{{ t('rewind.filesAffected', { n: filesAffected }, filesAffected!) }}</span>
              </button>
              <span v-else>{{ t('rewind.filesAffected', { n: filesAffected }, filesAffected!) }}</span>
              <template v-if="linesChanged">
                <span class="text-success">{{ t('diff.linesAdded', { n: linesChanged.added }) }}</span>
                <span class="text-error">{{ t('diff.linesRemoved', { n: linesChanged.removed }) }}</span>
              </template>
            </div>
            <div
              v-if="hasFileList && filesExpanded"
              class="mt-2 rounded bg-muted/50 border border-border/60 max-h-40 overflow-y-auto"
            >
              <button
                v-for="file in files"
                :key="file.path"
                type="button"
                class="w-full text-left px-3 py-1.5 font-mono text-xs text-foreground/80 hover:bg-primary/10 hover:text-foreground focus:outline-none focus-visible:bg-primary/10 cursor-pointer truncate"
                :title="t('rewind.openDiffTooltip', { path: file.path })"
                @click="emit('openRewindDiff', file.path)"
              >
                {{ file.displayName }}
              </button>
            </div>
          </template>
        </div>

        <div class="space-y-2">
          <button
            v-for="(option, index) in options"
            :key="option.key"
            class="w-full p-3 rounded-lg text-left transition-all flex items-start gap-3"
            :class="[
              isDisabled(option)
                ? 'bg-muted/40 border border-transparent opacity-50 cursor-not-allowed'
                : index === selectedIndex
                  ? 'bg-primary/60 border border-primary cursor-pointer'
                  : 'bg-muted border border-transparent hover:bg-muted/80 cursor-pointer',
            ]"
            :disabled="isDisabled(option)"
            :title="isDisabled(option) ? t('rewind.forkDisabledInRecall') : ''"
            @click="selectOption(index)"
            @mouseenter="!isDisabled(option) && (selectedIndex = index)"
          >
            <span
              class="shrink-0 w-6 h-6 rounded flex items-center justify-center text-sm font-mono leading-none"
              :class="index === selectedIndex && !isDisabled(option)
                ? 'bg-primary text-primary-foreground'
                : 'bg-border text-muted-foreground'"
            >
              {{ option.shortcut }}
            </span>
            <div>
              <div class="font-medium text-sm">{{ option.label }}</div>
              <div class="text-xs text-muted-foreground mt-0.5">{{ option.description }}</div>
            </div>
          </button>
        </div>

        <Alert class="bg-warning/20 border-warning/30">
          <AlertTitle class="text-warning font-semibold text-xs">{{ t('common.note') }}</AlertTitle>
          <AlertDescription class="text-xs text-foreground/70">
            {{ t('rewind.checkpointWarning') }}
          </AlertDescription>
        </Alert>

        <div class="pt-2 text-xs text-muted-foreground flex items-center gap-4">
          <span class="flex items-center gap-1">
            <kbd class="px-1.5 py-0.5 bg-muted rounded text-xs font-mono">1-4</kbd>
            <span>or</span>
            <kbd class="px-1.5 py-0.5 bg-muted rounded text-xs font-mono">↑↓</kbd>
            <kbd class="px-1.5 py-0.5 bg-muted rounded text-xs font-mono">Enter</kbd>
          </span>
        </div>
      </template>

      <template v-else>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ t('rewind.confirmCodeRewind.title') }}</AlertDialogTitle>
          <AlertDialogDescription>
            {{ t('rewind.confirmCodeRewind.description') }}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div class="flex justify-end gap-2 pt-2">
          <Button variant="outline" @click="backToOptions">
            {{ t('rewind.confirmCodeRewind.cancel') }}
          </Button>
          <Button variant="destructive" @click="confirmFileRewind">
            {{ t('rewind.confirmCodeRewind.confirm') }}
          </Button>
        </div>
      </template>
    </AlertDialogContent>
  </AlertDialog>
</template>
