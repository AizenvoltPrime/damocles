<script setup lang="ts" generic="T extends string">
import { computed } from 'vue';
import { Check, ChevronsUpDown } from 'lucide-vue-next';
import {
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectPortal,
  SelectRoot,
  SelectTrigger,
  SelectViewport,
} from 'reka-ui';
import { usePopperZIndex } from '@/composables/useOverlayEscape';
import { remPx } from '@/composables/useRemPx';

export interface SelectOption<V extends string> {
  value: V;
  label: string;
  hint?: string;
  disabled?: boolean;
}

// reka reserves '' for "no selection", so an unset setting needs a non-empty sentinel value of its own.
const props = defineProps<{
  modelValue: T;
  options: readonly SelectOption<T>[];
  label: string;
  placeholder?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: T): void;
}>();

const popperZIndex = usePopperZIndex();
const selected = computed(() => props.options.find((option) => option.value === props.modelValue));

function onUpdate(value: unknown): void {
  if (typeof value !== 'string' || value === props.modelValue) return;
  const option = props.options.find((candidate) => candidate.value === value);
  if (option) emit('update:modelValue', option.value);
}
</script>

<template>
  <SelectRoot
    :model-value="modelValue"
    :disabled="disabled ?? false"
    @update:model-value="onUpdate"
  >
    <SelectTrigger
      class="sm-select"
      :aria-label="label"
    >
      <span class="sm-select-value">{{ selected?.label ?? placeholder ?? modelValue }}</span>
      <ChevronsUpDown
        class="size-3.25 sm-select-chevron"
        aria-hidden="true"
      />
    </SelectTrigger>
    <SelectPortal>
      <SelectContent
        position="popper"
        side="bottom"
        align="end"
        :side-offset="remPx(0.25)"
        class="sm-popper"
        :style="popperZIndex === undefined ? undefined : { zIndex: popperZIndex }"
      >
        <SelectViewport class="sm-popper-viewport">
          <SelectItem
            v-for="option in options"
            :key="option.value"
            :value="option.value"
            :disabled="option.disabled ?? false"
            class="sm-option"
          >
            <span class="sm-option-text">
              <SelectItemText>{{ option.label }}</SelectItemText>
              <span
                v-if="option.hint"
                class="sm-option-hint"
              >{{ option.hint }}</span>
            </span>
            <SelectItemIndicator class="sm-option-check">
              <Check
                class="size-3.5"
                aria-hidden="true"
              />
            </SelectItemIndicator>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
