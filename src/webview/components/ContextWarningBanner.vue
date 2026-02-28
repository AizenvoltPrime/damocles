<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { Button } from '@/components/ui/button';
import { IconBolt, IconWarning, IconXMark } from '@/components/icons';
import { useSessionStore } from '@/stores/useSessionStore';
import { useContextPercentage } from '@/composables/useContextPercentage';
import type { ContextWarningLevel } from '@shared/types/settings';

const { t } = useI18n();
const { sessionStats } = storeToRefs(useSessionStore());

const props = defineProps<{
  level: ContextWarningLevel;
  autoCompactTriggered?: boolean;
}>();

defineEmits<{
  (e: 'dismiss'): void;
}>();

const { totalContext, contextPercentage: percentUsed } = useContextPercentage(sessionStats);

const formattedTokens = computed(() => {
  const input = Math.round(totalContext.value / 1000);
  const total = Math.round(sessionStats.value.contextWindowSize / 1000);
  return `${input}K / ${total}K`;
});

const accentColor = computed(() => {
  if (props.level === 'critical') return 'var(--color-destructive)';
  if (props.level === 'soft') return 'var(--color-orange)';
  return 'var(--color-warning)';
});

const isCompacting = computed(() => props.autoCompactTriggered);
</script>

<template>
  <div
    class="context-warning-banner"
    :class="{ 'is-compacting': isCompacting }"
    :style="{ '--accent': accentColor }"
  >
    <div class="accent-stripe" />

    <div class="flex items-center gap-2.5 flex-1 min-w-0 py-1.5 pl-3 pr-1">
      <component
        :is="level === 'critical' ? IconBolt : IconWarning"
        :size="14"
        class="shrink-0 banner-icon"
      />

      <span class="text-xs font-medium banner-title truncate">
        {{ isCompacting ? t('context.autoCompacting') : (level === 'critical' ? t('context.critical') : level === 'soft' ? t('context.soft') : t('context.warning')) }}
      </span>

      <div class="flex items-center gap-2 ml-auto shrink-0">
        <div class="progress-track">
          <div
            class="progress-fill"
            :class="{ 'shimmer': isCompacting }"
            :style="{ width: `${Math.min(percentUsed, 100)}%` }"
          />
        </div>

        <span class="text-[11px] tabular-nums opacity-60">
          {{ formattedTokens }} ({{ percentUsed }}%)
        </span>

        <Button
          variant="ghost"
          size="icon-sm"
          class="opacity-40 hover:opacity-100 h-5 w-5 shrink-0"
          @click="$emit('dismiss')"
          :title="t('common.dismiss')"
        >
          <IconXMark :size="10" />
        </Button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.context-warning-banner {
  position: relative;
  display: flex;
  align-items: stretch;
  border-bottom: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
  background: color-mix(in srgb, var(--accent) 6%, var(--card));
  transition: all 0.3s ease;
}

.context-warning-banner.is-compacting {
  background: color-mix(in srgb, var(--accent) 10%, var(--card));
  box-shadow: inset 0 -1px 12px -6px color-mix(in srgb, var(--accent) 20%, transparent);
}

.accent-stripe {
  width: 3px;
  flex-shrink: 0;
  background: var(--accent);
  opacity: 0.8;
  transition: opacity 0.3s ease;
}

.is-compacting .accent-stripe {
  opacity: 1;
  animation: pulse-stripe 1.5s ease-in-out infinite;
}

.banner-icon {
  color: var(--accent);
}

.banner-title {
  color: var(--accent);
}

.progress-track {
  width: 80px;
  height: 4px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--accent) 15%, transparent);
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--accent);
  transition: width 0.6s ease;
}

.progress-fill.shimmer {
  background: linear-gradient(
    90deg,
    var(--accent) 0%,
    color-mix(in srgb, var(--accent) 60%, white) 50%,
    var(--accent) 100%
  );
  background-size: 200% 100%;
  animation: shimmer 1.5s ease-in-out infinite;
}

@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

@keyframes pulse-stripe {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 1; }
}
</style>
