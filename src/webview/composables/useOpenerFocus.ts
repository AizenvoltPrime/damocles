import { nextTick, toValue, watch, type MaybeRefOrGetter } from 'vue';

/**
 * Focus return for a reka dialog opened without a reka trigger, which reka would otherwise leave on `body`.
 * Bind the returned handler to the content's `close-auto-focus`.
 */
export function useOpenerFocus(open: MaybeRefOrGetter<boolean>): (event: Event) => void {
  let opener: HTMLElement | null = null;
  // The nearest focusable region holding the opener (its overlay or the transcript), for an opener that the
  // confirmed action disabled (a Stop turned busy) or removed (the run it stopped already ended).
  let region: HTMLElement | null = null;
  watch(() => toValue(open), (isOpen) => {
    if (!isOpen) return;
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    region = opener?.parentElement?.closest<HTMLElement>('[tabindex]') ?? null;
  }, { immediate: true });

  return (event) => {
    event.preventDefault();
    const target = opener;
    const fallback = region;
    opener = null;
    region = null;
    // Read after the flush that closed the dialog, which is the one that disables the opener.
    void nextTick(() => {
      if (target?.isConnected && !target.matches(':disabled')) target.focus();
      else if (fallback?.isConnected) fallback.focus();
    });
  };
}
