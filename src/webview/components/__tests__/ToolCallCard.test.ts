// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { ToolCall } from '@shared/types/session';
import { CANCELLED_TOOL_DETAIL_KEY } from '@shared/types/session';
import { TEAM_TOOL_LABELS } from '@shared/team-tool-labels';
import ToolCallCard from '../ToolCallCard.vue';
import { convertHistoryTools } from '@/composables/message-handler/utils';
import ToolOverlay from '../ToolOverlay.vue';
import SkillToolCard from '../SkillToolCard.vue';
import LoadingSpinner from '../LoadingSpinner.vue';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useUIStore } from '@/stores/useUIStore';
import { i18n } from '@/i18n';

/**
 * What the card puts on screen for a tool the user is reading after the fact.
 *
 * The two glyphs are compared by their lucide glyph name rather than by a colour class, because the card
 * picks a component and colours it separately: asserting only the colour would pass on a green-coloured
 * check and asserting only the component would pass on a red one.
 */


const CHECK_PATH = 'circle-check';
const BAN_PATH = 'ban';
const SPINNER_PATH = 'loader-circle';

function card(toolCall: ToolCall): VueWrapper {
  return mount(ToolCallCard, {
    props: { toolCall, source: 'session' },
    global: {
      plugins: [i18n],
      stubs: { LiveOutputPane: true, DiffView: true, MarkdownRenderer: true },
    },
  });
}

/** The lucide glyph name of every icon the card rendered, e.g. `ban` or `circle-check`. */
function headerPaths(wrapper: VueWrapper): string[] {
  return wrapper.findAll('svg').map((svg) => svg.classes().find((c) => c.startsWith('lucide-') && !c.endsWith('-icon'))?.slice('lucide-'.length) ?? '');
}

beforeEach(() => setActivePinia(createPinia()));

describe('a cancelled tool call', () => {
  const cancelled: ToolCall = {
    id: 't-1',
    name: 'Bash',
    input: { command: 'sleep 300' },
    status: 'cancelled',
    result: 'partial output',
    metadata: { [CANCELLED_TOOL_DETAIL_KEY]: true },
  };

  it('renders the neutral ban glyph and never the success check', () => {
    const paths = headerPaths(card(cancelled));

    expect(paths).toContain(BAN_PATH);
    expect(paths).not.toContain(CHECK_PATH);
  });

  it('renders the completed call it would otherwise be mistaken for with the check', () => {
    // Pins the contrast: without this, a card that rendered no icon at all would pass the case above.
    const paths = headerPaths(card({ ...cancelled, status: 'completed' }));

    expect(paths).toContain(CHECK_PATH);
    expect(paths).not.toContain(BAN_PATH);
  });

  it('says it was stopped rather than that it failed, and carries no error colouring', () => {
    const wrapper = card(cancelled);

    expect(wrapper.text()).toContain('Stopped');
    expect(wrapper.html()).not.toContain('--d-danger');
    expect(wrapper.html()).not.toContain('--d-success');
  });

  it('does not reuse the abandoned card copy', () => {
    expect(card(cancelled).text()).not.toContain('Not executed');
    expect(card({ ...cancelled, status: 'abandoned' }).text()).toContain('Not executed');
  });
});

describe('a tool call that never ran', () => {
  const abandoned: ToolCall = { id: 't-1', name: 'Read', input: { file_path: '/a.ts' }, status: 'abandoned' };

  it('says the model call that requested it failed when that is why it never ran', () => {
    const text = card({ ...abandoned, abandonReason: 'failed' }).text();

    expect(text).toContain(i18n.global.t('toolCall.notExecuted'));
    expect(text).toContain(i18n.global.t('toolCall.abandonedFailed'));
    expect(text).not.toContain(i18n.global.t('toolCall.abandonedStopped'));
  });

  it('says the turn was stopped when that is why it never finished', () => {
    const text = card({ ...abandoned, abandonReason: 'stopped' }).text();

    expect(text).toContain(i18n.global.t('toolCall.abandonedStopped'));
    expect(text).not.toContain(i18n.global.t('toolCall.abandonedFailed'));
  });
});

describe('a tool call whose outcome was never recorded', () => {
  const unrecorded: ToolCall = {
    id: 't-1',
    name: 'Bash',
    input: { command: 'ls' },
    status: 'unrecorded',
  };

  function overlay(tool: ToolCall): VueWrapper {
    return mount(ToolOverlay, {
      props: { tool },
      global: {
        plugins: [i18n],
        stubs: { LiveOutputPane: true, MarkdownRenderer: true, CodeBlock: true },
      },
    });
  }

  it('renders no spinner, so the card does not read as a tool still running', () => {
    const wrapper = card(unrecorded);

    expect(headerPaths(wrapper)).not.toContain(SPINNER_PATH);
    expect(wrapper.find('.d-spinning').exists()).toBe(false);
  });

  it('renders the spinner for the pre-terminal status it must not be confused with', () => {
    // Pins the contrast: without this, a card that never renders a spinner at all would pass the case above.
    const wrapper = card({ ...unrecorded, status: 'pending' });

    expect(headerPaths(wrapper)).toContain(SPINNER_PATH);
    expect(wrapper.find('.d-spinning').exists()).toBe(true);
  });

  it('takes neither the success check nor the glyph the stopped and abandoned cards use', () => {
    const paths = headerPaths(card(unrecorded));

    expect(paths).not.toContain(CHECK_PATH);
    expect(paths).not.toContain(BAN_PATH);
  });

  it('says the outcome was not recorded rather than reusing the abandoned or stopped copy', () => {
    const text = card(unrecorded).text();

    expect(text).toContain('Outcome not recorded');
    expect(text).not.toContain('Not executed');
    expect(text).not.toContain('Stopped');
  });

  it('carries the muted weight rather than success or error colouring', () => {
    const html = card(unrecorded).html();

    expect(html).toContain('opacity-60');
    expect(html).not.toContain('--d-success');
    expect(html).not.toContain('--d-danger');
  });

  it('opens an overlay that shows the input instead of short-circuiting to a running body', () => {
    const wrapper = overlay(unrecorded);

    expect(wrapper.find('h2').text()).toBe('Bash');
    expect(wrapper.text()).toContain('Input');
    expect(wrapper.get('[data-testid="tool-overlay-command"]').text()).toBe('$ ls');
    expect(wrapper.text()).not.toContain('Tool is running');
    expect(wrapper.findComponent(LoadingSpinner).exists()).toBe(false);
  });

  it('badges the overlay as unrecorded rather than as running', () => {
    const text = overlay(unrecorded).text();

    expect(text).toContain('Outcome not recorded');
    expect(text).not.toContain('Running');
  });

  it('shows the input above a waiting line for the pre-terminal status it must not be confused with', () => {
    // Pins the contrast: a live call says it is running, and still shows what it was asked to run.
    const wrapper = overlay({ ...unrecorded, status: 'pending' });

    expect(wrapper.text()).toContain('Tool is running');
    expect(wrapper.text()).toContain('Input');
    expect(wrapper.get('[data-testid="tool-overlay-command"]').text()).toBe('$ ls');
  });
});

describe('team tool cards', () => {
  const names = Object.keys(TEAM_TOOL_LABELS);

  it('covers all twenty-one team tools', () => {
    expect(names).toHaveLength(21);
  });

  it.each(names)('renders %s under its human label and never the raw name', (name) => {
    const label = TEAM_TOOL_LABELS[name];
    const wrapper = card({ id: 't-1', name, input: {}, status: 'completed' });

    expect(wrapper.text()).toContain(label);
    expect(wrapper.text()).not.toContain(name);
  });

  it.each(names)('makes %s expandable', async (name) => {
    const wrapper = card({ id: 't-1', name, input: {}, status: 'completed' });

    await wrapper.trigger('click');

    expect(useUIStore()).toMatchObject({ expandedToolId: 't-1', expandedToolSource: 'session' });
  });

  it('gives a team tool an icon of its own rather than the generic wrench fallback', () => {
    const team = headerPaths(card({ id: 't-1', name: 'team_write_scratchpad', input: {}, status: 'completed' }));
    const unknown = headerPaths(card({ id: 't-2', name: 'SomeUnmappedTool', input: {}, status: 'completed' }));

    expect(team[0]).not.toBe(unknown[0]);
  });

  it('leaves a non-team tool name untouched', () => {
    expect(card({ id: 't-1', name: 'Bash', input: { command: 'ls' }, status: 'completed' }).text()).toContain('Bash');
  });

  it('shows who a message went to instead of the id the model was handed back', () => {
    const wrapper = card({
      id: 't-1',
      name: 'team_send_message',
      input: { to: 'lead', content: 'the parser is done' },
      status: 'completed',
      result: 'Message sent (id: c16959e3-3eb8-434d-9c4b-289eee27f1e6)',
    });

    expect(wrapper.text()).toContain('To lead: the parser is done');
    expect(wrapper.text()).toContain('Sent to lead');
    expect(wrapper.text()).not.toContain('c16959e3');
  });

  it('shows the section read instead of the raw arguments object', () => {
    const wrapper = card({ id: 't-1', name: 'team_read_scratchpad', input: { section: 'mission-brief' }, status: 'completed' });

    expect(wrapper.text()).toContain('mission-brief');
    expect(wrapper.text()).not.toContain('{"section"');
  });

  it('shows an errored team result raw rather than summarising a success over it', () => {
    const wrapper = card({
      id: 't-1',
      name: 'team_send_message',
      input: { to: 'ghost', content: 'hello' },
      status: 'failed',
      isError: true,
      result: 'Unknown agent "ghost". Team members: lead, coder',
    });

    expect(wrapper.text()).toContain('Unknown agent "ghost"');
    expect(wrapper.text()).not.toContain('Sent to ghost');
  });

  it('leaves a non-team tool result as the head of the raw text', () => {
    const wrapper = card({ id: 't-1', name: 'Bash', input: { command: 'ls' }, status: 'completed', result: 'a.ts\nb.ts' });

    expect(wrapper.text()).toContain('a.ts');
  });
});

describe('the expanded overlay for a team tool', () => {
  it('shows the raw snake_case name so session logs and greps still match', () => {
    const wrapper = mount(ToolOverlay, {
      props: {
        tool: { id: 't-1', name: 'team_write_scratchpad', input: { section: 'webview' }, status: 'completed', result: 'ok' },
      },
      global: {
        plugins: [i18n],
        stubs: { LiveOutputPane: true, MarkdownRenderer: true, CodeBlock: true },
      },
    });

    expect(wrapper.find('h2').text()).toBe('team_write_scratchpad');
    expect(wrapper.text()).toContain('Write scratchpad');
  });
});

/**
 * `toolCall.name` is model and MCP controlled text, and every presentation table it indexes is a plain
 * object. A bare index for an `Object.prototype` key returns an inherited function, which then reaches
 * code expecting a miss. `__proto__` is the case an own-property check catches and a `!== undefined`
 * check does not, because it yields an object rather than a function.
 */
describe('a tool named after an Object.prototype member', () => {
  const PROTOTYPE_KEYS = ['toString', 'constructor', 'valueOf', '__proto__'];

  function protoCall(name: string): ToolCall {
    return { id: 't-1', name, input: { command: 'ls' }, status: 'completed', result: 'done' };
  }

  it.each(PROTOTYPE_KEYS)('renders the card for %s instead of throwing', (name) => {
    expect(() => card(protoCall(name))).not.toThrow();
  });

  it.each(PROTOTYPE_KEYS)('shows %s as its own name rather than a team tool label', (name) => {
    expect(card(protoCall(name)).text()).toContain(name);
  });

  it.each(PROTOTYPE_KEYS)('gives %s the same fallback icon an unmapped tool name gets', (name) => {
    // The team table and the built-in table are both indexed by the name; either one leaking an
    // inherited member hands Vue a function as a component and this diverges.
    const unmapped = headerPaths(card(protoCall('SomeUnmappedTool')));

    expect(headerPaths(card(protoCall(name)))).toEqual(unmapped);
  });

  it.each(PROTOTYPE_KEYS)('summarises the input of %s with the built-in formatter', (name) => {
    // A leaked presentation entry would call `summarizeInput`, which no prototype member has.
    expect(card(protoCall(name)).text()).toContain('ls');
  });

  it.each(PROTOTYPE_KEYS)('opens the overlay for %s with a string subtitle', (name) => {
    const wrapper = mount(ToolOverlay, {
      props: { tool: protoCall(name) },
      global: {
        plugins: [i18n],
        stubs: { LiveOutputPane: true, MarkdownRenderer: true, CodeBlock: true },
      },
    });

    expect(wrapper.find('h2').text()).toBe(name);
    expect(wrapper.text()).toContain('Built-in tool');
  });

  it('keeps a real team tool working, so the gate rejects only inherited members', () => {
    const wrapper = card({ id: 't-1', name: 'team_read_scratchpad', input: { section: 'mission' }, status: 'completed' });

    expect(wrapper.text()).toContain('Read scratchpad');
    expect(wrapper.text()).toContain('mission');
  });
});

describe('the expand affordance', () => {
  const expandable: ToolCall = { id: 't-1', name: 'Bash', input: { command: 'ls' }, status: 'completed' };

  it('gives the name a focusable button role rather than putting one around the whole card', () => {
    // A role="button" on the card would make every descendant presentational, hiding the Stop button.
    const wrapper = card(expandable);
    const name = wrapper.get('[role="button"]');

    expect(name.attributes('tabindex')).toBe('0');
    expect(name.text()).toBe('Bash');
    expect(wrapper.attributes('role')).toBeUndefined();
  });

  it('names the control for a screen reader and says it opens a dialog', () => {
    const name = card(expandable).get('[role="button"]');

    expect(name.attributes('aria-label')).toBe('Expand Bash details');
    expect(name.attributes('aria-haspopup')).toBe('dialog');
  });

  it('expands on Enter and on Space', async () => {
    for (const key of ['Enter', ' ']) {
      const wrapper = card(expandable);
      await wrapper.get('[role="button"]').trigger('keydown', { key });

      expect(useUIStore()).toMatchObject({ expandedToolId: 't-1', expandedToolSource: 'session' });
      useUIStore().collapseTool();
    }
  });

  it('ignores a key that is neither Enter nor Space', async () => {
    const wrapper = card(expandable);
    await wrapper.get('[role="button"]').trigger('keydown', { key: 'a' });

    expect(useUIStore().expandedToolId).toBeNull();
  });

  it('offers no keyboard target for a card that does not expand', () => {
    const wrapper = card({ id: 't-1', name: 'SomeUnmappedTool', input: {}, status: 'completed' });

    expect(wrapper.find('[role="button"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('SomeUnmappedTool');
  });
});

describe('a file path in the row', () => {
  const FOLDER = '/home/a/proj';
  const FILE = `${FOLDER}/src/auth.ts`;

  beforeEach(() => {
    useSettingsStore().setWorkspaceFolders([{ key: 'k', name: 'proj', label: 'proj', path: FOLDER }], 'k', 'k');
  });

  it.each(['Read', 'Edit'])('shows %s folder-relative with the full path in its tooltip', (name) => {
    const arg = card({ id: 't-1', name, input: { file_path: FILE }, status: 'completed' }).get(`[title="${FILE}"]`);

    expect(arg.text()).toBe('src/auth.ts');
  });
});

describe('the card frame', () => {
  const skill = (status: ToolCall['status']): VueWrapper =>
    mount(SkillToolCard, { props: { toolCall: { id: 's-1', name: 'Skill', input: { skill: 'demo' }, status } }, global: { plugins: [i18n] } });

  it.each<ToolCall['status']>(['awaiting_approval', 'running', 'failed', 'cancelled'])('draws a %s call the way the specialised cards do', (status) => {
    const tool = card({ id: 't-1', name: 'Bash', input: { command: 'ls' }, status });
    const special = skill(status);

    expect(tool.classes()).toEqual(special.classes());
    // The skill card draws no body glyph for these statuses, so its last glyph is the status icon.
    expect(headerPaths(tool)).toContain(headerPaths(special).at(-1));
    expect(tool.find('.d-spinning').exists()).toBe(special.find('.d-spinning').exists());
  });

  it('animates only through the motion.css classes', () => {
    for (const status of ['pending', 'running', 'awaiting_approval'] as const) {
      expect(card({ id: 't-1', name: 'Bash', input: { command: 'ls' }, status, liveOutput: 'x' }).html()).not.toContain('animate-[');
    }
  });
});

describe('a call replayed from history', () => {
  const replay = (durationMs?: number): ToolCall => convertHistoryTools([{ id: 't-1', name: 'Bash', input: { command: 'ls' }, result: 'ok', ...(durationMs === undefined ? {} : { durationMs }) }])![0]!;

  it('shows the execution time pi recorded', () => {
    expect(card(replay(1234)).text()).toContain('1.2s');
  });

  it('shows no time for a session recorded before pi kept one', () => {
    expect(card(replay()).text()).not.toMatch(/\d(ms|\.\ds)\b/);
  });
});
