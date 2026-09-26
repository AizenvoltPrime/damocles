<script setup lang="ts">
import { computed, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Progress } from '@/components/ui/progress';
import { IconStop, IconWarning, IconXMark } from '@/components/icons';
import { formatCost } from '@/composables/useTeamFormatting';

const { t, locale } = useI18n();

const props = defineProps<{
  currentSpend: number;
  limit: number;
  exceeded?: boolean;
}>();

defineEmits<{
  (e: 'dismiss'): void;
}>();

const percentUsed = computed(() => {
  if (props.limit <= 0) return 0;
  return Math.min((props.currentSpend / props.limit) * 100, 100);
});

const progressClass = computed(() => {
  if (props.exceeded) return '[&>div]:bg-error';
  if (percentUsed.value >= 90) return '[&>div]:bg-error';
  if (percentUsed.value >= 80) return '[&>div]:bg-warning';
  return '[&>div]:bg-success';
});

const alertClass = computed(() => {
  if (props.exceeded) return 'bg-error/30 border-error/50';
  return 'bg-warning/30 border-warning/50';
});

const iconComponent = computed((): Component => props.exceeded ? IconStop : IconWarning);
</script>

<template>
  <Alert
    class="flex items-center gap-3 px-4 py-2 rounded-none border-x-0 border-t-0"
    :class="alertClass"
  >
    <component :is="iconComponent" :size="20" class="shrink-0" />

    <div class="flex-1 min-w-0">
      <AlertTitle v-if="exceeded" class="font-medium text-error mb-0">
        {{ t('budget.exceeded') }}
      </AlertTitle>
      <AlertTitle v-else class="font-medium text-warning mb-0">
        {{ t('budget.approaching') }}
      </AlertTitle>

      <AlertDescription class="flex items-center gap-3 mt-1">
        <Progress
          :model-value="percentUsed"
          class="flex-1 max-w-32 h-1.5 bg-gray-700"
          :class="progressClass"
        />
        <span class="text-xs opacity-70">
          {{ formatCost(currentSpend, locale) }} / {{ formatCost(limit, locale) }}
          ({{ percentUsed.toFixed(0) }}%)
        </span>
      </AlertDescription>
    </div>

    <Button
      variant="ghost"
      size="icon-sm"
      class="opacity-50 hover:opacity-100 h-6 w-6 shrink-0"
      @click="$emit('dismiss')"
      :title="t('common.dismiss')"
    >
      <IconXMark :size="12" />
    </Button>
  </Alert>
</template>
