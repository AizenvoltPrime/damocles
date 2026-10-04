import { readonly, ref, watch, onScopeDispose, type Ref } from 'vue';

/** A view this close to its end is at the bottom; absorbs fractional scroll offsets at non-100% zoom. */
const AT_BOTTOM_PX = 2;
/** How long a view under a user gesture must go without scrolling before pinning resumes. */
const SETTLE_MS = 150;

const SCROLL_KEYS: ReadonlySet<string> = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
const DOWN_KEYS: ReadonlySet<string> = new Set(['ArrowDown', 'PageDown', 'End']);
const TEXT_ENTRY = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const SPACE_ACTIVATES = 'button, a[href], summary, [role="button"], [role="checkbox"], [role="switch"], [role="tab"]';

export interface StickToBottomOptions {
  /** Whether the view follows when it attaches and when `resetKey` changes. Defaults to following. */
  startFollowing?: () => boolean;
  /** A change of value starts the view over, as `startFollowing` decides. */
  resetKey?: () => unknown;
}

function maxScroll(el: Element): number {
  return el.scrollHeight - el.clientHeight;
}

function isAtBottom(el: HTMLElement): boolean {
  return maxScroll(el) - el.scrollTop <= AT_BOTTOM_PX;
}

/** The scroll key this event presses, or null for one that types, activates a control, or was handled. */
function scrollKey(e: KeyboardEvent): string | null {
  if (e.defaultPrevented || e.altKey || !SCROLL_KEYS.has(e.key)) return null;
  const target = e.target instanceof Element ? e.target : null;
  if (target?.closest(TEXT_ENTRY)) return null;
  if (e.key === ' ' && target?.closest(SPACE_ACTIVATES)) return null;
  return e.key;
}

/**
 * Keeps a scrolling view at its bottom while content streams in, the way a chat or a terminal does.
 * The view's own position is the only evidence that the reader left the bottom; a user gesture only
 * holds pinning until the view settles. The rule: `docs/invariants.md#streaming-views`.
 */
export function useStickToBottom(scrollRef: Readonly<Ref<HTMLElement | null>>, options: StickToBottomOptions = {}) {
  const startFollowing = options.startFollowing ?? (() => true);
  const following = ref(startFollowing());
  let lastTop = 0;
  let lastMax = 0;
  let pointerHeld = false;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let detach: (() => void) | null = null;

  function record(el: HTMLElement): void {
    lastTop = el.scrollTop;
    lastMax = maxScroll(el);
  }

  function pinIfFollowing(el: HTMLElement): void {
    if (following.value && !isAtBottom(el)) el.scrollTop = maxScroll(el);
    record(el);
  }

  function isHeld(): boolean {
    return pointerHeld || settleTimer !== null;
  }

  /** Reads where the view is and decides whether it still follows; pins it only outside a user gesture. */
  function sync(): void {
    const el = scrollRef.value;
    if (!el) return;
    const top = el.scrollTop;
    const movedUp = top < lastTop;
    const shrank = maxScroll(el) < lastMax;
    const atBottom = isAtBottom(el);
    const held = isHeld();
    if (movedUp && (!atBottom || (held && !shrank))) following.value = false;
    else if (atBottom && (top > lastTop || shrank)) following.value = true;
    if (held) record(el);
    else pinIfFollowing(el);
  }

  function holdUntilSettled(): void {
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      sync();
    }, SETTLE_MS);
  }

  function endHold(): void {
    pointerHeld = false;
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = null;
  }

  /** A downward gesture at the bottom cannot move the view, so it is read as the reader asking to follow. */
  function followIfAtBottom(): void {
    const el = scrollRef.value;
    if (el && isAtBottom(el)) following.value = true;
  }

  function onScroll(): void {
    if (settleTimer !== null) holdUntilSettled();
    sync();
  }

  function onWheel(e: WheelEvent): void {
    if (e.ctrlKey) return;
    holdUntilSettled();
    if (e.deltaY > 0) followIfAtBottom();
  }

  function onKeyDown(e: KeyboardEvent): void {
    const key = scrollKey(e);
    if (key === null) return;
    holdUntilSettled();
    if (DOWN_KEYS.has(key) || (key === ' ' && !e.shiftKey)) followIfAtBottom();
  }

  function onPointerDown(): void {
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = null;
    pointerHeld = true;
  }

  function onPointerUp(): void {
    if (!pointerHeld) return;
    pointerHeld = false;
    holdUntilSettled();
  }

  function restart(el: HTMLElement): void {
    endHold();
    following.value = startFollowing();
    pinIfFollowing(el);
  }

  function attach(el: HTMLElement): () => void {
    restart(el);
    // Growth is read from DOM mutations, not a ResizeObserver on the content (docs/invariants.md#streaming-views).
    const mutations = new MutationObserver(sync);
    mutations.observe(el, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'open', 'hidden'],
    });
    const resizes = new ResizeObserver(sync);
    resizes.observe(el);
    const doc = el.ownerDocument;
    const win = doc.defaultView;
    const passive = { passive: true } as const;
    const captured = { passive: true, capture: true } as const;
    el.addEventListener('scroll', onScroll, passive);
    el.addEventListener('wheel', onWheel, passive);
    el.addEventListener('pointerdown', onPointerDown, passive);
    // Keyboard scrolling can move the view while focus is outside it.
    doc.addEventListener('keydown', onKeyDown, passive);
    win?.addEventListener('pointerup', onPointerUp, passive);
    win?.addEventListener('pointercancel', onPointerUp, passive);
    // Layout that changes with no DOM mutation: media finishing loading, and CSS animations finishing.
    el.addEventListener('load', sync, captured);
    el.addEventListener('animationend', sync, captured);
    el.addEventListener('transitionend', sync, captured);
    return () => {
      endHold();
      mutations.disconnect();
      resizes.disconnect();
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onPointerDown);
      doc.removeEventListener('keydown', onKeyDown);
      win?.removeEventListener('pointerup', onPointerUp);
      win?.removeEventListener('pointercancel', onPointerUp);
      el.removeEventListener('load', sync, true);
      el.removeEventListener('animationend', sync, true);
      el.removeEventListener('transitionend', sync, true);
    };
  }

  watch(
    scrollRef,
    (el) => {
      detach?.();
      detach = el ? attach(el) : null;
    },
    { immediate: true, flush: 'post' },
  );

  if (options.resetKey) {
    watch(options.resetKey, () => {
      const el = scrollRef.value;
      if (el) restart(el);
    }, { flush: 'post' });
  }

  onScopeDispose(() => {
    detach?.();
    detach = null;
  });

  /** Follows again and jumps to the bottom, for a reader who asked for the latest output. */
  function scrollToBottom(): void {
    endHold();
    following.value = true;
    const el = scrollRef.value;
    if (el) pinIfFollowing(el);
  }

  /** The jump button unmounts once the view follows, so focus moves into the view. */
  function jumpToLatest(): void {
    scrollRef.value?.focus({ preventScroll: true });
    scrollToBottom();
  }

  return { isFollowing: readonly(following), scrollToBottom, jumpToLatest };
}
