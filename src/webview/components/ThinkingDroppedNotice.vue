<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ThinkingDroppedNotice as ThinkingDroppedNoticeType } from '@shared/types/session';
import { Brain } from 'lucide-vue-next';
import TranscriptNotice from './TranscriptNotice.vue';
import { useLocalizedText } from '@/composables/useLocalizedText';

const { t } = useI18n();
const { rt } = useLocalizedText();

const props = defineProps<{
  notice: ThinkingDroppedNoticeType;
}>();

const title = computed(() =>
  props.notice.count === 1
    ? t('thinkingDropped.titleOne')
    : t('thinkingDropped.titleMany', { count: props.notice.count }),
);

// The title carries the total, so a reason's own count shows only beside other reasons.
const reasonText = computed(() => {
  const { reasons } = props.notice;
  return reasons
    .map((reason) => (reasons.length > 1 ? t('thinkingDropped.reasonCount', { reason: rt(reason.text), count: reason.count }) : rt(reason.text)))
    .join('; ');
});
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
