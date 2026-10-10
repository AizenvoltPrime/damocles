<script setup lang="ts" generic="T extends string">
import { computed, useId } from 'vue';
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
  /** Emits a pick of the option already selected too. */
  reselectable?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: T): void;
}>();

const popperZIndex = usePopperZIndex();
const selected = computed(() => props.options.find((option) => option.value === props.modelValue));
// A disabled option's hint is why it cannot run, so the trigger keeps showing it while that option stays selected.
const selectedReason = computed(() => (selected.value?.disabled ? selected.value.hint : undefined));
const reasonId = useId();
const optionHintId = (index: number): string => `${reasonId}-option-${index}`;

function onUpdate(value: unknown): void {
  if (typeof value !== 'string' || (value === props.modelValue && !props.reselectable)) return;
  const option = props.options.find((candidate) => candidate.value === value);
  if (option && !option.disabled) emit('update:modelValue', option.value);
}

// reka skips a disabled item in keyboard navigation, which would hide its reason, so an unavailable option stays focusable and only its pick is cancelled.
function cancelPick(option: SelectOption<T>, event: Event): void {
  if (option.disabled) event.preventDefault();
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
      :aria-describedby="selectedReason ? reasonId : undefined"
    >
      <span class="sm-select-value">{{ selected?.label ?? placeholder ?? modelValue }}</span>
      <span
        v-if="selectedReason"
        :id="reasonId"
        class="sm-select-hint"
      >{{ selectedReason }}</span>
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
          <!-- as-child: reka's own aria-disabled would override one passed as an attribute; the child's props win. -->
          <SelectItem
            v-for="(option, index) in options"
            :key="option.value"
            :value="option.value"
            as-child
            @select="cancelPick(option, $event)"
          >
            <div
              class="sm-option"
              :aria-disabled="option.disabled ? 'true' : undefined"
              :data-unavailable="option.disabled ? '' : undefined"
              :aria-describedby="option.hint ? optionHintId(index) : undefined"
            >
              <span class="sm-option-text">
                <SelectItemText>{{ option.label }}</SelectItemText>
                <span
                  v-if="option.hint"
                  :id="optionHintId(index)"
                  class="sm-option-hint"
                >{{ option.hint }}</span>
              </span>
              <SelectItemIndicator class="sm-option-check">
                <Check
                  class="size-3.5"
                  aria-hidden="true"
                />
              </SelectItemIndicator>
            </div>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
