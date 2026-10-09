import { onKeyStroke } from '@vueuse/core';
import { injectDialogRootContext } from 'reka-ui';
import {
  computed,
  inject,
  onBeforeMount,
  onScopeDispose,
  provide,
  shallowRef,
  watch,
  type ComponentPublicInstance,
  type ComputedRef,
  type InjectionKey,
  type ShallowRef,
} from 'vue';

interface EscapeEntry {
  readonly onClose: () => void;
  readonly modal: boolean;
  readonly root: (() => HTMLElement | null) | undefined;
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

/** The root element of the top overlay that registered one, where focus goes back when the control that opened a closing overlay is gone. */
export function topOverlayRoot(): HTMLElement | null {
  for (let index = stack.value.length - 1; index >= 0; index--) {
    const root = stack.value[index]!.root?.();
    if (root?.isConnected) return root;
  }
  return null;
}

export interface OverlayOptions {
  /** A host prompt that must cover every overlay: it paints on MODAL_Z_INDEX and stays on top of overlays opened after it. */
  readonly modal?: boolean;
  /** A dialog that stays mounted while closed (a reka dialog playing its exit) holds its place in the stack only while this is true. */
  readonly active?: () => boolean;
  /** The overlay's root element, which takes focus when an overlay opened over it closes after its opener went away. */
  readonly root?: () => HTMLElement | null;
}

/**
 * Registers a full-screen overlay in the shared overlay stack.
 *
 * Paint order and Escape routing both come from the order overlays were opened in, never from DOM
 * sibling order in `App.vue`; a nested overlay mounts strictly after the overlay it opens over.
 */
export function useOverlayEscape(onClose: () => void, options: OverlayOptions = {}): OverlayLayer {
  const entry: EscapeEntry = { onClose, modal: options.modal === true, root: options.root };

  // A dialog playing its exit keeps the layer it had while open, or it would drop behind the overlay it was opened over.
  let exitZIndex = BASE_Z_INDEX;
  const zIndex = computed(() => {
    if (entry.modal) return MODAL_Z_INDEX;
    const depth = stack.value.indexOf(entry);
    if (depth === -1) return exitZIndex;
    return Math.min(BASE_Z_INDEX + depth, MODAL_Z_INDEX - 1);
  });

  // An overlay opened under an open modal goes below it, so Escape and the Tab trap stay with the modal the user sees.
  function enter(): void {
    const firstModal = entry.modal ? -1 : stack.value.findIndex((e) => e.modal);
    stack.value = firstModal === -1
      ? [...stack.value, entry]
      : [...stack.value.slice(0, firstModal), entry, ...stack.value.slice(firstModal)];
  }

  function leave(): void {
    exitZIndex = zIndex.value;
    stack.value = stack.value.filter((e) => e !== entry);
  }

  // Registered before the first render, so a nested overlay never paints one frame behind the one it opened over.
  const { active } = options;
  if (active) watch(active, (open) => (open ? enter() : leave()), { immediate: true, flush: 'sync' });
  else onBeforeMount(enter);

  // Scope stop runs synchronously inside unmount, while `onUnmounted` is queued post-flush and stops
  // running app-wide once any post-flush callback has thrown; the entry has to leave either way.
  onScopeDispose(leave);

  const isTop = computed(() => stack.value[stack.value.length - 1] === entry);

  onKeyStroke('Escape', (e) => {
    if (!isTop.value) return;
    // The open popup or dialog closes itself; stopping the event here would close the overlay around it instead. A dialog
    // registered beneath this overlay is not one of them.
    const beneath = stack.value.filter((e) => e !== entry).map((e) => e.root?.());
    if ([...document.querySelectorAll(NESTED_LAYER_SELECTOR)].some((layer) => !beneath.includes(layer as HTMLElement))) return;
    e.stopPropagation();
    e.preventDefault();
    entry.onClose();
  }, { target: document });

  provide(OVERLAY_Z_INDEX, zIndex);

  return { zIndex, isTop };
}

/**
 * A reka modal dialog's layer of the stack (`ui/alert-dialog`, `ui/dialog` content), held while the dialog is open, so an
 * overlay opened over it paints above it and takes Escape. `content` is the reka content component.
 */
export function useDialogLayer(content: Readonly<ShallowRef<ComponentPublicInstance | null>>): ComputedRef<number> {
  const dialog = injectDialogRootContext();
  // The stack reads the root only while the dialog is open, when reka renders its content element.
  const root = (): HTMLElement | null => (content.value?.$el as HTMLElement | undefined) ?? null;
  // reka's own dismissable layer takes Escape, which the stack leaves to an open dialog.
  return useOverlayEscape(() => undefined, { active: () => dialog.open.value, root }).zIndex;
}
