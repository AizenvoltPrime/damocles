// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref, type Ref } from 'vue';
import ImageLightbox from '../ImageLightbox.vue';
import { hasOpenOverlay, useOverlayEscape } from '@/composables/useOverlayEscape';
import { i18n } from '@/i18n';

/** An overlay that opens the lightbox, the way McpToolOverlay and the subagent overlay do. */
function mountHost(onHostClose: () => void): { wrapper: VueWrapper; open: Ref<boolean>; hostZ: () => number } {
  const open = ref(false);
  let hostZ = 0;
  const Host = defineComponent({
    setup() {
      const { zIndex } = useOverlayEscape(onHostClose);
      return () => {
        hostZ = zIndex.value;
        return h(ImageLightbox, { open: open.value, imageUrl: 'data:image/png;base64,AAAA', onClose: () => { open.value = false; } });
      };
    },
  });
  const wrapper = mount(Host, { global: { plugins: [i18n] }, attachTo: document.body });
  return { wrapper, open, hostZ: () => hostZ };
}

function pressEscape(): void {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
}

function lightboxBackdrop(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('.bg-black\\/80');
}

let host: VueWrapper | null = null;

afterEach(() => {
  host?.unmount();
  host = null;
});

describe('ImageLightbox in the overlay stack', () => {
  it('takes Escape ahead of the overlay that opened it and paints one level above it', async () => {
    const onHostClose = vi.fn();
    const mounted = mountHost(onHostClose);
    host = mounted.wrapper;

    mounted.open.value = true;
    await nextTick();
    await nextTick();

    const backdrop = lightboxBackdrop();
    expect(backdrop).not.toBeNull();
    expect(Number(backdrop!.style.zIndex)).toBe(mounted.hostZ() + 1);
    expect(backdrop!.className).not.toContain('z-50');
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(Number(dialog!.style.zIndex)).toBeGreaterThanOrEqual(Number(backdrop!.style.zIndex));
    // A dangling aria-labelledby leaves the dialog unnamed for a screen reader.
    const titleId = dialog!.getAttribute('aria-labelledby');
    expect(titleId && document.getElementById(titleId)?.textContent).toBe('Image preview');
    expect(dialog!.hasAttribute('aria-describedby')).toBe(false);

    pressEscape();
    await nextTick();
    await nextTick();

    expect(mounted.open.value).toBe(false);
    expect(onHostClose).not.toHaveBeenCalled();
    expect(lightboxBackdrop()).toBeNull();
    // Only the host is left on the stack; the next Escape is the host's.
    pressEscape();
    expect(onHostClose).toHaveBeenCalledTimes(1);
  });

  it('leaves the stack empty once it closes with no host', async () => {
    const open = ref(true);
    host = mount(
      defineComponent({
        setup: () => () => h(ImageLightbox, { open: open.value, imageUrl: 'data:image/png;base64,AAAA', onClose: () => { open.value = false; } }),
      }),
      { global: { plugins: [i18n] }, attachTo: document.body },
    );
    await nextTick();
    expect(hasOpenOverlay()).toBe(true);

    pressEscape();
    await nextTick();

    expect(open.value).toBe(false);
    expect(hasOpenOverlay()).toBe(false);
  });
});
