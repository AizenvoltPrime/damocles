<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { CompactionAbortedNotice as CompactionAbortedNoticeType } from '@shared/types/session';
import { IconStop } from '@/components/icons';

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
  <!-- py-2 (not my-2): the scroll engine measures element height, and margins are collapsed/ignored. -->
  <div class="mx-4 py-2">
    <div class="flex items-start gap-2.5 rounded-md border border-warning/30 bg-muted px-3 py-2 text-xs">
      <div class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center text-warning">
        <IconStop :size="14" />
      </div>
      <div class="flex flex-col gap-0.5">
        <span class="font-medium text-foreground">{{ t('compactionAborted.title') }}</span>
        <span class="text-muted-foreground">{{ triggerText }} {{ retryText }}</span>
        <span v-if="notice.errorMessage" class="text-muted-foreground/80">
          {{ t('compactionAborted.reason', { message: notice.errorMessage }) }}
        </span>
      </div>
    </div>
  </div>
</template>
