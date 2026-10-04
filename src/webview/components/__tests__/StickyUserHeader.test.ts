// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import StickyUserHeader from '../StickyUserHeader.vue';
import PinnedRestoreChip from '../PinnedRestoreChip.vue';
import type { ChatMessage } from '@shared/types/session';
import { formatClock } from '@/utils/clock';
import { i18n } from '@/i18n';

/** The pinned user header and its restore chip: every action is a named button that reaches its handler. */

const MESSAGE: ChatMessage = { id: 'u1', role: 'user', content: 'Rate-limit the login route', timestamp: Date.UTC(2026, 0, 2, 14, 5) };

function header(props: Partial<{ offset: number; canRewind: boolean; promptIndex: number }> = {}) {
  return mount(StickyUserHeader, {
    props: { message: MESSAGE, offset: 0, itemIndex: 0, promptIndex: 2, canRewind: true, expanded: false, ...props },
    global: { plugins: [i18n], stubs: { MarkdownRenderer: true } },
  });
}

beforeEach(() => setActivePinia(createPinia()));

describe('the pinned user header', () => {
  it('shows the pin, You, the 24-hour time and the prompt number', () => {
    const wrapper = header();

    expect(wrapper.find('svg.lucide-pin').exists()).toBe(true);
    expect(wrapper.text()).toContain('You');
    expect(wrapper.get('[data-testid="user-message-time"]').text()).toBe(formatClock(MESSAGE.timestamp, 'en'));
    expect(wrapper.get('[data-testid="pinned-prompt-index"]').text()).toBe('· prompt 3');
  });

  it('scrolls to the message, rewinds to it and hides itself through named buttons', async () => {
    const wrapper = header();

    const scroll = wrapper.get('[data-testid="pinned-scroll-to"]');
    expect(scroll.attributes('aria-label')).toBe('Scroll to user message');
    await scroll.trigger('click');

    const rewind = wrapper.get('[data-testid="user-message-rewind"]');
    expect(rewind.attributes('aria-label')).toBe('Rewind conversation to this message');
    await rewind.trigger('click');

    const hide = wrapper.get('[data-testid="pinned-hide"]');
    expect(hide.attributes('title')).toBe('Hide pinned header');
    await hide.trigger('click');

    expect(wrapper.emitted('scrollToPrimary')).toHaveLength(1);
    expect(wrapper.emitted('rewind')).toEqual([[MESSAGE]]);
    expect(wrapper.emitted('hide-pinned')).toHaveLength(1);
  });

  it('offers scrolling back only while the header is fully pinned', () => {
    expect(header({ offset: -12 }).find('[data-testid="pinned-scroll-to"]').exists()).toBe(false);
  });

  it('copies the message text', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    await header().get('[data-testid="user-message-copy"]').trigger('click');

    expect(writeText).toHaveBeenCalledWith(MESSAGE.content);
  });

  it('opens the injected context for its prompt', async () => {
    const wrapper = header();

    await wrapper.get('[data-testid="user-message-context"]').trigger('click');

    expect(wrapper.emitted('viewContext')).toEqual([[2]]);
  });
});

describe('the restore chip', () => {
  it('is a named button that restores the header', async () => {
    const chip = mount(PinnedRestoreChip, { props: { message: MESSAGE }, global: { plugins: [i18n] } });

    expect(chip.element.tagName).toBe('BUTTON');
    expect(chip.attributes('title')).toBe('Show pinned header');
    await chip.trigger('click');

    expect(chip.emitted('restore')).toHaveLength(1);
  });
});
