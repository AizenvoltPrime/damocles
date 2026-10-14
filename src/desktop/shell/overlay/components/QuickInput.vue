<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import type { Component } from 'vue';
import { useI18n } from 'vue-i18n';
import { CircleAlert, Cloud, CornerDownLeft, FilePen, Folder, GitBranchPlus, LockKeyhole, Tag, TextCursorInput } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { inputProblem, MAX_INPUT_VALUE_LENGTH, type InputValidation } from '@shared/input-validation';
import type { InputBrowseResult, OverlayAnswer, OverlayRequest } from '../../../preload/overlay-channels';
import type { ShellPlatform } from '../../../preload/shell-channels';
import { visibleText } from '@shared/visible-text';

// VS Code's input box (showInputBox); a password's value lives only in this component and is cleared as the box answers.
const props = defineProps<{
  request: Extract<OverlayRequest, { kind: 'input' }>;
  platform: ShellPlatform;
  browse?: ((value: string) => Promise<InputBrowseResult | null | undefined>) | undefined;
}>();
const emit = defineEmits<{ answer: [answer: OverlayAnswer] }>();
const { t } = useI18n();

const ICONS: Readonly<Record<InputValidation, Component>> = { branchName: GitBranchPlus, path: FilePen, remoteName: Cloud, tagName: Tag };

const value = ref(props.request.password ? '' : props.request.value ?? '');
// A prompt can carry text another program wrote, so its control and bidi characters show as escapes.
const prompt = computed(() => visibleText(props.request.prompt));
const input = ref<HTMLInputElement | null>(null);
const browseButton = ref<InstanceType<typeof Button> | null>(null);
// A prefill such as a branch prefix ending in '/' is not yet valid; the box turns invalid only after an edit or an Enter.
const touched = ref(false);
// bumped by a refused Enter, so the message replays its swap-in
const refusals = ref(0);
const titleId = useId();
const messageId = useId();

const problem = computed(() => (props.request.validation ? inputProblem(props.request.validation, value.value, { windows: props.platform === 'win32' }) : undefined));
// the browse button's call failed, which the message line says until the next edit
const browseFailed = ref(false);
const problemText = computed(() => {
  const current = touched.value ? problem.value : undefined;
  if (!current) return '';
  return current.code === 'char' ? t('quickInput.invalid.char', { char: current.char }) : t(`quickInput.invalid.${current.code}`);
});
// what the line under the box says in place of the prompt
const messageText = computed(() => (browseFailed.value ? t('quickInput.browseFailed') : problemText.value));

// set once the box answered or left, so a browse result arriving later is dropped
let ended = false;
const browsing = ref(false);

function answer(next: OverlayAnswer): void {
  ended = true;
  emit('answer', next);
  if (props.request.password) value.value = '';
}

function focusField(selection?: readonly [number, number]): void {
  const element = input.value;
  if (!element) return;
  element.focus();
  if (selection) element.setSelectionRange(selection[0], selection[1]);
}

// The box stays as it is while main's dialog is open; its result replaces the value and selection, and focus returns to the field.
async function browseFolder(): Promise<void> {
  const browse = props.browse;
  if (!browse || browsing.value || ended) return;
  browsing.value = true;
  browseFailed.value = false;
  let result: InputBrowseResult | null | undefined;
  try {
    result = await browse(value.value);
  } catch {
    if (!ended) browseFailed.value = true;
    return;
  } finally {
    browsing.value = false;
  }
  if (ended) return;
  if (!result) {
    focusField();
    return;
  }
  value.value = result.value;
  touched.value = true;
  await nextTick();
  if (!ended) focusField(result.valueSelection ?? [0, result.value.length]);
}

function onBrowseKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') answer({ kind: 'dismissed' });
  else if (event.key === 'Tab') focusField();
  else return;
  event.preventDefault();
  event.stopPropagation();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.isComposing) {
    if (problem.value === undefined) answer({ kind: 'input', value: value.value });
    else {
      touched.value = true;
      refusals.value++;
    }
  } else if (event.key === 'Escape') {
    answer({ kind: 'dismissed' });
  } else if (event.key === 'Tab') {
    browseButton.value?.$el.focus();
  } else {
    return;
  }
  // Tab moves between the field and its browse button, so focus never leaves the popup.
  event.preventDefault();
  event.stopPropagation();
}

// The field holds the box's keys (Enter, Escape), so a press elsewhere in the dialog leaves focus in it.
function keepFocus(event: MouseEvent): void {
  if (event.target !== input.value) event.preventDefault();
}

onBeforeUnmount(() => {
  ended = true;
  value.value = '';
});

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
    :data-password="request.password || undefined"
    :aria-labelledby="request.title ? titleId : undefined"
    :aria-label="request.title ? undefined : prompt"
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
        :is="request.password ? LockKeyhole : request.validation ? ICONS[request.validation] : TextCursorInput"
        aria-hidden="true"
        class="size-3.5 shrink-0 text-(--d-faint)"
      />
      <!-- A bare field, as QuickPick's: the shadcn Input part brings its own border and ring, which the row draws here. -->
      <input
        ref="input"
        v-model="value"
        :type="request.password ? 'password' : 'text'"
        spellcheck="false"
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        data-testid="quick-input-field"
        :aria-label="request.title ?? prompt"
        :aria-invalid="problemText ? 'true' : 'false'"
        :aria-describedby="messageId"
        :placeholder="request.placeholder"
        :maxlength="MAX_INPUT_VALUE_LENGTH"
        class="min-w-0 flex-1 border-0 bg-transparent text-(--d-text) outline-none placeholder:text-(--d-faint)"
        :class="request.validation ? 'font-mono text-12.5' : 'text-13'"
        @input="touched = true; browseFailed = false"
        @keydown="onKeydown"
      >
      <Button
        v-if="request.browse && browse"
        ref="browseButton"
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="quick-input-browse"
        class="size-5.5 shrink-0 rounded-md text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) focus-visible:ring-1 focus-visible:ring-(--d-accent) [&_svg]:size-3.5"
        :aria-label="request.browse.tooltip"
        :title="request.browse.tooltip"
        :aria-busy="browsing || undefined"
        @click="browseFolder"
        @keydown="onBrowseKeydown"
      >
        <Folder aria-hidden="true" />
      </Button>
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
          v-if="messageText"
          :key="`${messageText}:${refusals}`"
          data-testid="quick-input-problem"
          :data-code="browseFailed ? 'browseFailed' : problem?.code"
          class="min-w-0 text-(--d-danger-text) [grid-area:1/1]"
        >
          <span class="flex items-start gap-1.5"><CircleAlert
            aria-hidden="true"
            class="mt-0.5 size-3 shrink-0"
          /><span class="min-w-0">{{ messageText }}</span></span>
        </p>
        <p
          v-else
          key="prompt"
          data-testid="quick-input-prompt"
          class="text-(--d-faint-text) [grid-area:1/1]"
        >
          {{ prompt }}
        </p>
      </Transition>
    </div>
  </div>
</template>
