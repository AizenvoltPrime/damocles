import { useI18n } from 'vue-i18n';
import { NO_PROJECT_KEY, type UsageStatsSource } from '@shared/types/usage-stats';
import { OTHER_MODELS_SERIES, UNKNOWN_MODEL_SERIES, type TokenType } from './stats-chart-data';

export function folderName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? cwd;
}

/** Display names for `/stats` keys; raw keys stay in titles so two models with one label stay distinguishable. */
export function useStatsLabels() {
  const { t, te } = useI18n();

  function model(key: string | null, label?: string | null): string {
    if (key === null || key === UNKNOWN_MODEL_SERIES) return t('usageStats.breakdown.unknownModel');
    if (key === OTHER_MODELS_SERIES) return t('usageStats.chart.otherModels');
    return label ?? key;
  }

  function project(key: string, cwd: string | null): string {
    return key === NO_PROJECT_KEY || cwd === null ? t('usageStats.filters.noProject') : folderName(cwd);
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

  return { model, project, source, sourceDetail, tokenType };
}
