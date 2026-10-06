const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keeps Tab and Shift+Tab cycling inside root; returns whether it handled the key. */
export function trapTab(event: KeyboardEvent, root: HTMLElement): boolean {
  if (event.key !== 'Tab') return false;
  // A part on its way out (a leaving toast) is inert, so it can neither take focus nor end the cycle.
  const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.closest('[inert]') === null);
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) return false;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !root.contains(active))) {
    event.preventDefault();
    last.focus();
    return true;
  }
  if (!event.shiftKey && (active === last || !root.contains(active))) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}
