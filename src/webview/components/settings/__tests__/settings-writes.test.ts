import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useSettingWritesStore } from '../settings-writes';

const saved = (key: string) => ({ type: 'settingWriteResult', key, ok: true, scope: 'user', file: '/home/u/.damocles/settings.json' } as const);
const failed = (key: string) => ({ type: 'settingWriteResult', key, ok: false, error: 'EACCES' } as const);

beforeEach(() => setActivePinia(createPinia()));

describe('setting writes', () => {
  it('settles each key\'s writes on their own, so one key\'s failure reverts only that key', () => {
    const writes = useSettingWritesStore();
    const revertA = vi.fn();
    const revertB = vi.fn();
    writes.begin('damocles.a', revertA);
    writes.begin('damocles.b', revertB);

    writes.settle(failed('damocles.b'));
    writes.settle(saved('damocles.a'));

    expect(revertB).toHaveBeenCalledOnce();
    expect(revertA).not.toHaveBeenCalled();
    expect(writes.latest(['damocles.a'])).toMatchObject({ kind: 'saved', scope: 'user' });
    expect(writes.latest(['damocles.b'])).toMatchObject({ kind: 'error', error: 'EACCES' });
  });

  it('clears a key\'s error when the next write to it starts', () => {
    const writes = useSettingWritesStore();
    writes.begin('damocles.a', () => {});
    writes.settle(failed('damocles.a'));
    expect(writes.latest(['damocles.a'])?.kind).toBe('error');

    writes.begin('damocles.a', () => {});
    expect(writes.latest(['damocles.a'])).toBeUndefined();
  });

  it('shows a row backed by several keys the result that settled last', () => {
    const writes = useSettingWritesStore();
    writes.begin('damocles.team.leadModel', () => {});
    writes.begin('damocles.team.leadEffort', () => {});
    writes.settle(saved('damocles.team.leadEffort'));
    writes.settle(failed('damocles.team.leadModel'));

    expect(writes.latest(['damocles.team.leadModel', 'damocles.team.leadEffort'])).toMatchObject({ kind: 'error' });
  });

  it('records a result that arrives with no write in flight without reverting anything', () => {
    const writes = useSettingWritesStore();
    const revert = vi.fn();
    writes.begin('damocles.a', revert);
    writes.settle(saved('damocles.a'));
    writes.settle(failed('damocles.a'));

    expect(revert).not.toHaveBeenCalled();
    expect(writes.latest(['damocles.a'])).toMatchObject({ kind: 'error' });
  });
});
