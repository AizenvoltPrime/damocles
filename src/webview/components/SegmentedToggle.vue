<script setup lang="ts" generic="T extends string">
import { computed, useTemplateRef, type Component } from 'vue';
import { ToggleGroupItem, ToggleGroupRoot, type AcceptableValue } from 'reka-ui';
import SlidingIndicator from './SlidingIndicator.vue';
import { useSlidingIndicator } from '@/composables/useSlidingIndicator';

export interface SegmentedOption<V extends string> {
  value: V;
  label: string;
  icon?: Component;
  /** Shown but not choosable; the arrow keys skip it. */
  disabled?: boolean;
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
  /** A radio group (role radiogroup, radios that select as focus moves) instead of pressed toggle buttons. */
  radios?: boolean;
}>(), { selectedClass: 'text-(--d-text)', disabled: false, size: 'sm', radios: false });

const emit = defineEmits<{
  (e: 'update:modelValue', value: T): void;
}>();

const SIZES = {
  sm: { root: 'rounded-7 p-0.5', item: 'h-5 rounded-5 px-2 text-11 font-medium', unselected: 'text-(--d-faint)', radius: 5 },
  md: { root: 'flex-wrap justify-end rounded-9 p-0.75', item: 'rounded-7 px-2.75 py-1 text-xs/normal', unselected: 'text-(--d-muted)', radius: 7 },
} as const;
const sized = computed(() => SIZES[props.size]);

const root = useTemplateRef<HTMLElement>('root');
const selected = computed(() => props.options.findIndex((option) => option.value === props.modelValue));
const { box, animate } = useSlidingIndicator(() => root.value ?? undefined, '[data-segment]', selected);

// aria-pressed is undefined so the radio role's aria-checked is the only state a radio carries.
function itemAttrs(option: SegmentedOption<T>): Record<string, string | undefined> {
  if (!props.radios) return { ...option.attrs };
  return { role: 'radio', 'aria-checked': String(option.value === props.modelValue), 'aria-pressed': undefined, ...option.attrs };
}

function focused(option: SegmentedOption<T>): void {
  if (props.radios && option.disabled !== true && option.value !== props.modelValue) emit('update:modelValue', option.value);
}

function onUpdate(value: AcceptableValue): void {
  const option = props.options.find((candidate) => candidate.value === value);
  if (option && option.value !== props.modelValue) emit('update:modelValue', option.value);
}
</script>

<template>
  <!-- as-child: reka's root forces role="group" on its own element, so the element whose role this sets is ours -->
  <ToggleGroupRoot
    as-child
    type="single"
    :model-value="modelValue"
    :disabled="disabled === true"
    @update:model-value="onUpdate"
  >
    <div
      ref="root"
      class="relative isolate flex"
      :class="sized.root"
      :role="radios ? 'radiogroup' : 'group'"
    >
      <SlidingIndicator
        :box="box"
        :radius="sized.radius"
        :animate="animate"
        :class="indicatorClass"
      />
      <ToggleGroupItem
        v-for="option in options"
        :key="option.value"
        :value="option.value"
        :disabled="option.disabled === true"
        v-bind="itemAttrs(option)"
        data-segment
        class="relative z-1 flex items-center gap-1 whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--d-accent) disabled:cursor-not-allowed disabled:opacity-(--d-opacity-disabled)"
        :class="[sized.item, option.value === modelValue ? selectedClass : [sized.unselected, 'enabled:hover:text-(--d-text)']]"
        @focus="focused(option)"
      >
        <component
          :is="option.icon"
          v-if="option.icon"
          class="size-2.5"
          aria-hidden="true"
        />
        {{ option.label }}
      </ToggleGroupItem>
    </div>
  </ToggleGroupRoot>
</template>
