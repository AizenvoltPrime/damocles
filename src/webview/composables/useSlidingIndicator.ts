import { nextTick, onMounted, onScopeDispose, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useResizeObserver } from '@vueuse/core';

export interface IndicatorBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Measures the selected item of a group for `SlidingIndicator`. `root` is the items' offset parent
 * (positioned), and `selected` is the index among its elements matching `selector`.
 */
export function useSlidingIndicator(root: MaybeRefOrGetter<HTMLElement | null | undefined>, selector: string, selected: MaybeRefOrGetter<number>) {
  const box = shallowRef<IndicatorBox | null>(null);
  // False until the first box of a (re)mounted group is painted, so an opening popup places the indicator instead of flying it in.
  const animate = shallowRef(false);
  const target = shallowRef<HTMLElement | null>(null);

  function measure(): void {
    const container = toValue(root);
    const index = toValue(selected);
    const item = container?.querySelectorAll<HTMLElement>(selector)[index] ?? null;
    target.value = item;
    box.value = item ? { x: item.offsetLeft, y: item.offsetTop, width: item.offsetWidth, height: item.offsetHeight } : null;
  }

  let frame = 0;
  function place(): void {
    animate.value = false;
    measure();
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      animate.value = box.value !== null;
    });
  }

  useResizeObserver(() => [toValue(root), target.value].filter((el): el is HTMLElement => el instanceof HTMLElement), measure);
  watch(() => toValue(selected), () => void nextTick(measure));
  watch(() => toValue(root), place, { flush: 'post' });
  onMounted(place);
  onScopeDispose(() => cancelAnimationFrame(frame));

  return { box, animate, measure };
}
