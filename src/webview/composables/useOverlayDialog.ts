import { onKeyStroke } from '@vueuse/core';
import { onMounted, onScopeDispose, shallowRef, useId, type ComputedRef, type ShallowRef } from 'vue';
import { useOverlayEscape } from './useOverlayEscape';

/**
 * Marks the region an overlay hands focus back to when the control that opened it is gone.
 *
 * The transcript is virtualized, so the row a tool overlay was opened from can be recycled while the
 * overlay is up. Focusing a detached element does nothing and focus falls to `document.body`.
 */
const RETURN_FOCUS_FALLBACK = '[data-overlay-return-focus]';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface OverlayDialog {
  /** Bind on the dialog's root element; an overlay left on a fixed z-index cannot be opened over. */
  readonly zIndex: ComputedRef<number>;
  /** Only the top overlay may take Escape or trap Tab; one beneath it must leave both alone. */
  readonly isTop: ComputedRef<boolean>;
  /** Bind as `ref` on the same root element, or the dialog can neither trap Tab nor place focus. */
  readonly root: ShallowRef<HTMLElement | null>;
  /** Bind as the root's `aria-labelledby` and as the `id` of the heading that names the dialog. */
  readonly titleId: string;
}

/**
 * Modal dialog behaviour for a full-screen overlay: stack registration, Escape, paint order, an
 * accessible name, and focus moved in on open, contained while open and handed back on close.
 */
export function useOverlayDialog(onClose: () => void): OverlayDialog {
  const { zIndex, isTop } = useOverlayEscape(onClose);
  const root = shallowRef<HTMLElement | null>(null);
  const titleId = useId();

  // Read during setup, while the control that opened the overlay still holds focus.
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  function focusableItems(): HTMLElement[] {
    const el = root.value;
    if (!el) return [];
    return Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  }

  onMounted(() => {
    (focusableItems()[0] ?? root.value)?.focus();
  });

  onScopeDispose(() => {
    const target = opener?.isConnected === true
      ? opener
      : document.querySelector<HTMLElement>(RETURN_FOCUS_FALLBACK);
    target?.focus();
  });

  onKeyStroke(
    'Tab',
    (e) => {
      const el = root.value;
      if (!isTop.value || !el) return;

      const items = focusableItems();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        e.preventDefault();
        el.focus();
        return;
      }

      const active = document.activeElement;
      if (active === null || active === document.body) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      // Focus placed in another widget belongs to it; a modal portalled above this one is that case.
      if (!el.contains(active)) return;

      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    { target: document },
  );

  return { zIndex, isTop, root, titleId };
}
