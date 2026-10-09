<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';

// One Search input (the Search section's and the Search Editor's): a box around a bare textarea or input with its toggles
// inside, as VS Code's find inputs. The shadcn Input and Textarea draw their own box, which this layout would replace wholesale.
const props = defineProps<{
  modelValue: string;
  // the query and replace inputs take Ctrl+Enter (Cmd+Enter) newlines and grow with their lines (VS Code's SearchWidget)
  multiline?: boolean;
  label: string;
  placeholder?: string | undefined;
  maxlength: number;
  invalid?: boolean;
  testid: string;
  controls?: string | undefined;
  // VS Code's HistoryInputBox steps; Up/Down reach them on the first and last line, Alt+Up/Down anywhere
  history?: { previous(value: string): string | undefined; next(value: string): string } | undefined;
  isMac: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: string]; keydown: [event: KeyboardEvent] }>();
const { t } = useI18n();

const field = ref<HTMLTextAreaElement | HTMLInputElement | null>(null);
// the value history navigation showed, announced as VS Code's aria.status does
const announced = ref('');

const onFirstLine = (element: HTMLTextAreaElement | HTMLInputElement): boolean => !element.value.slice(0, element.selectionStart ?? 0).includes('\n');
const onLastLine = (element: HTMLTextAreaElement | HTMLInputElement): boolean => !element.value.slice(element.selectionEnd ?? element.value.length).includes('\n');

function show(value: string): void {
  emit('update:modelValue', value);
  announced.value = value === '' ? t('search.clearedInput') : value;
}

function onKeydown(event: KeyboardEvent): void {
  const element = field.value;
  if (!element) return;
  const newline = event.key === 'Enter' && !event.altKey && !event.shiftKey && (props.isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
  if (props.multiline && newline) {
    event.preventDefault();
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? start;
    const value = `${element.value.slice(0, start)}\n${element.value.slice(end)}`;
    if (value.length > props.maxlength) return;
    element.value = value;
    element.setSelectionRange(start + 1, start + 1);
    emit('update:modelValue', value);
    return;
  }
  const plain = !event.ctrlKey && !event.metaKey && !event.shiftKey;
  if (props.history && plain && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    const up = event.key === 'ArrowUp';
    if (event.altKey || (up ? onFirstLine(element) : onLastLine(element))) {
      event.preventDefault();
      const value = up ? props.history.previous(element.value) : props.history.next(element.value);
      if (value !== undefined) show(value);
      return;
    }
  }
  emit('keydown', event);
}

defineExpose({
  focus: () => field.value?.focus(),
  select: () => field.value?.select(),
  hasFocus: () => field.value !== null && document.activeElement === field.value,
});
</script>

<template>
  <div
    class="flex min-h-7 items-start gap-0.5 rounded-7 border bg-(--d-input) pr-0.75 pl-2.25 focus-within:border-(--d-accent)"
    :class="invalid ? 'border-(--d-danger)' : 'border-(--d-border2)'"
  >
    <textarea
      v-if="multiline"
      ref="field"
      rows="1"
      spellcheck="false"
      autocomplete="off"
      :data-testid="testid"
      :value="modelValue"
      :maxlength="maxlength"
      :aria-label="label"
      :aria-invalid="invalid || undefined"
      :aria-controls="controls"
      :placeholder="placeholder"
      class="block max-h-30 min-h-6.5 min-w-0 flex-1 resize-none overflow-x-hidden overflow-y-auto border-0 bg-transparent py-1.25 text-12.5/4 text-(--d-text) outline-none field-sizing-content placeholder:text-(--d-faint)"
      @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
      @keydown="onKeydown"
    />
    <input
      v-else
      ref="field"
      type="text"
      spellcheck="false"
      autocomplete="off"
      :data-testid="testid"
      :value="modelValue"
      :maxlength="maxlength"
      :aria-label="label"
      :aria-invalid="invalid || undefined"
      :aria-controls="controls"
      :placeholder="placeholder"
      class="h-6.5 min-w-0 flex-1 border-0 bg-transparent text-12 text-(--d-text) outline-none placeholder:text-(--d-faint)"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @keydown="onKeydown"
    >
    <!-- The toggles stay on the first line while the text grows below. -->
    <span class="flex h-6.5 shrink-0 items-center gap-0.5">
      <slot />
    </span>
    <span
      role="status"
      class="sr-only"
    >{{ announced }}</span>
  </div>
</template>
