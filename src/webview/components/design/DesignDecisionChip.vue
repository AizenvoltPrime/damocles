<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useResizeObserver } from '@vueuse/core';
import { CircleCheck, TriangleAlert } from 'lucide-vue-next';
import type { DesignDecisionView, DesignResultDecision } from '@shared/types/design';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { referenceRowParts } from './reference-row';

// "D1 Fidelity · Interactive prototype": the id and title on the design tint, the chosen value muted beside them.
// A leaving chip is one a rewind removes: dashed, unfilled and struck through in the design hue. A replaced one is dimmed on a
// faint solid border and names its replacement. An active conflict flag shows a warning mark, a resolved one a muted check,
// each with its reason in the tooltip.
const props = defineProps<{
  decision: DesignResultDecision & Partial<Pick<DesignDecisionView, 'conflicts' | 'reference'>>;
  leaving?: boolean;
  replacedBy?: string | undefined;
  /** The ids of the decision's flags core still publishes as active; absent: every flag it carries is active. */
  activeConflicts?: readonly string[] | undefined;
}>();
const { t } = useI18n();

const stored = computed(() => props.decision.conflicts ?? []);
const conflicts = computed(() => stored.value.filter((flag) => props.activeConflicts?.includes(flag.id) ?? true));
const resolved = computed(() => stored.value.filter((flag) => !(props.activeConflicts?.includes(flag.id) ?? true)));
const label = computed(() => t('design.decision.chip', { id: props.decision.id, title: props.decision.title, chosen: props.decision.chosen }));
const conflictNotes = computed(() => [
  ...conflicts.value.map((flag) => t(`design.decision.conflict.${flag.kind}`, { id: flag.id, reason: flag.reason })),
  ...resolved.value.map((flag) => t(`design.decision.conflictResolved.${flag.kind}`, { id: flag.id, reason: flag.reason })),
]);
const referenceRow = computed(() => (props.decision.reference ? referenceRowParts(props.decision.reference) : undefined));
const notes = computed(() => [
  ...(referenceRow.value ? [t('design.decision.sourceRef.reference', referenceRow.value)] : []),
  ...(props.replacedBy ? [t('design.decision.replacedBy', { id: props.replacedBy })] : []),
  ...conflictNotes.value,
]);

// A chip that cuts its text short, or carries a note, takes focus and a tooltip, so a keyboard user reaches its full text.
const title = ref<HTMLElement | null>(null);
const chosen = ref<HTMLElement | null>(null);
const truncated = ref(false);
function measure(): void {
  truncated.value = [title.value, chosen.value].some((element) => element !== null && element.scrollWidth > element.clientWidth);
}
useResizeObserver(title, measure);
useResizeObserver(chosen, measure);
const explained = computed(() => truncated.value || notes.value.length > 0);
</script>

<template>
  <Tooltip :disabled="!explained">
    <TooltipTrigger as-child>
      <span
        class="d-tone-design inline-flex h-5.5 max-w-72 min-w-0 flex-none items-center gap-1 rounded-full border px-2 text-11 whitespace-nowrap outline-none focus-visible:ring-1 focus-visible:ring-(--d-design)"
        :class="[
          leaving ? 'border-dashed border-(--tone)/55 bg-transparent' : replacedBy ? 'border-(--d-border) bg-transparent' : 'border-(--tone)/30 bg-(--tone)/12',
          replacedBy ? 'opacity-60' : '',
        ]"
        :tabindex="explained ? 0 : undefined"
        data-testid="design-decision-chip"
        :data-decision-id="decision.id"
        :data-leaving="leaving ? 'true' : undefined"
        :data-replaced-by="replacedBy"
        :data-conflicts="conflicts.length > 0 ? conflicts.length : undefined"
        :data-resolved-conflicts="resolved.length > 0 ? resolved.length : undefined"
        :data-truncated="truncated ? 'true' : undefined"
      >
        <TriangleAlert
          v-if="conflicts.length > 0"
          class="size-3 flex-none text-(--d-warning-text)"
          aria-hidden="true"
          data-testid="design-decision-conflict"
        />
        <CircleCheck
          v-else-if="resolved.length > 0"
          class="size-3 flex-none text-(--d-faint-text)"
          aria-hidden="true"
          data-testid="design-decision-conflict-resolved"
        />
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
        <span
          v-if="replacedBy"
          class="flex-none text-10.5 text-(--d-faint-text)"
          data-testid="design-decision-replaced"
        >{{ t('design.decision.replacedBy', { id: replacedBy }) }}</span>
        <span
          v-for="note in conflictNotes"
          :key="note"
          class="sr-only"
        >{{ note }}</span>
      </span>
    </TooltipTrigger>
    <TooltipContent data-testid="design-decision-chip-tooltip">
      <span class="block">{{ label }}</span>
      <span
        v-for="note in notes"
        :key="note"
        class="block"
      >{{ note }}</span>
    </TooltipContent>
  </Tooltip>
</template>
