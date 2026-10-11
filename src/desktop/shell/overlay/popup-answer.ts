import type { PopupAnswer } from '../../preload/overlay-channels';

/**
 * The value of a popup-scoped overlay call, or undefined when main answered that its popup is closed: the popup is on its
 * way out, so the caller has nothing to show. A rejection is a real failure and reaches the caller.
 */
export async function answerOf<T>(call: Promise<PopupAnswer<T>>): Promise<T | undefined> {
  const answer = await call;
  return answer.ok ? answer.value : undefined;
}

/** Whether main ran a popup-scoped action that returns nothing: false when its popup is closed. A rejection reaches the caller. */
export async function ran(call: Promise<PopupAnswer<void>>): Promise<boolean> {
  return (await call).ok;
}
