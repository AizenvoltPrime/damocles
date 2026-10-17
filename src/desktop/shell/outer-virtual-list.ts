import { computed, ref, shallowRef, watch, type Ref } from 'vue';
import { useEventListener, useResizeObserver } from '@vueuse/core';

export interface VirtualRange {
  readonly start: number;
  readonly end: number;
}

// tops[i] is item i's top within the list and tops[length] the list's height. Returns the items that meet
// [viewTop, viewTop + viewHeight), widened by overscan on each side.
export function visibleRange(tops: readonly number[], viewTop: number, viewHeight: number, overscan: number): VirtualRange {
  const count = tops.length - 1;
  const firstEndingAfter = (y: number): number => {
    let low = 0;
    let high = count;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (tops[mid + 1]! > y) high = mid;
      else low = mid + 1;
    }
    return low;
  };
  const start = firstEndingAfter(viewTop);
  let end = start;
  while (end < count && tops[end]! < viewTop + viewHeight) end++;
  return { start: Math.max(0, start - overscan), end: Math.min(count, end + overscan) };
}

/**
 * A virtual list that scrolls with the content above it: `scroller` is the one scroll container, and `list` sits inside it
 * after that content. `scroller` must be `list`'s offsetParent (positioned), so `list.offsetTop` is in scrollTop's space.
 */
export function useOuterVirtualList<T>(
  items: Ref<readonly T[]>,
  options: { scroller: Ref<HTMLElement | null>; list: Ref<HTMLElement | null>; itemHeight: (item: T) => number; overscan: number },
) {
  const { scroller, list, itemHeight, overscan } = options;
  const scrollTop = ref(0);
  const viewHeight = ref(0);
  const listTop = ref(0);
  // Item heights are rem: a font size change resizes the scroller's content, which re-reads them.
  const resized = ref(0);

  const tops = computed(() => {
    void resized.value;
    const result = [0];
    for (const item of items.value) result.push(result.at(-1)! + itemHeight(item));
    return result;
  });
  const range = computed(() => visibleRange(tops.value, scrollTop.value - listTop.value, viewHeight.value, overscan));
  const visible = computed(() => items.value.slice(range.value.start, range.value.end).map((data, offset) => ({ data, index: range.value.start + offset })));
  const wrapperStyle = computed(() => {
    const above = tops.value[range.value.start]!;
    return { height: `${tops.value.at(-1)! - above}px`, marginTop: `${above}px` };
  });

  function measure(): void {
    const element = scroller.value;
    if (!element) return;
    scrollTop.value = element.scrollTop;
    viewHeight.value = element.clientHeight;
    listTop.value = list.value?.offsetTop ?? 0;
  }

  // The scroller and its children: a child resizing above the list moves the list.
  const observed = shallowRef<HTMLElement[]>([]);
  watch(scroller, (element) => {
    observed.value = element ? [element, ...Array.from(element.children, (child) => child as HTMLElement)] : [];
    measure();
  }, { flush: 'post', immediate: true });
  useResizeObserver(observed, () => {
    resized.value++;
    measure();
  });
  useEventListener(scroller, 'scroll', measure, { passive: true });

  // Scrolls the least distance that shows item index whole, and renders the new window before the next tick.
  function reveal(index: number): void {
    const element = scroller.value;
    if (!element || index < 0 || index >= items.value.length) return;
    const top = listTop.value + tops.value[index]!;
    const bottom = listTop.value + tops.value[index + 1]!;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight;
    measure();
  }

  return { list: visible, wrapperStyle, reveal, viewHeight };
}
