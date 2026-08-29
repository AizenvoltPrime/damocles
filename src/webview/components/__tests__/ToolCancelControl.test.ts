// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { ToolCall } from '@shared/types/session';
import ToolCancelControl from '../ToolCancelControl.vue';
import { i18n } from '@/i18n';

/**
 * The note box's keyboard contract, which is the main chat composer's: Enter sends, Shift+Enter opens
 * a line. Escape closes the note and must not travel: the overlay stack listens on `document`, so an
 * Escape that propagates closes the overlay the user is typing into.
 *
 * The events are dispatched on the real element and bubble, which is the only way the propagation case
 * can fail for the right reason.
 */

const RUNNING_SHELL_CALL: ToolCall = {
  id: 't-1',
  name: 'Bash',
  input: { command: 'sleep 300' },
  status: 'running',
};

function open(toolCall: ToolCall = RUNNING_SHELL_CALL): VueWrapper {
  return mount(ToolCancelControl, {
    props: { toolCall, source: 'session' },
    global: { plugins: [i18n] },
    attachTo: document.body,
  });
}

async function openNote(wrapper: VueWrapper): Promise<HTMLTextAreaElement> {
  await wrapper.find('button').trigger('click');
  await wrapper.vm.$nextTick();
  const textarea = wrapper.find('textarea');
  if (!textarea.exists()) throw new Error('the note box did not open');
  return textarea.element;
}

function press(el: HTMLElement, key: string, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  return event;
}

function spyOnPost(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis.acquireVsCodeApi(), 'postMessage');
}

/** The Send button, which is the second of the three controls the note box renders. */
function sendButton(wrapper: VueWrapper): HTMLElement {
  const buttons = wrapper.findAll('button');
  const send = buttons[0];
  if (!send) throw new Error('the note box rendered no Send button');
  return send.element;
}

beforeEach(() => setActivePinia(createPinia()));

describe('the cancel note box', () => {
  it('is a textarea rather than a single-line input', async () => {
    const wrapper = open();
    await openNote(wrapper);

    expect(wrapper.find('textarea').exists()).toBe(true);
    expect(wrapper.find('input').exists()).toBe(false);
  });

  it('sends on Enter', async () => {
    const wrapper = open();
    const textarea = await openNote(wrapper);
    textarea.value = 'wrong loop, use seq 1 5';
    textarea.dispatchEvent(new Event('input'));
    await wrapper.vm.$nextTick();

    const posted = spyOnPost();
    press(textarea, 'Enter');
    await wrapper.vm.$nextTick();

    expect(posted).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'cancelToolCall', toolUseId: 't-1', note: 'wrong loop, use seq 1 5' }),
    );
    posted.mockRestore();
  });

  it('inserts a newline on Shift+Enter and sends nothing', async () => {
    const wrapper = open();
    const textarea = await openNote(wrapper);
    textarea.value = 'first';
    textarea.dispatchEvent(new Event('input'));
    await wrapper.vm.$nextTick();
    textarea.selectionStart = textarea.selectionEnd = 'first'.length;

    const posted = spyOnPost();
    press(textarea, 'Enter', true);
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    expect(wrapper.find('textarea').element.value).toBe('first\n');
    expect(posted).not.toHaveBeenCalled();
    posted.mockRestore();
  });

  it('opens the line at the caret rather than at the end', async () => {
    const wrapper = open();
    const textarea = await openNote(wrapper);
    textarea.value = 'abcd';
    textarea.dispatchEvent(new Event('input'));
    await wrapper.vm.$nextTick();
    textarea.selectionStart = textarea.selectionEnd = 2;

    press(textarea, 'Enter', true);
    await wrapper.vm.$nextTick();

    expect(wrapper.find('textarea').element.value).toBe('ab\ncd');
  });

  it('keeps a multi-line note intact when Enter finally sends it', async () => {
    const wrapper = open();
    const textarea = await openNote(wrapper);
    textarea.value = 'line one';
    textarea.dispatchEvent(new Event('input'));
    await wrapper.vm.$nextTick();
    textarea.selectionStart = textarea.selectionEnd = 'line one'.length;

    press(textarea, 'Enter', true);
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    const grown = wrapper.find('textarea').element;
    grown.value = 'line one\nline two';
    grown.dispatchEvent(new Event('input'));
    await wrapper.vm.$nextTick();

    const posted = spyOnPost();
    press(grown, 'Enter');
    await wrapper.vm.$nextTick();

    expect(posted).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'cancelToolCall', toolUseId: 't-1', note: 'line one\nline two' }),
    );
    posted.mockRestore();
  });

  it('closes the note on Escape without letting it reach the overlay stack', async () => {
    const wrapper = open();
    const textarea = await openNote(wrapper);

    const onDocument = vi.fn();
    document.addEventListener('keydown', onDocument);
    press(textarea, 'Escape');
    await wrapper.vm.$nextTick();
    document.removeEventListener('keydown', onDocument);

    expect(onDocument).not.toHaveBeenCalled();
    expect(wrapper.find('textarea').exists()).toBe(false);
  });

  it('lets an ordinary key through to the document', async () => {
    // Pins the case above to `stopPropagation` rather than to the event never bubbling at all.
    const wrapper = open();
    const textarea = await openNote(wrapper);

    const onDocument = vi.fn();
    document.addEventListener('keydown', onDocument);
    press(textarea, 'a');
    document.removeEventListener('keydown', onDocument);

    expect(onDocument).toHaveBeenCalledTimes(1);
  });

  it('sends with no note when the box is empty', async () => {
    const wrapper = open();
    const textarea = await openNote(wrapper);

    const posted = spyOnPost();
    press(textarea, 'Enter');
    await wrapper.vm.$nextTick();

    const [message] = posted.mock.calls[0] as [Record<string, unknown>];
    expect(message).toEqual({ type: 'cancelToolCall', toolUseId: 't-1', requestId: expect.any(String) });
    expect(Object.hasOwn(message, 'note')).toBe(false);
    posted.mockRestore();
  });

  it('carries a request id the extension can echo back on a rejection', async () => {
    const wrapper = open();
    const textarea = await openNote(wrapper);

    const posted = spyOnPost();
    press(textarea, 'Enter');
    await wrapper.vm.$nextTick();

    const [message] = posted.mock.calls[0] as [{ requestId?: unknown }];
    expect(typeof message.requestId).toBe('string');
    expect((message.requestId as string).length).toBeGreaterThan(0);
    posted.mockRestore();
  });
});

describe('the composition guard', () => {
  it('does not send when Enter commits an IME candidate', async () => {
    const wrapper = open();
    const textarea = await openNote(wrapper);
    textarea.value = 'ημιτελ';
    textarea.dispatchEvent(new Event('input'));
    await wrapper.vm.$nextTick();

    const posted = spyOnPost();
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }),
    );
    await wrapper.vm.$nextTick();

    expect(posted).not.toHaveBeenCalled();
    expect(wrapper.find('textarea').exists()).toBe(true);
    posted.mockRestore();
  });

  it('does not send when the commit arrives as keyCode 229 with no isComposing', async () => {
    const wrapper = open();
    const textarea = await openNote(wrapper);

    const posted = spyOnPost();
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    Object.defineProperty(event, 'keyCode', { value: 229 });
    textarea.dispatchEvent(event);
    await wrapper.vm.$nextTick();

    expect(posted).not.toHaveBeenCalled();
    expect(wrapper.find('textarea').exists()).toBe(true);
    posted.mockRestore();
  });
});

describe('the visibility gate', () => {
  it('renders nothing for a shell call that already finished', () => {
    const wrapper = open({ ...RUNNING_SHELL_CALL, status: 'completed' });
    expect(wrapper.find('button').exists()).toBe(false);
  });

  it('renders nothing for a running tool the extension cannot cancel', () => {
    const wrapper = open({ ...RUNNING_SHELL_CALL, name: 'Read', input: { file_path: 'a.ts' } });
    expect(wrapper.find('button').exists()).toBe(false);
  });

  it('renders the button for a running shell call', () => {
    expect(open().find('button').exists()).toBe(true);
  });
});

describe('the stopping state', () => {
  const stopping: ToolCall = { ...RUNNING_SHELL_CALL, cancelRequested: true };

  it('shows the stopping label rather than the stop label', () => {
    const wrapper = open(stopping);
    expect(wrapper.find('button').text()).toBe(i18n.global.t('toolCall.stopping'));
    expect(wrapper.find('button').text()).not.toBe(i18n.global.t('toolCall.stop'));
  });

  it('marks the button unavailable and busy while staying focusable', () => {
    const button = open(stopping).find('button');
    expect(button.attributes('aria-disabled')).toBe('true');
    expect(button.attributes('aria-busy')).toBe('true');
    // Left out of `disabled` on purpose: a disabled button cannot take the focus the note box returns.
    expect(button.attributes('disabled')).toBeUndefined();
  });

  it('does not open the note box when the button is activated while stopping', async () => {
    const wrapper = open(stopping);
    await wrapper.find('button').trigger('click');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('textarea').exists()).toBe(false);
  });

  it('advertises the two-step action before the cancel is in flight', () => {
    expect(open().find('button').attributes('aria-label')).toBe(i18n.global.t('toolCall.stopWithNote'));
    expect(open(stopping).find('button').attributes('aria-label')).toBeUndefined();
  });
});

describe('the double-cancel guard', () => {
  it('posts once for two clicks on Send inside the same tick', async () => {
    // Both clicks land on the same node before any re-render; awaiting each would let the note close
    // and the second click would hit the re-rendered Stop button, passing with no guard at all.
    const wrapper = open();
    await openNote(wrapper);
    const send = sendButton(wrapper);

    const posted = spyOnPost();
    send.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    send.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wrapper.vm.$nextTick();

    expect(posted).toHaveBeenCalledTimes(1);
    posted.mockRestore();
  });

  it('does not re-arm when the store never recorded the cancel', async () => {
    // This fixture lives in no store, so `cancelRequested` never flips. Only the local guard can hold,
    // and without it the trigger comes back enabled and every further click posts again.
    const wrapper = open();
    const posted = spyOnPost();

    const textarea = await openNote(wrapper);
    press(textarea, 'Enter');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('textarea').exists()).toBe(false);
    expect(wrapper.find('button').text()).toBe(i18n.global.t('toolCall.stopping'));

    await wrapper.find('button').trigger('click');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('textarea').exists()).toBe(false);
    expect(posted).toHaveBeenCalledTimes(1);
    posted.mockRestore();
  });
});

describe('focus after the note box closes', () => {
  it('returns focus to the trigger when Escape closes the note', async () => {
    const wrapper = open();
    const textarea = await openNote(wrapper);
    expect(document.activeElement).toBe(textarea);

    press(textarea, 'Escape');
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    expect(document.activeElement).toBe(wrapper.find('button').element);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('returns focus to the trigger when the note is sent', async () => {
    const wrapper = open();
    const textarea = await openNote(wrapper);

    press(textarea, 'Enter');
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    expect(document.activeElement).toBe(wrapper.find('button').element);
    expect(document.activeElement).not.toBe(document.body);
  });
});
