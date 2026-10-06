// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import ChatInput from '../ChatInput.vue';
import { i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { elementAttachmentBus } from '@/composables/useElementAttachments';
import type { ImageAttachment } from '@/composables/useImageAttachments';
import type { ElementAttachment } from '@shared/types/browser';

// Pasting an image needs a canvas resize happy-dom cannot run, so a test seeds the attachments directly.
const seeded = vi.hoisted(() => ({ images: [] as ImageAttachment[] }));
vi.mock('@/composables/useImageAttachments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/composables/useImageAttachments')>();
  return {
    ...actual,
    useImageAttachments: () => {
      const api = actual.useImageAttachments();
      api.attachments.value.push(...seeded.images);
      return api;
    },
  };
});

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

beforeEach(() => {
  setActivePinia(createPinia());
  seeded.images = [];
});

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

describe('the composer with an autocomplete list open', () => {
  it('names the open list and follows its highlighted option, so a screen reader hears the arrow keys', async () => {
    const wrapper = composer();
    const textarea = wrapper.get('textarea').element;
    expect(textarea.hasAttribute('aria-controls')).toBe(false);
    expect(textarea.hasAttribute('aria-activedescendant')).toBe(false);

    await openSlashPopup(wrapper);
    const listId = textarea.getAttribute('aria-controls');
    expect(textarea.getAttribute('aria-autocomplete')).toBe('list');
    expect([...document.querySelectorAll(`[id="${listId}"]`)].at(-1)?.getAttribute('role')).toBe('listbox');
    expect(textarea.getAttribute('aria-activedescendant')).toBe(`${listId}-0`);

    keydown(textarea, { key: 'ArrowDown' });
    await wrapper.vm.$nextTick();

    // Earlier composers in this file stay mounted with their own popups, so take this composer's, the last one teleported.
    const active = [...document.querySelectorAll(`[id="${textarea.getAttribute('aria-activedescendant')}"]`)].at(-1);
    expect(active?.getAttribute('aria-selected')).toBe('true');
    expect(active?.textContent).toContain('/compact');
    wrapper.unmount();
  });
});

describe('the composer while a workspace folder switch is pending', () => {
  const FOLDERS = [
    { key: 'c:/ws/a', name: 'a', label: 'a', path: 'C:/ws/a' },
    { key: 'c:/ws/b', name: 'b', label: 'b', path: 'C:/ws/b' },
  ];

  function pendingSwitch(): void {
    const store = useSettingsStore();
    store.setWorkspaceFolders(FOLDERS, 'c:/ws/a', 'c:/ws/a');
    store.requestPanelWorkspaceFolder('c:/ws/b');
  }

  const sendButton = (wrapper: VueWrapper) => wrapper.findAll('button').at(-1)!;

  it('neither sends nor queues, disables Send, and keeps the draft for the new folder', async () => {
    pendingSwitch();
    const wrapper = composer();
    const textarea = await type(wrapper, 'follow up');

    keydown(textarea, { key: 'Enter' });
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted('send')).toBeUndefined();
    expect(wrapper.emitted('queue')).toBeUndefined();
    expect(textarea.value).toBe('follow up');
    expect(sendButton(wrapper).attributes('disabled')).toBeDefined();
  });

  it('does not queue behind a running turn either, and keeps Stop usable', async () => {
    pendingSwitch();
    const wrapper = composer();
    await wrapper.setProps({ isProcessing: true });
    expect(sendButton(wrapper).attributes('disabled')).toBeUndefined();

    const textarea = await type(wrapper, 'follow up');
    keydown(textarea, { key: 'Enter' });
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted('queue')).toBeUndefined();
  });

  it('sends again once the extension answers', async () => {
    pendingSwitch();
    const wrapper = composer();
    useSettingsStore().setWorkspaceFolders(FOLDERS, 'c:/ws/b', 'c:/ws/a');
    const textarea = await type(wrapper, 'hello');

    keydown(textarea, { key: 'Enter' });
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted('send')).toHaveLength(1);
  });
});

describe('the composer on /steer', () => {
  const IMAGE: ImageAttachment = { id: 'img-1', dataUrl: 'data:image/png;base64,AAAA', base64Data: 'AAAA', mediaType: 'image/png', width: 1, height: 1 };
  const IMAGE_BLOCK = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const ELEMENT: ElementAttachment = {
    id: 'el-1', selector: 'div', tagName: 'div', attributes: {}, outerHTML: '<div></div>', computedStyles: {},
    boundingBox: { x: 0, y: 0, width: 1, height: 1 }, elementScreenshot: '', consoleMessages: [], networkErrors: [],
  };

  const imageStrip = (wrapper: VueWrapper) => wrapper.findComponent({ name: 'ImageThumbnailStrip' }).props('attachments') as unknown[];
  const elementStrip = (wrapper: VueWrapper) => wrapper.findComponent({ name: 'ElementAttachmentStrip' }).props('attachments') as unknown[];
  const lastError = () => useStreamingStore().messages.filter((m) => m.role === 'error').at(-1)?.content;

  async function submit(wrapper: VueWrapper, text: string): Promise<HTMLTextAreaElement> {
    const textarea = await type(wrapper, text);
    keydown(textarea, { key: 'Enter' });
    await wrapper.vm.$nextTick();
    return textarea;
  }

  it('keeps the text and images on a usage error, and sends nothing', async () => {
    seeded.images = [IMAGE];
    const wrapper = composer();
    const textarea = await submit(wrapper, '/steer');

    expect(lastError()).toBe(i18n.global.t('steerCommand.usage'));
    expect(wrapper.emitted('steer')).toBeUndefined();
    expect(wrapper.emitted('send')).toBeUndefined();
    expect(textarea.value).toBe('/steer');
    expect(imageStrip(wrapper)).toHaveLength(1);
  });

  it('keeps the text, images and elements when a browser element is attached', async () => {
    seeded.images = [IMAGE];
    const wrapper = composer();
    elementAttachmentBus.emit(ELEMENT);
    await wrapper.vm.$nextTick();
    const textarea = await submit(wrapper, '/steer abc look');

    expect(lastError()).toBe(i18n.global.t('steerCommand.noElements'));
    expect(wrapper.emitted('steer')).toBeUndefined();
    expect(wrapper.emitted('send')).toBeUndefined();
    expect(textarea.value).toBe('/steer abc look');
    expect(imageStrip(wrapper)).toHaveLength(1);
    expect(elementStrip(wrapper)).toHaveLength(1);
  });

  it('emits steer with the images and clears the box on a valid steer', async () => {
    seeded.images = [IMAGE];
    const wrapper = composer();
    const textarea = await submit(wrapper, '/steer abc look at this');

    expect(wrapper.emitted('steer')).toEqual([[{ agentId: 'abc', message: 'look at this', images: [IMAGE_BLOCK] }, expect.any(String)]]);
    expect(wrapper.emitted('send')).toBeUndefined();
    expect(textarea.value).toBe('');
    expect(imageStrip(wrapper)).toHaveLength(0);
  });

  it('emits steer, not queue, while a turn is running', async () => {
    const wrapper = composer();
    await wrapper.setProps({ isProcessing: true });
    await submit(wrapper, '/steer abc stop');

    expect(wrapper.emitted('steer')).toEqual([[{ agentId: 'abc', message: 'stop', images: [] }, expect.any(String)]]);
    expect(wrapper.emitted('queue')).toBeUndefined();
  });
});

describe('the composer when the extension refuses a steer it already cleared', () => {
  const IMAGE: ImageAttachment = { id: 'img-1', dataUrl: 'data:image/png;base64,AAAA', base64Data: 'AAAA', mediaType: 'image/png', width: 3, height: 2 };

  const imageStrip = (wrapper: VueWrapper) => wrapper.findComponent({ name: 'ImageThumbnailStrip' }).props('attachments') as unknown[];

  async function steer(wrapper: VueWrapper, text: string): Promise<HTMLTextAreaElement> {
    const textarea = await type(wrapper, text);
    keydown(textarea, { key: 'Enter' });
    await wrapper.vm.$nextTick();
    return textarea;
  }

  async function settle(wrapper: VueWrapper, requestId: string, delivered: boolean): Promise<void> {
    (wrapper.vm as unknown as { settleSteer: (requestId: string, delivered: boolean) => void }).settleSteer(requestId, delivered);
    await wrapper.vm.$nextTick();
  }

  const requestIdOf = (wrapper: VueWrapper, index: number): string => wrapper.emitted('steer')![index]![1] as string;

  it('puts the text and the same image attachments back into an empty box', async () => {
    seeded.images = [IMAGE];
    const wrapper = composer();
    const textarea = await steer(wrapper, '/steer abc look at this');
    expect(textarea.value).toBe('');

    await settle(wrapper, requestIdOf(wrapper, 0), false);

    expect(textarea.value).toBe('/steer abc look at this');
    const restored = imageStrip(wrapper);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toStrictEqual(IMAGE);
  });

  it('leaves new typing alone and drops the held draft', async () => {
    seeded.images = [IMAGE];
    const wrapper = composer();
    const textarea = await steer(wrapper, '/steer abc look');
    await type(wrapper, 'something new');

    await settle(wrapper, requestIdOf(wrapper, 0), false);

    expect(textarea.value).toBe('something new');
    expect(imageStrip(wrapper)).toHaveLength(0);
  });

  it('drops the held draft on a delivered steer, so a later refusal restores nothing', async () => {
    const wrapper = composer();
    const textarea = await steer(wrapper, '/steer abc look');

    await settle(wrapper, requestIdOf(wrapper, 0), true);
    await settle(wrapper, requestIdOf(wrapper, 0), false);

    expect(textarea.value).toBe('');
  });

  it('restores the steer the result names, whatever order the results arrive in', async () => {
    const wrapper = composer();
    await steer(wrapper, '/steer abc first');
    const textarea = await steer(wrapper, '/steer abc second');
    expect(requestIdOf(wrapper, 0)).not.toBe(requestIdOf(wrapper, 1));

    await settle(wrapper, requestIdOf(wrapper, 1), true);
    await settle(wrapper, requestIdOf(wrapper, 0), false);

    expect(textarea.value).toBe('/steer abc first');
  });

  it('restores nothing for a result with an id it never sent', async () => {
    const wrapper = composer();
    const textarea = await steer(wrapper, '/steer abc look');

    await settle(wrapper, 'steer-unknown', false);

    expect(textarea.value).toBe('');
  });
});

describe('the composer taking back queued messages a stop never sent', () => {
  const IMAGE_BLOCK = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'AAAA' } };

  const imageStrip = (wrapper: VueWrapper) => wrapper.findComponent({ name: 'ImageThumbnailStrip' }).props('attachments') as ImageAttachment[];

  beforeEach(() => {
    seeded.images = [];
    // happy-dom decodes no image, so a loaded one is stood in for.
    vi.stubGlobal('Image', class {
      naturalWidth = 3;
      naturalHeight = 2;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    });
    return () => vi.unstubAllGlobals();
  });

  it('appends the text after what the box already holds and re-attaches the images', async () => {
    const wrapper = composer();
    const textarea = await type(wrapper, 'a draft typed since');

    (wrapper.vm as unknown as { restoreQueued: (blocks: unknown[]) => void }).restoreQueued([IMAGE_BLOCK, { type: 'text', text: 'rerun the spec' }]);
    await vi.waitFor(() => expect(imageStrip(wrapper)).toHaveLength(1));

    expect(textarea.value).toBe('a draft typed since\n\nrerun the spec');
    expect(imageStrip(wrapper)[0]).toMatchObject({ base64Data: 'AAAA', mediaType: 'image/png', dataUrl: 'data:image/png;base64,AAAA', width: 3, height: 2 });
  });
});

describe('the composer prefixing its draft', () => {
  const prepend = (wrapper: VueWrapper, prefix: string): void => (wrapper.vm as unknown as { prependInput: (prefix: string) => void }).prependInput(prefix);

  it('puts the prefix before the draft and keeps the caret on the same text', async () => {
    const wrapper = composer();
    const textarea = await type(wrapper, 'why is the build slow');
    textarea.setSelectionRange(4, 6);

    prepend(wrapper, '/btw ');
    await wrapper.vm.$nextTick();

    expect(textarea.value).toBe('/btw why is the build slow');
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([9, 11]);
    wrapper.unmount();
  });

  it('leaves the caret after the prefix in an empty box', async () => {
    const wrapper = composer();
    const textarea = wrapper.get('textarea').element as HTMLTextAreaElement;

    prepend(wrapper, '/btw ');
    await wrapper.vm.$nextTick();

    expect(textarea.value).toBe('/btw ');
    expect(textarea.selectionStart).toBe(5);
    wrapper.unmount();
  });

  it('does not add the prefix twice', async () => {
    const wrapper = composer();
    const textarea = await type(wrapper, '/btw why');

    prepend(wrapper, '/btw ');
    await wrapper.vm.$nextTick();

    expect(textarea.value).toBe('/btw why');
    wrapper.unmount();
  });
});

describe('the composer sending a prompt that is not its draft', () => {
  const IMAGE: ImageAttachment = { id: 'img-1', dataUrl: 'data:image/png;base64,AAAA', base64Data: 'AAAA', mediaType: 'image/png', width: 1, height: 1 };
  const imageStrip = (wrapper: VueWrapper) => wrapper.findComponent({ name: 'ImageThumbnailStrip' }).props('attachments') as unknown[];
  const sendPrompt = (wrapper: VueWrapper, prompt: string): void => (wrapper.vm as unknown as { sendPrompt: (prompt: string) => void }).sendPrompt(prompt);

  it('sends only the prompt and keeps the draft and its attachments staged', async () => {
    seeded.images = [IMAGE];
    const wrapper = composer();
    const textarea = await type(wrapper, 'half a thought');

    sendPrompt(wrapper, 'Write tests');
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted('send')).toEqual([['Write tests', expect.any(Boolean)]]);
    expect(textarea.value).toBe('half a thought');
    expect(imageStrip(wrapper)).toHaveLength(1);
    wrapper.unmount();
  });

  it('queues it behind a running turn', async () => {
    const wrapper = composer();
    await wrapper.setProps({ isProcessing: true });

    sendPrompt(wrapper, 'Write tests');

    expect(wrapper.emitted('queue')).toEqual([['Write tests']]);
    expect(wrapper.emitted('send')).toBeUndefined();
    wrapper.unmount();
  });
});

describe('Shift+Tab in the composer', () => {
  beforeEach(() => setActivePinia(createPinia()));

  const press = (textarea: HTMLTextAreaElement, init: KeyboardEventInit): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true, ...init });
    textarea.dispatchEvent(event);
    return event;
  };

  it('takes a bare Shift+Tab for mode cycling but leaves modified chords to the host', () => {
    const textarea = composer().get('textarea').element as HTMLTextAreaElement;

    expect(press(textarea, {}).defaultPrevented).toBe(true);
    // Ctrl+Shift+Tab is the previous-tab accelerator on desktop and the previous-editor chord in VS Code.
    expect(press(textarea, { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press(textarea, { metaKey: true }).defaultPrevented).toBe(false);
    expect(press(textarea, { altKey: true }).defaultPrevented).toBe(false);
  });
});

/** A mode or YOLO change re-checks the open approval prompts, which exist only while a turn runs. */
describe('mode and YOLO controls while a turn runs', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('cycles the mode from Shift+Tab and the mode button, and toggles YOLO', async () => {
    const wrapper = composer();
    await wrapper.setProps({ isProcessing: true });

    await wrapper.get('textarea').trigger('keydown', { key: 'Tab', shiftKey: true });
    await wrapper.get('[data-testid="composer-mode"]').trigger('click');
    await wrapper.get('[data-testid="composer-yolo"]').trigger('click');

    expect(wrapper.emitted('changeMode')).toEqual([['acceptEdits'], ['acceptEdits']]);
    expect(wrapper.emitted('toggleDangerouslySkipPermissions')).toHaveLength(1);
    wrapper.unmount();
  });
});

describe('Escape while a turn runs', () => {
  it('stops the run, except when pressed inside a dock prompt card or a confirmation, which keep it', async () => {
    const wrapper = composer();
    await wrapper.setProps({ isProcessing: true });
    const card = document.body.appendChild(document.createElement('section'));
    card.setAttribute('data-dock-prompt', '');
    const tab = card.appendChild(document.createElement('button'));
    const confirmation = document.body.appendChild(document.createElement('div'));
    confirmation.setAttribute('role', 'alertdialog');
    const choice = confirmation.appendChild(document.createElement('button'));

    keydown(tab, { key: 'Escape' });
    keydown(choice, { key: 'Escape' });
    expect(wrapper.emitted('cancel')).toBeUndefined();

    keydown(document.body, { key: 'Escape' });
    expect(wrapper.emitted('cancel')).toHaveLength(1);
    wrapper.unmount();
    card.remove();
    confirmation.remove();
  });
});

/**
 * The box sizes itself from its text in CSS (`field-sizing`) up to a rem cap, so the cap follows the host font. A height
 * written from script is a px value, which neither follows the font nor gives the space back when the text goes.
 */
describe('the composer box size', () => {
  it('grows with its content from two rows up to a 12.5rem cap, then scrolls', () => {
    const wrapper = composer();

    expect(wrapper.get('textarea').classes()).toEqual(expect.arrayContaining([
      'field-sizing-content',
      'min-h-[round(calc(2lh+1.125rem),0.0625rem)]',
      'max-h-50',
      'overflow-y-auto',
    ]));
    wrapper.unmount();
  });

  it('writes no size from script as the text grows, is sent, or is cleared', async () => {
    const wrapper = composer();
    const textarea = await type(wrapper, Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'));
    await wrapper.vm.$nextTick();
    expect(textarea.getAttribute('style') ?? '').toBe('');

    keydown(textarea, { key: 'Enter' });
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted('send')).toHaveLength(1);
    expect(textarea.value).toBe('');
    expect(textarea.getAttribute('style') ?? '').toBe('');
    wrapper.unmount();
  });
});
