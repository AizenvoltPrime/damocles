<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { HTMLAttributes } from 'vue';
import { effortBadgeLabelKey, type EffortBadgeLevel } from '@shared/effort-badge';
import { Badge } from '@/components/ui/badge';
import { IconBrain } from '@/components/icons';
import { cn } from '@/lib/utils';

const props = defineProps<{
  effort: EffortBadgeLevel;
  class?: HTMLAttributes['class'];
}>();

const { t } = useI18n();

const label = computed(() => t(effortBadgeLabelKey(props.effort)));
const accessibleName = computed(() => t('effortBadge.ariaLabel', { level: label.value }));
</script>

<template>
  <Badge
    variant="secondary"
    role="note"
    :aria-label="accessibleName"
    :title="accessibleName"
    data-testid="effort-badge"
    :class="cn('text-10 px-1.5 py-0 gap-1 font-medium shrink-0', props.class)"
  >
    <IconBrain
      aria-hidden="true"
      class="size-2.5 shrink-0"
    />
    <span aria-hidden="true">{{ label }}</span>
  </Badge>
</template>
