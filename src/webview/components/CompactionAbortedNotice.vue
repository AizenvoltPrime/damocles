<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { CompactionAbortedNotice as CompactionAbortedNoticeType } from '@shared/types/session';
import { CircleStop } from 'lucide-vue-next';
import TranscriptNotice from './TranscriptNotice.vue';

const { t } = useI18n();

const props = defineProps<{
  notice: CompactionAbortedNoticeType;
}>();

const triggerText = computed(() => {
  if (props.notice.trigger === 'manual') return t('compactionAborted.triggerManual');
  if (props.notice.trigger === 'overflow') return t('compactionAborted.triggerOverflow');
  return t('compactionAborted.triggerThreshold');
});

const retryText = computed(() =>
  props.notice.willRetry ? t('compactionAborted.willRetry') : t('compactionAborted.noRetry'),
);
</script>

<template>
  <TranscriptNotice
    tone="warning"
    :icon="CircleStop"
    :title="t('compactionAborted.title')"
  >
    <span>{{ triggerText }} {{ retryText }}</span>
    <span v-if="notice.errorMessage">{{ t('compactionAborted.reason', { message: notice.errorMessage }) }}</span>
  </TranscriptNotice>
</template>
