// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ref, defineComponent, h, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import type { RunningSubagentInfo } from '@shared/types/subagents';
import { useSlashCommandAutocomplete } from '../useSlashCommandAutocomplete';

const hoisted = vi.hoisted(() => ({
  postMessage: vi.fn(),
  handlers: [] as Array<(message: ExtensionToWebviewMessage) => void>,
}));

vi.mock('../useVSCode', () => ({
  useVSCode: () => ({
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

type Autocomplete = ReturnType<typeof useSlashCommandAutocomplete>;

function setup() {
  const inputText = ref('');
  const textarea = document.createElement('textarea');
  const textareaRef = ref<HTMLTextAreaElement | null>(textarea);

  let api!: Autocomplete;
  const Wrapper = defineComponent({
    setup() {
      api = useSlashCommandAutocomplete(inputText, textareaRef);
      return () => h('div');
    },
  });
  const wrapper = mount(Wrapper);

  /** Reflect the input value + cursor into both the ref and the textarea. */
  function typeText(text: string, cursor: number = text.length) {
    inputText.value = text;
    textarea.value = text;
    textarea.setSelectionRange(cursor, cursor);
  }

  function dispatch(message: ExtensionToWebviewMessage) {
    hoisted.handlers.forEach(handler => handler(message));
  }

  return { api, inputText, textarea, wrapper, typeText, dispatch };
}

function runningAgent(overrides: Partial<RunningSubagentInfo> = {}): RunningSubagentInfo {
  return {
    id: 'abcd1234efgh5678',
    agentType: 'general-purpose',
    description: 'Investigate the failing test',
    status: 'running',
    isBackground: false,
    ...overrides,
  };
}

describe('useSlashCommandAutocomplete — agent mode', () => {
  beforeEach(() => {
    hoisted.postMessage.mockClear();
    hoisted.handlers = [];
  });

  it('enters agent mode with an empty query on "/steer " and requests a fresh list', () => {
    const { api, typeText } = setup();

    typeText('/steer ');
    api.checkAndUpdateSlashCommand();

    expect(api.mode.value).toBe('agent');
    expect(api.query.value).toBe('');
    expect(api.isOpen.value).toBe(true);
    expect(hoisted.postMessage).toHaveBeenCalledWith({ type: 'requestRunningSubagents' });
  });

  it('captures the partial id/description query on "/steer ab"', () => {
    const { api, typeText } = setup();

    typeText('/steer ab');
    api.checkAndUpdateSlashCommand();

    expect(api.mode.value).toBe('agent');
    expect(api.query.value).toBe('ab');
  });

  it('fetches fresh on every entry into agent mode (no caching)', () => {
    const { api, typeText } = setup();

    typeText('/steer ');
    api.checkAndUpdateSlashCommand();
    api.checkAndUpdateSlashCommand();

    expect(hoisted.postMessage).toHaveBeenCalledTimes(2);
  });

  it('shows the loading state only on the first fetch, then keeps the list visible while revalidating', async () => {
    const { api, typeText, dispatch } = setup();

    typeText('/steer ');
    api.checkAndUpdateSlashCommand();
    expect(api.agentsLoading.value).toBe(true); // no list yet → show the spinner

    dispatch({ type: 'runningSubagents', agents: [runningAgent()] });
    await nextTick();
    expect(api.agentsLoading.value).toBe(false);

    // A subsequent keystroke revalidates but must NOT flip back to a spinner (stale-while-revalidate).
    typeText('/steer a');
    api.checkAndUpdateSlashCommand();
    expect(api.agentsLoading.value).toBe(false);
    expect(api.agents.value.length).toBeGreaterThan(0);
  });

  it('re-clamps the selection and never dereferences a stale index when the list shrinks async', async () => {
    const { api, typeText, dispatch } = setup();

    typeText('/steer ');
    api.checkAndUpdateSlashCommand();
    dispatch({
      type: 'runningSubagents',
      agents: [runningAgent({ id: 'a1' }), runningAgent({ id: 'b2' }), runningAgent({ id: 'c3' })],
    });
    await nextTick();

    api.selectedIndex.value = 2; // highlight the last row

    // Two subagents finish; the list shrinks under the stale highlight.
    dispatch({ type: 'runningSubagents', agents: [runningAgent({ id: 'a1' })] });
    await nextTick();
    expect(api.selectedIndex.value).toBe(0); // re-clamped into range

    // Enter must not throw (the pre-fix crash was insertAgent(undefined)).
    expect(() => api.handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))).not.toThrow();
  });

  it('does not crash on Enter when the highlight points past the list (insert guard)', () => {
    const { api, typeText } = setup();

    typeText('/steer ');
    api.checkAndUpdateSlashCommand(); // agent mode, empty list
    api.selectedIndex.value = 5; // force an out-of-range highlight with no clamp

    expect(() => api.handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))).not.toThrow();
  });

  it('chains into the agent picker after completing the /steer command via Tab/Enter', async () => {
    const { api, typeText, dispatch, inputText } = setup();

    typeText('/steer', 6); // command mode (no trailing space)
    api.checkAndUpdateSlashCommand();
    dispatch({
      type: 'customSlashCommands',
      commands: [{ name: 'steer', description: 'Steer a running subagent', source: 'builtin' }],
    });
    await nextTick();

    api.selectItem(0); // inserts "/steer " and schedules the chained detection
    typeText(inputText.value); // mirror v-model so the chained detection sees the new value + cursor
    await nextTick();

    expect(api.mode.value).toBe('agent');
    expect(hoisted.postMessage).toHaveBeenCalledWith({ type: 'requestRunningSubagents' });
  });

  it('inserts "/steer <id> " and keeps the popup closed once a trailing space follows', async () => {
    const { api, inputText, typeText, dispatch } = setup();

    typeText('/steer ');
    api.checkAndUpdateSlashCommand();

    const agent = runningAgent();
    dispatch({ type: 'runningSubagents', agents: [agent] });
    await nextTick();

    expect(api.agents.value).toHaveLength(1);
    expect(api.agentsLoading.value).toBe(false);

    api.selectItem(0);

    expect(inputText.value).toBe(`/steer ${agent.id} `);
    expect(api.isOpen.value).toBe(false);
    expect(api.mode.value).toBe('command');

    // Re-run detection with the cursor after the trailing space — the agent
    // regex no longer matches, so the popup must stay closed.
    typeText(inputText.value);
    api.checkAndUpdateSlashCommand();

    expect(api.isOpen.value).toBe(false);
  });
});
