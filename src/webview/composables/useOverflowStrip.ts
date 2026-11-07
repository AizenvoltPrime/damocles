import { computed, onBeforeUnmount, onMounted, ref, type Ref } from 'vue';
import { useResizeObserver, type MaybeElementRef } from '@vueuse/core';
import { remPx } from './useRemPx';

// VS Code's tab scrollbar (multiEditorTabsControl.ts, base/browser/ui/scrollbar): a 3px slider over the strip's bottom edge,
// taking no layout height, shown while the strip is hovered or scrolls and faded out 500 ms after (HIDE_TIMEOUT).
const SLIDER_HIDE_MS = 500;
const SLIDER_MIN_REM = 1.25;

/**
 * A strip that scrolls sideways under an overlay slider (OverflowSlider.vue) and fades the edge with more content beyond it.
 * The strip takes the `d-overflow-strip` class and `fadeClass`, its scroll and wheel handlers, and its wrapper the pointer
 * handlers; `content` is the strip's row, whose growth changes the overflow without resizing the strip.
 */
export function useOverflowStrip(strip: Ref<HTMLElement | null>, content: MaybeElementRef) {
  const fadeStart = ref(false);
  const fadeEnd = ref(false);
  const slider = ref<{ left: number; width: number } | null>(null);
  const sliderShown = ref(false);
  const hovered = ref(false);
  const drag = ref<{ pointerId: number; startX: number; startScroll: number } | null>(null);
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  function measure(): void {
    const element = strip.value;
    if (!element) return;
    const { scrollLeft, clientWidth, scrollWidth } = element;
    fadeStart.value = scrollLeft > 1;
    fadeEnd.value = scrollLeft + clientWidth < scrollWidth - 1;
    if (scrollWidth <= clientWidth + 1) {
      slider.value = null;
      // The slider unmounts mid-drag without a pointerup.
      drag.value = null;
      return;
    }
    const width = Math.max(remPx(SLIDER_MIN_REM), (clientWidth * clientWidth) / scrollWidth);
    slider.value = { width, left: ((clientWidth - width) * scrollLeft) / (scrollWidth - clientWidth) };
  }
  useResizeObserver([strip, content], measure);
  onMounted(measure);

  function revealSlider(): void {
    sliderShown.value = true;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!hovered.value && !drag.value) sliderShown.value = false;
    }, SLIDER_HIDE_MS);
  }
  onBeforeUnmount(() => clearTimeout(hideTimer));

  function onScroll(): void {
    measure();
    revealSlider();
  }

  function onPointerEnter(): void {
    hovered.value = true;
    sliderShown.value = true;
    clearTimeout(hideTimer);
  }

  function onPointerLeave(): void {
    hovered.value = false;
    revealSlider();
  }

  // A vertical wheel scrolls the strip sideways.
  function onWheel(event: WheelEvent): void {
    const element = strip.value;
    if (!element || element.scrollWidth <= element.clientWidth || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    element.scrollLeft += event.deltaY;
  }

  // Dragging the slider moves the strip by the same share of its scroll width.
  function onSliderDown(event: PointerEvent): void {
    const element = strip.value;
    if (event.button !== 0 || !element) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    drag.value = { pointerId: event.pointerId, startX: event.clientX, startScroll: element.scrollLeft };
  }

  function onSliderMove(event: PointerEvent): void {
    const element = strip.value;
    const start = drag.value;
    if (!element || !slider.value || start?.pointerId !== event.pointerId) return;
    const ratio = (element.scrollWidth - element.clientWidth) / Math.max(1, element.clientWidth - slider.value.width);
    element.scrollLeft = start.startScroll + (event.clientX - start.startX) * ratio;
  }

  function onSliderUp(event: PointerEvent): void {
    if (drag.value?.pointerId !== event.pointerId) return;
    drag.value = null;
    revealSlider();
  }

  return {
    fadeClass: computed(() => ({ 'd-overflow-fade-start': fadeStart.value, 'd-overflow-fade-end': fadeEnd.value })),
    slider,
    sliderShown: computed(() => sliderShown.value || drag.value !== null),
    dragging: computed(() => drag.value !== null),
    measure,
    onScroll,
    onWheel,
    onPointerEnter,
    onPointerLeave,
    onSliderDown,
    onSliderMove,
    onSliderUp,
  };
}

export type OverflowStrip = ReturnType<typeof useOverflowStrip>;
