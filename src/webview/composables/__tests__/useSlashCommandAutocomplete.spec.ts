// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ref, defineComponent, h, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import type { SteerTargetInfo } from '@shared/types/subagents';
import type { RootWithheld } from '@shared/types/commands';
import { useSlashCommandAutocomplete } from '../useSlashCommandAutocomplete';

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

type SubagentTarget = Extract<SteerTargetInfo, { kind: 'subagent' }>;

function runningAgent(overrides: Partial<SubagentTarget> = {}): SubagentTarget {
  return {
    kind: 'subagent',
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
    expect(hoisted.postMessage).toHaveBeenCalledWith({ type: 'requestSteerTargets' });
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

    dispatch({ type: 'steerTargets', agents: [runningAgent()] });
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
      type: 'steerTargets',
      agents: [runningAgent({ id: 'a1' }), runningAgent({ id: 'b2' }), runningAgent({ id: 'c3' })],
    });
    await nextTick();

    api.selectedIndex.value = 2; // highlight the last row

    // Two subagents finish; the list shrinks under the stale highlight.
    dispatch({ type: 'steerTargets', agents: [runningAgent({ id: 'a1' })] });
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
    expect(hoisted.postMessage).toHaveBeenCalledWith({ type: 'requestSteerTargets' });
  });

  it('lists team members and matches on the team title and member name', async () => {
    const { api, typeText, dispatch } = setup();
    const member: SteerTargetInfo = {
      kind: 'team-member',
      id: 'member-uuid-1',
      teamId: 'team-1',
      teamTitle: 'Payments rewrite',
      memberName: 'backend',
      role: 'specialist',
      status: 'running',
    };

    typeText('/steer ');
    api.checkAndUpdateSlashCommand();
    dispatch({ type: 'steerTargets', agents: [runningAgent(), member] });
    await nextTick();
    expect(api.agents.value).toHaveLength(2);

    typeText('/steer backend');
    api.checkAndUpdateSlashCommand();
    expect(api.agents.value.map((a) => a.id)).toEqual(['member-uuid-1']);

    typeText('/steer Payments');
    api.checkAndUpdateSlashCommand();
    expect(api.agents.value.map((a) => a.id)).toEqual(['member-uuid-1']);
  });

  it('inserts "/steer <id> " and keeps the popup closed once a trailing space follows', async () => {
    const { api, inputText, typeText, dispatch } = setup();

    typeText('/steer ');
    api.checkAndUpdateSlashCommand();

    const agent = runningAgent();
    dispatch({ type: 'steerTargets', agents: [agent] });
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

describe('useSlashCommandAutocomplete — withheld rows', () => {
  beforeEach(() => {
    hoisted.postMessage.mockClear();
    hoisted.handlers = [];
  });

  async function openWith(withheld: { reason: 'linkOutside' } | { reason: 'broken'; target: string }) {
    const harness = setup();
    harness.typeText('/gs');
    harness.api.checkAndUpdateSlashCommand();
    harness.dispatch({
      type: 'customSlashCommands',
      commands: [{ name: 'gs:', namespace: 'gs', description: '', filePath: '/ws/.claude/commands/gs', source: 'project', withheld }],
    });
    await nextTick();
    hoisted.postMessage.mockClear();
    return harness;
  }

  it.each(['Enter', 'Tab'])('never inserts an inert row on %s, and swallows the key', async (key) => {
    const { api, inputText } = await openWith({ reason: 'broken', target: '/gone' });

    expect(api.handleKeyDown(new KeyboardEvent('keydown', { key }))).toBe(true);
    api.selectItem(0);

    expect(inputText.value).toBe('/gs');
    expect(hoisted.postMessage).not.toHaveBeenCalled();
  });

  it.each(['Enter', 'Tab'])('keeps the menu open on %s over an inert row and names its reason, until the highlight moves', async (key) => {
    const { api, inputText } = await openWith({ reason: 'broken', target: '/gone' });
    expect(api.inactiveReason.value).toBeNull();

    expect(api.handleKeyDown(new KeyboardEvent('keydown', { key }))).toBe(true);

    expect(inputText.value).toBe('/gs');
    expect(api.isOpen.value).toBe(true);
    expect(api.inactiveReason.value).toEqual({ reason: 'broken', target: '/gone' });

    api.handleKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(api.inactiveReason.value).toBeNull();
  });

  it('asks the host to trust the project for a link leading out of it, and inserts nothing', async () => {
    const { api, inputText } = await openWith({ reason: 'linkOutside' });

    api.handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(hoisted.postMessage).toHaveBeenCalledWith({ type: 'setProjectTrusted' });
    expect(inputText.value).toBe('/gs');
    expect(api.isOpen.value).toBe(false);
  });

  it('asks for trust when the row is clicked too', async () => {
    const { api, inputText } = await openWith({ reason: 'linkOutside' });

    api.selectItem(0);

    expect(hoisted.postMessage).toHaveBeenCalledWith({ type: 'setProjectTrusted' });
    expect(inputText.value).toBe('/gs');
  });
});

describe('useSlashCommandAutocomplete — withheld folders', () => {
  beforeEach(() => {
    hoisted.postMessage.mockClear();
    hoisted.handlers = [];
  });

  async function openWith(query: string, withheld: RootWithheld) {
    const harness = setup();
    harness.typeText(`/${query}`);
    harness.api.checkAndUpdateSlashCommand();
    harness.dispatch({
      type: 'customSlashCommands',
      commands: [{ name: 'deploy', description: 'ship it', filePath: '/home/.damocles/commands/deploy.md', source: 'user' }],
      withheldRoots: [{ kind: 'withheldRoot', assets: 'commands', folder: '.claude', source: 'project', filePath: '/ws/.claude/commands', untrusted: true, withheld }],
    });
    await nextTick();
    hoisted.postMessage.mockClear();
    return harness;
  }

  const shown = (api: Autocomplete): string[] => api.filteredCommands.value.map((row) => ('kind' in row ? row.folder : row.name));

  it('lists a withheld folder after the commands under a bare slash only', async () => {
    const { api, typeText } = await openWith('', { reason: 'share' });

    expect(shown(api)).toEqual(['deploy', '.claude']);
    typeText('/dep');
    api.checkAndUpdateSlashCommand();
    expect(shown(api)).toEqual(['deploy']);
  });

  // A word whose letters occur in `.claude/commands` would otherwise land on the inert row, and Enter would send nothing.
  it('lets Enter send a typed word no command matches', async () => {
    const { api, inputText } = await openWith('clean', { reason: 'share' });

    expect(shown(api)).toEqual([]);
    expect(api.handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(false);
    expect(inputText.value).toBe('/clean');
  });

  it('never inserts a withheld folder\'s row', async () => {
    const { api, inputText } = await openWith('', { reason: 'share' });
    api.selectedIndex.value = 1;

    expect(api.handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(true);
    api.selectItem(1);

    expect(inputText.value).toBe('/');
    expect(hoisted.postMessage).not.toHaveBeenCalled();
  });

  it('asks the host to trust the project for a folder linked out of it', async () => {
    const { api, inputText } = await openWith('', { reason: 'linkOutside' });
    api.selectedIndex.value = 1;

    api.handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(hoisted.postMessage).toHaveBeenCalledWith({ type: 'setProjectTrusted' });
    expect(inputText.value).toBe('/');
    expect(api.isOpen.value).toBe(false);
  });
});
