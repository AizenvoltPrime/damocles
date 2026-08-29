<script setup lang="ts">
import { ref, computed, nextTick, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';

/** A reader who scrolled up keeps their position; only a view already at the bottom follows the tail. */
const TAIL_FOLLOW_THRESHOLD_PX = 24;

/** Every frame is a full snapshot, so the pane caps what it lays out rather than trusting the producer. */
const TAIL_LINE_LIMIT = 400;
const TAIL_CHAR_LIMIT = 20_000;

/** ESC [ parameters intermediates final, the colour and cursor form that `--color=always` emits. */
// eslint-disable-next-line no-control-regex
const ANSI_CSI = /\u001B\[[0-?]*[ -/]*[@-~]/g;

const props = defineProps<{
  output: string;
  truncated: boolean;
  heightClass: string;
}>();

const { t } = useI18n();

const pane = ref<HTMLPreElement | null>(null);

/** A progress bar rewrites its line from column zero, so only the text after the last return survives. */
function collapseCarriageReturns(line: string): string {
  const withoutEol = line.endsWith('\r') ? line.slice(0, -1) : line;
  const lastReturn = withoutEol.lastIndexOf('\r');
  return lastReturn === -1 ? withoutEol : withoutEol.slice(lastReturn + 1);
}

// Stripping runs before the tail slice, so a cut cannot land inside an escape sequence and leave the
// remainder of it in the DOM as literal text.
const rendered = computed(() => {
  const lines = props.output.replace(ANSI_CSI, '').split('\n').map(collapseCarriageReturns);
  const kept = lines.length > TAIL_LINE_LIMIT ? lines.slice(-TAIL_LINE_LIMIT) : lines;
  const joined = kept.join('\n');
  const text = joined.length > TAIL_CHAR_LIMIT ? joined.slice(-TAIL_CHAR_LIMIT) : joined;
  return { text, sliced: kept.length < lines.length || text.length < joined.length };
});

const showTruncationHint = computed(() => props.truncated || rendered.value.sliced);

function scrollToTail(): void {
  const el = pane.value;
  if (el) el.scrollTop = el.scrollHeight;
}

// Covers a mount that already has output: the overlay opens over a command that has been running a while.
onMounted(scrollToTail);

watch(
  () => props.output,
  () => {
    const el = pane.value;
    // Measured before the DOM patch, so the decision uses the position the reader is looking at.
    const atTail = el === null || el.scrollHeight - el.scrollTop - el.clientHeight <= TAIL_FOLLOW_THRESHOLD_PX;
    if (!atTail) return;
    void nextTick(scrollToTail);
  },
);
</script>

<template>
  <!-- The height belongs to the wrapper, not the pre: the hint line must not change the pane's total
       height, which would re-fire the message list ResizeObserver on every frame. -->
  <div :class="heightClass" class="flex flex-col gap-1">
    <p v-if="showTruncationHint" class="shrink-0 text-[11px] italic text-muted-foreground">
      {{ t('liveOutput.truncated') }}
    </p>
    <!-- aria-live is off because a frame replaces the whole text node, so any live setting would re-read the entire buffer several times a second. -->
    <pre
      v-if="rendered.text.length > 0"
      ref="pane"
      tabindex="0"
      role="log"
      aria-live="off"
      :aria-label="t('liveOutput.regionLabel')"
      class="flex-1 min-h-0 m-0 rounded bg-foreground/5 p-2 text-xs font-mono text-foreground/80 whitespace-pre-wrap break-all overflow-y-auto overscroll-contain"
    >{{ rendered.text }}</pre>
    <div
      v-else
      role="status"
      class="flex-1 min-h-0 flex items-center justify-center rounded bg-foreground/5 p-2 text-xs italic text-muted-foreground"
    >
      {{ t('liveOutput.waiting') }}
    </div>
  </div>
</template>
