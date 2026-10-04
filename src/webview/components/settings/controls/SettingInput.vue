<script setup lang="ts" generic="V">
import { ref, useId, watch } from 'vue';

export type InputParse<R> = (raw: string) => { ok: true; value: R } | { ok: false; error: string };

const props = defineProps<{
  /** The saved value as text; the field shows it again on Escape and after the host's answer. */
  modelValue: string;
  parse: InputParse<V>;
  label: string;
  prefix?: string;
  suffix?: string;
  placeholder?: string;
  inputmode?: 'text' | 'decimal' | 'numeric';
  wide?: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: 'commit', value: V): void;
}>();

const draft = ref(props.modelValue);
const error = ref<string | null>(null);
const errorId = useId();

watch(() => props.modelValue, (value) => {
  draft.value = value;
  error.value = null;
});

function commit(): void {
  if (draft.value === props.modelValue) {
    error.value = null;
    return;
  }
  const parsed = props.parse(draft.value);
  if (!parsed.ok) {
    error.value = parsed.error;
    return;
  }
  error.value = null;
  emit('commit', parsed.value);
}

// Escape belongs to the field while it holds an edit; stopping it keeps the modal open.
function revert(event: KeyboardEvent): void {
  if (draft.value === props.modelValue && error.value === null) return;
  event.stopPropagation();
  event.preventDefault();
  draft.value = props.modelValue;
  error.value = null;
}
</script>

<template>
  <div class="flex flex-col items-end gap-1">
    <div
      class="sm-input"
      :class="{ 'sm-input-wide': wide }"
      :data-invalid="error === null ? undefined : ''"
    >
      <span
        v-if="prefix"
        class="sm-input-affix"
        aria-hidden="true"
      >{{ prefix }}</span>
      <input
        v-model="draft"
        type="text"
        :inputmode="inputmode ?? 'text'"
        spellcheck="false"
        autocomplete="off"
        :aria-label="label"
        :aria-invalid="error === null ? undefined : 'true'"
        :aria-describedby="error === null ? undefined : errorId"
        :placeholder="placeholder"
        :disabled="disabled"
        @keydown.enter.prevent="commit"
        @keydown.esc="revert"
        @blur="commit"
      >
      <span
        v-if="suffix"
        class="sm-input-affix"
        aria-hidden="true"
      >{{ suffix }}</span>
    </div>
    <p
      v-if="error !== null"
      :id="errorId"
      class="sm-feedback sm-feedback-error"
      role="alert"
      data-testid="setting-invalid"
    >
      {{ error }}
    </p>
  </div>
</template>
