<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useId } from 'vue';
import type { Component } from 'vue';
import { useI18n } from 'vue-i18n';
import { CircleAlert, CornerDownLeft, FilePen, GitBranchPlus, TextCursorInput } from 'lucide-vue-next';
import { inputProblem, type InputValidation } from '@shared/input-validation';
import type { OverlayAnswer, OverlayRequest } from '../../../preload/overlay-channels';
import type { ShellPlatform } from '../../../preload/shell-channels';

// VS Code's input box (showInputBox): one line of text main asks for, checked as typed by the request's validation kind.
// Enter answers only a valid value; Escape and the scrim dismiss it.
const props = defineProps<{ request: Extract<OverlayRequest, { kind: 'input' }>; platform: ShellPlatform }>();
const emit = defineEmits<{ answer: [answer: OverlayAnswer] }>();
const { t } = useI18n();

const ICONS: Readonly<Record<InputValidation, Component>> = { branchName: GitBranchPlus, path: FilePen };

const value = ref(props.request.value ?? '');
const input = ref<HTMLInputElement | null>(null);
// A prefill such as a branch prefix ending in '/' is not yet valid; the box turns invalid only after an edit or an Enter.
const touched = ref(false);
// bumped by a refused Enter, so the message replays its swap-in
const refusals = ref(0);
const titleId = useId();
const messageId = useId();

const problem = computed(() => (props.request.validation ? inputProblem(props.request.validation, value.value, { windows: props.platform === 'win32' }) : undefined));
const problemText = computed(() => {
  const current = touched.value ? problem.value : undefined;
  if (!current) return '';
  return current.code === 'char' ? t('quickInput.invalid.char', { char: current.char }) : t(`quickInput.invalid.${current.code}`);
});

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.isComposing) {
    if (problem.value === undefined) emit('answer', { kind: 'input', value: value.value });
    else {
      touched.value = true;
      refusals.value++;
    }
  } else if (event.key === 'Escape') {
    emit('answer', { kind: 'dismissed' });
  } else if (event.key !== 'Tab') {
    return;
  }
  // Tab stays in the box, its only control, so focus never leaves the popup.
  event.preventDefault();
  event.stopPropagation();
}

// The field holds the box's keys (Enter, Escape), so a press elsewhere in the dialog leaves focus in it.
function keepFocus(event: MouseEvent): void {
  if (event.target !== input.value) event.preventDefault();
}

onMounted(() => {
  void nextTick(() => {
    const element = input.value;
    if (!element) return;
    element.focus();
    const [start, end] = props.request.valueSelection ?? [0, value.value.length];
    element.setSelectionRange(start, end);
  });
});
</script>

<template>
  <div
    role="dialog"
    aria-modal="true"
    data-testid="quick-input"
    :data-validation="request.validation"
    :aria-labelledby="request.title ? titleId : undefined"
    :aria-label="request.title ? undefined : request.prompt"
    class="d-quick-input fixed top-11.5 left-1/2 flex w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 flex-col rounded-xl border border-(--d-border2) bg-(--d-card) p-1.5 text-(--d-text) shadow-(--d-shadow)"
    @mousedown="keepFocus"
  >
    <p
      v-if="request.title"
      :id="titleId"
      data-testid="quick-input-title"
      class="truncate px-1.5 pt-0.75 pb-1.5 text-11.5 font-semibold text-(--d-muted)"
    >
      {{ request.title }}
    </p>
    <label
      class="flex h-8 shrink-0 items-center gap-2 rounded-lg border border-(--d-accent) bg-(--d-input) px-2.5 shadow-[0_0_0_3px_var(--d-accent-soft)] transition-[border-color,box-shadow] duration-150 data-invalid:border-(--d-danger) data-invalid:shadow-[0_0_0_3px_color-mix(in_srgb,var(--d-danger)_16%,transparent)]"
      :data-invalid="problemText ? '' : undefined"
    >
      <component
        :is="request.validation ? ICONS[request.validation] : TextCursorInput"
        aria-hidden="true"
        class="size-3.5 shrink-0 text-(--d-faint)"
      />
      <!-- A bare field, as QuickPick's: the shadcn Input part brings its own border and ring, which the row draws here. -->
      <input
        ref="input"
        v-model="value"
        type="text"
        spellcheck="false"
        autocomplete="off"
        data-testid="quick-input-field"
        :aria-label="request.title ?? request.prompt"
        :aria-invalid="problemText ? 'true' : 'false'"
        :aria-describedby="messageId"
        :placeholder="request.placeholder"
        class="min-w-0 flex-1 border-0 bg-transparent text-(--d-text) outline-none placeholder:text-(--d-faint)"
        :class="request.validation ? 'font-mono text-12.5' : 'text-13'"
        @input="touched = true"
        @keydown="onKeydown"
      >
      <kbd
        aria-hidden="true"
        class="flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-5 border border-(--d-border2) bg-(--d-panel) px-1 text-(--d-muted) transition-opacity duration-150"
        :class="problem ? 'opacity-35' : ''"
      >
        <CornerDownLeft class="size-3" />
      </kbd>
    </label>
    <!-- The prompt and the validation message share one grid cell and swap there, so neither moves the box. -->
    <div
      :id="messageId"
      aria-live="polite"
      class="grid px-2 pt-1.5 pb-0.5 text-11.5"
    >
      <Transition name="t-swap">
        <p
          v-if="problemText"
          :key="`${problemText}:${refusals}`"
          data-testid="quick-input-problem"
          :data-code="problem?.code"
          class="min-w-0 text-(--d-danger-text) [grid-area:1/1]"
        >
          <span class="flex items-start gap-1.5"><CircleAlert
            aria-hidden="true"
            class="mt-0.5 size-3 shrink-0"
          /><span class="min-w-0">{{ problemText }}</span></span>
        </p>
        <p
          v-else
          key="prompt"
          data-testid="quick-input-prompt"
          class="text-(--d-faint-text) [grid-area:1/1]"
        >
          {{ request.prompt }}
        </p>
      </Transition>
    </div>
  </div>
</template>
