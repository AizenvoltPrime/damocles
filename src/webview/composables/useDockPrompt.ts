import { onMounted, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useEventListener } from '@vueuse/core';
import { injectListboxRootContext } from 'reka-ui';
import { isEditableTarget } from '@/utils/editable-target';
import { hasOpenOverlay } from '@/composables/useOverlayEscape';

/** On the root of every prompt card docked above the composer: the composer's Escape skips it and the digit rule counts it. */
export const DOCK_PROMPT_SELECTOR = '[data-dock-prompt]';

// A digit inside another widget (an open menu, popover or listbox) is that widget's typeahead.
const OTHER_WIDGET = '[data-dismissable-layer], [role="menu"], [role="listbox"], [role="dialog"]';

/**
 * Digits 1-9 answer the dock prompt that holds focus. With focus outside every dock prompt they answer only while
 * one dock prompt is mounted, so a digit never decides a card beside the one the user is answering.
 * `card` is the element carrying `data-dock-prompt`; `answer` returns false when the digit picks nothing.
 */
export function useDockPromptDigits(card: MaybeRefOrGetter<HTMLElement | null | undefined>, answer: (digit: number) => boolean): void {
  useEventListener(document, 'keydown', (e: KeyboardEvent) => {
    const element = toValue(card);
    if (!element || e.defaultPrevented || e.repeat || !/^[1-9]$/.test(e.key)) return;
    if (e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(e.target) || hasOpenOverlay()) return;
    const target = e.target instanceof Element ? e.target : null;
    const owner = target?.closest(DOCK_PROMPT_SELECTOR);
    if (owner) {
      if (owner !== element) return;
    } else if (target?.closest(OTHER_WIDGET) || document.querySelectorAll(DOCK_PROMPT_SELECTOR).length !== 1) {
      return;
    }
    if (answer(Number(e.key))) e.preventDefault();
  });
}

// Dispatched on a dock prompt's options list by `focusDockPrompt`.
const FOCUS_OPTIONS_EVENT = 'damocles:focus-dock-options';
const FORM_FIELD = 'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [role="checkbox"]';
const FOCUSABLE = 'button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Focus a dock prompt for a user action that names it (a notification's Review), whatever holds focus: its
 * options list, else its first form field, else its first control. The mount-time hold in
 * `useDockPromptOptionsFocus` does not apply.
 */
export function focusDockPrompt(card: HTMLElement): void {
  const options = card.querySelector<HTMLElement>('[role="listbox"]');
  // A listbox that is not a `DockPromptOptions` leaves the event unanswered, and the card's fields take focus.
  const answered = options ? !options.dispatchEvent(new CustomEvent(FOCUS_OPTIONS_EVENT, { cancelable: true })) : false;
  if (!answered) (card.querySelector<HTMLElement>(FORM_FIELD) ?? card.querySelector<HTMLElement>(FOCUSABLE))?.focus();
}

/** Answers `focusDockPrompt` on the options list: releases the hold and focuses the highlighted option, or the first. */
export function useDockPromptOptionsExplicitFocus(list: MaybeRefOrGetter<HTMLElement | null | undefined>): void {
  const root = injectListboxRootContext();
  useEventListener(() => toValue(list), FOCUS_OPTIONS_EVENT, (event: Event) => {
    event.preventDefault();
    root.focusable.value = true;
    const highlighted = root.highlightedElement.value;
    if (highlighted?.isConnected) root.changeHighlight(highlighted);
    else root.highlightFirstItem();
  });
}

/**
 * A dock prompt's options take focus as they mount, unless focus is in an editable field, in another dock prompt or in
 * an open overlay. Called inside reka's `ListboxRoot`, which focuses its first highlighted item one tick after mount.
 */
export function useDockPromptOptionsFocus(list: MaybeRefOrGetter<HTMLElement | null | undefined>): void {
  const root = injectListboxRootContext();
  onMounted(() => {
    const active = document.activeElement;
    const owner = active?.closest(DOCK_PROMPT_SELECTOR);
    const ownCard = toValue(list)?.closest(DOCK_PROMPT_SELECTOR);
    if (!isEditableTarget(active) && (!owner || owner === ownCard) && !hasOpenOverlay()) return;
    root.focusable.value = false;
    watch(root.highlightedElement, () => { root.focusable.value = true; }, { once: true });
  });
}
