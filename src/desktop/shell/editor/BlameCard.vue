<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Copy, GitCommitHorizontal, History } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { commitTime } from '@/utils/clock';
import type { ScmBlameCommit } from '../../preload/scm-channels';
import { visibleText } from '@shared/visible-text';

// The inline blame's hover card (blame.ts getBlameInformationHover): who, when and what, with the commit's actions.
const props = defineProps<{ commit: ScmBlameCommit; ago: string }>();
const emit = defineEmits<{ openCommit: []; copyCommitId: []; openTimeline: []; hold: [by: 'pointer' | 'focus', inside: boolean] }>();
const { t, locale } = useI18n();

const date = computed(() => commitTime(props.commit.authorTime, locale.value).full);
const author = computed(() => visibleText(props.commit.author));
// the shown name's first grapheme, so a combining mark stays with its letter
const initial = computed(() => (new Intl.Segmenter().segment(author.value.trim())[Symbol.iterator]().next().value?.segment ?? '?').toUpperCase());
const ACTION = 'd-press h-6.5 gap-1.5 rounded-md px-2 text-12 text-(--d-text) hover:bg-(--d-hover) [&_svg]:size-3.5';
</script>

<template>
  <div
    role="dialog"
    data-testid="blame-card"
    :aria-label="t('blame.cardLabel', { author })"
    class="qd-blame-card w-80 max-w-full rounded-10 border border-(--d-border2) bg-(--d-card) p-3 text-12.5 text-(--d-text) shadow-(--d-shadow)"
    @pointerenter="emit('hold', 'pointer', true)"
    @pointerleave="emit('hold', 'pointer', false)"
    @focusin="emit('hold', 'focus', true)"
    @focusout="emit('hold', 'focus', false)"
  >
    <div class="flex items-center gap-2.5">
      <span
        class="flex size-7 shrink-0 items-center justify-center rounded-full bg-(--d-accent-soft) text-12 font-semibold text-(--d-accent-text)"
        aria-hidden="true"
      >{{ initial }}</span>
      <div class="min-w-0 flex-1">
        <div class="truncate font-medium">
          {{ author }}
        </div>
        <div class="truncate text-11.5 text-(--d-faint-text)">
          {{ visibleText(commit.authorEmail) }}
        </div>
      </div>
      <span
        class="shrink-0 text-11.5 text-(--d-muted)"
        :title="date"
      >{{ ago }}</span>
    </div>
    <p class="mt-2.5 line-clamp-3 wrap-break-word">
      {{ visibleText(commit.summary) }}
    </p>
    <div class="mt-2 flex items-center gap-2 text-11.5 text-(--d-faint-text)">
      <span
        class="rounded-5 bg-(--d-hover) px-1.5 font-mono text-(--d-muted)"
        data-testid="blame-card-hash"
      >{{ commit.hash.slice(0, 7) }}</span>
      <span data-testid="blame-card-date">{{ date }}</span>
    </div>
    <div class="mt-2.5 flex flex-wrap items-center gap-1 border-t border-(--d-border) pt-2">
      <Button
        size="sm"
        variant="ghost"
        data-testid="blame-open-commit"
        :class="ACTION"
        @click="emit('openCommit')"
      >
        <GitCommitHorizontal aria-hidden="true" />{{ t('blame.openCommit') }}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        data-testid="blame-copy-commit-id"
        :class="ACTION"
        @click="emit('copyCommitId')"
      >
        <Copy aria-hidden="true" />{{ t('blame.copyCommitId') }}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        data-testid="blame-open-timeline"
        :class="ACTION"
        @click="emit('openTimeline')"
      >
        <History aria-hidden="true" />{{ t('blame.openTimeline') }}
      </Button>
    </div>
  </div>
</template>
