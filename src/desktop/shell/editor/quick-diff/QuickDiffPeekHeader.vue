<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronDown, ChevronUp, Minus, Plus, Undo2, X } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import type { ChangeKind } from './quick-diff-compute';

// The peek's title row (quickDiffWidget.ts: the file, "{n} of {m} changes", and the actions on that change).
const props = defineProps<{
  name: string;
  index: number;
  count: number;
  staged: boolean;
  kind: ChangeKind;
  busy: boolean;
  shortcuts: { readonly next: string; readonly previous: string };
}>();
const emit = defineEmits<{ stage: []; unstage: []; revert: []; next: []; previous: []; close: [] }>();
const { t } = useI18n();

const position = computed(() => t('quickDiff.position', { index: props.index + 1, count: props.count }));
const KIND_BORDER: Readonly<Record<ChangeKind, string>> = { added: 'border-(--d-success)', modified: 'border-(--d-info)', deleted: 'border-(--d-danger)' };
const KIND_FILL: Readonly<Record<ChangeKind, string>> = { added: 'bg-(--d-success)', modified: 'bg-(--d-info)', deleted: 'bg-(--d-danger)' };
const ICON_BUTTON = 'd-press size-6 rounded-md text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-3.5';
</script>

<template>
  <div class="flex h-full items-center gap-2 border-b border-(--d-border) bg-(--d-panel) pr-1.5 pl-3 text-12">
    <!-- The change's gutter mark in small: its kind's colour, hollow when staged. -->
    <span
      class="size-2 shrink-0 rounded-full border-[1.5px]"
      :class="[KIND_BORDER[kind], staged ? 'bg-transparent' : KIND_FILL[kind]]"
      aria-hidden="true"
    />
    <span class="min-w-0 truncate font-medium text-(--d-text)">{{ name }}</span>
    <span
      class="shrink-0 text-11.5 text-(--d-faint-text)"
      aria-live="polite"
    >{{ staged ? t('quickDiff.stagedChange', { position }) : position }}</span>
    <span class="flex-1" />
    <Button
      v-if="staged"
      size="sm"
      variant="ghost"
      data-testid="peek-unstage"
      class="d-press h-6 gap-1.5 rounded-md px-2 text-12 text-(--d-text) hover:bg-(--d-border2) [&_svg]:size-3.5"
      :disabled="busy"
      @click="emit('unstage')"
    >
      <Minus aria-hidden="true" />{{ t('quickDiff.unstageHunk') }}
    </Button>
    <template v-else>
      <Button
        size="sm"
        variant="ghost"
        data-testid="peek-stage"
        class="d-press h-6 gap-1.5 rounded-md px-2 text-12 text-(--d-text) hover:bg-(--d-border2) [&_svg]:size-3.5"
        :disabled="busy"
        @click="emit('stage')"
      >
        <Plus aria-hidden="true" />{{ t('quickDiff.stageHunk') }}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        data-testid="peek-revert"
        class="d-press h-6 gap-1.5 rounded-md px-2 text-12 text-(--d-text) hover:bg-(--d-border2) [&_svg]:size-3.5"
        :disabled="busy"
        @click="emit('revert')"
      >
        <Undo2 aria-hidden="true" />{{ t('quickDiff.revertHunk') }}
      </Button>
    </template>
    <span
      class="mx-0.5 h-4 w-px bg-(--d-border2)"
      aria-hidden="true"
    />
    <Button
      size="icon"
      variant="ghost"
      data-testid="peek-previous"
      :class="ICON_BUTTON"
      :aria-label="t('quickDiff.previousChange')"
      :title="`${t('quickDiff.previousChange')} (${shortcuts.previous})`"
      :aria-keyshortcuts="shortcuts.previous"
      @click="emit('previous')"
    >
      <ChevronUp aria-hidden="true" />
    </Button>
    <Button
      size="icon"
      variant="ghost"
      data-testid="peek-next"
      :class="ICON_BUTTON"
      :aria-label="t('quickDiff.nextChange')"
      :title="`${t('quickDiff.nextChange')} (${shortcuts.next})`"
      :aria-keyshortcuts="shortcuts.next"
      @click="emit('next')"
    >
      <ChevronDown aria-hidden="true" />
    </Button>
    <Button
      size="icon"
      variant="ghost"
      data-testid="peek-close"
      :class="ICON_BUTTON"
      :aria-label="t('quickDiff.close')"
      :title="t('quickDiff.close')"
      @click="emit('close')"
    >
      <X aria-hidden="true" />
    </Button>
  </div>
</template>
