export interface ViewRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The part of rect at or right of and below the view's origin: desktop main refuses an anchor with a negative x or y. */
export function visibleRect(rect: DOMRect): ViewRect {
  const x = Math.max(0, rect.left);
  const y = Math.max(0, rect.top);
  return { x, y, width: Math.max(0, rect.right - x), height: Math.max(0, rect.bottom - y) };
}
