import { useI18n } from 'vue-i18n';
import { NO_PROJECT_KEY, type UsageStatsCredentialRow, type UsageStatsSource } from '@shared/types/usage-stats';
import { folderName } from '@/lib/folder-name';
import { useChatHost } from '@/composables/useChatHost';
import { useHostNames, type HostName } from '@/composables/useHostNames';
import { OTHER_MODELS_SERIES, UNKNOWN_MODEL_SERIES, type TokenType } from './stats-chart-data';

/** Display names for `/stats` keys; raw keys stay in titles so two models with one label stay distinguishable. */
export function useStatsLabels() {
  const { t, te } = useI18n();
  const hostNames = useHostNames();
  const chatHost = useChatHost();

  function model(key: string | null, label?: string | null): string {
    if (key === null || key === UNKNOWN_MODEL_SERIES) return t('usageStats.breakdown.unknownModel');
    if (key === OTHER_MODELS_SERIES) return t('usageStats.chart.otherModels');
    return label ?? key;
  }

  function project(key: string, cwd: string | null): string {
    return key === NO_PROJECT_KEY || cwd === null ? t('usageStats.filters.noProject') : folderName(cwd);
  }

  /** The host a remote row ran on, as this computer names it; none before main sent the names, and a host id they lack is a host the user forgot. */
  function host(hostId: string | undefined): HostName | undefined {
    const names = hostNames.value;
    if (hostId === undefined || names === undefined) return undefined;
    return names.get(hostId) ?? { name: t('usageStats.removedHost') };
  }

  /** A project with the host it is on, for text that cannot carry the host chip (filter options, chart titles). */
  function projectOnHost(key: string, cwd: string | null, hostId: string | undefined): string {
    const on = host(hostId);
    return on ? t('usageStats.projectOnHost', { project: project(key, cwd), host: on.name }) : project(key, cwd);
  }

  /** A host's own credential row names its host: by id on this computer's core, else the page's own host on a remote chat's core. */
  function credential(row: UsageStatsCredentialRow): { label: string; title: string } {
    if (row.credential === 'signIn') return { label: t('usageStats.breakdown.credential.signIn'), title: t('usageStats.breakdown.credential.signInTitle') };
    const name = host(row.hostId)?.name ?? chatHost.value?.name;
    if (name === undefined) return { label: t('usageStats.breakdown.credential.host'), title: t('usageStats.breakdown.credential.hostTitle') };
    return { label: t('composer.modelSourceHost', { host: name }), title: t('usageStats.breakdown.credential.hostEnvironmentTitle', { host: name }) };
  }

  function source(source: UsageStatsSource): string {
    return t(`usageStats.sources.${source}`);
  }

  /** Agent types, roles and unknown purposes are shown as recorded; known purposes and kinds are translated. */
  function sourceDetail(source: UsageStatsSource, detail: string | null): string {
    if (detail === null) {
      if (source === 'subagent') return t('usageStats.sourceDetails.unknownAgent');
      return t(source === 'team' ? 'usageStats.sourceDetails.unknownRole' : 'usageStats.sourceDetails.unknown');
    }
    // The entry parser records a sub-call whose ledger line names no purpose as `unknown`.
    if (source === 'background' && detail === 'unknown') return t('usageStats.sourceDetails.unknown');
    const key = source === 'background' ? `usageStats.purposes.${detail}` : `usageStats.sourceDetails.${source}.${detail}`;
    return (source === 'background' || source === 'compaction' || source === 'cacheWarm') && te(key) ? t(key) : detail;
  }

  function tokenType(type: TokenType): string {
    return t(`usageStats.tokenTypes.${type}`);
  }

  return { model, project, host, projectOnHost, credential, source, sourceDetail, tokenType };
}
