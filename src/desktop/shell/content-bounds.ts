import type { ContentBounds } from '../preload/shell-channels';

function boundsOf(element: HTMLElement): ContentBounds {
  const rect = element.getBoundingClientRect();
  // Rounding the edges, not the size, keeps the view flush with its neighbours.
  const left = Math.max(0, Math.round(rect.left));
  const top = Math.max(0, Math.round(rect.top));
  return {
    x: left,
    y: top,
    width: Math.max(0, Math.round(rect.right) - left),
    height: Math.max(0, Math.round(rect.bottom) - top),
  };
}

// Dispatched on window once the layout grid's panes have finished moving: a script animation (`element.animate()`) fires
// no animationend, and a pane that changes slot may keep its size.
export const LAYOUT_SETTLED_EVENT = 'damocles:layout-settled';

/**
 * Reports the content element's rectangle whenever it or a layout neighbour resizes, when an animation or transition ends
 * or the layout settles (a transform, such as the focus overlay's zoom or a pane's glide, moves an element without resizing
 * it), and after every devicePixelRatio change, which main needs to rescale the view even when the CSS rectangle is unchanged.
 */
export function watchContentBounds(
  content: HTMLElement,
  neighbours: readonly HTMLElement[],
  report: (bounds: ContentBounds) => void,
): () => void {
  let last: ContentBounds | undefined;
  const send = (force: boolean): void => {
    const next = boundsOf(content);
    if (!force && last && last.x === next.x && last.y === next.y && last.width === next.width && last.height === next.height) return;
    last = next;
    report(next);
  };

  const observer = new ResizeObserver(() => send(false));
  for (const element of [content, ...neighbours]) observer.observe(element);
  const settled = (): void => send(false);
  window.addEventListener('animationend', settled, true);
  window.addEventListener('transitionend', settled, true);
  window.addEventListener(LAYOUT_SETTLED_EVENT, settled);

  let dprQuery: MediaQueryList | undefined;
  const onDprChange = (): void => {
    armDpr();
    send(true);
  };
  const armDpr = (): void => {
    dprQuery?.removeEventListener('change', onDprChange);
    dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    dprQuery.addEventListener('change', onDprChange);
  };
  armDpr();
  send(true);

  return () => {
    observer.disconnect();
    window.removeEventListener('animationend', settled, true);
    window.removeEventListener('transitionend', settled, true);
    window.removeEventListener(LAYOUT_SETTLED_EVENT, settled);
    dprQuery?.removeEventListener('change', onDprChange);
  };
}
