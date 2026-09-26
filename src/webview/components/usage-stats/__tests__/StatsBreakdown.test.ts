// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import StatsBreakdown from '../StatsBreakdown.vue';
import { i18n } from '@/i18n';
import { useUsageStatsStore } from '@/stores/useUsageStatsStore';
import type { WebviewToExtensionMessage } from '@shared/types/messages';
import type { UsageStatsAggregate, UsageStatsReport } from '@shared/types/usage-stats';

const posted = vi.hoisted((): WebviewToExtensionMessage[] => []);
vi.mock('@/composables/useVSCode', () => ({
  useVSCode: () => ({ postMessage: (m: WebviewToExtensionMessage) => posted.push(m) }),
}));

const ALPHA = 'c:\\work\\alpha';
const BETA = 'c:\\work\\beta';

function agg(cost: number, input: number, over: Partial<UsageStatsAggregate> = {}): UsageStatsAggregate {
  return { cost, input, output: 0, cacheRead: 0, cacheWrite: 0, unpricedTokens: 0, requests: 1, ...over };
}

// Sonnet costs most but uses the fewest tokens, so cost and token order disagree.
function report(): UsageStatsReport {
  return {
    range: { startMs: 0, endMs: 1 },
    totals: { cost: 10, input: 1_000, output: 0, cacheRead: 3_000, cacheWrite: 0, unpricedTokens: 500, netCacheSavings: 0, requests: 6, sessions: 2, activeDays: 1 },
    previousTotals: null,
    filterOptions: {
      models: [],
      projects: [{ key: ALPHA, cwd: 'C:\\Work\\alpha' }, { key: BETA, cwd: 'C:\\Work\\beta' }],
    },
    indexedAtMs: 1,
    byModel: [
      { key: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5', ...agg(7, 100, { cacheRead: 300 }) },
      { key: 'openai/gpt-5', label: 'GPT-5', ...agg(3, 400, { cacheRead: 2_700 }) },
      { key: 'local/llama', label: null, ...agg(0, 500, { unpricedTokens: 500 }) },
    ],
    byProject: [
      { key: ALPHA, cwd: 'C:\\Work\\alpha', ...agg(8, 300, { cacheRead: 1_000 }) },
      { key: BETA, cwd: 'C:\\Work\\beta', ...agg(2, 700, { cacheRead: 2_000, unpricedTokens: 500 }) },
    ],
    bySource: [
      { source: 'main', detail: null, ...agg(5, 400, { cacheRead: 3_000 }) },
      { source: 'subagent', detail: 'Explore', ...agg(3, 100) },
      { source: 'subagent', detail: 'Plan', ...agg(1, 50) },
      { source: 'background', detail: 'session-title', ...agg(1, 450, { unpricedTokens: 500 }) },
    ],
  };
}

function mountBreakdown(metric: 'cost' | 'tokens' = 'cost') {
  return mount(StatsBreakdown, {
    props: { report: report(), metric },
    global: { plugins: [i18n] },
    attachTo: document.body,
  });
}

type Wrapper = ReturnType<typeof mountBreakdown>;

function section(wrapper: Wrapper, id: string) {
  return wrapper.get(`[data-breakdown="${id}"]`);
}

// Project keys hold backslashes, which a CSS attribute selector would need escaped.
function row(wrapper: Wrapper, sectionId: string, rowId: string) {
  const found = section(wrapper, sectionId).findAll('tbody tr').find((r) => r.attributes('data-row') === rowId);
  if (!found) throw new Error(`no row ${rowId}`);
  return found;
}

function rowIds(wrapper: Wrapper, id: string): string[] {
  return section(wrapper, id).findAll('tbody tr').map((r) => r.attributes('data-row')!);
}

beforeEach(() => {
  posted.length = 0;
  setActivePinia(createPinia());
  document.body.innerHTML = '';
});

describe('StatsBreakdown', () => {
  it('sorts by the metric by default and re-sorts from the column headers', async () => {
    const wrapper = mountBreakdown();
    expect(rowIds(wrapper, 'model')).toEqual(['model:anthropic/claude-sonnet-4-5', 'model:openai/gpt-5', 'model:local/llama']);
    expect(section(wrapper, 'model').get('th[aria-sort="descending"]').text()).toContain('Cost');

    await section(wrapper, 'model').get('[data-sort="tokens"]').trigger('click');
    expect(rowIds(wrapper, 'model')).toEqual(['model:openai/gpt-5', 'model:local/llama', 'model:anthropic/claude-sonnet-4-5']);
    expect(section(wrapper, 'model').get('th[aria-sort="descending"]').text()).toContain('Tokens');

    await section(wrapper, 'model').get('[data-sort="tokens"]').trigger('click');
    expect(rowIds(wrapper, 'model')).toEqual(['model:anthropic/claude-sonnet-4-5', 'model:local/llama', 'model:openai/gpt-5']);
    expect(section(wrapper, 'model').get('th[aria-sort="ascending"]').text()).toContain('Tokens');

    await section(wrapper, 'model').get('[data-sort="name"]').trigger('click');
    expect(rowIds(wrapper, 'model')).toEqual(['model:anthropic/claude-sonnet-4-5', 'model:openai/gpt-5', 'model:local/llama']);

    // Sorting one table leaves the others alone.
    expect(rowIds(wrapper, 'project')).toEqual([`project:${ALPHA}`, `project:${BETA}`]);
  });

  it('sorts by cache hit rate', async () => {
    const wrapper = mountBreakdown();
    await section(wrapper, 'model').get('[data-sort="cache"]').trigger('click');
    // 2700/3100, 300/400, then llama with no cache reads.
    expect(rowIds(wrapper, 'model')).toEqual(['model:openai/gpt-5', 'model:anthropic/claude-sonnet-4-5', 'model:local/llama']);
  });

  it('sorts a row with no prompt tokens to rate below every rate in both directions', async () => {
    const byModel = [
      ...report().byModel!,
      { key: 'openai/gpt-image', label: 'GPT Image', ...agg(1, 0, { output: 900 }) },
    ];
    const wrapper = mount(StatsBreakdown, { props: { report: { ...report(), byModel }, metric: 'cost' }, global: { plugins: [i18n] } });
    expect(row(wrapper, 'model', 'model:openai/gpt-image').text()).toContain('n/a');

    await section(wrapper, 'model').get('[data-sort="cache"]').trigger('click');
    expect(rowIds(wrapper, 'model')).toEqual(['model:openai/gpt-5', 'model:anthropic/claude-sonnet-4-5', 'model:local/llama', 'model:openai/gpt-image']);

    await section(wrapper, 'model').get('[data-sort="cache"]').trigger('click');
    expect(section(wrapper, 'model').get('th[aria-sort="ascending"]').text()).toContain('Cache hit');
    expect(rowIds(wrapper, 'model')).toEqual(['model:local/llama', 'model:anthropic/claude-sonnet-4-5', 'model:openai/gpt-5', 'model:openai/gpt-image']);
  });

  it('shows shares of the chosen metric', () => {
    const cost = mountBreakdown('cost');
    expect(section(cost, 'model').get('[data-row="model:anthropic/claude-sonnet-4-5"]').text()).toContain('70%');
    const tokens = mountBreakdown('tokens');
    // Sonnet: 400 of 4,000 tokens; the tokens metric also sorts by tokens.
    expect(section(tokens, 'model').get('[data-row="model:anthropic/claude-sonnet-4-5"]').text()).toContain('10%');
    expect(rowIds(tokens, 'model')[0]).toBe('model:openai/gpt-5');
  });

  it('marks rows with unpriced tokens', () => {
    const wrapper = mountBreakdown();
    const badged = (id: string) => section(wrapper, id).findAll('tbody tr').filter((r) => r.find('[data-unpriced]').exists()).map((r) => r.attributes('data-row'));
    expect(badged('model')).toEqual(['model:local/llama']);
    expect(badged('project')).toEqual([`project:${BETA}`]);
    expect(badged('source')).toEqual(['source:background']);
    expect(section(wrapper, 'model').get('[data-unpriced]').attributes('title')).toBe('500 tokens have no recorded price and are not counted in the cost');
  });

  it('reads a wholly unpriced row as unpriced rather than $0.00, and a partly priced one as its cost', () => {
    const wrapper = mountBreakdown();
    const llamaCost = section(wrapper, 'model').get('[data-row="model:local/llama"] [data-cost]');
    expect(llamaCost.text()).toBe('unpriced');
    expect(llamaCost.attributes('title')).toContain('It is not $0.');
    expect(section(wrapper, 'model').get('[data-row="model:local/llama"]').text()).not.toContain('$0.00');

    // Beta holds priced spend as well as unpriced tokens, so its cost stands, with the badge beside it.
    expect(row(wrapper, 'project', `project:${BETA}`).get('[data-cost]').text()).toBe('$2.00');
  });

  it('names a single unpriced token in the singular', () => {
    const wrapper = mount(StatsBreakdown, {
      props: { report: { ...report(), byModel: [{ key: 'local/llama', label: null, ...agg(0, 1, { unpricedTokens: 1 }) }] }, metric: 'cost' },
      global: { plugins: [i18n] },
    });
    expect(section(wrapper, 'model').get('[data-unpriced]').attributes('title')).toBe('1 token has no recorded price and is not counted in the cost');
  });

  it('expands a source into its details; the main chat has none', async () => {
    const wrapper = mountBreakdown();
    const source = section(wrapper, 'source');
    expect(rowIds(wrapper, 'source')).toEqual(['source:main', 'source:subagent', 'source:background']);
    expect(source.get('[data-row="source:main"]').find('[data-expand]').exists()).toBe(false);
    expect(source.get('[data-row="source:subagent"]').text()).toContain('Subagents');
    expect(source.get('[data-row="source:subagent"]').text()).toContain('$4.00');
    expect(source.findAll('[data-source-detail]')).toHaveLength(0);

    const toggle = source.get('[data-row="source:subagent"] [data-expand]');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    await toggle.trigger('click');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(source.findAll('[data-source-detail]').map((r) => r.text())).toEqual([
      expect.stringContaining('Explore'),
      expect.stringContaining('Plan'),
    ]);

    await source.get('[data-row="source:background"] [data-expand]').trigger('click');
    expect(source.get('[data-row="source:background:session-title"]').text()).toContain('Conversation titles');

    await toggle.trigger('click');
    expect(source.find('[data-row="source:subagent:Explore"]').exists()).toBe(false);
    // Expanding sends no request.
    expect(posted).toHaveLength(0);
  });

  it('labels a background sub-call with no recorded purpose instead of showing the raw sentinel', async () => {
    const bySource = [...report().bySource!, { source: 'background' as const, detail: 'unknown', ...agg(1, 10) }];
    const wrapper = mount(StatsBreakdown, { props: { report: { ...report(), bySource }, metric: 'cost' }, global: { plugins: [i18n] } });
    await section(wrapper, 'source').get('[data-row="source:background"] [data-expand]').trigger('click');
    expect(section(wrapper, 'source').get('[data-row="source:background:unknown"]').text()).toContain('Not recorded');
  });

  it('drills into a clicked project through the store filter and shows a removable chip', async () => {
    const wrapper = mountBreakdown();
    const store = useUsageStatsStore();
    expect(wrapper.find('[data-project-chip]').exists()).toBe(false);

    await row(wrapper, 'project', `project:${BETA}`).trigger('click');
    await nextTick();
    expect(store.projectKeys).toEqual([BETA]);
    const msg = posted[posted.length - 1];
    expect(msg?.type === 'requestUsageStats' && msg.query.projectKeys).toEqual([BETA]);

    const chip = wrapper.get('[data-project-chip]');
    expect(chip.text()).toContain('beta');
    expect(chip.attributes('title')).toBe('C:\\Work\\beta');

    // Clicking the project already drilled into sends nothing new.
    const sent = posted.length;
    await row(wrapper, 'project', `project:${BETA}`).trigger('click');
    expect(posted).toHaveLength(sent);

    await chip.get('button[aria-label="Remove the beta filter"]').trigger('click');
    await nextTick();
    expect(store.projectKeys).toEqual([]);
    expect(wrapper.find('[data-project-chip]').exists()).toBe(false);
  });

  it('ignores clicks on rows that are not projects', async () => {
    const wrapper = mountBreakdown();
    await section(wrapper, 'model').get('[data-row="model:openai/gpt-5"]').trigger('click');
    expect(posted).toHaveLength(0);
  });

  it('names each table with a caption', () => {
    const wrapper = mountBreakdown();
    expect(section(wrapper, 'model').get('caption').text()).toBe('By model');
    expect(section(wrapper, 'project').get('caption').text()).toBe('By project');
    expect(section(wrapper, 'source').get('caption').text()).toBe('By source');
  });
});
