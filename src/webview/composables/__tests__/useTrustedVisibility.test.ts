// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref, type Ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { HELD_EVENTS, READY_ATTRIBUTE, useTrustedVisibility } from '@/composables/useTrustedVisibility';
import { SHOWN_HOLD_MS } from '@/composables/trusted-hold';
import { installVisibilityObserver } from '@/__tests__/visibility-observer';

// the setup file ends the shown hold at once; these tests are about the real one
vi.unmock('@/composables/trusted-hold');

const mounted: VueWrapper[] = [];
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

interface Card {
  wrapper: VueWrapper;
  answered: string[];
  gate: Ref<boolean>;
  quiet: Ref<boolean>;
  request: Ref<string | null>;
  refuse: () => boolean;
}

// A card with an answer button, a typed note, a form and a view-only control, as the trusted cards build them; `request` keys
// its root as a dock card's request id does, and null leaves the component mounted with no card.
function card(gated: boolean, first: string | null = 'r1'): Card {
  const answered: string[] = [];
  const gate = ref(gated);
  const quiet = ref(false);
  const request = ref(first);
  let refuse: () => boolean = () => true;
  const Card = defineComponent({
    setup() {
      const root = ref<HTMLElement | null>(null);
      const gateOf = useTrustedVisibility(root, gate, { quiet });
      refuse = gateOf.refuse;
      return () => h('div', { 'data-explain': String(gateOf.explain.value), 'data-visible': String(gateOf.isVisible.value) }, request.value === null ? [] : [
        h('section', { ref: root, key: request.value, 'data-trusted': '', 'data-request': request.value, onKeydown: (event: KeyboardEvent) => answered.push(`root-key:${event.key}`) }, [
          h('button', { 'data-testid': 'allow', onClick: () => answered.push(`allow:${request.value}`) }),
          h('textarea', { 'data-testid': 'note', onKeydown: (event: KeyboardEvent) => answered.push(`note-key:${event.key}`) }),
          h('form', { 'data-testid': 'form', onSubmit: (event: Event) => { event.preventDefault(); answered.push('submit'); } }),
          h('button', { 'data-testid': 'expand', 'data-view-only': '', onClick: () => answered.push('expand') }),
        ]),
      ]);
    },
  });
  const wrapper = mount(Card, { attachTo: document.body });
  mounted.push(wrapper);
  return { wrapper, answered, gate, quiet, request, refuse: () => refuse() };
}

const section = (wrapper: VueWrapper): HTMLElement => wrapper.get('section').element as HTMLElement;
const ready = (wrapper: VueWrapper): string | null => section(wrapper).getAttribute(READY_ATTRIBUTE);
// The card starts its hold and its observer after the mount's flush.
async function shownFor(ms: number): Promise<void> {
  await nextTick();
  vi.advanceTimersByTime(ms);
  await nextTick();
}

describe('the visibility gate', () => {
  it('watches the whole card with IntersectionObserver v2 at threshold 1 and its 100 ms delay', async () => {
    const visibility = installVisibilityObserver(false);
    const { wrapper } = card(true);
    await nextTick();
    expect(visibility.inits).toEqual([{ threshold: 1, trackVisibility: true, delay: 100 }]);
    expect(visibility.observed()).toEqual([section(wrapper)]);
  });

  it('holds only the events a card may decide on', () => {
    expect([...HELD_EVENTS]).toEqual(['click', 'dblclick', 'auxclick', 'submit', 'keydown', 'keyup']);
  });

  it.each(HELD_EVENTS)('stops a %s on a covered card before the card\'s own handlers and before any listener outside it', async (type) => {
    const visibility = installVisibilityObserver(false);
    const { wrapper } = card(true);
    await shownFor(SHOWN_HOLD_MS);
    const seen: string[] = [];
    const inside = (): number => seen.push('card');
    const outside = (): number => seen.push('document');
    section(wrapper).addEventListener(type, inside);
    document.addEventListener(type, outside);
    try {
      const target = wrapper.get('[data-testid="allow"]').element;
      target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
      expect(seen).toEqual([]);

      visibility.report(true);
      await nextTick();
      target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
      expect(seen).toEqual(['card', 'document']);
    } finally {
      document.removeEventListener(type, outside);
    }
  });

  it.each(['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'contextmenu'])('lets a %s on a covered card reach listeners outside it, since no card decides on one', async (type) => {
    installVisibilityObserver(false);
    const { wrapper } = card(true);
    await shownFor(SHOWN_HOLD_MS);
    const outside = vi.fn();
    document.addEventListener(type, outside);
    try {
      wrapper.get('[data-testid="allow"]').element.dispatchEvent(new Event(type, { bubbles: true }));
      expect(outside).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener(type, outside);
    }
  });

  it('holds every click, key and submit on a covered card, except a view-only control', async () => {
    const visibility = installVisibilityObserver(false);
    const { wrapper, answered } = card(true);
    await shownFor(SHOWN_HOLD_MS);
    expect(wrapper.attributes('data-visible')).toBe('false');
    expect(ready(wrapper)).toBe('false');

    await wrapper.get('[data-testid="allow"]').trigger('click');
    await wrapper.get('[data-testid="note"]').trigger('keydown', { key: 'Enter' });
    await wrapper.get('[data-testid="form"]').trigger('submit');
    await wrapper.get('[data-testid="expand"]').trigger('click');
    expect(answered).toEqual(['expand']);

    visibility.report(true);
    await nextTick();
    expect(wrapper.attributes('data-visible')).toBe('true');
    expect(ready(wrapper)).toBe('true');
    await wrapper.get('[data-testid="allow"]').trigger('click');
    await wrapper.get('[data-testid="note"]').trigger('keydown', { key: 'Enter' });
    expect(answered).toEqual(['expand', 'allow:r1', 'note-key:Enter', 'root-key:Enter']);
  });

  it('does not count a card that is only partly in view, whatever else the entry says', async () => {
    const visibility = installVisibilityObserver(true);
    const { wrapper, answered } = card(true);
    await shownFor(SHOWN_HOLD_MS);
    expect(ready(wrapper)).toBe('true');

    visibility.report(true, 0.5);
    await nextTick();
    expect(ready(wrapper)).toBe('false');
    await wrapper.get('[data-testid="allow"]').trigger('click');
    expect(answered).toEqual([]);

    visibility.report(true, 1);
    await nextTick();
    await wrapper.get('[data-testid="allow"]').trigger('click');
    expect(answered).toEqual(['allow:r1']);
  });

  it('holds the card again once something covers it', async () => {
    const visibility = installVisibilityObserver(true);
    const { wrapper, answered } = card(true);
    await shownFor(SHOWN_HOLD_MS);
    visibility.report(false);
    await nextTick();
    await wrapper.get('[data-testid="allow"]').trigger('click');
    expect(answered).toEqual([]);
  });

  it('cancels a held click, so a covered button never activates by default either', async () => {
    installVisibilityObserver(false);
    const { wrapper } = card(true);
    await shownFor(SHOWN_HOLD_MS);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    wrapper.get('[data-testid="allow"]').element.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
  });

  it('observes nothing where the host paints no theme CSS, and starts observing when the gate turns on', async () => {
    const visibility = installVisibilityObserver(false);
    const { wrapper, answered, gate } = card(false);
    await shownFor(SHOWN_HOLD_MS);
    expect(visibility.inits).toEqual([]);
    await wrapper.get('[data-testid="allow"]').trigger('click');
    expect(answered).toEqual(['allow:r1']);

    gate.value = true;
    await nextTick();
    await nextTick();
    expect(wrapper.attributes('data-visible')).toBe('false');
    await wrapper.get('[data-testid="allow"]').trigger('click');
    expect(answered).toEqual(['allow:r1']);
  });

  it('stops observing and answers again when the gate turns off', async () => {
    const visibility = installVisibilityObserver(false);
    const { wrapper, answered, gate } = card(true);
    await shownFor(SHOWN_HOLD_MS);
    await wrapper.get('[data-testid="allow"]').trigger('click');
    expect(answered).toEqual([]);

    gate.value = false;
    await nextTick();
    await nextTick();
    expect(visibility.observed()).toEqual([]);
    expect(ready(wrapper)).toBe('true');
    await wrapper.get('[data-testid="allow"]').trigger('click');
    expect(answered).toEqual(['allow:r1']);
  });

  it('stops observing when the card unmounts', async () => {
    const visibility = installVisibilityObserver(true);
    const { wrapper } = card(true);
    await nextTick();
    wrapper.unmount();
    mounted.splice(0);
    expect(visibility.observed()).toEqual([]);
  });
});

describe('the reason a covered card gives', () => {
  it('shows only once the check outlasts the card\'s entrance, so a card that settles never flashes it', async () => {
    const visibility = installVisibilityObserver(false);
    const { wrapper } = card(true);
    await shownFor(300);
    visibility.report(true);
    await nextTick();
    await shownFor(1000);
    expect(wrapper.attributes('data-explain')).toBe('false');

    visibility.report(false);
    await nextTick();
    await shownFor(499);
    expect(wrapper.attributes('data-explain')).toBe('false');
    await shownFor(1);
    expect(wrapper.attributes('data-explain')).toBe('true');

    visibility.report(true);
    await nextTick();
    expect(wrapper.attributes('data-explain')).toBe('false');
  });

  it('counts from the card\'s own appearance, not from the mount of a component that shows no card yet', async () => {
    installVisibilityObserver(false);
    const { wrapper, request } = card(true, null);
    await shownFor(600);
    expect(wrapper.attributes('data-explain')).toBe('false');

    request.value = 'r1';
    await nextTick();
    await nextTick();
    expect(wrapper.attributes('data-explain')).toBe('false');
    await shownFor(499);
    expect(wrapper.attributes('data-explain')).toBe('false');
    await shownFor(1);
    expect(wrapper.attributes('data-explain')).toBe('true');
  });

  it('is not carried over to the next card', async () => {
    installVisibilityObserver(false);
    const { wrapper, request } = card(true);
    await shownFor(600);
    expect(wrapper.attributes('data-explain')).toBe('true');

    request.value = null;
    await nextTick();
    await nextTick();
    expect(wrapper.attributes('data-explain')).toBe('false');
    await shownFor(600);
    request.value = 'r2';
    await nextTick();
    await nextTick();
    expect(wrapper.attributes('data-explain')).toBe('false');
  });

  it('stays unsaid while the card is held for a reason it states elsewhere', async () => {
    installVisibilityObserver(false);
    const { wrapper, answered, quiet } = card(true);
    quiet.value = true;
    await shownFor(600);
    expect(wrapper.attributes('data-explain')).toBe('false');
    await wrapper.get('[data-testid="allow"]').trigger('click');
    expect(answered).toEqual([]);

    quiet.value = false;
    await nextTick();
    expect(wrapper.attributes('data-explain')).toBe('true');
  });
});

describe('the hold of a card just shown', () => {
  it('takes no answer for 500 ms where nothing is observed, and says so on the card', async () => {
    const { wrapper, answered } = card(false);
    await nextTick();
    expect(SHOWN_HOLD_MS).toBe(500);
    expect(ready(wrapper)).toBe('false');

    await shownFor(499);
    // 498 ms later: this press must not answer, and the test below shows that it restarts the hold
    expect(ready(wrapper)).toBe('false');
    await shownFor(1);
    expect(ready(wrapper)).toBe('true');
    await wrapper.get('[data-testid="allow"]').trigger('click');
    expect(answered).toEqual(['allow:r1']);
  });

  it('starts again from a press that lands inside it', async () => {
    const { wrapper, answered } = card(false);
    await shownFor(400);
    await wrapper.get('[data-testid="allow"]').trigger('click');
    expect(answered).toEqual([]);

    await shownFor(499);
    expect(ready(wrapper)).toBe('false');
    await wrapper.get('[data-testid="note"]').trigger('keydown', { key: 'Enter' });
    expect(answered).toEqual([]);

    await shownFor(499);
    expect(ready(wrapper)).toBe('false');
    await shownFor(1);
    expect(ready(wrapper)).toBe('true');
    await wrapper.get('[data-testid="allow"]').trigger('click');
    expect(answered).toEqual(['allow:r1']);
  });

  it.each([
    ['a character typed into a field', 'note', 'a'],
    ['Tab', 'allow', 'Tab'],
    ['an arrow key', 'allow', 'ArrowDown'],
    ['a modifier', 'allow', 'Shift'],
  ])('is not restarted by %s, which answers nothing', async (_name, testId, key) => {
    const { wrapper, answered } = card(false);
    await shownFor(400);
    await wrapper.get(`[data-testid="${testId}"]`).trigger('keydown', { key });
    await wrapper.get(`[data-testid="${testId}"]`).trigger('keyup', { key });
    expect(answered).toEqual([]);
    await shownFor(100);
    expect(ready(wrapper)).toBe('true');
  });

  it('refuses an answer that does not pass through the card, and that press restarts it too', async () => {
    const { wrapper, refuse } = card(false);
    await shownFor(400);
    expect(refuse()).toBe(true);
    await shownFor(499);
    expect(refuse()).toBe(true);
    await shownFor(500);
    expect(ready(wrapper)).toBe('true');
    expect(refuse()).toBe(false);
  });

  it('refuses while no card is shown', async () => {
    const { refuse } = card(false, null);
    await shownFor(1000);
    expect(refuse()).toBe(true);
  });

  it('holds the card that replaces the one just answered, so the second click of a double-click answers nothing', async () => {
    const { wrapper, answered, request } = card(false);
    await shownFor(SHOWN_HOLD_MS);
    await wrapper.get('[data-testid="allow"]').trigger('click');
    expect(answered).toEqual(['allow:r1']);

    request.value = 'r2';
    await nextTick();
    await nextTick();
    expect(section(wrapper).dataset.request).toBe('r2');
    expect(ready(wrapper)).toBe('false');
    await shownFor(150);
    await wrapper.get('[data-testid="allow"]').trigger('click');
    expect(answered).toEqual(['allow:r1']);

    await shownFor(SHOWN_HOLD_MS);
    await wrapper.get('[data-testid="allow"]').trigger('click');
    expect(answered).toEqual(['allow:r1', 'allow:r2']);
  });

  it('takes no answer on an element the card no longer shows, which stays in the page while its leave plays', async () => {
    const { wrapper, answered, request } = card(false);
    await shownFor(SHOWN_HOLD_MS);
    // as a Transition keeps a leaving card: still connected, its own handlers still bound
    const leaving = section(wrapper);
    const button = leaving.querySelector<HTMLElement>('[data-testid="allow"]')!;
    request.value = 'r2';
    await nextTick();
    await nextTick();
    document.body.append(leaving);
    try {
      expect(leaving.getAttribute(READY_ATTRIBUTE)).toBe('false');
      expect(leaving.hasAttribute('inert')).toBe(true);
      await shownFor(2000);
      button.click();
      leaving.querySelector<HTMLElement>('[data-testid="expand"]')!.click();
      expect(answered).toEqual([]);
    } finally {
      leaving.remove();
    }
  });
});
