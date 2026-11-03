import { onScopeDispose, shallowRef, type Ref } from 'vue';
import { remPx } from './useRemPx';

export interface DragAutoScrollOptions {
  /** Height of the zone at the top and bottom edge where a held drag scrolls. */
  readonly edgeRem: number;
  /** Scroll per frame with the pointer at the edge itself; less in proportion as it sits further in. */
  readonly maxStepRem: number;
}

// VS Code's list (setupDragAndDropScrollTopAnimation): a 35px zone, 14px steps, a 1 s idle stop.
export const DRAG_AUTO_SCROLL: DragAutoScrollOptions = { edgeRem: 2.1875, maxStepRem: 0.875 };
// Chromium repeats dragover while the pointer rests, so this long a silence means the drag ended without a dragleave.
const IDLE_STOP_MS = 1000;

/**
 * Scrolls `scroller` while a drag is held near its top or bottom edge. Call `onDragOver` from every dragover over it,
 * and `stop` when the drag leaves, drops or ends. While `holding`, bind the scroller's overflow hidden, with
 * `scrollbar-gutter: stable` so its content keeps its width: Chromium also scrolls a drag's scroll box from its own 20px
 * edge belt, at its own speed, but never one whose overflow is hidden. `holding` is true only in the edge zones, so the
 * wheel and the scrollbar still work while the drag is anywhere else over it.
 */
export function useDragAutoScroll(scroller: Readonly<Ref<HTMLElement | null>>, options: DragAutoScrollOptions = DRAG_AUTO_SCROLL) {
  let pointerY = 0;
  let frame: number | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const holding = shallowRef(false);

  // `by` is this frame's scroll toward the nearer edge, negative upward, and 0 outside the zones.
  function measure(element: HTMLElement): { readonly hold: boolean; readonly by: number } {
    if (element.scrollHeight <= element.clientHeight) return { hold: false, by: 0 };
    const { top, bottom } = element.getBoundingClientRect();
    const fromTop = pointerY - top;
    const fromBottom = bottom - pointerY;
    const nearer = Math.min(fromTop, fromBottom);
    const edge = remPx(options.edgeRem);
    // The hold band keeps the full edge so it always contains Chromium's belt; the scroll zone shrinks so the two never meet.
    const zone = Math.min(edge, (bottom - top) / 3);
    const hold = nearer < edge;
    if (nearer >= zone) return { hold, by: 0 };
    // Whole pixels: a fractional scrollTop can round back to where it was, which would stall a shallow hold.
    const by = Math.ceil(remPx(options.maxStepRem) * Math.min(1, (zone - nearer) / zone));
    return { hold, by: fromTop <= fromBottom ? -by : by };
  }

  function step(): void {
    frame = undefined;
    const element = scroller.value;
    if (!element) return;
    const { by } = measure(element);
    const max = Math.max(0, element.scrollHeight - element.clientHeight);
    const to = Math.min(max, Math.max(0, element.scrollTop + by));
    if (to === element.scrollTop) return;
    element.scrollTop = to;
    frame = requestAnimationFrame(step);
  }

  function stop(): void {
    if (frame !== undefined) cancelAnimationFrame(frame);
    if (idle !== undefined) clearTimeout(idle);
    frame = undefined;
    idle = undefined;
    holding.value = false;
  }

  function onDragOver(event: DragEvent): void {
    pointerY = event.clientY;
    const element = scroller.value;
    const { hold, by } = element ? measure(element) : { hold: false, by: 0 };
    holding.value = hold;
    if (by !== 0) frame ??= requestAnimationFrame(step);
    else if (frame !== undefined) {
      cancelAnimationFrame(frame);
      frame = undefined;
    }
    if (idle !== undefined) clearTimeout(idle);
    idle = hold || frame !== undefined ? setTimeout(stop, IDLE_STOP_MS) : undefined;
  }

  onScopeDispose(stop);
  return { onDragOver, stop, holding };
}
