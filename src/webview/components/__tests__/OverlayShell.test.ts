// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, markRaw, nextTick, ref, Transition } from 'vue';
import OverlayShell from '../OverlayShell.vue';
import { i18n } from '@/i18n';

/**
 * The shared overlay shell: a scrim and a 16px panel that zoom in and out through the `t-overlay`
 * transition the mount site wraps it in, and a z-index from the overlay stack.
 */

const StubIcon = markRaw({ render: () => h('span') });
const mounted: VueWrapper[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = '';
});

function host(open = ref(true), count = 1, hasDraft: (index: number) => boolean = () => false) {
  const closes: number[] = [];
  const wrapper = mount(defineComponent({
    setup: () => () => Array.from({ length: count }, (_, i) =>
      h(Transition, { name: 't-overlay', appear: true }, () =>
        open.value ? h(OverlayShell, { key: i, title: `overlay ${i}`, icon: StubIcon, hasDraft: hasDraft(i), onClose: () => closes.push(i) }) : null)),
  }), { global: { plugins: [i18n], stubs: { transition: false } }, attachTo: document.body });
  mounted.push(wrapper);
  return { wrapper, open, closes };
}

const dialogs = () => [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')];

describe('OverlayShell', () => {
  it('enters with the t-overlay classes, panel included', () => {
    host();
    const [dialog] = dialogs();

    expect(dialog!.classList).toContain('t-overlay-enter-active');
    expect(dialog!.querySelector('.o-panel')).not.toBeNull();
    expect(dialog!.querySelector('.o-panel')!.className).toContain('rounded-2xl');
  });

  it('plays its exit before it leaves the page', async () => {
    const { open } = host();

    open.value = false;
    await nextTick();

    const [dialog] = dialogs();
    expect(dialog).toBeDefined();
    expect(dialog!.classList).toContain('t-overlay-leave-active');
  });

  it('takes its z-index from the overlay stack, one level per overlay opened over it', () => {
    host(ref(true), 2);
    const [beneath, above] = dialogs();

    expect(Number(beneath!.style.zIndex)).toBe(50);
    expect(Number(above!.style.zIndex)).toBe(51);
    expect(beneath!.className).not.toMatch(/\bz-\d/);
  });

  it('closes only itself from its X when opened over another overlay', () => {
    const { closes } = host(ref(true), 2);
    const [, above] = dialogs();

    above!.querySelector<HTMLElement>('[data-testid="overlay-close"]')!.click();

    expect(closes).toEqual([1]);
  });

  it('closes from its scrim', () => {
    const { closes } = host();

    dialogs()[0]!.querySelector<HTMLElement>('[data-testid="overlay-scrim"]')!.click();

    expect(closes).toEqual([0]);
  });

  it('stays open on a scrim click while it holds a draft, and still closes from its X and Escape', () => {
    const { closes } = host(ref(true), 1, () => true);
    const [dialog] = dialogs();

    dialog!.querySelector<HTMLElement>('[data-testid="overlay-scrim"]')!.click();
    expect(closes).toEqual([]);

    dialog!.querySelector<HTMLElement>('[data-testid="overlay-close"]')!.click();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(closes).toEqual([0, 0]);
  });

  it('keeps a draft overlay open beneath a nested one: the top X closes only the top, and the draft scrim does nothing', () => {
    const { closes } = host(ref(true), 2, (i) => i === 0);
    const [beneath, above] = dialogs();

    above!.querySelector<HTMLElement>('[data-testid="overlay-close"]')!.click();
    beneath!.querySelector<HTMLElement>('[data-testid="overlay-scrim"]')!.click();

    expect(closes).toEqual([1]);
  });

  it('puts focus on its named close button when it opens', () => {
    host();

    expect(document.activeElement?.getAttribute('data-testid')).toBe('overlay-close');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close');
  });
});

describe('OverlayShell following its output', () => {
  function shell(followKey: string | undefined) {
    const wrapper = mount(OverlayShell, {
      props: { title: 'agent', icon: StubIcon, followKey },
      slots: { default: () => h('p', 'output') },
      global: { plugins: [i18n] },
      attachTo: document.body,
    });
    mounted.push(wrapper);
    const body = wrapper.get('.o-panel > .overflow-y-auto').element as HTMLElement;
    // happy-dom computes no layout; the body holds 1000px of output in a 100px window.
    let top = 0;
    Object.defineProperties(body, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, 900)); } },
    });
    return { wrapper, body };
  }

  /** A reader's scroll: the wheel, then the browser moving the view and firing `scroll`. */
  async function scrollUp(body: HTMLElement, by: number): Promise<void> {
    body.dispatchEvent(new WheelEvent('wheel', { deltaY: -by, bubbles: true }));
    body.scrollTop -= by;
    body.dispatchEvent(new Event('scroll'));
    await nextTick();
  }

  it('opens at the bottom, offers the jump button once the reader scrolls up, and follows again from it', async () => {
    const { wrapper, body } = shell('agent-a');
    await nextTick();
    expect(body.scrollTop).toBe(900);
    expect(wrapper.find('[data-testid="scroll-to-bottom"]').exists()).toBe(false);

    await scrollUp(body, 300);
    await wrapper.get('[data-testid="scroll-to-bottom"]').trigger('click');

    expect(body.scrollTop).toBe(900);
    expect(wrapper.find('[data-testid="scroll-to-bottom"]').exists()).toBe(false);
  });

  it('moves focus into the body when the jump button unmounts, so it stays inside the dialog', async () => {
    const { wrapper, body } = shell('agent-a');
    await nextTick();
    await scrollUp(body, 300);

    const button = wrapper.get('[data-testid="scroll-to-bottom"]');
    (button.element as HTMLElement).focus();
    await button.trigger('click');

    // happy-dom focuses any element; a browser focuses only one with a tabindex.
    expect(body.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(body);
  });

  it('leaves a body without a follow key where it is and offers no jump button', async () => {
    const { wrapper, body } = shell(undefined);
    await nextTick();

    body.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }));
    await nextTick();

    expect(body.scrollTop).toBe(0);
    expect(wrapper.find('[data-testid="scroll-to-bottom"]').exists()).toBe(false);
    expect(body.hasAttribute('tabindex')).toBe(false);
  });
});
