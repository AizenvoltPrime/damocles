import { onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue';
import type { RepoAccountsView, RepoServerAccounts } from '@shared/forge/bindings';
import type { DamoclesForgeShellApi, ForgeChanged } from '../../preload/forge-channels';

type Translate = (key: string, values: Record<string, unknown>) => string;

export type ForgeChosen = NonNullable<ForgeChanged['chosen']>;

/**
 * The shown repository's accounts per server (the account chip) as main resolves them. A refetch on a change keeps the previous view on
 * screen, so only the first read of a repository shows the loading chip. chosen: an ask-once answer for this project, set
 * once the view that holds it has arrived.
 */
export function useRepoAccounts(api: DamoclesForgeShellApi, repoId: Ref<string | undefined>) {
  const view = shallowRef<RepoAccountsView | null>(null);
  const loading = ref(false);
  const failed = ref(false);
  const chosen = shallowRef<ForgeChosen | null>(null);
  let read = 0;

  async function load(id: string, recheck: boolean, answer?: ForgeChosen): Promise<void> {
    const mine = ++read;
    loading.value = true;
    let next: RepoAccountsView | null;
    try {
      next = await api.repoAccounts(id, recheck);
    } catch {
      if (mine !== read) return;
      loading.value = false;
      failed.value = true;
      return;
    }
    if (mine !== read || repoId.value !== id) return;
    loading.value = false;
    failed.value = false;
    view.value = next;
    if (answer && next?.projectKey === answer.projectKey) chosen.value = answer;
  }

  watch(repoId, (id) => {
    read++;
    view.value = null;
    failed.value = false;
    loading.value = false;
    if (id !== undefined) void load(id, false);
  }, { immediate: true });

  onScopeDispose(api.onChanged((changed) => {
    const id = repoId.value;
    if (id === undefined) return;
    const key = view.value?.projectKey;
    if (changed.projectKeys && key !== undefined && !changed.projectKeys.includes(key)) return;
    void load(id, false, changed.chosen);
  }));

  return {
    view,
    loading,
    failed,
    chosen,
    // the account chip's Try again: the access check runs again for the servers whose last check failed
    retry: (): void => {
      if (repoId.value !== undefined) void load(repoId.value, true);
    },
    reload: (): void => {
      if (repoId.value !== undefined) void load(repoId.value, false);
    },
  };
}

/**
 * The account chip's notice for a server whose access check could not reach it: what push uses meanwhile, by how the account was settled.
 * Git's own credentials use no account, and an account that must sign in again cannot push, which the chip already says.
 */
export function checkFailedNotice(server: RepoServerAccounts, t: Translate): string | undefined {
  if (!server.checkFailed) return undefined;
  switch (server.state) {
    case 'chosen': return t('forge.notice.checkFailed', { server: server.server });
    case 'auto': return t('forge.notice.checkFailedAuto', { server: server.server, login: server.account.login });
    case 'choose': return t('forge.notice.checkFailedChoose', { server: server.server });
    case 'signInAgain':
    case 'ownCredentials':
    case 'signIn': return undefined;
  }
}

/** The servers the chip shows: each but one the user sent to Git's own credentials without an account there. */
export function chipServers(view: RepoAccountsView | null): readonly RepoServerAccounts[] {
  return (view?.servers ?? []).filter((server) => server.state !== 'ownCredentials' || server.accounts.length > 0);
}
