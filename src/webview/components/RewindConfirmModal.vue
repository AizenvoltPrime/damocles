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
import { IconWarning } from '@/components/icons';
import type { RewindOption } from '@shared/types/session';

const { t } = useI18n();

const props = defineProps<{
  visible: boolean;
  messagePreview?: string;
  filesAffected?: number;
  linesChanged?: { added: number; removed: number };
}>();

const emit = defineEmits<{
  confirm: [option: RewindOption];
  cancel: [];
}>();

const selectedIndex = ref(-1);

const options = computed<{ key: RewindOption; label: string; description: string; shortcut: string }[]>(() => [
  {
    key: 'code-and-conversation',
    label: t('rewind.options.codeAndConversation.label'),
    description: t('rewind.options.codeAndConversation.description'),
    shortcut: '1',
  },
  {
    key: 'conversation-only',
    label: t('rewind.options.conversationOnly.label'),
    description: t('rewind.options.conversationOnly.description'),
    shortcut: '2',
  },
  {
    key: 'code-only',
    label: t('rewind.options.codeOnly.label'),
    description: t('rewind.options.codeOnly.description'),
    shortcut: '3',
  },
  {
    key: 'cancel',
    label: t('rewind.options.cancel.label'),
    description: t('rewind.options.cancel.description'),
    shortcut: '4',
  },
]);

watch(() => props.visible, (visible) => {
  if (visible) {
    selectedIndex.value = -1;
  }
});

function handleKeyDown(event: KeyboardEvent) {
  if (!props.visible) return;

  const target = event.target as HTMLElement;
  if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable) return;

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
      if (selectedIndex.value <= 0) {
        selectedIndex.value = options.value.length - 1;
      } else {
        selectedIndex.value--;
      }
      break;
    case 'ArrowDown':
      event.preventDefault();
      if (selectedIndex.value < 0 || selectedIndex.value >= options.value.length - 1) {
        selectedIndex.value = 0;
      } else {
        selectedIndex.value++;
      }
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

function selectOption(index: number) {
  const option = options.value[index];
  if (option.key === 'cancel') {
    emit('cancel');
  } else {
    emit('confirm', option.key);
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeyDown);
});

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeyDown);
});
</script>

<template>
  <AlertDialog :open="visible" @update:open="(open: boolean) => !open && emit('cancel')">
    <AlertDialogContent class="bg-card border-border max-w-md">
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

      <div v-if="filesAffected" class="flex items-center gap-3 text-xs text-muted-foreground px-1">
        <span>{{ t('rewind.filesAffected', { n: filesAffected }, filesAffected) }}</span>
        <template v-if="linesChanged">
          <span class="text-success">{{ t('diff.linesAdded', { n: linesChanged.added }) }}</span>
          <span class="text-error">{{ t('diff.linesRemoved', { n: linesChanged.removed }) }}</span>
        </template>
      </div>

      <div class="space-y-2">
        <button
          v-for="(option, index) in options"
          :key="option.key"
          class="w-full p-3 rounded-lg text-left transition-all flex items-start gap-3 cursor-pointer"
          :class="index === selectedIndex
            ? 'bg-primary/60 border border-primary'
            : 'bg-muted border border-transparent hover:bg-muted/80'"
          @click="selectOption(index)"
          @mouseenter="selectedIndex = index"
        >
          <span
            class="shrink-0 w-6 h-6 rounded flex items-center justify-center text-sm font-mono leading-none"
            :class="index === selectedIndex
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
    </AlertDialogContent>
  </AlertDialog>
</template>
