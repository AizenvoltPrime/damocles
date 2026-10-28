<script setup lang="ts" generic="T extends string">
import { computed, useTemplateRef, type Component } from 'vue';
import { ToggleGroupItem, ToggleGroupRoot, type AcceptableValue } from 'reka-ui';
import SlidingIndicator from './SlidingIndicator.vue';
import { useSlidingIndicator } from '@/composables/useSlidingIndicator';

export interface SegmentedOption<V extends string> {
  value: V;
  label: string;
  icon?: Component;
  /** Extra attributes for the option's button, such as a `data-*` hook. */
  attrs?: Record<string, string>;
}

/**
 * A single-choice segmented control whose selection slides as one indicator (reka ToggleGroup, so arrow keys
 * move between options). Pressing the active option again changes nothing.
 */
const props = withDefaults(defineProps<{
  modelValue: T;
  options: readonly SegmentedOption<T>[];
  /** The indicator's colour as a text class; it must resolve to an opaque colour. */
  indicatorClass: string;
  /** The selected option's text colour. */
  selectedClass?: string;
  disabled?: boolean;
  /** `md` is the settings modal's control (Desktop template settings rows): larger options that wrap onto right-aligned lines. */
  size?: 'sm' | 'md';
  /**
   * `equal` (size `sm`): the options are equal grid columns and the selected pill moves one column per option by transform, so its place
   * never depends on measured text widths. `measured`: the indicator measures the selected option.
   */
  variant?: 'measured' | 'equal';
}>(), { selectedClass: 'text-(--d-text)', disabled: false, size: 'sm', variant: 'measured' });

const emit = defineEmits<{
  (e: 'update:modelValue', value: T): void;
}>();

const SIZES = {
  sm: { root: 'rounded-7 p-0.5', item: 'h-5 rounded-5 px-2 text-11 font-medium', unselected: 'text-(--d-faint)', radius: 5 },
  md: { root: 'flex-wrap justify-end rounded-9 p-0.75', item: 'rounded-7 px-2.75 py-1 text-xs/normal', unselected: 'text-(--d-muted)', radius: 7 },
} as const;
const sized = computed(() => SIZES[props.size]);
// the equal variant's pill, inset by the `sm` track's padding
const EQUAL_PILL = 'inset-y-0.5 left-0.5 w-[calc((100%-0.25rem)/var(--segments))] rounded-5';

const root = useTemplateRef('root');
const selected = computed(() => props.options.findIndex((option) => option.value === props.modelValue));
const { box, animate } = useSlidingIndicator(() => (props.variant === 'measured' ? root.value?.$el as HTMLElement | undefined : undefined), '[data-segment]', selected);

function onUpdate(value: AcceptableValue): void {
  const option = props.options.find((candidate) => candidate.value === value);
  if (option && option.value !== props.modelValue) emit('update:modelValue', option.value);
}
</script>

<template>
  <ToggleGroupRoot
    ref="root"
    type="single"
    :model-value="modelValue"
    :disabled="disabled === true"
    class="relative isolate"
    :class="[sized.root, variant === 'equal' ? 'grid auto-cols-[1fr] grid-flow-col' : 'flex']"
    :style="variant === 'equal' ? { '--segments': options.length } : undefined"
    @update:model-value="onUpdate"
  >
    <SlidingIndicator
      v-if="variant === 'equal'"
      :box="null"
      :radius="sized.radius"
      :animate="false"
      :columns="{ index: selected }"
      data-testid="segmented-pill"
      :class="[EQUAL_PILL, indicatorClass]"
    />
    <SlidingIndicator
      v-else
      :box="box"
      :radius="sized.radius"
      :animate="animate"
      :class="indicatorClass"
    />
    <ToggleGroupItem
      v-for="option in options"
      :key="option.value"
      :value="option.value"
      v-bind="option.attrs"
      data-segment
      class="relative z-1 flex items-center gap-1 whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--d-accent)"
      :class="[sized.item, variant === 'equal' && 'justify-center', option.value === modelValue ? selectedClass : [sized.unselected, 'enabled:hover:text-(--d-text)']]"
    >
      <component
        :is="option.icon"
        v-if="option.icon"
        class="size-2.5"
        aria-hidden="true"
      />
      {{ option.label }}
    </ToggleGroupItem>
  </ToggleGroupRoot>
</template>
