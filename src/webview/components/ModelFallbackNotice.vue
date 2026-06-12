<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ModelFallbackNotice as ModelFallbackNoticeType } from '@shared/types/session';

const { t } = useI18n();

const props = defineProps<{
  notice: ModelFallbackNoticeType;
}>();

const TRIGGER_KEYS: Record<string, string> = {
  model_not_found: 'modelFallback.triggers.modelNotFound',
  permission_denied: 'modelFallback.triggers.permissionDenied',
  overloaded: 'modelFallback.triggers.overloaded',
  server_error: 'modelFallback.triggers.serverError',
  last_resort: 'modelFallback.triggers.lastResort',
  unknown: 'modelFallback.triggers.unknown',
};

const triggerLabel = computed(() => {
  const key = TRIGGER_KEYS[props.notice.trigger];
  return key ? t(key) : props.notice.trigger;
});
</script>

<template>
  <div class="flex items-center gap-3 py-2 px-4">
    <div class="flex-1 h-px bg-gradient-to-r from-transparent via-border to-transparent" />
    <div class="flex items-center gap-2 whitespace-nowrap min-w-0">
      <span class="text-xs text-muted-foreground uppercase tracking-widest font-medium">{{ t('modelFallback.title') }}</span>
      <span class="text-xs text-foreground/80 truncate">{{ t('modelFallback.switch', { from: notice.fromModel, to: notice.toModel }) }}</span>
      <span class="px-1.5 py-0.5 rounded text-xs font-medium bg-warning/20 text-warning border border-warning/30">{{ triggerLabel }}</span>
    </div>
    <div class="flex-1 h-px bg-gradient-to-r from-transparent via-border to-transparent" />
  </div>
</template>
