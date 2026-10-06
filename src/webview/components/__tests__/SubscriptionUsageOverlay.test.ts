// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import SubscriptionUsageOverlay from '../SubscriptionUsageOverlay.vue';
import { useSubscriptionUsageStore } from '@/stores/useSubscriptionUsageStore';
import { i18n } from '@/i18n';
import type { ClaudeAccountProfile, SubscriptionUsageData } from '@shared/types/usage';
import type { WebviewToExtensionMessage } from '@shared/types/messages';

const posted: WebviewToExtensionMessage[] = [];
vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({
    postMessage: (m: WebviewToExtensionMessage) => posted.push(m),
    onMessage: () => () => {},
    getState: () => undefined,
    setState: () => {},
  }),
}));

const EMAIL = 'person@example.com';
const ORG = "person@example.com's Organization";

const PROFILE: ClaudeAccountProfile = {
  organizationType: 'claude_max',
  rateLimitTier: 'default_claude_max_20x',
  seatTier: null,
  subscriptionStatus: 'active',
  hasExtraUsageEnabled: false,
  email: EMAIL,
  organizationName: ORG,
};

function mountWith(claude: SubscriptionUsageData['claude']) {
  const store = useSubscriptionUsageStore();
  store.openOverlay();
  store.handleDataLoaded({ claude, gpt: { status: 'not-connected', bars: [] }, fetchedAt: Date.now() });
  return mount(SubscriptionUsageOverlay, { global: { plugins: [i18n] } });
}

function mountWithGpt(gpt: SubscriptionUsageData['gpt']) {
  const store = useSubscriptionUsageStore();
  store.openOverlay();
  store.handleDataLoaded({ claude: { status: 'not-connected', bars: [] }, gpt, fetchedAt: Date.now() });
  return mount(SubscriptionUsageOverlay, { global: { plugins: [i18n] } });
}

beforeEach(() => {
  posted.length = 0;
  setActivePinia(createPinia());
});

describe('SubscriptionUsageOverlay account profile', () => {
  it('shows the plan and tiers in readable form and masks the identifying fields', async () => {
    const wrapper = mountWith({ status: 'ok', bars: [], profile: PROFILE });
    await nextTick();

    const account = wrapper.get('[data-testid="claude-account"]');
    expect(account.text()).toContain('Max');
    expect(account.text()).toContain('Max 20x');
    expect(account.text()).toContain('Active');
    expect(account.text()).toContain('Off');
    expect(account.text()).not.toContain('Seat tier');
    expect(account.text()).not.toContain(EMAIL);
    expect(account.text()).not.toContain(ORG);
  });

  it('reveals one identifying field per click, through a named button', async () => {
    const wrapper = mountWith({ status: 'ok', bars: [], profile: PROFILE });
    await nextTick();

    const showEmail = wrapper.get('button[aria-label="Show Email"]');
    await showEmail.trigger('click');

    const account = wrapper.get('[data-testid="claude-account"]');
    expect(account.text()).toContain(EMAIL);
    expect(account.text()).not.toContain(ORG);
    expect(wrapper.find('button[aria-label="Show Email"]').exists()).toBe(false);
    expect(wrapper.find('button[aria-label="Show Organization"]').exists()).toBe(true);
  });

  it('masks again after the overlay is closed and reopened', async () => {
    const first = mountWith({ status: 'ok', bars: [], profile: PROFILE });
    await nextTick();
    await first.get('button[aria-label="Show Email"]').trigger('click');
    expect(first.text()).toContain(EMAIL);
    first.unmount();

    const reopened = mountWith({ status: 'ok', bars: [], profile: PROFILE });
    await nextTick();
    expect(reopened.text()).not.toContain(EMAIL);
  });

  it('keeps the usage bars and notes the missing details when the profile failed', async () => {
    const wrapper = mountWith({
      status: 'ok',
      bars: [{ id: 'five_hour', utilization: 40, resetsAt: null }],
      profileError: 'HTTP 500',
    });
    await nextTick();

    expect(wrapper.find('[data-testid="claude-account"]').exists()).toBe(false);
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("Couldn't load account details");
  });
});

describe('SubscriptionUsageOverlay reset captions', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a reset later today on the 24-hour clock and a later one with its weekday', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2025, 11, 31, 1, 0));
    const wrapper = mountWith({
      status: 'ok',
      bars: [
        { id: 'five_hour', utilization: 32, resetsAt: new Date(2025, 11, 31, 6, 10).getTime() },
        { id: 'seven_day', utilization: 82, resetsAt: new Date(2026, 0, 3, 5, 0).getTime() },
      ],
    });
    await nextTick();

    expect(wrapper.text()).toContain('Resets at 06:10');
    expect(wrapper.text()).toContain('Resets Saturday 05:00');
  });
});

describe('SubscriptionUsageOverlay ChatGPT usage link', () => {
  const USAGE_URL = 'https://chatgpt.com/settings/usage';

  it('links to the usage page through openExternalUrl when there are no bars', async () => {
    const wrapper = mountWithGpt({ status: 'ok', bars: [], usageUrl: USAGE_URL });
    await nextTick();

    const link = wrapper.get('[data-testid="gpt-usage-link"]');
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(false);
    const button = link.get('button');
    expect(button.text()).toBe('View usage on chatgpt.com');

    await button.trigger('click');
    expect(posted).toEqual([{ type: 'openExternalUrl', url: USAGE_URL }]);
  });

  it('shows the bars and no link when the usage endpoint answered', async () => {
    const wrapper = mountWithGpt({
      status: 'ok',
      bars: [{ id: 'codex_primary', utilization: 30, resetsAt: null, windowSeconds: 18_000 }],
    });
    await nextTick();

    expect(wrapper.find('[data-testid="gpt-usage-link"]').exists()).toBe(false);
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(true);
  });
});
