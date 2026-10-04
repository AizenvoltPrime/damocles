<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { CacheMissNotice as CacheMissNoticeType } from '@shared/types/session';
import { formatTokenCount, formatCost } from '@/composables/useTeamFormatting';
import { Database } from 'lucide-vue-next';
import TranscriptNotice from './TranscriptNotice.vue';
import { CACHE_TTL_MS } from '@shared/types/constants';

const { t, locale } = useI18n();

const props = defineProps<{
  notice: CacheMissNoticeType;
}>();

// A model switch is the reported cause whenever it co-occurs with an idle gap, so the idle hint is
// suppressed on modelChanged: the title already blames the switch, and showing "idle for N min"
// underneath would contradict it (the switch, not the TTL, is why the cache missed).
const showIdleHint = computed(() => !props.notice.modelChanged && props.notice.idleMs >= CACHE_TTL_MS);

// Title states the observable cause: a model switch, an idle-gap cache expiry, or a plain miss.
// Without this a model-switch miss would falsely read "Prompt cache expired".
const title = computed(() => {
  if (props.notice.modelChanged) return t('cacheMiss.titleModelSwitch');
  if (showIdleHint.value) return t('cacheMiss.title');
  return t('cacheMiss.titleGeneric');
});

const formattedTokens = computed(() => formatTokenCount(props.notice.missedTokens, locale.value));

const hasCost = computed(() => props.notice.missedCost > 0);

// formatCost returns a bare amount; the locale `detail` template adds the "≈" prefix, so the
// component must NOT prepend its own (that produced "≈≈$0.42").
const detailText = computed(() =>
  hasCost.value
    ? t('cacheMiss.detail', { tokens: formattedTokens.value, cost: formatCost(props.notice.missedCost, locale.value) })
    : t('cacheMiss.detailTokensOnly', { tokens: formattedTokens.value }),
);

const idleMinutes = computed(() => Math.round(props.notice.idleMs / 60000));
</script>

<template>
  <TranscriptNotice
    tone="info"
    :icon="Database"
    :title="title"
  >
    <span>{{ detailText }}</span>
    <span v-if="showIdleHint">{{ t('cacheMiss.idleHint', { minutes: idleMinutes }) }}</span>
  </TranscriptNotice>
</template>
