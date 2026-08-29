// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { hasOpenOverlay, useOverlayEscape, MODAL_Z_INDEX } from '../useOverlayEscape';

/**
 * Escape must reach exactly one overlay: the one the user is looking at.
 *
 * Before the stack, every mounted overlay bound Escape on `document`, so a tool overlay opened on top
 * of a subagent overlay closed both at once. These tests drive real mounts and a real keydown, because
 * the registration and the unregistration both hang off component lifecycle and a hand-called
 * register/unregister pair would not prove that the composable wires them.
 */

const mounted: VueWrapper[] = [];

function openOverlay(onClose: () => void): VueWrapper {
  const wrapper = mount(
    defineComponent({
      setup() {
        useOverlayEscape(onClose);
        return () => null;
      },
    }),
    { attachTo: document.body },
  );
  mounted.push(wrapper);
  return wrapper;
}

function closeOverlay(wrapper: VueWrapper): void {
  wrapper.unmount();
  const index = mounted.indexOf(wrapper);
  if (index !== -1) mounted.splice(index, 1);
}

/** Dispatched from `body` and bubbling, so it reaches a listener bound on `document` or on `window`. */
function pressEscape(): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  document.body.dispatchEvent(event);
  return event;
}

afterEach(() => {
  // The stack lives at module scope, so a wrapper left mounted would leak into the next test.
  while (mounted.length > 0) mounted.pop()?.unmount();
});

describe('escape reaching only the overlay on top', () => {
  it('closes the overlay opened last and leaves the one beneath it open', () => {
    const beneath = vi.fn();
    const onTop = vi.fn();

    openOverlay(beneath);
    openOverlay(onTop);

    pressEscape();

    expect(onTop).toHaveBeenCalledTimes(1);
    expect(beneath).not.toHaveBeenCalled();
  });

  it('closes the overlay beneath once the one above it has closed', () => {
    const beneath = vi.fn();
    const onTop = vi.fn();

    openOverlay(beneath);
    const top = openOverlay(onTop);

    closeOverlay(top);
    pressEscape();

    expect(beneath).toHaveBeenCalledTimes(1);
    expect(onTop).not.toHaveBeenCalled();
  });

  it('keeps closing the topmost overlay after one in the middle closes out of order', () => {
    const bottom = vi.fn();
    const middle = vi.fn();
    const top = vi.fn();

    openOverlay(bottom);
    const middleWrapper = openOverlay(middle);
    const topWrapper = openOverlay(top);

    closeOverlay(middleWrapper);

    // The middle entry left by identity, so the top entry must still be the top entry.
    pressEscape();
    expect(top).toHaveBeenCalledTimes(1);
    expect(middle).not.toHaveBeenCalled();
    expect(bottom).not.toHaveBeenCalled();

    closeOverlay(topWrapper);

    // And the bottom entry must still be reachable rather than stranded under a removed one.
    pressEscape();
    expect(bottom).toHaveBeenCalledTimes(1);
    expect(top).toHaveBeenCalledTimes(1);
    expect(middle).not.toHaveBeenCalled();
  });

  it('stops the escape key from travelling past the overlay that handled it', () => {
    openOverlay(vi.fn());

    const event = pressEscape();

    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves the escape key alone when no overlay is open', () => {
    const event = pressEscape();

    expect(event.defaultPrevented).toBe(false);
  });
});

describe('the stack entry a torn-down overlay leaves behind', () => {
  it('is gone the instant the overlay is torn down, without waiting for a flush', () => {
    // `onUnmounted` is queued post-flush, so an entry removed there is still on the stack for the rest
    // of the tick, and stops being removed at all once any post-flush callback has thrown.
    const beneath = vi.fn();
    const top = openOverlay(beneath);

    expect(hasOpenOverlay()).toBe(true);

    top.unmount();
    mounted.splice(mounted.indexOf(top), 1);

    expect(hasOpenOverlay()).toBe(false);
  });

  it('hands Escape back to the overlay beneath in the same tick', () => {
    const beneath = vi.fn();
    const top = vi.fn();

    openOverlay(beneath);
    const topWrapper = openOverlay(top);

    topWrapper.unmount();
    mounted.splice(mounted.indexOf(topWrapper), 1);
    pressEscape();

    expect(beneath).toHaveBeenCalledTimes(1);
    expect(top).not.toHaveBeenCalled();
  });
});

/** Renders the layer it was handed, so a test can read `zIndex` and `isTop` off the DOM. */
function openLayer(): VueWrapper {
  const wrapper = mount(
    {
      setup() {
        const { zIndex, isTop } = useOverlayEscape(() => {});
        return () => h('div', { 'data-z': String(zIndex.value), 'data-top': String(isTop.value) });
      },
    },
    { attachTo: document.body },
  );
  mounted.push(wrapper);
  return wrapper;
}

function zIndexOf(wrapper: VueWrapper): number {
  return Number(wrapper.get('div').attributes('data-z'));
}

describe('the derived paint order', () => {
  it('climbs one layer per overlay opened', () => {
    const layers = [openLayer(), openLayer(), openLayer()];

    expect(layers.map(zIndexOf)).toEqual([50, 51, 52]);
  });

  it('stops below the global modal layer instead of climbing into it', () => {
    const layers = Array.from({ length: 25 }, () => openLayer());

    for (const layer of layers) expect(zIndexOf(layer)).toBeLessThan(MODAL_Z_INDEX);
  });

  it('marks only the overlay opened last as the top layer', async () => {
    const beneath = openLayer();
    const top = openLayer();

    await top.vm.$nextTick();

    expect(beneath.get('div').attributes('data-top')).toBe('false');
    expect(top.get('div').attributes('data-top')).toBe('true');
  });
});

describe('a document-level handler that is not part of the stack', () => {
  it('still runs on the same Escape, because stopPropagation cannot reach a sibling listener', () => {
    // This is why `App.vue`'s plan-cancel handler needs its own check rather than trusting the stack.
    const sibling = vi.fn();
    document.addEventListener('keydown', sibling);

    try {
      openOverlay(vi.fn());
      pressEscape();

      expect(sibling).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', sibling);
    }
  });

  it('can stand down for as long as an overlay owns Escape', () => {
    const planCancel = vi.fn();
    const guarded = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || hasOpenOverlay()) return;
      planCancel();
    };
    document.addEventListener('keydown', guarded);

    try {
      pressEscape();
      expect(planCancel).toHaveBeenCalledTimes(1);

      const overlayClose = vi.fn();
      const overlay = openOverlay(overlayClose);
      pressEscape();

      expect(overlayClose).toHaveBeenCalledTimes(1);
      expect(planCancel).toHaveBeenCalledTimes(1);

      closeOverlay(overlay);
      pressEscape();

      expect(planCancel).toHaveBeenCalledTimes(2);
    } finally {
      document.removeEventListener('keydown', guarded);
    }
  });
});
