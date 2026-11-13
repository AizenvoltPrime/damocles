import { effectScope, nextTick, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RepoAccountsView } from '../../../shared/forge/bindings';
import type { DamoclesForgeShellApi, ForgeChanged } from '../../preload/forge-channels';
import { useRepoAccounts } from '../forge/repo-accounts';

const viewOf = (projectKey: string): RepoAccountsView => ({ projectKey, project: projectKey, servers: [] });

// repoAccounts answers when the test settles it, by repository and in call order
function fakeApi() {
  const reads: Array<{ readonly repoId: string; readonly settle: (view: RepoAccountsView | null) => void }> = [];
  const listeners = new Set<(changed: ForgeChanged) => void>();
  const api = {
    repoAccounts: vi.fn((repoId: string) => new Promise<RepoAccountsView | null>((resolve) => reads.push({ repoId, settle: resolve }))),
    onChanged: vi.fn((listener: (changed: ForgeChanged) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  } as unknown as DamoclesForgeShellApi;
  return { api, reads, fire: (changed: ForgeChanged) => listeners.forEach((listener) => listener(changed)) };
}

const scopes: Array<ReturnType<typeof effectScope>> = [];
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop();
});

function mounted(api: DamoclesForgeShellApi, initial: string | undefined) {
  const repoId = ref<string | undefined>(initial);
  const scope = effectScope();
  scopes.push(scope);
  const accounts = scope.run(() => useRepoAccounts(api, repoId))!;
  return { repoId, accounts };
}

describe('useRepoAccounts', () => {
  it('drops a read that a newer one overtook, so an older answer never replaces a newer view', async () => {
    const { api, reads, fire } = fakeApi();
    const { accounts } = mounted(api, 'repo-a');
    fire({ projectKeys: ['a'] });
    expect(reads).toHaveLength(2);
    reads[1]!.settle(viewOf('a-new'));
    await nextTick();
    reads[0]!.settle(viewOf('a-old'));
    await nextTick();
    expect(accounts.view.value?.projectKey).toBe('a-new');
    expect(accounts.loading.value).toBe(false);
  });

  it('shows nothing of the previous repository after a switch, and drops its late answer', async () => {
    const { api, reads } = fakeApi();
    const { repoId, accounts } = mounted(api, 'repo-a');
    reads[0]!.settle(viewOf('a'));
    await nextTick();
    expect(accounts.view.value?.projectKey).toBe('a');
    repoId.value = 'repo-b';
    await nextTick();
    expect(accounts.view.value).toBeNull();
    expect(reads.map((read) => read.repoId)).toEqual(['repo-a', 'repo-b']);
    repoId.value = 'repo-c';
    await nextTick();
    reads[1]!.settle(viewOf('b'));
    await nextTick();
    expect(accounts.view.value).toBeNull();
    reads[2]!.settle(viewOf('c'));
    await nextTick();
    expect(accounts.view.value?.projectKey).toBe('c');
  });

  it('takes an ask-once answer only for the project the arriving view holds, and ignores another project\'s change', async () => {
    const { api, reads, fire } = fakeApi();
    const { accounts } = mounted(api, 'repo-a');
    reads[0]!.settle(viewOf('a'));
    await nextTick();
    fire({ projectKeys: ['other'] });
    expect(reads).toHaveLength(1);
    fire({ projectKeys: ['a'], chosen: { projectKey: 'other', serverId: 's', accountId: 'x' } });
    reads[1]!.settle(viewOf('a'));
    await nextTick();
    expect(accounts.chosen.value).toBeNull();
    const chosen = { projectKey: 'a', serverId: 's', accountId: 'x' };
    fire({ projectKeys: ['a'], chosen });
    expect(accounts.chosen.value).toBeNull();
    reads[2]!.settle(viewOf('a'));
    await nextTick();
    expect(accounts.chosen.value).toEqual(chosen);
  });
});
