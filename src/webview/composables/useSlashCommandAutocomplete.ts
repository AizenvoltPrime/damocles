import { ref, computed, onMounted, onUnmounted, nextTick, type Ref } from 'vue';
import { Fzf, byLengthAsc } from 'fzf';
import { useVSCode } from './useVSCode';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import type { SlashCommandItem } from '@shared/types/commands';
import type { RunningSubagentInfo } from '@shared/types/subagents';

const MAX_FILTERED_ITEMS = 50;

export function useSlashCommandAutocomplete(
  inputText: Ref<string>,
  textareaRef: Ref<HTMLTextAreaElement | null>
) {
  const { postMessage, onMessage } = useVSCode();

  const isOpen = ref(false);
  const query = ref('');
  const slashStartIndex = ref(-1);
  const selectedIndex = ref(0);
  const commands = ref<SlashCommandItem[]>([]);
  const isLoading = ref(false);
  const commandsLoaded = ref(false);

  const mode = ref<'command' | 'agent'>('command');
  const agents = ref<RunningSubagentInfo[]>([]);
  const agentsLoading = ref(false);

  const filteredCommands = computed(() => {
    if (!query.value) {
      return commands.value;
    }

    const fzf = new Fzf(commands.value, {
      selector: (cmd: SlashCommandItem) => cmd.name,
      tiebreakers: [byLengthAsc],
      limit: MAX_FILTERED_ITEMS,
    });

    return fzf.find(query.value).map(result => result.item);
  });

  const filteredAgents = computed(() => {
    if (!query.value) {
      return agents.value;
    }

    const fzf = new Fzf(agents.value, {
      selector: agent => agent.description + ' ' + agent.id,
      tiebreakers: [byLengthAsc],
      limit: MAX_FILTERED_ITEMS,
    });

    return fzf.find(query.value).map(result => result.item);
  });

  function handleMessage(message: ExtensionToWebviewMessage) {
    if (message.type === 'customSlashCommands') {
      commands.value = message.commands;
      commandsLoaded.value = true;
      isLoading.value = false;
      clampSelection(filteredCommands.value.length);
    }
    if (message.type === 'runningSubagents') {
      agents.value = message.agents;
      agentsLoading.value = false;
      // The list can shrink between keystrokes (a subagent finished); keep the highlight in range so a
      // subsequent Enter never dereferences a stale index (insertAgent(undefined)).
      clampSelection(filteredAgents.value.length);
    }
  }

  /** Keep the highlighted row within the (possibly async-updated) list bounds. */
  function clampSelection(itemCount: number) {
    if (selectedIndex.value >= itemCount) {
      selectedIndex.value = Math.max(0, itemCount - 1);
    }
  }

  let cleanup: (() => void) | null = null;

  onMounted(() => {
    cleanup = onMessage(handleMessage);
  });

  onUnmounted(() => {
    cleanup?.();
  });

  function detectSlashCommand(): { triggered: boolean; query: string; startIndex: number } {
    const textarea = textareaRef.value;
    if (!textarea) return { triggered: false, query: '', startIndex: -1 };

    const cursorPos = textarea.selectionStart;
    const text = inputText.value;

    for (let i = cursorPos - 1; i >= 0; i--) {
      const char = text[i];

      if (char === ' ' || char === '\n' || char === '\t') {
        return { triggered: false, query: '', startIndex: -1 };
      }

      if (char === '/') {
        const isAtStart = i === 0 || /\s/.test(text[i - 1] ?? '');
        if (isAtStart) {
          const commandQuery = text.slice(i + 1, cursorPos);
          if (!/\s/.test(commandQuery)) {
            return { triggered: true, query: commandQuery, startIndex: i };
          }
        }
        return { triggered: false, query: '', startIndex: -1 };
      }
    }

    return { triggered: false, query: '', startIndex: -1 };
  }

  function checkAndUpdateSlashCommand() {
    const textarea = textareaRef.value;
    if (!textarea) return;

    const textBeforeCursor = inputText.value.slice(0, textarea.selectionStart);
    const agentMatch = textBeforeCursor.match(/^(\s*)\/steer\s+(\S*)$/);

    if (agentMatch) {
      mode.value = 'agent';
      query.value = agentMatch[2] ?? '';
      slashStartIndex.value = (agentMatch[1] ?? '').length;

      if (!isOpen.value) {
        isOpen.value = true;
        selectedIndex.value = 0;
      }

      // Stale-while-revalidate: always refetch (a subagent may have started/finished), but only show the
      // loading state on the first fetch. Once a list exists, keep it visible while the refresh resolves.
      postMessage({ type: 'requestRunningSubagents' });
      if (agents.value.length === 0) agentsLoading.value = true;

      clampSelection(filteredAgents.value.length);
      return;
    }

    mode.value = 'command';

    const result = detectSlashCommand();

    if (result.triggered) {
      query.value = result.query;
      slashStartIndex.value = result.startIndex;

      if (!isOpen.value) {
        open();
      }

      clampSelection(filteredCommands.value.length);
    } else {
      close();
    }
  }

  function open() {
    if (!commandsLoaded.value && !isLoading.value) {
      isLoading.value = true;
      postMessage({ type: 'requestCustomSlashCommands' });
    }
    isOpen.value = true;
    selectedIndex.value = 0;
  }

  function close() {
    isOpen.value = false;
    query.value = '';
    slashStartIndex.value = -1;
    selectedIndex.value = 0;
    mode.value = 'command';
  }

  function handleKeyDown(event: KeyboardEvent): boolean {
    if (!isOpen.value) return false;

    const itemCount = mode.value === 'agent'
      ? filteredAgents.value.length
      : filteredCommands.value.length;

    switch (event.key) {
      case 'ArrowUp':
        if (selectedIndex.value > 0) {
          selectedIndex.value--;
        } else {
          selectedIndex.value = itemCount - 1;
        }
        return true;

      case 'ArrowDown':
        if (selectedIndex.value < itemCount - 1) {
          selectedIndex.value++;
        } else {
          selectedIndex.value = 0;
        }
        return true;

      case 'Tab':
      case 'Enter':
        if (itemCount > 0) {
          if (mode.value === 'agent') {
            insertAgent(filteredAgents.value[selectedIndex.value]);
          } else {
            insertCommand(filteredCommands.value[selectedIndex.value]);
          }
          return true;
        }
        return false;

      case 'Escape':
        close();
        return true;

      default:
        return false;
    }
  }

  function insertCommand(command: SlashCommandItem | undefined) {
    const textarea = textareaRef.value;
    if (!textarea || !command) return;

    const before = inputText.value.slice(0, slashStartIndex.value);
    const after = inputText.value.slice(textarea.selectionStart);

    const insertion = `/${command.name} `;
    inputText.value = before + insertion + after;

    // `/steer ` is a two-stage command: completing it opens the agent picker at the second stage.
    const chainsToAgentPicker = command.name === 'steer';

    nextTick(() => {
      const newPosition = before.length + insertion.length;
      textarea.setSelectionRange(newPosition, newPosition);
      textarea.focus();
      if (chainsToAgentPicker) checkAndUpdateSlashCommand();
    });

    close();
  }

  function insertAgent(agent: RunningSubagentInfo | undefined) {
    const textarea = textareaRef.value;
    if (!textarea || !agent) return;

    const before = inputText.value.slice(0, slashStartIndex.value);
    const after = inputText.value.slice(textarea.selectionStart);

    const insertion = `/steer ${agent.id} `;
    inputText.value = before + insertion + after;

    nextTick(() => {
      const newPosition = before.length + insertion.length;
      textarea.setSelectionRange(newPosition, newPosition);
      textarea.focus();
    });

    close();
  }

  function selectItem(index: number) {
    if (mode.value === 'agent') {
      if (index >= 0 && index < filteredAgents.value.length) {
        insertAgent(filteredAgents.value[index]);
      }
      return;
    }

    if (index >= 0 && index < filteredCommands.value.length) {
      insertCommand(filteredCommands.value[index]);
    }
  }

  return {
    isOpen,
    query,
    selectedIndex,
    filteredCommands,
    isLoading,
    mode,
    agents: filteredAgents,
    agentsLoading,
    checkAndUpdateSlashCommand,
    handleKeyDown,
    selectItem,
    close,
  };
}
