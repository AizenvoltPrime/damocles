/**
 * A filter for an overlay list's hover events: true only when the pointer moved since the previous event. A list that opens
 * under a resting pointer gets a move event with no movement (X11 sends one as the view appears), which must not take the
 * keyboard's selection from the first row.
 */
export function createPointerMoveFilter(): (event: MouseEvent) => boolean {
  let last: { x: number; y: number } | undefined;
  return (event) => {
    const moved = last !== undefined && (last.x !== event.screenX || last.y !== event.screenY);
    last = { x: event.screenX, y: event.screenY };
    return moved;
  };
}
