import { vi } from 'vitest';

export interface StackSizes {
  /** Height of the scroll area's visible part. */
  viewPx: number;
  rowPx: number;
  headingPx: number;
}

/**
 * Gives happy-dom, which has no layout, a stacked one inside `scroller`: every `[role="option"]` is `rowPx` tall, every
 * group heading (the element its group's `aria-labelledby` names) `headingPx`, everything else nothing. The scroller's
 * visible part starts at client top 0 and is `viewPx` tall; its `scrollTop` clamps as a browser's does. Positions are
 * measured on every read, so filtering and arriving rows reflow the stack. Undo with `vi.restoreAllMocks()`.
 */
export function stackLayout(scroller: HTMLElement, { viewPx, rowPx, headingPx }: StackSizes): void {
  scroller.style.overflowY = 'auto';

  const boxes = (): { tops: Map<Element, [number, number]>; height: number } => {
    const tops = new Map<Element, [number, number]>();
    let y = 0;
    for (const element of scroller.querySelectorAll('*')) {
      if (element.closest('[hidden]')) continue;
      const heading = element.id !== '' && element.parentElement?.getAttribute('aria-labelledby') === element.id;
      const height = element.getAttribute('role') === 'option' ? rowPx : heading ? headingPx : 0;
      if (height === 0) continue;
      tops.set(element, [y, height]);
      y += height;
    }
    return { tops, height: y };
  };

  let scrollTop = 0;
  const maxScroll = () => Math.max(0, boxes().height - viewPx);
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, get: () => viewPx },
    scrollHeight: { configurable: true, get: () => Math.max(viewPx, boxes().height) },
    scrollTop: {
      configurable: true,
      get: () => Math.min(scrollTop, maxScroll()),
      set: (value: number) => (scrollTop = Math.min(Math.max(0, value), maxScroll())),
    },
  });

  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this === scroller) return new DOMRect(0, 0, 400, viewPx);
    const box = boxes().tops.get(this);
    return box ? new DOMRect(0, box[0] - scroller.scrollTop, 400, box[1]) : original.call(this);
  });
}
