<script setup lang="ts" generic="V">
import { computed, ref, useId, watch } from 'vue';

export type InputParse<R> = (raw: string) => { ok: true; value: R } | { ok: false; error: string };

const props = withDefaults(defineProps<{
  /** The saved value as text; the field shows it again on Escape and after the host's answer. */
  modelValue: string;
  parse: InputParse<V>;
  label: string;
  prefix?: string;
  suffix?: string;
  placeholder?: string | undefined;
  inputmode?: 'text' | 'decimal' | 'numeric';
  wide?: boolean;
  /** The field leads a row of controls: it aligns to its start, and its error wraps within the input's width. */
  inline?: boolean;
  disabled?: boolean;
  /** For a visible <label for> outside the field. */
  inputId?: string;
  /**
   * False makes the field a one-shot answer rather than a setting: blur sends nothing, and Enter or `submit()` sends the
   * value even when it equals modelValue.
   */
  commitOnBlur?: boolean;
  /**
   * The owner's verdict on the last value sent, such as the host refusing it, and null while that verdict is pending. Shown like
   * a parse error until the user edits the value.
   */
  refusal?: string | null;
}>(), { commitOnBlur: true, refusal: null });

const emit = defineEmits<{
  (e: 'commit', value: V): void;
}>();

const draft = ref(props.modelValue);
const parseError = ref<string | null>(null);
// The draft a refusal judges: the one shown at mount, then the one last sent; null once the user edited it.
const judgedDraft = ref<string | null>(draft.value);
const error = computed(() => parseError.value ?? (judgedDraft.value === null ? null : props.refusal));
const errorId = useId();

watch(() => props.modelValue, (value) => {
  draft.value = value;
  parseError.value = null;
});

watch(draft, (value) => {
  if (value !== judgedDraft.value) judgedDraft.value = null;
});

function submit(): void {
  const parsed = props.parse(draft.value);
  if (!parsed.ok) {
    parseError.value = parsed.error;
    return;
  }
  parseError.value = null;
  judgedDraft.value = draft.value;
  emit('commit', parsed.value);
}

function commit(): void {
  if (draft.value === props.modelValue) {
    parseError.value = null;
    return;
  }
  submit();
}

function entered(): void {
  if (props.commitOnBlur) commit();
  else submit();
}

function blurred(): void {
  if (props.commitOnBlur) commit();
}

defineExpose({ submit });

// Escape belongs to the field while it holds an edit; stopping it keeps the modal open.
function revert(event: KeyboardEvent): void {
  if (draft.value === props.modelValue && parseError.value === null) return;
  event.stopPropagation();
  event.preventDefault();
  draft.value = props.modelValue;
  parseError.value = null;
}
</script>

<template>
  <div
    class="flex flex-col gap-1"
    :class="inline ? 'items-start' : 'items-end'"
  >
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
        :id="inputId"
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
        @keydown.enter.prevent="entered"
        @keydown.esc="revert"
        @blur="blurred"
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
      :class="{ 'w-0 min-w-full': inline }"
      role="alert"
      data-testid="setting-invalid"
    >
      {{ error }}
    </p>
  </div>
</template>
