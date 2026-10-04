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
