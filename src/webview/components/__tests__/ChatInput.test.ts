// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import ChatInput from '../ChatInput.vue';
import { i18n } from '@/i18n';

/**
 * An IME commits its candidate with Enter. That keydown arrives with `isComposing` true, and on Windows
 * sometimes only as keyCode 229, so a composer that reads `event.key` alone sends a half-typed message
 * during ordinary typing in any composed script.
 */

function composer(): VueWrapper {
  return mount(ChatInput, {
    props: { isProcessing: false, permissionMode: 'default', dangerouslySkipPermissions: false },
    global: { plugins: [i18n], stubs: { ElementAttachmentStrip: true, ImageThumbnailStrip: true } },
    attachTo: document.body,
  });
}

/** Opens the slash-command popup with two entries, the way the extension's reply does. */
async function openSlashPopup(wrapper: VueWrapper): Promise<HTMLTextAreaElement> {
  window.dispatchEvent(new MessageEvent('message', {
    data: {
      type: 'customSlashCommands',
      commands: [
        { name: 'clear', description: 'clear the session', source: 'builtin' },
        { name: 'compact', description: 'compact the transcript', source: 'builtin' },
      ],
    },
  }));
  await wrapper.vm.$nextTick();

  const textarea = wrapper.get('textarea');
  await textarea.setValue('/');
  textarea.element.selectionStart = textarea.element.selectionEnd = 1;
  await textarea.trigger('input');
  await wrapper.vm.$nextTick();

  return textarea.element as HTMLTextAreaElement;
}

function popupSelectedIndex(wrapper: VueWrapper): number {
  return wrapper.findComponent({ name: 'SlashCommandPopup' }).props('selectedIndex') as number;
}

async function type(wrapper: VueWrapper, text: string): Promise<HTMLTextAreaElement> {
  const textarea = wrapper.get('textarea');
  await textarea.setValue(text);
  return textarea.element as HTMLTextAreaElement;
}

function keydown(el: HTMLElement, init: KeyboardEventInit & { keyCode?: number }): void {
  const { keyCode, ...rest } = init;
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...rest });
  if (keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: keyCode });
  el.dispatchEvent(event);
}

beforeEach(() => setActivePinia(createPinia()));

describe('the composer during an IME composition', () => {
  it('does not send when Enter commits a candidate', async () => {
    const wrapper = composer();
    const textarea = await type(wrapper, 'γεια');

    keydown(textarea, { key: 'Enter', isComposing: true });
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted('send')).toBeUndefined();
    expect(wrapper.emitted('queue')).toBeUndefined();
  });

  it('does not send when the commit arrives as keyCode 229 with no isComposing', async () => {
    const wrapper = composer();
    const textarea = await type(wrapper, 'γεια');

    keydown(textarea, { key: 'Enter', keyCode: 229 });
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted('send')).toBeUndefined();
  });

  it('still sends on a plain Enter, so the guard did not disable the composer', async () => {
    // Pins the contrast: without this, a composer that never sends at all would pass both cases above.
    const wrapper = composer();
    const textarea = await type(wrapper, 'γεια');

    keydown(textarea, { key: 'Enter' });
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted('send')).toEqual([['γεια', expect.any(Boolean)]]);
  });

  it('leaves the typed text in the box when the composition commit is ignored', async () => {
    const wrapper = composer();
    const textarea = await type(wrapper, 'γεια');

    keydown(textarea, { key: 'Enter', isComposing: true });
    await wrapper.vm.$nextTick();

    expect(wrapper.get('textarea').element.value).toBe('γεια');
  });
});

/**
 * The composition guard sits at the top of `handleKeydown`, ahead of the mode-cycling branch and both
 * autocomplete branches, so during a composition the composer stands down from popup navigation too.
 * That is what an IME needs: while a candidate window is open the IME owns the arrow keys, and a
 * composer that also moved its own popup selection would fight it on every keystroke.
 */
describe('the composer during an IME composition, beyond Enter', () => {
  it('leaves the slash-command popup selection alone', async () => {
    const wrapper = composer();
    const textarea = await openSlashPopup(wrapper);
    expect(popupSelectedIndex(wrapper)).toBe(0);

    keydown(textarea, { key: 'ArrowDown', isComposing: true });
    await wrapper.vm.$nextTick();

    expect(popupSelectedIndex(wrapper)).toBe(0);
  });

  it('moves the popup selection on a plain arrow key', async () => {
    // Pins the contrast: without this, a composer whose popup never moved would pass the case above.
    const wrapper = composer();
    const textarea = await openSlashPopup(wrapper);

    keydown(textarea, { key: 'ArrowDown' });
    await wrapper.vm.$nextTick();

    expect(popupSelectedIndex(wrapper)).toBe(1);
  });

  it('leaves the popup selection alone for a keyCode 229 arrow key', async () => {
    const wrapper = composer();
    const textarea = await openSlashPopup(wrapper);

    keydown(textarea, { key: 'ArrowDown', keyCode: 229 });
    await wrapper.vm.$nextTick();

    expect(popupSelectedIndex(wrapper)).toBe(0);
  });
});
