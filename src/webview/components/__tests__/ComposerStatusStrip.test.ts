// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { SessionStats as Stats } from '@shared/types/session';
import ComposerStatusStrip from '../composer/ComposerStatusStrip.vue';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useCompassStore } from '@/stores/useCompassStore';
import { useBackgroundTaskStore } from '@/stores/useBackgroundTaskStore';
import { useTeamStore } from '@/stores/useTeamStore';
import { i18n } from '@/i18n';

/**
 * The strip shows the conversation's cumulative totals, which the extension computes from pi's session
 * stats (live) or the session file (reload). The context meter keeps its own last-request snapshot.
 */

const api = (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }).acquireVsCodeApi();

function stats(over: Partial<Stats> = {}): Stats {
  return {
    totalInputTokens: 30,
    totalOutputTokens: 1_500,
    cacheReadTokens: 9_000,
    cacheCreationTokens: 970,
    costUsd: 0.75,
    numTurns: 3,
    contextInputTokens: 2,
    contextCacheReadTokens: 3_000,
    contextCacheWriteTokens: 100,
    contextWindowSize: 200_000,
    ...over,
  };
}

const mounted: VueWrapper[] = [];
let posted: unknown[] = [];

function mountStrip(s: Stats, dollarBilled = true): VueWrapper {
  useSettingsStore().setAccountInfo({ model: 'claude-opus-5-5', dollarBilled });
  const wrapper = mount(ComposerStatusStrip, { props: { stats: s }, attachTo: document.body, global: { plugins: [i18n] } });
  mounted.push(wrapper);
  return wrapper;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function openContextMenu(wrapper: VueWrapper): Promise<HTMLElement> {
  const trigger = wrapper.get('[data-testid="composer-context"]').element as HTMLElement;
  trigger.focus();
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await flush();
  const menu = document.body.querySelector<HTMLElement>('[data-testid="composer-context-menu"]');
  if (!menu) throw new Error('the context menu did not open');
  return menu;
}

beforeEach(() => {
  setActivePinia(createPinia());
  posted = [];
  vi.spyOn(api, 'postMessage').mockImplementation((message: unknown) => void posted.push(message));
});
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('ComposerStatusStrip', () => {
  it('shows the summed cost, all prompt tokens, output and the turn count', () => {
    const text = mountStrip(stats()).text();
    expect(text).toContain('$0.75');
    expect(text).toContain('10.0K');
    expect(text).toContain('1.5K');
    expect(text).toContain('3 turns');
    expect(text).toContain('90% cache');
  });

  it('keeps the context meter on the last-request snapshot', () => {
    expect(mountStrip(stats()).get('[data-testid="composer-context"]').text()).toBe('3.1K / 200.0K · 2%');
  });

  it('breaks the prompt tokens down in the tooltip', () => {
    const title = mountStrip(stats()).findAll('span').map((s) => s.attributes('title')).find((t) => t?.startsWith('Session tokens'));
    expect(title).toBe('Session tokens\nUncached input: 30\nCache read: 9,000\nCache write: 970\nOutput: 1,500');
  });

  it('marks a subscription session an estimate', () => {
    expect(mountStrip(stats(), false).text()).toContain('~$0.75 est.');
  });

  it('marks tokens with no recorded price unpriced instead of $0.00', () => {
    const wrapper = mountStrip(stats({ costUsd: 0 }));
    expect(wrapper.text()).toContain('unpriced');
    expect(wrapper.text()).not.toContain('$0.00');
    const title = wrapper.findAll('span').map((s) => s.attributes('title')).find((t) => t?.startsWith('Cost of'));
    expect(title).toContain('No price is recorded');
  });

  it('never rounds a hit rate short of 100% up to 100%', () => {
    expect(mountStrip(stats({ totalInputTokens: 5, cacheReadTokens: 995, cacheCreationTokens: 0 })).text()).toContain('99% cache');
  });

  it('shows billions of tokens with a B suffix', () => {
    expect(mountStrip(stats({ totalInputTokens: 0, cacheReadTokens: 1_234_500_000, cacheCreationTokens: 0 })).text()).toContain('1.2B');
  });

  it('hides the turn count and cache rate on a fresh session', () => {
    const text = mountStrip(stats({ totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, numTurns: 0 })).text();
    expect(text).not.toContain('turn');
    expect(text).not.toContain('cache');
    expect(text).toContain('$0.00');
  });

  it('opens the session log', async () => {
    const wrapper = mountStrip(stats());
    await wrapper.get('[data-testid="composer-open-log"]').trigger('click');
    expect(wrapper.emitted('openLog')).toHaveLength(1);
  });
});

describe('the strip on a narrow panel', () => {
  it('keeps turns, cost and the session log out of the group that clips, and the pills keep their names', () => {
    useCompassStore().updateStatus({ state: 'ready', fileCount: 12, nodeCount: 340, edgeCount: 900, communityCount: 4, flowCount: 0, lastIndexedAt: null });
    useBackgroundTaskStore().handleTaskStarted({ taskId: 'b1', toolUseId: 'u1', description: 'npm test', status: 'running' });
    useTeamStore().$patch({ teams: { t1: { teamId: 't1', status: 'running' } } });
    const wrapper = mountStrip(stats());

    const left = wrapper.get('[data-testid="composer-status-left"]');
    const right = wrapper.get('[data-testid="composer-status-right"]');
    expect(left.classes()).toContain('overflow-hidden');
    expect(right.classes()).toContain('shrink-0');
    expect(right.find('[data-testid="composer-open-log"]').exists()).toBe(true);
    expect(right.text()).toContain('$0.75');
    for (const pill of ['composer-compass', 'composer-background', 'composer-team']) {
      const found = left.get(`[data-testid="${pill}"]`);
      // Below the 720px fold a pill shows only its icon; its label stays as its accessible name.
      expect(found.find('[class*="@max-[43rem]:sr-only"]').text(), pill).not.toBe('');
    }
  });
});

describe('the context menu', () => {
  it('names the auto-compact threshold and offers details and compaction', async () => {
    const settings = useSettingsStore();
    settings.updateSettings({ ...settings.currentSettings, autoCompact: { enabled: true, triggerPercent: 80 } });
    const menu = await openContextMenu(mountStrip(stats()));

    expect(menu.textContent).toContain('Context usage · auto-compact at 80%');
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim())).toEqual(['View details', 'Compact now']);
  });

  it('opens the details overlay from View details', async () => {
    const wrapper = mountStrip(stats());
    const menu = await openContextMenu(wrapper);

    menu.querySelector<HTMLElement>('[data-action="details"]')!.click();
    await flush();

    expect(wrapper.emitted('openContextUsage')).toHaveLength(1);
    expect(posted).toEqual([]);
  });

  it('compacts through the /compact command', async () => {
    const menu = await openContextMenu(mountStrip(stats()));

    menu.querySelector<HTMLElement>('[data-action="compact"]')!.click();
    await flush();

    expect(posted).toEqual([{ type: 'sendMessage', content: '/compact' }]);
  });
});
