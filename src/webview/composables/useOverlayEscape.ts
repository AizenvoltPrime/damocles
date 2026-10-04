import { onKeyStroke } from '@vueuse/core';
import {
  computed,
  inject,
  onBeforeMount,
  onScopeDispose,
  provide,
  shallowRef,
  type ComputedRef,
  type InjectionKey,
  type ShallowRef,
} from 'vue';

interface EscapeEntry {
  readonly onClose: () => void;
  readonly modal: boolean;
}

/** The bottom overlay sits here; each one opened on top of it takes the next value up. */
const BASE_Z_INDEX = 50;

/** The global modal layer, above every overlay panel. Bind it wherever a modal must cover the stack. */
export const MODAL_Z_INDEX = 60;

const stack: ShallowRef<readonly EscapeEntry[]> = shallowRef([]);

/** Bind on a stack overlay's own reka dismissable layer, or the stack yields Escape to the overlay itself. */
const OVERLAY_LAYER_ATTR = 'data-overlay-layer';

// reka stamps `data-dismissable-layer` on every open popup and dialog and hears Escape on `window`, after `document`.
const NESTED_LAYER_SELECTOR = `[data-dismissable-layer]:not([${OVERLAY_LAYER_ATTR}]):not([data-state="closed"])`;

const OVERLAY_Z_INDEX: InjectionKey<ComputedRef<number>> = Symbol('overlayZIndex');

/**
 * The z-index for popper content rendered inside an overlay: one above it, because the popper is portalled
 * to `body` and would otherwise tie with or sink below the overlay. Undefined outside any overlay.
 */
export function usePopperZIndex(): ComputedRef<number | undefined> {
  const overlayZIndex = inject(OVERLAY_Z_INDEX, null);
  return computed(() => (overlayZIndex ? overlayZIndex.value + 1 : undefined));
}

export interface OverlayLayer {
  /** Bind on the overlay's root element; an overlay left on a fixed z-index cannot be opened over. */
  readonly zIndex: ComputedRef<number>;
  /** Only the top overlay may take Escape or trap Tab; one beneath it must leave both alone. */
  readonly isTop: ComputedRef<boolean>;
}

/** A document-level key handler outside the stack must yield while this is true. */
export function hasOpenOverlay(): boolean {
  return stack.value.length > 0;
}

/** Every open overlay, modal layers included. */
export function openOverlayCount(): number {
  return stack.value.length;
}

export interface OverlayOptions {
  /** A host prompt that must cover every overlay: it paints on MODAL_Z_INDEX and stays on top of overlays opened after it. */
  readonly modal?: boolean;
}

/**
 * Registers a full-screen overlay in the shared overlay stack.
 *
 * Paint order and Escape routing both come from the order overlays were opened in, never from DOM
 * sibling order in `App.vue`; a nested overlay mounts strictly after the overlay it opens over.
 */
export function useOverlayEscape(onClose: () => void, options: OverlayOptions = {}): OverlayLayer {
  const entry: EscapeEntry = { onClose, modal: options.modal === true };

  // Registered before the first render, so a nested overlay never paints one frame behind the one it opened over.
  // An overlay opened under an open modal goes below it, so Escape and the Tab trap stay with the modal the user sees.
  onBeforeMount(() => {
    const firstModal = entry.modal ? -1 : stack.value.findIndex((e) => e.modal);
    stack.value = firstModal === -1
      ? [...stack.value, entry]
      : [...stack.value.slice(0, firstModal), entry, ...stack.value.slice(firstModal)];
  });

  // Scope stop runs synchronously inside unmount, while `onUnmounted` is queued post-flush and stops
  // running app-wide once any post-flush callback has thrown; the entry has to leave either way.
  onScopeDispose(() => {
    stack.value = stack.value.filter((e) => e !== entry);
  });

  const isTop = computed(() => stack.value[stack.value.length - 1] === entry);

  onKeyStroke('Escape', (e) => {
    if (!isTop.value) return;
    // The open popup closes itself; stopping the event here would close the overlay around it instead.
    if (document.querySelector(NESTED_LAYER_SELECTOR)) return;
    e.stopPropagation();
    e.preventDefault();
    entry.onClose();
  }, { target: document });

  const zIndex = computed(() => {
    if (entry.modal) return MODAL_Z_INDEX;
    const depth = stack.value.indexOf(entry);
    if (depth === -1) return BASE_Z_INDEX;
    return Math.min(BASE_Z_INDEX + depth, MODAL_Z_INDEX - 1);
  });
  provide(OVERLAY_Z_INDEX, zIndex);

  return { zIndex, isTop };
}
