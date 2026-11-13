import { onScopeDispose, shallowRef, watch, type Ref } from 'vue';
import type { CiStatusView } from '@shared/forge/ci';
import type { DamoclesForgeShellApi } from '../../preload/forge-channels';

type Translate = (key: string) => string;

/**
 * The shown repository's CI as main watches it (the CI chip). Main polls only while the shell says Source Control shows the
 * repository (and pauses on window blur itself); null is no chip.
 */
export function useRepoCi(api: DamoclesForgeShellApi, repoId: Ref<string | undefined>, shown: Ref<boolean>, t: Translate) {
  const status = shallowRef<CiStatusView | null>(null);
  let read = 0;

  async function load(id: string): Promise<void> {
    const mine = ++read;
    let next: CiStatusView | null;
    try {
      next = await api.ciStatus(id);
    } catch (error) {
      if (mine !== read) return;
      console.error('[ci] main refused ciStatus', error);
      next = { status: 'error', message: t('forge.ci.readFailed') };
    }
    if (mine === read && repoId.value === id) status.value = next;
  }

  function watchRepo(id: string, visible: boolean): void {
    api.ciWatch(id, visible).catch((error: unknown) => console.error('[ci] main refused ciWatch', error));
  }

  watch(repoId, (id) => {
    read++;
    status.value = null;
    if (id !== undefined) void load(id);
  }, { immediate: true });

  watch([repoId, shown], ([id, visible], previous) => {
    const [previousId, wasVisible] = previous ?? [undefined, false];
    if (previousId !== undefined && wasVisible && (previousId !== id || !visible)) watchRepo(previousId, false);
    if (id !== undefined && visible && (previousId !== id || !wasVisible)) watchRepo(id, true);
  }, { immediate: true });

  onScopeDispose(api.onCiChanged((changed) => {
    if (changed.repoId === repoId.value) status.value = changed.status;
  }));
  onScopeDispose(() => {
    if (repoId.value !== undefined && shown.value) watchRepo(repoId.value, false);
  });

  return { status };
}
