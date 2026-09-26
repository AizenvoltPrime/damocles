import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { totalUnpriced } from '@shared/usage-accounting';
import { formatCost } from './useTeamFormatting';

/**
 * Team costs come from pi's API rate table whatever the session authenticates with, so on a flat
 * subscription the figure is an equivalent rather than a charge. Unknown billing renders as a charge,
 * because understating a real cost is the worse error.
 */
export function useCostLabel() {
  const { t, locale } = useI18n();
  const { accountInfo } = storeToRefs(useSettingsStore());

  const panelDollarBilled = computed(() => accountInfo.value?.dollarBilled ?? true);
  // A team role can run a model the panel does not, so an agent's own flag wins where one is supplied.
  const billed = (agentDollarBilled?: boolean): boolean => agentDollarBilled ?? panelDollarBilled.value;

  const costLabel = (cost: number, agentDollarBilled?: boolean): string => {
    const amount = formatCost(cost, locale.value);
    return billed(agentDollarBilled) ? amount : t('team.costEstimate', { cost: amount });
  };
  const costTitle = (agentDollarBilled?: boolean): string | undefined =>
    billed(agentDollarBilled) ? undefined : t('team.costEstimateTooltip');

  /** A summed cost with its token count: tokens billed at no recorded price read as unpriced, never as $0. */
  const spendLabel = (cost: number, tokens: number, agentDollarBilled?: boolean): string =>
    totalUnpriced(cost, tokens) ? t('common.unpriced') : costLabel(cost, agentDollarBilled);
  const spendTitle = (cost: number, tokens: number, agentDollarBilled?: boolean): string | undefined =>
    totalUnpriced(cost, tokens) ? t('common.unpricedTooltip') : costTitle(agentDollarBilled);

  /**
   * The billing flag for a sum over agents. One billed agent makes part of the total a real charge, so
   * the whole figure reads as one. Agents that spent nothing say nothing about the total, and a total
   * built from none of them returns undefined so the panel value answers instead.
   */
  const teamDollarBilled = (agents: ReadonlyArray<{ costUsd: number; dollarBilled: boolean }>): boolean | undefined => {
    const spenders = agents.filter(a => a.costUsd > 0);
    return spenders.length === 0 ? undefined : spenders.some(a => a.dollarBilled);
  };

  return { costLabel, costTitle, spendLabel, spendTitle, teamDollarBilled, panelDollarBilled };
}
