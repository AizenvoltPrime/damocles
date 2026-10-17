<script setup lang="ts">
import { LETTER_TONE, type StatusLetter, type StatusTone } from '@shared/scm/status-letter';
import { TONE_TEXT } from './scm-list';

// A git status letter as every view shows it: Files, Source control, editor tabs, diff tabs, the Graph and dialogs. A plain
// decoration, not a control, so no shadcn part covers it. tone defaults to the letter's own; a new letter springs in.
const props = defineProps<{
  letter: StatusLetter;
  tone?: StatusTone | undefined;
  title?: string | undefined;
  // on the keyed inner span, which holds only the current letter while an old one leaves
  letterTestId?: string | undefined;
}>();
</script>

<template>
  <span
    class="flex w-4 shrink-0 justify-center text-11 font-semibold"
    :style="{ color: TONE_TEXT[props.tone ?? LETTER_TONE[props.letter]] }"
    :title="props.title"
  >
    <Transition name="t-letter">
      <span
        :key="props.letter"
        :data-testid="props.letterTestId"
      >{{ props.letter }}</span>
    </Transition>
  </span>
</template>
