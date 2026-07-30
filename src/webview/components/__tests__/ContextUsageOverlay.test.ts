// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import ContextUsageOverlay from '../ContextUsageOverlay.vue';
import { useContextUsageStore } from '@/stores/useContextUsageStore';
import { i18n, applyLocale } from '@/i18n';
import type { ContextUsageData } from '@shared/types/session';

function make(overrides: Partial<ContextUsageData> = {}): ContextUsageData {
  return {
    model: 'test-model',
    totalTokens: 100,
    maxTokens: 1000,
    rawMaxTokens: 1000,
    percentage: 10,
    categories: [],
    memoryFiles: [],
    mcpTools: [],
    agents: [],
    apiUsage: null,
    ...overrides,
  };
}

function mountWithData(data: ContextUsageData) {
  const store = useContextUsageStore();
  store.openOverlay();
  store.handleDataLoaded(data);
  return mount(ContextUsageOverlay, { global: { plugins: [i18n] } });
}

/**
 * Row names for one collapsible section, in render order. Collapsed content is not in the DOM, so the
 * section is expanded first — the trigger toggles, so it is only clicked when currently closed, which
 * keeps repeat calls (e.g. re-reading after a locale change) idempotent.
 */
async function sectionNames(
  wrapper: ReturnType<typeof mountWithData>,
  label: string,
): Promise<string[]> {
  const trigger = wrapper.findAll('button').find(b => b.text().startsWith(label));
  if (!trigger) throw new Error(`section not found: ${label}`);
  if (trigger.attributes('aria-expanded') !== 'true') await trigger.trigger('click');
  const contentId = trigger.element.getAttribute('aria-controls');
  const content = wrapper.find(`#${contentId}`);
  return content.findAll(':scope > div > div').map(row => row.find('span').text());
}

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => applyLocale('en'));

describe('ContextUsageOverlay — detail section ordering', () => {
  it('sorts agents alphabetically regardless of registry discovery order', async () => {
    const wrapper = mountWithData(
      make({
        agents: [
          { agentType: 'zeta-agent', source: 'user', tokens: 10 },
          { agentType: 'alpha-agent', source: 'user', tokens: 20 },
          { agentType: 'mid-agent', source: 'project', tokens: 30 },
        ],
      }),
    );
    expect(await sectionNames(wrapper, 'Agents')).toEqual([
      'alpha-agent',
      'mid-agent',
      'zeta-agent',
    ]);
  });

  it('orders case-insensitively — the default UTF-16 sort would front-load every capitalized name', async () => {
    const wrapper = mountWithData(
      make({
        agents: [
          { agentType: 'banana', source: 'user', tokens: 1 },
          { agentType: 'Apple', source: 'user', tokens: 1 },
          { agentType: 'cherry', source: 'user', tokens: 1 },
          { agentType: 'Blueberry', source: 'user', tokens: 1 },
        ],
      }),
    );
    expect(await sectionNames(wrapper, 'Agents')).toEqual([
      'Apple',
      'banana',
      'Blueberry',
      'cherry',
    ]);
  });

  // Under sensitivity 'base' these compare equal, so sort() preserves input order and the rendered
  // order still tracks discovery — the exact instability this sort removes.
  it('breaks case-only ties deterministically rather than preserving input order', async () => {
    const rows = [
      { name: 'bash', callTokens: 1, resultTokens: 0 },
      { name: 'Bash', callTokens: 1, resultTokens: 0 },
    ];
    const breakdown = {
      toolCallTokens: 2,
      toolResultTokens: 0,
      attachmentTokens: 0,
      assistantMessageTokens: 0,
      userMessageTokens: 1,
      attachmentsByType: [],
    };

    const first = mountWithData(make({ messageBreakdown: { ...breakdown, toolCallsByType: rows } }));
    await sectionNames(first, 'Message Breakdown');
    const forward = await sectionNames(first, 'Tool Calls by Type');

    setActivePinia(createPinia());
    const second = mountWithData(
      make({ messageBreakdown: { ...breakdown, toolCallsByType: [...rows].reverse() } }),
    );
    await sectionNames(second, 'Message Breakdown');
    const reversed = await sectionNames(second, 'Tool Calls by Type');

    expect(forward).toEqual(reversed);
  });

  it('orders embedded numbers naturally, so step10 follows step9 rather than step1', async () => {
    const wrapper = mountWithData(
      make({
        agents: [
          { agentType: 'step10', source: 'user', tokens: 1 },
          { agentType: 'step9', source: 'user', tokens: 1 },
          { agentType: 'step1', source: 'user', tokens: 1 },
        ],
      }),
    );
    expect(await sectionNames(wrapper, 'Agents')).toEqual(['step1', 'step9', 'step10']);
  });

  it('sorts skills, whose rows come from a filesystem walk', async () => {
    const wrapper = mountWithData(
      make({
        skills: {
          totalSkills: 3,
          includedSkills: 3,
          tokens: 6,
          skillFrontmatter: [
            { name: 'xlsx', source: 'user', tokens: 2 },
            { name: 'algorithmic-art', source: 'user', tokens: 2 },
            { name: 'pdf', source: 'project', tokens: 2 },
          ],
        },
      }),
    );
    expect(await sectionNames(wrapper, 'Skills')).toEqual(['algorithmic-art', 'pdf', 'xlsx']);
  });

  it('sorts MCP tools, whose rows come from server registration order', async () => {
    const wrapper = mountWithData(
      make({
        mcpTools: [
          { name: 'zoom_out', serverName: 's1', tokens: 1 },
          { name: 'apply_edit', serverName: 's2', tokens: 1 },
        ],
      }),
    );
    expect(await sectionNames(wrapper, 'MCP Tools')).toEqual(['apply_edit', 'zoom_out']);
  });

  it('sorts tool-calls-by-type, which otherwise follows first-use order in the branch walk', async () => {
    const wrapper = mountWithData(
      make({
        messageBreakdown: {
          toolCallTokens: 3,
          toolResultTokens: 0,
          attachmentTokens: 0,
          assistantMessageTokens: 0,
          userMessageTokens: 1,
          toolCallsByType: [
            { name: 'Write', callTokens: 1, resultTokens: 0 },
            { name: 'Bash', callTokens: 1, resultTokens: 0 },
            { name: 'Read', callTokens: 1, resultTokens: 0 },
          ],
          attachmentsByType: [],
        },
      }),
    );
    await sectionNames(wrapper, 'Message Breakdown'); // nested — the parent must be open first
    expect(await sectionNames(wrapper, 'Tool Calls by Type')).toEqual(['Bash', 'Read', 'Write']);
  });

  // The detail sections remap their rows through .map() before sorting, so an in-place sort could not
  // reach store state through them. toolCallsByType/attachmentsByType are the arrays handed to
  // sortByName BY REFERENCE, so they are the only place a mutating sort is observable.
  it('does not mutate the store arrays it sorts by reference', async () => {
    const wrapper = mountWithData(
      make({
        messageBreakdown: {
          toolCallTokens: 2,
          toolResultTokens: 0,
          attachmentTokens: 2,
          assistantMessageTokens: 0,
          userMessageTokens: 1,
          toolCallsByType: [
            { name: 'Write', callTokens: 1, resultTokens: 0 },
            { name: 'Bash', callTokens: 1, resultTokens: 0 },
          ],
          attachmentsByType: [
            { name: 'image', tokens: 1 },
            { name: 'document', tokens: 1 },
          ],
        },
      }),
    );
    await sectionNames(wrapper, 'Message Breakdown');
    await sectionNames(wrapper, 'Tool Calls by Type');
    await sectionNames(wrapper, 'Attachments by Type');

    const mb = useContextUsageStore().data!.messageBreakdown!;
    expect(mb.toolCallsByType.map(t => t.name)).toEqual(['Write', 'Bash']);
    expect(mb.attachmentsByType.map(a => a.name)).toEqual(['image', 'document']);
  });

  // el sorts Greek ahead of Latin, en sorts it after — so this ordering flips only if the collator is
  // built from the live locale. A collator pinned to a constant locale passes the ASCII cases above.
  it('re-sorts against the active locale rather than a fixed one', async () => {
    const wrapper = mountWithData(
      make({
        agents: [
          { agentType: 'zebra', source: 'user', tokens: 1 },
          { agentType: 'άλφα', source: 'user', tokens: 1 },
          { agentType: 'apple', source: 'user', tokens: 1 },
        ],
      }),
    );
    expect(await sectionNames(wrapper, 'Agents')).toEqual(['apple', 'zebra', 'άλφα']);

    applyLocale('el');
    await nextTick();
    expect(await sectionNames(wrapper, 'Agents')).toEqual(['άλφα', 'apple', 'zebra']);
  });

  it('keeps the message-breakdown rows in their authored semantic order', async () => {
    const wrapper = mountWithData(
      make({
        messageBreakdown: {
          toolCallTokens: 4,
          toolResultTokens: 3,
          attachmentTokens: 5,
          assistantMessageTokens: 2,
          userMessageTokens: 1,
          toolCallsByType: [],
          attachmentsByType: [],
        },
      }),
    );
    expect((await sectionNames(wrapper, 'Message Breakdown')).slice(0, 5)).toEqual([
      'User Messages',
      'Assistant Messages',
      'Tool Calls',
      'Tool Results',
      'Attachments',
    ]);
  });
});
