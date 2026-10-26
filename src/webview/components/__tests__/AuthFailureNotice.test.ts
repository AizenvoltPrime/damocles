// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import AuthFailureNotice from '../AuthFailureNotice.vue';
import AuthFailureBanner from '../AuthFailureBanner.vue';
import VirtualItemWrapper from '../VirtualItemWrapper.vue';
import type { AuthFailure } from '@/stores/useUIStore';
import type { VirtualItem } from '@/composables/useVirtualizedMessages';
import type { ChatMessage } from '@shared/types/session';
import { i18n, applyLocale } from '@/i18n';

vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({ postMessage: () => {}, onMessage: () => () => {}, getState: () => undefined, setState: () => {} }),
}));

const RAW = '401 {"error":{"message":"Authentication Fails, Your api key: ****0000 is invalid","type":"authentication_error"}}';

const mounted: VueWrapper[] = [];
function track<T extends VueWrapper>(wrapper: T): T {
  mounted.push(wrapper);
  return wrapper;
}

function mountNotice(failure: AuthFailure, details = RAW) {
  return track(mount(AuthFailureNotice, { props: { failure, details }, global: { plugins: [i18n] }, attachTo: document.body }));
}

const toggle = (wrapper: VueWrapper) => wrapper.find('[data-testid="auth-failure-notice-details-toggle"]');
const details = (wrapper: VueWrapper) => wrapper.find('[data-testid="auth-failure-notice-details"]');

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  applyLocale('en');
});

describe('AuthFailureNotice, a replayed credential refusal', () => {
  it('shows the live card\'s provider-named title and message, with no settings action', () => {
    const failure: AuthFailure = { account: 'deepseek', reason: 'rejected' };
    const notice = mountNotice(failure);
    const banner = track(mount(AuthFailureBanner, { props: { failure }, global: { plugins: [i18n] } }));

    expect(notice.find('section').attributes('aria-label')).toBe('DeepSeek authentication required');
    expect(notice.find('[data-testid="auth-failure-notice-message"]').text()).toBe(banner.find('[data-testid="auth-banner-message"]').text());
    expect(notice.text()).not.toContain('Open settings');
    expect(notice.findAll('button').map((b) => b.text())).toEqual(['Details']);
  });

  it('keeps the provider text behind Details', async () => {
    const notice = mountNotice({ account: 'deepseek', reason: 'rejected' });
    expect(details(notice).exists()).toBe(false);
    expect(notice.text()).not.toContain('Authentication Fails');

    await toggle(notice).trigger('click');
    expect(details(notice).text()).toBe(RAW);
    expect(toggle(notice).attributes('aria-expanded')).toBe('true');
  });

  it('describes Details by the notice title, so a screen reader says whose details they are', () => {
    const notice = mountNotice({ account: 'deepseek', reason: 'rejected' });
    const describedBy = toggle(notice).attributes('aria-describedby');

    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy ?? '')?.textContent).toBe('DeepSeek authentication required');
  });

  it('sizes the chevron through the button, whose own svg size rule beats a class on the icon', () => {
    expect(toggle(mountNotice({ account: 'deepseek', reason: 'rejected' })).classes()).toContain('[&_svg]:size-3');
  });

  it('replays a missing credential with the live card\'s message and no Details, since its text is pi\'s, not the provider\'s', () => {
    const failure: AuthFailure = { account: 'deepseek', reason: 'missing' };
    const notice = mountNotice(failure, 'Provider is not configured: deepseek');
    const banner = track(mount(AuthFailureBanner, { props: { failure }, global: { plugins: [i18n] } }));

    expect(notice.find('[data-testid="auth-failure-notice-message"]').text()).toBe('No DeepSeek credential is saved. Add one in settings to continue.');
    expect(notice.find('[data-testid="auth-failure-notice-message"]').text()).toBe(banner.find('[data-testid="auth-banner-message"]').text());
    expect(toggle(notice).exists()).toBe(false);
    expect(notice.text()).not.toContain('not configured');
  });

  it('is localized', () => {
    applyLocale('el');
    expect(mountNotice({ account: 'deepseek', reason: 'missing' }).find('[data-testid="auth-failure-notice-message"]').text()).toBe(
      'Δεν υπάρχει αποθηκευμένο διαπιστευτήριο για το DeepSeek. Προσθέστε ένα στις ρυθμίσεις για να συνεχίσετε.',
    );
    const notice = mountNotice({ account: 'xai', reason: 'noApiAccess' });
    expect(notice.find('section').attributes('aria-label')).toBe('Απαιτείται σύνδεση στο xAI');
    expect(toggle(notice).text()).toBe('Λεπτομέρειες');
  });
});

describe('a replayed error row', () => {
  function row(message: Partial<ChatMessage>): VueWrapper {
    const chat: ChatMessage = { id: 'e1', role: 'error', content: RAW, timestamp: 0, isReplay: true, ...message };
    const item: VirtualItem = { id: 'error-e1', type: 'error-message', message: chat, originalMessageIndex: 0, sourceMessageId: 'e1', spacingLevel: 0, text: chat.content };
    return track(mount(VirtualItemWrapper, { props: { item, top: 0, arriving: false, canRewind: false, promptIndex: 0 }, global: { plugins: [i18n] } }));
  }

  it('renders a credential refusal as its account\'s notice, and any other failure as the plain error', async () => {
    const refused = row({ authFailure: { account: 'deepseek', reason: 'rejected' } });
    expect(refused.findComponent(AuthFailureNotice).exists()).toBe(true);
    expect(refused.text()).toContain('DeepSeek authentication required');
    expect(refused.text()).not.toContain('Authentication Fails');
    await toggle(refused).trigger('click');
    expect(details(refused).text()).toBe(RAW);

    const plain = row({});
    expect(plain.findComponent(AuthFailureNotice).exists()).toBe(false);
    expect(plain.text()).toContain('Authentication Fails');
  });
});
