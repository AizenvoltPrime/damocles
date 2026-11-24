import { computed, ref, toValue, watch, type ComputedRef, type MaybeRefOrGetter } from 'vue';
import { tryOnScopeDispose } from '@vueuse/core';
import { isEditableTarget } from '@/utils/editable-target';
import { afterShownHold } from './trusted-hold';

// IntersectionObserver v2: TypeScript's DOM types lack trackVisibility, delay and isVisible.
interface VisibilityObserverInit extends IntersectionObserverInit {
  trackVisibility: boolean;
  delay: number;
}
type VisibilityEntry = IntersectionObserverEntry & { readonly isVisible?: boolean };

// Chromium's minimum delay for trackVisibility; a smaller value throws.
const VISIBILITY_DELAY_MS = 100;

// Every event a trusted card may bind a decision to (docs/invariants.md "Theme CSS and trusted regions"): a card decides on
// a click, a submit or a key, never on a pointer, mouse, touch or contextmenu event, which reach listeners outside the card.
// Keys keep their default action, so text still types.
export const HELD_EVENTS = ['click', 'dblclick', 'auxclick', 'submit', 'keydown', 'keyup'] as const;
const CANCELLED_EVENTS: ReadonlySet<string> = new Set(['click', 'dblclick', 'auxclick', 'submit']);
// Keys that move or modify and never answer, so they do not restart the hold of a card just shown.
const NOT_A_PRESS: ReadonlySet<string> = new Set(['Tab', 'Shift', 'Control', 'Alt', 'Meta', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
// A control that only views (a card's Expand preview) acts while the card is held.
const VIEW_ONLY = '[data-view-only]';
// "true" once the card may be answered, "false" while it is held; on the observed element, for tests and styles.
export const READY_ATTRIBUTE = 'data-trusted-ready';
// Past the longest entrance animation in motion.css (300 ms) plus the check's delay, so a card that turns visible as it
// settles never flashes its reason, and a card that stays covered says why.
const EXPLAIN_AFTER_MS = 500;

export interface TrustedVisibilityOptions {
  /** The card is held for a reason it states elsewhere (its host is away), so it does not explain the check. */
  quiet?: MaybeRefOrGetter<boolean>;
  /** The request the card shows, where a newer one replaces it on the same element: each change starts the hold again. */
  request?: MaybeRefOrGetter<unknown>;
}

export interface TrustedVisibility {
  /** The card may be answered: shown for `SHOWN_HOLD_MS` and, where gated, wholly in view, uncovered and undistorted. */
  isVisible: ComputedRef<boolean>;
  /** The card has stayed covered past its entrance, so it says why its controls do nothing. */
  explain: ComputedRef<boolean>;
  /** For an answer that does not pass through the card's root (a document key listener): true while the card is held. */
  refuse: () => boolean;
}

function isPress(event: Event): boolean {
  if (event.type === 'keyup') return false;
  if (!(event instanceof KeyboardEvent)) return true;
  if (NOT_A_PRESS.has(event.key)) return false;
  return event.key === 'Enter' || event.key === 'Escape' || !isEditableTarget(event.target);
}

/**
 * A trusted card answers only once it has been shown for `SHOWN_HOLD_MS` (in every host; a press inside that window
 * restarts it) and, where `gated` (`HostCapabilities.damoclesTheme`: VS Code paints no theme CSS), while Chromium reports
 * the whole card in view, unobscured and undistorted (IntersectionObserver v2 at threshold 1). Until then every event of
 * `HELD_EVENTS` on it stops at its root, before any of its own handlers and before any listener outside it; a card whose
 * handlers live outside its root (a document listener) asks `refuse`. A new request is a new element (key the card by its
 * request id), which starts held, or one that replaces the old in place is passed as `request`, which holds it again; an
 * element the card no longer shows, one playing its leave included, is inert and answers nothing.
 */
export function useTrustedVisibility(
  target: MaybeRefOrGetter<HTMLElement | null | undefined>,
  gated: MaybeRefOrGetter<boolean>,
  options: TrustedVisibilityOptions = {},
): TrustedVisibility {
  const whole = ref(false);
  const settled = ref(false);
  const explainDue = ref(false);
  const isVisible = computed(() => settled.value && (whole.value || !toValue(gated)));
  const explain = computed(() => explainDue.value && !toValue(options.quiet));
  let shown: HTMLElement | null = null;
  let observer: IntersectionObserver | null = null;
  let cancelHold: (() => void) | null = null;
  let explainTimer: ReturnType<typeof setTimeout> | undefined;

  const mark = (): void => shown?.setAttribute(READY_ATTRIBUTE, String(isVisible.value));
  watch(isVisible, mark, { flush: 'sync' });

  const startHold = (): void => {
    cancelHold?.();
    settled.value = false;
    cancelHold = afterShownHold(() => {
      cancelHold = null;
      settled.value = true;
    });
  };
  const endHold = (): void => {
    cancelHold?.();
    cancelHold = null;
    settled.value = false;
  };

  const setWhole = (next: boolean, observing: boolean): void => {
    whole.value = next;
    if (observing && !next) {
      if (explainTimer === undefined && !explainDue.value) explainTimer = setTimeout(() => { explainDue.value = true; }, EXPLAIN_AFTER_MS);
      return;
    }
    clearTimeout(explainTimer);
    explainTimer = undefined;
    explainDue.value = false;
  };

  const hold = (event: Event): void => {
    if (isVisible.value) return;
    const viewOnly = event.target instanceof Element ? event.target.closest(VIEW_ONLY) : null;
    if (viewOnly && event.currentTarget instanceof Node && event.currentTarget.contains(viewOnly)) return;
    event.stopImmediatePropagation();
    if (CANCELLED_EVENTS.has(event.type)) event.preventDefault();
    if (!settled.value && isPress(event)) startHold();
  };
  const swallow = (event: Event): void => {
    event.stopImmediatePropagation();
    if (CANCELLED_EVENTS.has(event.type)) event.preventDefault();
  };

  const unobserve = (): void => {
    observer?.disconnect();
    observer = null;
    clearTimeout(explainTimer);
    explainTimer = undefined;
    explainDue.value = false;
    whole.value = false;
  };
  // The element stays in the page while its leave plays, with its own handlers still bound: it is made inert, so no
  // pointer or key reaches it, and what a script still dispatches on it is swallowed.
  const retire = (): void => {
    unobserve();
    endHold();
    if (!shown) return;
    for (const type of HELD_EVENTS) {
      shown.removeEventListener(type, hold, { capture: true });
      shown.addEventListener(type, swallow, { capture: true });
    }
    shown.setAttribute(READY_ATTRIBUTE, 'false');
    shown.setAttribute('inert', '');
    shown = null;
  };

  watch(
    [() => toValue(target) ?? null, () => toValue(gated)],
    ([element, isGated]) => {
      if (element !== shown) {
        retire();
        shown = element;
        if (element) {
          for (const type of HELD_EVENTS) element.addEventListener(type, hold, { capture: true });
          startHold();
        }
      } else {
        unobserve();
      }
      mark();
      if (!element || !isGated) return;
      const init: VisibilityObserverInit = { threshold: 1, trackVisibility: true, delay: VISIBILITY_DELAY_MS };
      observer = new IntersectionObserver((entries) => {
        const last = entries[entries.length - 1] as VisibilityEntry | undefined;
        // threshold 1 reports isVisible only for a card wholly in view; the ratio is read too, so a clipped card never counts
        if (last) setWhole(last.isVisible === true && last.intersectionRatio >= 1, true);
      }, init);
      setWhole(false, true);
      observer.observe(element);
    },
    // sync: the element is held from the moment the card shows it, and a leaving one from the moment it is let go
    { immediate: true, flush: 'sync' },
  );

  watch(() => toValue(options.request), () => {
    if (shown) startHold();
  }, { flush: 'sync' });

  tryOnScopeDispose(retire);

  return {
    isVisible,
    explain,
    refuse: (): boolean => {
      if (isVisible.value) return false;
      if (shown && !settled.value) startHold();
      return true;
    },
  };
}
