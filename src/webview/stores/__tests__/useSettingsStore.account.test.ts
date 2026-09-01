import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useSettingsStore } from '../useSettingsStore';
import type { AccountInfo } from '../../../shared/types/settings';

/**
 * `buildAccountInfo` sets `subscriptionType` for a Claude model and `tokenSource` for an OpenAI or
 * custom-provider one, never both. Each payload is therefore a whole snapshot, and the store has to
 * replace rather than merge or the previous backend's field outlives the model that produced it.
 */
describe('useSettingsStore.setAccountInfo', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('drops the previous backend field when the model moves to another backend', () => {
    const store = useSettingsStore();
    const claude: AccountInfo = { model: 'claude-opus-5', subscriptionType: 'max', dollarBilled: false };
    const openai: AccountInfo = { model: 'gpt-5.6', tokenSource: 'openai-api-key', dollarBilled: true };

    store.setAccountInfo(claude);
    store.setAccountInfo(openai);

    expect(store.accountInfo).toEqual(openai);
    expect(store.accountInfo?.subscriptionType).toBeUndefined();
  });

  it('clears the account entirely on a null payload', () => {
    const store = useSettingsStore();
    store.setAccountInfo({ model: 'claude-opus-5', subscriptionType: 'max', dollarBilled: false });
    store.setAccountInfo(null);
    expect(store.accountInfo).toBeNull();
  });
});
