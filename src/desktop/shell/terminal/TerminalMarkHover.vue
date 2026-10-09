<script lang="ts">
import type { CommandStatus } from './terminal-commands';

export interface MarkHover {
  // changes for each hovered mark, so the card re-enters for a new one
  readonly key: string;
  readonly commandLine: string;
  readonly status: CommandStatus;
  readonly exitCode: number | null;
  readonly startTime: number;
  readonly endTime: number | null;
  // px within the terminal's box: the mark's top, bottom and right edge
  readonly top: number;
  readonly bottom: number;
  readonly right: number;
}
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { remPx } from '@/composables/useRemPx';
import { formatClock } from '@/utils/clock';
import { durationParts } from './terminal-commands';

// A hovered command mark's card: the command, how it ended and how long it took (custom markup: xterm draws the mark
// inside its own decoration, where no shadcn popover can anchor). It flips above the mark near the box's bottom.
const props = defineProps<{ hover: MarkHover | null; width: number; height: number }>();
const { t, locale } = useI18n();

// rem between the mark and the card, and the card's inset from the box's edges.
const GAP_REM = 0.25;
const EDGE_REM = 0.375;

const card = ref<HTMLElement | null>(null);
const place = ref<{ left: number; top: number; above: boolean }>({ left: 0, top: 0, above: false });
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | undefined;

// Numbers in the UI language's own digits and decimal separator (Greek writes 2,4).
function duration(ms: number): string {
  const parts = durationParts(ms);
  const number = (value: number, digits = 0): string => new Intl.NumberFormat(locale.value, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  if (parts.unit === 'milliseconds') return t('terminal.mark.milliseconds', { milliseconds: number(parts.milliseconds) });
  if (parts.unit === 'seconds') return t('terminal.mark.seconds', { seconds: number(parts.seconds, parts.fractionDigits) });
  return t('terminal.mark.minutes', { minutes: number(parts.minutes), seconds: number(parts.seconds) });
}

const status = computed(() => {
  const hover = props.hover;
  if (!hover) return '';
  if (hover.status === 'running') return t('terminal.mark.runningFor', { duration: duration(now.value - hover.startTime) });
  const took = duration((hover.endTime ?? hover.startTime) - hover.startTime);
  if (hover.status === 'success') return t('terminal.mark.succeededIn', { duration: took });
  return t('terminal.mark.failedAfter', { code: hover.exitCode ?? '', duration: took });
});

// A running command's duration counts up while its card shows.
watch(() => props.hover?.status === 'running', (running) => {
  clearInterval(ticker);
  ticker = undefined;
  now.value = Date.now();
  if (running) ticker = setInterval(() => (now.value = Date.now()), 1000);
}, { immediate: true });
onBeforeUnmount(() => clearInterval(ticker));

// Layout size, not getBoundingClientRect: the entrance animation starts translated.
watch(() => [props.hover, props.width, props.height] as const, async ([hover]) => {
  if (!hover) return;
  await nextTick();
  const element = card.value;
  if (!element) return;
  const gap = remPx(GAP_REM);
  const edge = remPx(EDGE_REM);
  const left = Math.max(edge, Math.min(hover.right + gap, props.width - element.offsetWidth - edge));
  const below = hover.bottom + gap;
  const fits = below + element.offsetHeight <= props.height - edge;
  place.value = { left, top: fits ? below : Math.max(edge, hover.top - gap - element.offsetHeight), above: !fits };
}, { immediate: true });
</script>

<template>
  <div class="pointer-events-none absolute inset-0 overflow-hidden">
    <Transition :name="place.above ? 't-pop-top' : 't-pop'">
      <div
        v-if="hover"
        ref="card"
        :key="hover.key"
        role="tooltip"
        data-testid="terminal-mark-hover"
        :data-status="hover.status"
        class="absolute flex max-w-80 flex-col gap-1 rounded-lg border border-(--d-border2) bg-(--d-card) px-2.5 py-2 text-11.5 text-(--d-muted) shadow-(--d-shadow)"
        :style="{ left: `${place.left}px`, top: `${place.top}px` }"
      >
        <code class="line-clamp-2 font-mono text-11.5 break-all whitespace-pre-wrap text-(--d-text)">{{ hover.commandLine || t('terminal.mark.unnamed') }}</code>
        <p class="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            class="size-1.5 shrink-0 rounded-full"
            :class="hover.status === 'running' ? 'bg-(--d-accent)' : hover.status === 'success' ? 'bg-(--d-success)' : 'bg-(--d-danger)'"
          />
          <span
            data-testid="terminal-mark-hover-status"
            :class="hover.status === 'failure' ? 'text-(--d-danger-text)' : ''"
          >{{ status }}</span>
        </p>
        <p class="text-10.5 text-(--d-faint-text)">
          {{ t('terminal.mark.startedAt', { time: formatClock(hover.startTime, locale, { seconds: true }) }) }}
        </p>
      </div>
    </Transition>
  </div>
</template>
