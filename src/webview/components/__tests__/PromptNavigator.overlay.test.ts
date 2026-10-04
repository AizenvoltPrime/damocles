// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, markRaw, nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import PromptNavigator from '../PromptNavigator.vue';
import PromptNavigatorChip from '../PromptNavigatorChip.vue';
import OverlayShell from '../OverlayShell.vue';
import { usePromptNavigatorStore } from '@/stores/usePromptNavigatorStore';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { useSessionStore } from '@/stores';
import { i18n } from '@/i18n';
import type { ChatMessage } from '@shared/types/session';

const mounted: VueWrapper[] = [];
const StubIcon = markRaw({ render: () => h('span') });

function user(id: string, content: string, promptIndex: number, sdkMessageId?: string): ChatMessage {
  return { id, role: 'user', content, timestamp: Date.UTC(2026, 0, 1, 14, 5), promptIndex, ...(sdkMessageId ? { sdkMessageId } : {}) } as ChatMessage;
}

function mountNavigator(): VueWrapper {
  const wrapper = mount(PromptNavigator, { global: { plugins: [i18n] }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}

function escape(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

beforeEach(() => {
  setActivePinia(createPinia());
  useStreamingStore().messages.push(user('m1', 'Rate-limit the login route', 0, 'sdk-1'), user('m2', 'Add a test for the 429 case', 1));
  useSessionStore().checkpointMessages.add('sdk-1');
  usePromptNavigatorStore().open();
});

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  document.body.innerHTML = '';
});

describe('PromptNavigator on the overlay frame', () => {
  it('opens as a stack overlay with its search box focused', async () => {
    const wrapper = mountNavigator();
    await nextTick();
    expect(wrapper.find('[role="dialog"]').attributes('aria-labelledby')).toBeTruthy();
    expect(wrapper.text()).toContain('Prompt navigator');
    expect(document.activeElement).toBe(wrapper.get('[data-testid="prompt-navigator-search"]').element);
  });

  it('filters by the search box and reports the count', async () => {
    const wrapper = mountNavigator();
    await wrapper.get('[data-testid="prompt-navigator-search"]').setValue('429');
    expect(wrapper.findAll('[data-testid="prompt-navigator-row"]')).toHaveLength(1);
    expect(wrapper.get('[data-testid="prompt-navigator-status"]').text()).toBe('1 of 2 prompts');
  });

  it('emits edit-and-resend with the prompt text and rewind with its message id', async () => {
    const wrapper = mountNavigator();
    const rows = wrapper.findAll('[data-testid="prompt-navigator-row"]');
    await rows[1]!.get('[data-testid="prompt-navigator-draft"]').trigger('click');
    await rows[0]!.get('[data-testid="prompt-navigator-rewind"]').trigger('click');
    expect(wrapper.emitted('editAndResend')).toEqual([['Add a test for the 429 case']]);
    expect(wrapper.emitted('rewind')).toEqual([['m1']]);
  });

  it('reports a refused clipboard write on the status line', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } });
    const wrapper = mountNavigator();
    await wrapper.findAll('[data-testid="prompt-navigator-copy"]')[0]!.trigger('click');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(wrapper.get('[data-testid="prompt-navigator-status"]').text()).toBe('Could not copy the prompt');
  });

  it('disables rewind for a prompt with no checkpoint', () => {
    const wrapper = mountNavigator();
    const rows = wrapper.findAll('[data-testid="prompt-navigator-row"]');
    expect(rows[1]!.get('[data-testid="prompt-navigator-rewind"]').attributes('disabled')).toBeDefined();
  });

  it('moves the active row with the arrow keys', async () => {
    const wrapper = mountNavigator();
    await wrapper.get('[data-testid="prompt-navigator-search"]').trigger('keydown', { key: 'ArrowDown' });
    const rows = wrapper.findAll('[data-testid="prompt-navigator-row"]');
    expect(rows.map((r) => r.attributes('aria-selected'))).toEqual(['false', 'true']);
  });

  it("puts only the active row's actions in the Tab order, and the overlay's Tab trap wraps past them", async () => {
    const wrapper = mountNavigator();
    await nextTick();
    const tabbable = () => wrapper.findAll('[data-testid="prompt-navigator-row"] button')
      .filter((b) => b.attributes('tabindex') !== '-1' && b.attributes('disabled') === undefined)
      .map((b) => b.attributes('data-testid'));
    expect(tabbable()).toEqual(['prompt-navigator-copy', 'prompt-navigator-draft', 'prompt-navigator-rewind']);

    await wrapper.get('[data-testid="prompt-navigator-search"]').trigger('keydown', { key: 'ArrowDown' });
    const rows = wrapper.findAll('[data-testid="prompt-navigator-row"]');
    expect(rows[0]!.findAll('button').every((b) => b.attributes('tabindex') === '-1')).toBe(true);
    // The second prompt has no checkpoint, so its rewind is disabled and only two actions remain.
    expect(tabbable()).toEqual(['prompt-navigator-copy', 'prompt-navigator-draft']);

    (rows[1]!.get('[data-testid="prompt-navigator-draft"]').element as HTMLElement).focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement?.getAttribute('data-testid')).toBe('overlay-close');
  });

  it('closes on Escape when it is the top overlay and returns focus to the opener', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const wrapper = mountNavigator();
    await nextTick();
    escape();
    expect(usePromptNavigatorStore().isOpen).toBe(false);
    wrapper.unmount();
    mounted.length = 0;
    expect(document.activeElement).toBe(opener);
  });

  it('is opened from a header chip that counts the rows it lists and shows the shortcut its tooltip names', () => {
    useStreamingStore().messages.push({ ...user('m3', 'subagent prompt', 2), parentToolUseId: 'tool-1' } as ChatMessage);
    const chip = mount(PromptNavigatorChip, { props: { showShortcut: true }, global: { plugins: [i18n] } });
    mounted.push(chip);
    const navigator = mountNavigator();

    const count = navigator.findAll('[data-testid="prompt-navigator-row"]').length;
    expect(count).toBe(2);
    expect(chip.get('[data-testid="chat-header-navigator"] span').text()).toBe(String(count));
    expect(chip.attributes('title')).toContain(chip.get('kbd').text());
  });

  it('leaves Escape to an overlay opened over it', async () => {
    mountNavigator();
    const top = mount(defineComponent({ setup: () => () => h(OverlayShell, { title: 'Top', icon: StubIcon }) }), { global: { plugins: [i18n] }, attachTo: document.body });
    mounted.push(top);
    await nextTick();
    escape();
    expect(usePromptNavigatorStore().isOpen).toBe(true);
  });
});
