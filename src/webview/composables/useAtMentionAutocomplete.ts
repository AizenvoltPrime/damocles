import { ref, computed, onMounted, onUnmounted, nextTick, type Ref } from 'vue';
import { Fzf, byLengthAsc } from 'fzf';
import { useVSCode } from './useVSCode';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import { AVAILABLE_AGENTS, type WorkspaceFileInfo, type CustomAgentInfo, type AtMentionItem } from '@shared/types/commands';

const MAX_VISIBLE_ITEMS = 10;

// Not widened to `AtMentionItem[]`: the dedupe below keys builtins on `data.id` and custom agents on
// `data.name`, which only typecheck while each list keeps its own variant of the union.
const builtinAgentItems = AVAILABLE_AGENTS
  .map(a => ({ type: 'builtin-agent' as const, data: a }));

function getItemSearchString(item: AtMentionItem): string {
  switch (item.type) {
    case 'file':
      return `${item.data.relativePath} ${item.data.relativePath.split('/').pop() || ''}`;
    case 'builtin-agent':
      return `agent-${item.data.id} ${item.data.name} ${item.data.description}`;
    case 'custom-agent':
      return `agent-${item.data.name} ${item.data.description}`;
  }
}

export function useAtMentionAutocomplete(
  inputText: Ref<string>,
  textareaRef: Ref<HTMLTextAreaElement | null>
) {
  const { postMessage, onMessage } = useVSCode();

  const isOpen = ref(false);
  const query = ref('');
  const atStartIndex = ref(-1);
  const selectedIndex = ref(0);
  const files = ref<WorkspaceFileInfo[]>([]);
  const customAgents = ref<CustomAgentInfo[]>([]);
  const isLoading = ref(false);
  const filesLoaded = ref(false);
  const customAgentsLoaded = ref(false);

  const filteredItems = computed((): AtMentionItem[] => {
    const customAgentItems = customAgents.value.map(a => ({
      type: 'custom-agent' as const,
      data: a,
    }));

    const agentsByName = new Map<string, AtMentionItem>();
    for (const item of builtinAgentItems) {
      agentsByName.set(item.data.id, item);
    }
    for (const item of customAgentItems) {
      agentsByName.set(item.data.name, item);
    }
    const allAgents = Array.from(agentsByName.values());

    const fileItems: AtMentionItem[] = files.value.map(f => ({
      type: 'file' as const,
      data: f,
    }));

    const allItems = [...allAgents, ...fileItems];

    if (!query.value) {
      return allItems.slice(0, MAX_VISIBLE_ITEMS);
    }

    const searchItems = allItems.map(item => ({
      original: item,
      searchStr: getItemSearchString(item),
    }));

    const fzf = new Fzf(searchItems, {
      selector: item => item.searchStr,
      tiebreakers: [byLengthAsc],
      limit: MAX_VISIBLE_ITEMS,
    });

    return fzf.find(query.value).map(result => result.item.original);
  });

  function handleMessage(message: ExtensionToWebviewMessage) {
    if (message.type === 'workspaceFiles') {
      files.value = message.files;
      filesLoaded.value = true;
      updateLoadingState();
    } else if (message.type === 'customAgents') {
      customAgents.value = message.agents;
      customAgentsLoaded.value = true;
      updateLoadingState();
    }
  }

  function updateLoadingState() {
    if (filesLoaded.value && customAgentsLoaded.value) {
      isLoading.value = false;
    }
  }

  let cleanup: (() => void) | null = null;

  onMounted(() => {
    cleanup = onMessage(handleMessage);
  });

  onUnmounted(() => {
    cleanup?.();
  });

  function detectAtMention(): { triggered: boolean; query: string; startIndex: number } {
    const textarea = textareaRef.value;
    if (!textarea) return { triggered: false, query: '', startIndex: -1 };

    const cursorPos = textarea.selectionStart;
    const text = inputText.value;

    for (let i = cursorPos - 1; i >= 0; i--) {
      const char = text[i];

      if (char === ' ' || char === '\n' || char === '\t') {
        return { triggered: false, query: '', startIndex: -1 };
      }

      if (char === '@') {
        const isAtStart = i === 0 || /\s/.test(text[i - 1] ?? '');
        if (isAtStart) {
          const mentionQuery = text.slice(i + 1, cursorPos);
          return { triggered: true, query: mentionQuery, startIndex: i };
        }
        return { triggered: false, query: '', startIndex: -1 };
      }
    }

    return { triggered: false, query: '', startIndex: -1 };
  }

  function checkAndUpdateMention() {
    const result = detectAtMention();

    if (result.triggered) {
      query.value = result.query;
      atStartIndex.value = result.startIndex;

      if (!isOpen.value) {
        open();
      }

      if (selectedIndex.value >= filteredItems.value.length) {
        selectedIndex.value = Math.max(0, filteredItems.value.length - 1);
      }
    } else {
      close();
    }
  }

  function open() {
    const needsFilesFetch = !filesLoaded.value;
    const needsAgentsFetch = !customAgentsLoaded.value;

    if ((needsFilesFetch || needsAgentsFetch) && !isLoading.value) {
      isLoading.value = true;
    }

    if (needsFilesFetch) {
      postMessage({ type: 'requestWorkspaceFiles' });
    }
    if (needsAgentsFetch) {
      postMessage({ type: 'requestCustomAgents' });
    }

    isOpen.value = true;
    selectedIndex.value = 0;
  }

  function close() {
    isOpen.value = false;
    query.value = '';
    atStartIndex.value = -1;
    selectedIndex.value = 0;
  }

  function handleKeyDown(event: KeyboardEvent): boolean {
    if (!isOpen.value) return false;

    switch (event.key) {
      case 'ArrowUp':
        if (selectedIndex.value > 0) {
          selectedIndex.value--;
        } else {
          selectedIndex.value = filteredItems.value.length - 1;
        }
        return true;

      case 'ArrowDown':
        if (selectedIndex.value < filteredItems.value.length - 1) {
          selectedIndex.value++;
        } else {
          selectedIndex.value = 0;
        }
        return true;

      case 'Tab':
      case 'Enter': {
        const selected = filteredItems.value[selectedIndex.value];
        if (selected) {
          insertMention(selected);
          return true;
        }
        return false;
      }

      case 'Escape':
        close();
        return true;

      default:
        return false;
    }
  }

  function insertMention(item: AtMentionItem) {
    const textarea = textareaRef.value;
    if (!textarea) return;

    const before = inputText.value.slice(0, atStartIndex.value);
    const after = inputText.value.slice(textarea.selectionStart);

    let mention: string;
    switch (item.type) {
      case 'file':
        mention = `@${item.data.relativePath} `;
        break;
      case 'builtin-agent':
        mention = `@agent-${item.data.id} `;
        break;
      case 'custom-agent':
        mention = `@agent-${item.data.name} `;
        break;
    }

    inputText.value = before + mention + after;

    nextTick(() => {
      const newPosition = before.length + mention.length;
      textarea.setSelectionRange(newPosition, newPosition);
      textarea.focus();
    });

    close();
  }

  function selectItem(index: number) {
    const item = filteredItems.value[index];
    if (item) insertMention(item);
  }

  return {
    isOpen,
    query,
    selectedIndex,
    filteredItems,
    isLoading,
    checkAndUpdateMention,
    handleKeyDown,
    selectItem,
    close,
  };
}
