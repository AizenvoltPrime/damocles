// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import BtwAsideBubble from '../BtwAsideBubble.vue';
import { useBtwStore } from '@/stores/useBtwStore';
import { createBtwHandlers } from '@/composables/message-handler/handlers/btw-handlers';
import { defined } from '@/__tests__/helpers';
import { nextTick } from 'vue';
import { applyLocale, i18n } from '@/i18n';
import { inGreek } from '../../../__mocks__/greek-locale';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import type { HandlerContext } from '@/composables/message-handler/types';

vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({ postMessage: () => {}, onMessage: () => () => {}, getState: () => undefined, setState: () => {} }),
}));

const mounted: VueWrapper[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
});
beforeEach(() => setActivePinia(createPinia()));

/** The aside after core's `btwError`, through the real handler and store. */
function failedAside(msg: Omit<Extract<ExtensionToWebviewMessage, { type: 'btwError' }>, 'type' | 'btwId'>): VueWrapper {
  const store = useBtwStore();
  store.addAside('b1', 'what is this?');
  defined(createBtwHandlers().btwError, 'btwError handler')({ type: 'btwError', btwId: 'b1', ...msg }, {} as HandlerContext);
  const wrapper = mount(BtwAsideBubble, { props: { aside: store.aside! }, global: { plugins: [i18n] }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}

describe('BtwAsideBubble, an aside that failed', () => {
  it("shows a credential failure as the transcript's notice for that account, keeping pi's text out", () => {
    const raw = 'No API key found for deepseek.\n\nUse /login to log into a provider via OAuth or API key. See:\n  /x/providers.md\n  /x/models.md';
    failedAside({ message: { message: raw }, authFailure: { account: 'deepseek', reason: 'missing' } });

    expect(document.body.textContent).toContain('No DeepSeek credential is saved. Add one in settings to continue.');
    expect(document.body.textContent).not.toContain('/login');
  });

  it("keeps a refused credential's provider text behind the notice's Details", async () => {
    const raw = '401 {"error":{"message":"Authentication Fails, Your api key: ****0000 is invalid"}}';
    const wrapper = failedAside({ message: { message: raw }, authFailure: { account: 'deepseek', reason: 'rejected' } });

    expect(document.body.textContent).toContain('DeepSeek authentication required');
    expect(document.body.textContent).not.toContain('Authentication Fails');
    await wrapper.find('[data-testid="auth-failure-notice-details-toggle"]').trigger('click');
    expect(wrapper.find('[data-testid="auth-failure-notice-details"]').text()).toBe(raw);
  });

  it('shows any other failure as its text', () => {
    failedAside({ message: { message: 'socket hang up' } });

    expect(document.body.textContent).toContain('socket hang up');
  });

  it('announces the failure politely, a notice or plain text alike', () => {
    const notice = failedAside({ message: { message: 'Provider is not configured: deepseek' }, authFailure: { account: 'deepseek', reason: 'missing' } });
    expect(notice.find('[data-testid="btw-error"]').attributes('role')).toBe('status');
    expect(notice.find('[data-testid="btw-error"]').text()).toContain('No DeepSeek credential is saved.');
    notice.unmount();
    mounted.pop();

    const plain = failedAside({ message: { message: 'socket hang up' } });
    expect(plain.find('[data-testid="btw-error"]').attributes('role')).toBe('status');
    expect(plain.find('[data-testid="btw-error"]').text()).toBe('socket hang up');
  });
});

describe('BtwAsideBubble after a language switch', () => {
  afterEach(() => applyLocale('en'));

  it("renders core's failure text in the new language", async () => {
    const coreText = { message: 'Could not open file: {0}', args: ['aside.md'] };
    const wrapper = failedAside({ message: coreText });
    expect(wrapper.get('[data-testid="btw-error"]').text()).toContain('Could not open file: aside.md');

    await applyLocale('el');
    await nextTick();
    expect(wrapper.get('[data-testid="btw-error"]').text()).toContain(inGreek(coreText));
  });
});
