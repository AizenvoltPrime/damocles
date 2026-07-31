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

/**
 * Slice 4 §4.2: the deferred category is a *saving*, not a spend. It must never be drawn in the
 * stacked bar (which is a picture of consumed context whose segments sum to the headline total), yet
 * must stay in the breakdown legend so the saving is visible — rendered visually distinct so it
 * cannot be misread as consumed. These assertions read the RENDERED DOM rather than the computed
 * properties: a shape assertion on `visibleCategories` still passes if the bar's `v-for` is later
 * repointed at `allCategories`, which is exactly the regression this suite exists to catch.
 */

/** The stacked overview bar element, or null when the component renders no bar at all. */
function bar(wrapper: ReturnType<typeof mountWithData>) {
  const el = wrapper.find('.flex.h-2\\.5');
  return el.exists() ? el : null;
}

/** `title` of every rendered bar segment — the segment's identity as the user sees it on hover. */
function barSegmentTitles(wrapper: ReturnType<typeof mountWithData>): string[] {
  return bar(wrapper)?.findAll(':scope > div').map(s => s.attributes('title') ?? '') ?? [];
}

/** Inline `width: N%` of every rendered bar segment, as numbers. */
function barSegmentWidths(wrapper: ReturnType<typeof mountWithData>): number[] {
  return (
    bar(wrapper)
      ?.findAll(':scope > div')
      .map(s => Number(/width:\s*([\d.]+)%/.exec(s.attributes('style') ?? '')?.[1] ?? NaN)) ?? []
  );
}

/** Breakdown-legend rows in render order, with the fields a reader actually sees. */
function legendRows(wrapper: ReturnType<typeof mountWithData>) {
  return wrapper.findAll('.space-y-1\\.5 > .flex.items-center.gap-2.text-xs').map(row => ({
    name: row.find('span').text(),
    muted: row.classes().includes('opacity-60'),
    text: row.text(),
  }));
}

// maxTokens 1000 / totalTokens 300 with the three consumed categories summing to exactly 300, and a
// deliberately huge 4000-token deferred row: if the bar filter regresses, the segment widths sum to
// 430% instead of 30% and the bar overflows its track — a loud failure, not a rounding-sized diff.
const DEFERRED_FIXTURE = {
  totalTokens: 300,
  maxTokens: 1000,
  percentage: 30,
  categories: [
    { name: 'System prompt', tokens: 100, color: '#a78bfa' },
    { name: 'MCP tools', tokens: 50, color: '#fbbf24' },
    { name: 'Tools', tokens: 150, color: '#f472b6' },
    { name: 'Tools (deferred)', tokens: 4000, color: '#94a3b8', isDeferred: true },
  ],
};

describe('ContextUsageOverlay — deferred categories are a saving, never a spend', () => {
  it('draws no stacked-bar segment for the deferred category', () => {
    const wrapper = mountWithData(make(DEFERRED_FIXTURE));
    const titles = barSegmentTitles(wrapper);
    expect(titles).toEqual(['System prompt: 100', 'MCP tools: 50', 'Tools: 150']);
    expect(titles.some(t => t.includes('Tools (deferred)'))).toBe(false);
    expect(bar(wrapper)!.html()).not.toContain('#94a3b8');
  });

  it('keeps the deferred category in the breakdown legend so the saving stays visible', () => {
    const wrapper = mountWithData(make(DEFERRED_FIXTURE));
    const rows = legendRows(wrapper);
    expect(rows.map(r => r.name)).toEqual([
      'System prompt',
      'MCP tools',
      'Tools',
      'Tools (deferred)',
    ]);
    expect(rows[3].text).toContain('4.0k');
  });

  it('keeps the bar reconciled with the headline total despite the deferred row', () => {
    const wrapper = mountWithData(make(DEFERRED_FIXTURE));
    const widths = barSegmentWidths(wrapper);
    expect(widths).toEqual([10, 5, 15]);
    // 300/1000 → the bar fills exactly the headline percentage; a leaked deferred row would make 430.
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(30, 5);
  });

  it('renders the deferred legend row muted and labelled not-consumed', () => {
    const wrapper = mountWithData(make(DEFERRED_FIXTURE));
    const deferredRow = legendRows(wrapper).find(r => r.name === 'Tools (deferred)')!;
    expect(deferredRow.muted).toBe(true);
    expect(deferredRow.text).toContain('Deferred');
  });

  // Presence-only assertions above would pass against a deferred row rendered identically to a
  // consumed one — the exact lie §4.2 exists to prevent. So pin the control case too.
  it('leaves consumed legend rows unmuted and unlabelled', () => {
    const wrapper = mountWithData(make(DEFERRED_FIXTURE));
    for (const row of legendRows(wrapper).filter(r => r.name !== 'Tools (deferred)')) {
      expect(row.muted).toBe(false);
      expect(row.text).not.toContain('Deferred');
    }
  });

  it('renders no bar at all when every non-zero category is deferred, rather than an empty track', () => {
    const wrapper = mountWithData(
      make({
        totalTokens: 0,
        maxTokens: 1000,
        percentage: 0,
        categories: [
          { name: 'Tools', tokens: 0, color: '#f472b6' },
          { name: 'Tools (deferred)', tokens: 4000, color: '#94a3b8', isDeferred: true },
        ],
      }),
    );
    expect(bar(wrapper)).toBeNull();
    expect(legendRows(wrapper).map(r => r.name)).toEqual(['Tools', 'Tools (deferred)']);
  });
});

describe('ContextUsageOverlay — deferred built-in tool badges', () => {
  const withDeferredTools = (rows: { name: string; tokens: number; isLoaded: boolean }[]) =>
    mountWithData(make({ deferredBuiltinTools: rows }));

  /** Rendered rows of one detail section as `name` + the row's full visible text (badge included). */
  async function sectionRows(wrapper: ReturnType<typeof mountWithData>, label: string) {
    const trigger = wrapper.findAll('button').find(b => b.text().startsWith(label));
    if (!trigger) throw new Error(`section not found: ${label}`);
    if (trigger.attributes('aria-expanded') !== 'true') await trigger.trigger('click');
    const content = wrapper.find(`#${trigger.element.getAttribute('aria-controls')}`);
    return content.findAll(':scope > div > div').map(row => ({
      name: row.find('span').text(),
      text: row.text(),
    }));
  }

  // The badge FLIP is the slice's demoable acceptance criterion, so assert the rendered TEXT: a
  // props-level check would pass even if the template dropped the badge entirely.
  it('badges an unloaded row "Deferred" and a loaded row "Loaded"', async () => {
    const wrapper = withDeferredTools([
      { name: 'BrowserOpen', tokens: 7, isLoaded: false },
      { name: 'CompassSearch', tokens: 10, isLoaded: true },
    ]);
    const rows = await sectionRows(wrapper, 'Deferred Built-in Tools');
    expect(rows.map(r => r.name)).toEqual(['BrowserOpen', 'CompassSearch']);
    expect(rows[0].text).toContain('Deferred');
    expect(rows[0].text).not.toContain('Loaded');
    expect(rows[1].text).toContain('Loaded');
  });

  it('flips the same row from Deferred to Loaded when activation lands', async () => {
    const before = withDeferredTools([{ name: 'BrowserOpen', tokens: 7, isLoaded: false }]);
    expect((await sectionRows(before, 'Deferred Built-in Tools'))[0].text).toContain('Deferred');

    setActivePinia(createPinia());
    const after = withDeferredTools([{ name: 'BrowserOpen', tokens: 7, isLoaded: true }]);
    const row = (await sectionRows(after, 'Deferred Built-in Tools'))[0];
    expect(row.text).toContain('Loaded');
    expect(row.text).not.toContain('Deferred');
  });

  it('renders system tools with their per-tool token cost', async () => {
    const wrapper = mountWithData(
      make({
        systemTools: [
          { name: 'Write', tokens: 12 },
          { name: 'Read', tokens: 8 },
        ],
      }),
    );
    const rows = await sectionRows(wrapper, 'System Tools');
    expect(rows.map(r => r.name)).toEqual(['Read', 'Write']);
    expect(rows[0].text).toContain('8');
    expect(rows[1].text).toContain('12');
  });
});
