<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ThinkingDroppedNotice as ThinkingDroppedNoticeType } from '@shared/types/session';
import { IconBrain } from '@/components/icons';

const { t } = useI18n();

const props = defineProps<{
  notice: ThinkingDroppedNoticeType;
}>();

const title = computed(() =>
  props.notice.count === 1
    ? t('thinkingDropped.titleOne')
    : t('thinkingDropped.titleMany', { count: props.notice.count }),
);

// The adapter already rendered each reason as a one-line explanation, so this joins and never parses.
const reasonText = computed(() => props.notice.reasons.join('; '));
</script>

<template>
  <!-- py-2 (not my-2): the scroll engine measures element height, and margins are collapsed/ignored. -->
  <div class="mx-4 py-2">
    <div class="flex items-start gap-2.5 rounded-md border border-warning/30 bg-muted px-3 py-2 text-xs">
      <div class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center text-warning">
        <IconBrain :size="14" />
      </div>
      <div class="flex flex-col gap-0.5">
        <span class="font-medium text-foreground">{{ title }}</span>
        <span v-if="reasonText" class="text-muted-foreground">{{ reasonText }}</span>
        <span class="text-muted-foreground/80">{{ t('thinkingDropped.meaning') }}</span>
      </div>
    </div>
  </div>
</template>
