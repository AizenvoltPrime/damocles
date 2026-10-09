<script lang="ts">
export interface LinkHover {
  // changes for each hovered link, so the hint re-enters for a new one
  readonly key: string;
  // the underline under each row the link covers, px within the terminal's box
  readonly segments: ReadonlyArray<{ readonly left: number; readonly top: number; readonly width: number }>;
  // px within the terminal's box: the link's first row top, its last row bottom, and where it starts
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly kind: 'file' | 'folder' | 'web';
}
</script>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { remPx } from '@/composables/useRemPx';

// A hovered terminal link: an accent underline under its cells and the "Ctrl+click" hint, both drawn inside the terminal's
// own box (custom markup: xterm draws the cells, so no shadcn part can anchor to them). The hint flips above the link when
// it would leave the box at the bottom.
const props = defineProps<{ hover: LinkHover | null; mac: boolean; width: number; height: number }>();
const { t } = useI18n();

// rem between the link and its hint, and the hint's inset from the box's edges.
const GAP_REM = 0.25;
const EDGE_REM = 0.375;

const hint = ref<HTMLElement | null>(null);
const place = ref<{ left: number; top: number; above: boolean }>({ left: 0, top: 0, above: false });
const label = computed(() => (props.hover ? t(`terminal.link.${props.hover.kind}`) : ''));

// Layout size, not getBoundingClientRect: the entrance animation starts translated.
watch(() => [props.hover, props.width, props.height] as const, async ([hover]) => {
  if (!hover) return;
  await nextTick();
  const element = hint.value;
  if (!element) return;
  const gap = remPx(GAP_REM);
  const edge = remPx(EDGE_REM);
  const left = Math.max(edge, Math.min(hover.left, props.width - element.offsetWidth - edge));
  const below = hover.bottom + gap;
  const fits = below + element.offsetHeight <= props.height - edge;
  place.value = { left, top: fits ? below : Math.max(edge, hover.top - gap - element.offsetHeight), above: !fits };
}, { immediate: true });
</script>

<template>
  <div
    class="pointer-events-none absolute inset-0 overflow-hidden"
  >
    <template v-if="hover">
      <span
        v-for="(segment, index) in hover.segments"
        :key="`${hover.key}:${index}`"
        data-testid="terminal-link-underline"
        class="terminal-link-underline absolute h-px bg-(--d-accent)"
        :style="{ left: `${segment.left}px`, top: `${segment.top}px`, width: `${segment.width}px` }"
      />
    </template>
    <Transition :name="place.above ? 't-pop-top' : 't-pop'">
      <p
        v-if="hover"
        ref="hint"
        :key="hover.key"
        role="tooltip"
        data-testid="terminal-link-hint"
        :data-kind="hover.kind"
        class="terminal-link-hint absolute flex items-center gap-1 rounded-md border border-(--d-border2) bg-(--d-card) py-0.75 pr-2 pl-1 text-11 whitespace-nowrap text-(--d-muted) shadow-(--d-shadow)"
        :style="{ left: `${place.left}px`, top: `${place.top}px` }"
      >
        <kbd class="min-w-4.5 rounded-5 border border-(--d-border2) bg-(--d-panel) px-1.25 text-center font-mono text-10.5/4 text-(--d-text)">{{ mac ? '⌘' : 'Ctrl' }}</kbd>
        <span aria-hidden="true">+</span>
        <span>{{ label }}</span>
      </p>
    </Transition>
  </div>
</template>
