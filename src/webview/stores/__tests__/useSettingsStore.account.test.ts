import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useSettingsStore } from '../useSettingsStore';
import type { AccountInfo } from '../../../shared/types/settings';

/**
 * Each `buildAccountInfo` payload is a whole snapshot, so the store has to replace rather than merge,
 * or a field the newer snapshot omits outlives the state that produced it.
 */
describe('useSettingsStore.setAccountInfo', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('drops a field the newer snapshot omits', () => {
    const store = useSettingsStore();
    const before: AccountInfo = { model: 'claude-opus-5-5', dollarBilled: false };
    const after: AccountInfo = { dollarBilled: true };

    store.setAccountInfo(before);
    store.setAccountInfo(after);

    expect(store.accountInfo).toEqual(after);
    expect(store.accountInfo?.model).toBeUndefined();
  });

  it('clears the account entirely on a null payload', () => {
    const store = useSettingsStore();
    store.setAccountInfo({ model: 'claude-opus-5-5', dollarBilled: false });
    store.setAccountInfo(null);
    expect(store.accountInfo).toBeNull();
  });
});
