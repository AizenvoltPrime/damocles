<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronRight, FileText } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { visibleText } from '@shared/visible-text';

// The build's output under its timeline step: the newest lines in a tail that folds away, and the whole buffer in a dialog.
// No line is live for assistive technology; the timeline's progressbar says the step, and a failure its alert.
const props = defineProps<{
  // the lines main keeps, newest last
  lines: readonly string[];
  // every line the build wrote; more than lines.length when main dropped the oldest
  total: number;
  hostName: string;
}>();
const { t } = useI18n();

// Lines the tail shows, each keyed by its place in the whole output so a line keeps its key as the buffer moves and only a new one fades in.
const TAIL_LINES = 5;
const first = computed(() => props.total - props.lines.length);
const tail = computed(() => props.lines.slice(-TAIL_LINES).map((text, index, shown) => ({ key: first.value + props.lines.length - shown.length + index, text: visibleText(text) })));

// Not a reka Collapsible: its trigger renders before its content names itself, so a tail open on mount would carry an empty aria-controls.
const open = ref(true);
const tailId = useId();

const fullOpen = ref(false);
const fullBox = ref<HTMLElement | null>(null);
const setFullBox = (element: unknown): void => {
  fullBox.value = element instanceof HTMLElement ? element : null;
};
// The full log follows the newest line unless the user scrolled up to read.
watch(() => props.total, async () => {
  const box = fullBox.value;
  const atEnd = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 2;
  await nextTick();
  if (atEnd && fullBox.value) fullBox.value.scrollTop = fullBox.value.scrollHeight;
});

function onFullOpen(event: Event): void {
  event.preventDefault();
  void nextTick(() => {
    const box = fullBox.value;
    if (!box) return;
    box.scrollTop = box.scrollHeight;
    box.focus();
  });
}
</script>

<template>
  <div
    class="mt-1.5 flex flex-col gap-1"
    data-testid="build-log"
  >
    <span class="flex flex-wrap items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid="build-log-toggle"
        class="-ms-1.5 h-6 rounded-6 px-1.5 text-11 text-(--d-muted) hover:text-(--d-text)"
        :aria-expanded="open"
        :aria-controls="tailId"
        @click="open = !open"
      >
        <ChevronRight
          aria-hidden="true"
          class="size-3 transition-transform duration-150 ease-out rtl:-scale-x-100"
          :class="open ? 'rotate-90' : ''"
        />
        {{ t('remote.buildLog.tail') }}
        <span class="text-(--d-faint-text) tabular-nums">· {{ t('remote.buildLog.lines', { count: total }, total) }}</span>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid="build-log-full"
        class="h-6 rounded-6 px-1.5 text-11 text-(--d-muted) hover:text-(--d-text)"
        :disabled="total === 0"
        @click="fullOpen = true"
      >
        <FileText aria-hidden="true" />
        {{ t('remote.buildLog.showFull') }}
      </Button>
    </span>
    <Transition name="t-tuck">
      <div
        v-show="open"
        :id="tailId"
        dir="ltr"
        data-testid="build-log-tail"
        class="flex flex-col rounded-8 bg-(--d-code) px-2 py-1.5 font-mono text-10.5/normal text-(--d-muted)"
      >
        <span
          v-if="tail.length === 0"
          class="text-(--d-faint-text)"
        >{{ t('remote.buildLog.waiting') }}</span>
        <span
          v-for="line in tail"
          :key="line.key"
          data-testid="build-log-line"
          class="d-fade-in block truncate whitespace-pre last:text-(--d-text)"
        >{{ line.text === '' ? ' ' : line.text }}</span>
      </div>
    </Transition>
    <Dialog v-model:open="fullOpen">
      <DialogContent
        data-testid="build-log-dialog"
        class="flex max-h-[80vh] w-[min(46rem,calc(100%-2rem))] max-w-none flex-col gap-3 p-4.5"
        @open-auto-focus="onFullOpen"
      >
        <div class="flex items-start gap-3 pe-8">
          <span
            aria-hidden="true"
            class="grid size-8 shrink-0 place-items-center rounded-10 bg-(--d-accent-soft) text-(--d-accent-text)"
          >
            <FileText class="size-4" />
          </span>
          <div class="flex min-w-0 flex-col gap-0.5 pt-0.5">
            <DialogTitle class="truncate text-15 font-semibold">
              {{ t('remote.buildLog.title', { name: hostName }) }}
            </DialogTitle>
            <DialogDescription class="text-12 text-(--d-muted) tabular-nums">
              {{ first > 0 ? t('remote.buildLog.dropped', { shown: lines.length, total }) : t('remote.buildLog.lines', { count: total }, total) }}
            </DialogDescription>
          </div>
        </div>
        <pre
          :ref="setFullBox"
          dir="ltr"
          tabindex="0"
          data-testid="build-log-full-text"
          :aria-label="t('remote.buildLog.fullLabel', { name: hostName })"
          class="m-0 min-h-0 flex-1 overflow-auto rounded-8 border border-(--d-border) bg-(--d-code) px-2.5 py-2 font-mono text-11/relaxed whitespace-pre-wrap break-all text-(--d-text) focus-visible:outline-1 focus-visible:outline-(--d-accent)"
        ><span
          v-for="(line, index) in lines"
          :key="first + index"
          class="block"
        >{{ visibleText(line) === '' ? ' ' : visibleText(line) }}</span></pre>
      </DialogContent>
    </Dialog>
  </div>
</template>
