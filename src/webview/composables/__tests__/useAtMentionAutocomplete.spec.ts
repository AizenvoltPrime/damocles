// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ref, defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import { useAtMentionAutocomplete } from '../useAtMentionAutocomplete';

const hoisted = vi.hoisted(() => ({
  postMessage: vi.fn(),
  handlers: [] as Array<(message: ExtensionToWebviewMessage) => void>,
}));

vi.mock('../usePlatformBridge', () => ({
  usePlatformBridge: () => ({
    postMessage: hoisted.postMessage,
    onMessage: (handler: (message: ExtensionToWebviewMessage) => void) => {
      hoisted.handlers.push(handler);
      return () => {
        hoisted.handlers = hoisted.handlers.filter(h => h !== handler);
      };
    },
    getState: () => undefined,
    setState: () => {},
  }),
}));

function setup() {
  const inputText = ref('');
  const textarea = document.createElement('textarea');
  let api!: ReturnType<typeof useAtMentionAutocomplete>;
  mount(defineComponent({
    setup() {
      api = useAtMentionAutocomplete(inputText, ref(textarea));
      return () => h('div');
    },
  }));
  const type = (text: string) => {
    inputText.value = text;
    textarea.value = text;
    textarea.setSelectionRange(text.length, text.length);
    api.checkAndUpdateMention();
  };
  const dispatch = (message: ExtensionToWebviewMessage) => hoisted.handlers.forEach(handler => handler(message));
  const files = () => api.filteredItems.value.flatMap(item => (item.type === 'file' ? [item.data.relativePath] : []));
  return { api, type, dispatch, files };
}

beforeEach(() => {
  hoisted.postMessage.mockClear();
  hoisted.handlers = [];
});

describe('useAtMentionAutocomplete', () => {
  it('replaces the files it loaded with a list core pushes, and asks for none itself', async () => {
    const { type, dispatch, files } = setup();
    type('@');
    expect(hoisted.postMessage.mock.calls.map(([message]) => message.type)).toEqual(['requestWorkspaceFiles', 'requestCustomAgents']);
    dispatch({ type: 'customAgents', agents: [] });
    dispatch({ type: 'workspaceFiles', files: [{ relativePath: 'link/out.ts', isDirectory: false }, { relativePath: 'a.ts', isDirectory: false }] });
    type('@ts');
    expect(files()).toContain('link/out.ts');

    dispatch({ type: 'workspaceFiles', files: [{ relativePath: 'a.ts', isDirectory: false }] });
    type('@');
    type('@ts');
    expect(files()).toEqual(['a.ts']);
    expect(hoisted.postMessage).toHaveBeenCalledTimes(2);
  });
});
