// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import ChatInput from '../ChatInput.vue';
import { i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { FILE_DRAG_MIME, serializeFileDragPayload } from '@shared/file-drag';
import { VSCODE_HOST_CAPABILITIES } from '@shared/types/messages';

const bridge = (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }).acquireVsCodeApi();
let posted: Array<{ type: string; [key: string]: unknown }> = [];
const mounted: VueWrapper[] = [];

function composer(): VueWrapper {
  const wrapper = mount(ChatInput, {
    props: { isProcessing: false, permissionMode: 'default', dangerouslySkipPermissions: false },
    global: { plugins: [i18n], stubs: { ElementAttachmentStrip: true, ImageThumbnailStrip: true } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

// A DataTransfer as Chromium hands a drop from another view: the types list and getData for each type.
function dragEvent(type: string, data: Record<string, string>): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: Object.keys(data), getData: (key: string) => data[key] ?? '', dropEffect: 'none' },
  });
  return event;
}

const payload = { [FILE_DRAG_MIME]: serializeFileDragPayload({ projectKey: 'p1', relativePath: 'src/a.ts' }) };

beforeEach(() => {
  setActivePinia(createPinia());
  posted = [];
  vi.spyOn(bridge, 'postMessage').mockImplementation((message: unknown) => void posted.push(message as { type: string }));
});
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('a file dropped on the composer', () => {
  it('shows the drop target while a file is over the composer and posts mentionDropped with the parsed fields only', async () => {
    useSettingsStore().setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES, fileMentionDrop: true });
    const wrapper = composer();
    const card = wrapper.get('[data-testid="composer"]').element;

    card.dispatchEvent(dragEvent('dragenter', payload));
    const over = dragEvent('dragover', payload);
    card.dispatchEvent(over);
    await wrapper.vm.$nextTick();
    expect(over.defaultPrevented).toBe(true);
    expect(wrapper.get('[data-testid="composer-drop-target"]').text()).toBe('Drop to mention in chat');

    const drop = dragEvent('drop', payload);
    card.dispatchEvent(drop);
    await wrapper.vm.$nextTick();
    expect(drop.defaultPrevented).toBe(true);
    expect(posted).toEqual([{ type: 'mentionDropped', projectKey: 'p1', relativePath: 'src/a.ts' }]);
    expect(wrapper.find('[data-testid="composer-drop-target"]').exists()).toBe(false);
  });

  it('posts nothing for a payload that is not exactly a project and a confined relative path', async () => {
    useSettingsStore().setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES, fileMentionDrop: true });
    const wrapper = composer();
    const card = wrapper.get('[data-testid="composer"]').element;
    for (const raw of ['not json', JSON.stringify({ projectKey: 'p1', relativePath: '../etc/passwd' }), JSON.stringify({ projectKey: 'p1', relativePath: 'C:/x' })]) {
      card.dispatchEvent(dragEvent('drop', { [FILE_DRAG_MIME]: raw }));
    }
    await wrapper.vm.$nextTick();
    expect(posted).toEqual([]);
  });

  it('takes no file drop on a host whose composer has no file views to drag from (VS Code)', async () => {
    const wrapper = composer();
    const card = wrapper.get('[data-testid="composer"]').element;
    const over = dragEvent('dragover', payload);
    card.dispatchEvent(dragEvent('dragenter', payload));
    card.dispatchEvent(over);
    card.dispatchEvent(dragEvent('drop', payload));
    await wrapper.vm.$nextTick();
    expect(over.defaultPrevented).toBe(false);
    expect(wrapper.find('[data-testid="composer-drop-target"]').exists()).toBe(false);
    expect(posted).toEqual([]);
  });

  it('leaves a plain text drag to the textarea', async () => {
    useSettingsStore().setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES, fileMentionDrop: true });
    const wrapper = composer();
    const over = dragEvent('dragover', { 'text/plain': 'hello' });
    wrapper.get('[data-testid="composer"]').element.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(false);
  });
});

describe('a mention core resolved', () => {
  it('inserts @path at the caret exactly as an autocomplete pick does, spaced from the word before it', async () => {
    const wrapper = composer();
    const textarea = wrapper.get('textarea');
    await textarea.setValue('look at');
    (textarea.element as HTMLTextAreaElement).setSelectionRange(7, 7);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'insertMention', path: '/w/p1/src/a.ts', display: 'src/a.ts' } }));
    await wrapper.vm.$nextTick();
    expect((textarea.element as HTMLTextAreaElement).value).toBe('look at @src/a.ts ');

    (textarea.element as HTMLTextAreaElement).setSelectionRange(0, 0);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'insertMention', path: '/w/p1/b.md', display: 'b.md' } }));
    await wrapper.vm.$nextTick();
    expect((textarea.element as HTMLTextAreaElement).value).toBe('@b.md look at @src/a.ts ');
  });
});
