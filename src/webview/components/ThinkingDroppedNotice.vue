<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ThinkingDroppedNotice as ThinkingDroppedNoticeType } from '@shared/types/session';
import { Brain } from 'lucide-vue-next';
import TranscriptNotice from './TranscriptNotice.vue';

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
  <TranscriptNotice
    tone="warning"
    :icon="Brain"
    :title="title"
  >
    <span v-if="reasonText">{{ reasonText }}</span>
    <span>{{ t('thinkingDropped.meaning') }}</span>
  </TranscriptNotice>
</template>
