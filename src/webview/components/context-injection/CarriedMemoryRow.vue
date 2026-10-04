<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Pin } from 'lucide-vue-next';
import { Badge } from '@/components/ui/badge';
import InjectedMemoryActions from './InjectedMemoryActions.vue';
import { memoryLabel, scopeBadgeClass } from './memory-display';
import type { CarriedMemory } from '@shared/types/context-injection';

const props = defineProps<{
  memory: CarriedMemory;
  /** The memory's current pin, which can differ from the one recorded with the prompt. */
  pinned: boolean;
  forgotten: boolean;
}>();

const { t } = useI18n();

const label = computed(() => memoryLabel(props.memory.title, props.memory.snippet));
</script>

<template>
  <li
    class="flex min-w-0 items-center gap-2 rounded-md border border-(--d-border) px-3 py-1.5 text-xs"
    :class="forgotten && 'opacity-60'"
    :data-memory-id="memory.id"
    :data-forgotten="forgotten || undefined"
  >
    <Pin
      v-if="pinned"
      class="size-3 shrink-0 text-(--d-warning)"
      role="img"
      :aria-label="t('contextInjection.badge.pinned')"
      data-badge="pinned"
    />
    <span class="min-w-0 flex-1 truncate text-(--d-text)" :title="memory.title ?? memory.snippet">{{ memory.title ?? memory.snippet }}</span>
    <Badge v-if="forgotten" variant="outline" class="shrink-0 border-[color-mix(in_srgb,var(--d-danger)_40%,transparent)] px-1 py-0 text-10 text-(--d-danger)" data-badge="forgotten">
      {{ t('contextInjection.badge.forgotten') }}
    </Badge>
    <Badge variant="outline" class="shrink-0 px-1 py-0 text-10" :class="scopeBadgeClass(memory.scope)">
      {{ t(`memory.scope.${memory.scope}`) }} · {{ t(`memory.kind.${memory.kind}`) }} · {{ t(`contextInjection.tier.${memory.tier}`) }}
    </Badge>
    <span class="shrink-0 text-10 text-(--d-muted) tabular-nums">
      {{ t('contextInjection.fromPrompt', { n: memory.injectedAtPrompt + 1 }) }}
    </span>
    <InjectedMemoryActions
      :id="memory.id"
      :kind="memory.kind"
      :label="label"
      :is-pinned="pinned"
      :forgotten="forgotten"
    />
  </li>
</template>
