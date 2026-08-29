// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { ToolCall } from '@shared/types/session';
import { CANCELLED_TOOL_DETAIL_KEY } from '@shared/types/session';
import { TEAM_TOOL_LABELS } from '@shared/team-tool-labels';
import ToolCallCard from '../ToolCallCard.vue';
import ToolOverlay from '../ToolOverlay.vue';
import LoadingSpinner from '../LoadingSpinner.vue';
import { IconCheck, IconBan } from '../icons';
import { i18n } from '@/i18n';

/**
 * What the card puts on screen for a tool the user is reading after the fact.
 *
 * The two glyphs are compared by their path data rather than by a class, because the card picks a
 * component and colours it separately: asserting only the colour would pass on a green-coloured check
 * and asserting only the component would pass on a red one.
 */

function pathOf(icon: { render?: unknown } | ((...args: never[]) => unknown)): string {
  const vnode = (icon as (props: object) => { children: { props: { d: string } }[] })({});
  const first = vnode.children[0];
  if (!first) throw new Error('icon rendered no path');
  return first.props.d;
}

const CHECK_PATH = pathOf(IconCheck);
const BAN_PATH = pathOf(IconBan);

function card(toolCall: ToolCall): VueWrapper {
  return mount(ToolCallCard, {
    props: { toolCall, source: 'session' },
    global: {
      plugins: [i18n],
      stubs: { LiveOutputPane: true, DiffView: true, MarkdownRenderer: true },
    },
  });
}

function headerPaths(wrapper: VueWrapper): string[] {
  return wrapper.findAll('svg path').map((p) => p.attributes('d') ?? '');
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
    expect(wrapper.html()).not.toContain('text-error');
    expect(wrapper.html()).not.toContain('text-success');
  });

  it('does not reuse the abandoned card copy', () => {
    expect(card(cancelled).text()).not.toContain('Not executed');
    expect(card({ ...cancelled, status: 'abandoned' }).text()).toContain('Not executed');
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
    expect(card(unrecorded).findComponent(LoadingSpinner).exists()).toBe(false);
  });

  it('renders the spinner for the pre-terminal status it must not be confused with', () => {
    // Pins the contrast: without this, a card that never renders a spinner at all would pass the case above.
    expect(card({ ...unrecorded, status: 'pending' }).findComponent(LoadingSpinner).exists()).toBe(true);
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
    expect(html).not.toContain('text-success');
    expect(html).not.toContain('text-error');
  });

  it('opens an overlay that shows the input instead of short-circuiting to a running body', () => {
    const wrapper = overlay(unrecorded);

    expect(wrapper.find('h2').text()).toBe('Bash');
    expect(wrapper.text()).toContain('Input');
    // The command rides into the stubbed code block as a prop, so the rendered text never holds it.
    expect(wrapper.html()).toContain('ls');
    expect(wrapper.text()).not.toContain('Tool is running');
    expect(wrapper.findComponent(LoadingSpinner).exists()).toBe(false);
  });

  it('badges the overlay as unrecorded rather than as running', () => {
    const text = overlay(unrecorded).text();

    expect(text).toContain('Outcome not recorded');
    expect(text).not.toContain('Running');
  });

  it('short-circuits the overlay for the pre-terminal status it must not be confused with', () => {
    // Pins the contrast: the overlay really does hide the input and badge "Running" for a live call.
    const wrapper = overlay({ ...unrecorded, status: 'pending' });

    expect(wrapper.text()).toContain('Tool is running');
    expect(wrapper.text()).not.toContain('Input');
    expect(wrapper.html()).not.toContain('ls');
  });
});

describe('team tool cards', () => {
  const names = Object.keys(TEAM_TOOL_LABELS);

  it('covers all nineteen team tools', () => {
    expect(names).toHaveLength(19);
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

    expect(wrapper.emitted('expand')).toEqual([['t-1']]);
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

      expect(wrapper.emitted('expand')).toEqual([['t-1']]);
    }
  });

  it('ignores a key that is neither Enter nor Space', async () => {
    const wrapper = card(expandable);
    await wrapper.get('[role="button"]').trigger('keydown', { key: 'a' });

    expect(wrapper.emitted('expand')).toBeUndefined();
  });

  it('offers no keyboard target for a card that does not expand', () => {
    const wrapper = card({ id: 't-1', name: 'SomeUnmappedTool', input: {}, status: 'completed' });

    expect(wrapper.find('[role="button"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('SomeUnmappedTool');
  });
});
