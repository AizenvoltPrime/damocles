<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useResizeObserver } from '@vueuse/core';
import type { DesignResultDecision } from '@shared/types/design';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

// "D1 Fidelity · Interactive prototype": the id and title on the design tint, the chosen value muted beside them.
// A leaving chip is one a rewind removes: dashed, unfilled and struck through in the design hue.
const props = defineProps<{ decision: DesignResultDecision; leaving?: boolean }>();
const { t } = useI18n();

const label = computed(() => t('design.decision.chip', { id: props.decision.id, title: props.decision.title, chosen: props.decision.chosen }));

// Only a chip that cuts its text short takes focus and a tooltip, so a keyboard user reaches its full text.
const title = ref<HTMLElement | null>(null);
const chosen = ref<HTMLElement | null>(null);
const truncated = ref(false);
function measure(): void {
  truncated.value = [title.value, chosen.value].some((element) => element !== null && element.scrollWidth > element.clientWidth);
}
useResizeObserver(title, measure);
useResizeObserver(chosen, measure);
</script>

<template>
  <Tooltip :disabled="!truncated">
    <TooltipTrigger as-child>
      <span
        class="d-tone-design inline-flex h-5.5 max-w-72 min-w-0 flex-none items-center gap-1 rounded-full border px-2 text-11 whitespace-nowrap outline-none focus-visible:ring-1 focus-visible:ring-(--d-design)"
        :class="leaving ? 'border-dashed border-(--tone)/55 bg-transparent' : 'border-(--tone)/30 bg-(--tone)/12'"
        :tabindex="truncated ? 0 : undefined"
        data-testid="design-decision-chip"
        :data-decision-id="decision.id"
        :data-leaving="leaving ? 'true' : undefined"
        :data-truncated="truncated ? 'true' : undefined"
      >
        <span class="font-mono text-10.5 font-semibold">{{ decision.id }}</span>
        <span
          ref="title"
          class="min-w-0 truncate font-medium"
          :class="leaving ? 'text-(--d-muted) line-through decoration-(--d-design)' : 'text-(--d-text)'"
        >{{ decision.title }}</span>
        <span
          aria-hidden="true"
          class="text-(--d-faint-text)"
        >·</span>
        <span
          ref="chosen"
          class="min-w-0 truncate text-(--d-muted)"
          :class="leaving ? 'line-through decoration-(--d-design)' : ''"
        >{{ decision.chosen }}</span>
      </span>
    </TooltipTrigger>
    <TooltipContent data-testid="design-decision-chip-tooltip">
      {{ label }}
    </TooltipContent>
  </Tooltip>
</template>
