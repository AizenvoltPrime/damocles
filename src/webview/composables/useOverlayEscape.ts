import { onKeyStroke } from '@vueuse/core';
import { computed, onBeforeMount, onScopeDispose, shallowRef, type ComputedRef, type ShallowRef } from 'vue';

interface EscapeEntry {
  readonly onClose: () => void;
}

/** The bottom overlay sits here; each one opened on top of it takes the next value up. */
const BASE_Z_INDEX = 50;

/** The global modal layer, above every overlay panel. Bind it wherever a modal must cover the stack. */
export const MODAL_Z_INDEX = 60;

const stack: ShallowRef<readonly EscapeEntry[]> = shallowRef([]);

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

/**
 * Registers a full-screen overlay in the shared overlay stack.
 *
 * Paint order and Escape routing both come from the order overlays were opened in, never from DOM
 * sibling order in `App.vue`; a nested overlay mounts strictly after the overlay it opens over.
 */
export function useOverlayEscape(onClose: () => void): OverlayLayer {
  const entry: EscapeEntry = { onClose };

  // Registered before the first render, so a nested overlay never paints one frame behind the one it opened over.
  onBeforeMount(() => {
    stack.value = [...stack.value, entry];
  });

  // Scope stop runs synchronously inside unmount, while `onUnmounted` is queued post-flush and stops
  // running app-wide once any post-flush callback has thrown; the entry has to leave either way.
  onScopeDispose(() => {
    stack.value = stack.value.filter((e) => e !== entry);
  });

  const isTop = computed(() => stack.value[stack.value.length - 1] === entry);

  onKeyStroke('Escape', (e) => {
    if (!isTop.value) return;
    e.stopPropagation();
    e.preventDefault();
    entry.onClose();
  }, { target: document });

  const zIndex = computed(() => {
    const depth = stack.value.indexOf(entry);
    if (depth === -1) return BASE_Z_INDEX;
    return Math.min(BASE_Z_INDEX + depth, MODAL_Z_INDEX - 1);
  });

  return { zIndex, isTop };
}
