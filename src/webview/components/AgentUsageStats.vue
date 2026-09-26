<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { agentCacheHitRate, agentTotalTokens, type AgentUsageTotals } from '@shared/usage-accounting';
import { formatTokenCount } from '@/composables/useTeamFormatting';
import { cacheHitPercent } from '@/utils/cacheHitPercent';
import { useCostLabel } from '@/composables/useCostLabel';

/**
 * An agent's tokens, cache hit rate and cost, each preceded by `separator` and each hidden while zero, so
 * the parts append to a metadata row. `card` joins the parent's flex row; `subtitle` flows inline as text.
 * `separatorClass` and `costClass` apply to `card` only, so the parts match the row's own separators.
 */
const props = withDefaults(defineProps<{
  usage: AgentUsageTotals;
  // Absent means the panel's flag answers; the explicit undefined default stops Vue casting it to false.
  dollarBilled?: boolean | undefined;
  variant: 'card' | 'subtitle';
  separator?: string;
  separatorClass?: string;
  costClass?: string;
}>(), { dollarBilled: undefined, separator: '•', separatorClass: 'text-foreground/40', costClass: '' });

const { t, locale } = useI18n();
const { costLabel, costTitle } = useCostLabel();

const totalTokens = computed(() => agentTotalTokens(props.usage));

const tokensTooltip = computed(() => {
  const n = (v: number) => v.toLocaleString(locale.value);
  return t('agentUsage.tokensTooltip', {
    input: n(props.usage.totalInputTokens),
    cacheRead: n(props.usage.cacheReadTokens),
    cacheWrite: n(props.usage.cacheCreationTokens),
    output: n(props.usage.totalOutputTokens),
  });
});

const cachePct = computed(() => {
  const rate = agentCacheHitRate(props.usage);
  const pct = rate === null ? 0 : cacheHitPercent(rate);
  return pct > 0 ? pct : null;
});

// A card row spaces its items with a flex gap; subtitle text needs spaces that cannot wrap.
const separatorText = computed(() => (props.variant === 'card' ? props.separator : `\u00a0${props.separator}\u00a0`));
const separatorClasses = computed(() => (props.variant === 'card' ? props.separatorClass : undefined));
const costClasses = computed(() => (props.variant === 'card' ? `font-medium ${props.costClass}`.trim() : undefined));
</script>

<template>
  <span :class="variant === 'card' ? 'contents' : undefined">
    <template v-if="totalTokens > 0">
      <span :class="separatorClasses">{{ separatorText }}</span>
      <span data-part="tokens" :title="tokensTooltip">{{ t('agentUsage.tokens', { n: formatTokenCount(totalTokens, locale) }, totalTokens) }}</span>
    </template>
    <template v-if="cachePct !== null">
      <span :class="separatorClasses">{{ separatorText }}</span>
      <span data-part="cache" :title="t('agentUsage.cacheHitTooltip')">{{ t('agentUsage.cacheHit', { pct: cachePct }) }}</span>
    </template>
    <template v-if="usage.costUsd > 0">
      <span :class="separatorClasses">{{ separatorText }}</span>
      <span data-part="cost" :class="costClasses" :title="costTitle(dollarBilled)">{{ costLabel(usage.costUsd, dollarBilled) }}</span>
    </template>
  </span>
</template>
