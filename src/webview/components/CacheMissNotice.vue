<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { CacheMissNotice as CacheMissNoticeType } from '@shared/types/session';
import { formatTokenCount, formatCost } from '@/composables/useTeamFormatting';
import { IconDatabase } from '@/components/icons';
import { CACHE_TTL_MS } from '@shared/types/constants';

const { t } = useI18n();

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

const formattedTokens = computed(() => formatTokenCount(props.notice.missedTokens));

const hasCost = computed(() => props.notice.missedCost > 0);

// formatCost returns a bare "$X.XX"; the locale `detail` template adds the "≈" prefix, so the
// component must NOT prepend its own (that produced "≈≈$0.42").
const detailText = computed(() =>
  hasCost.value
    ? t('cacheMiss.detail', { tokens: formattedTokens.value, cost: formatCost(props.notice.missedCost) })
    : t('cacheMiss.detailTokensOnly', { tokens: formattedTokens.value }),
);

const idleMinutes = computed(() => Math.round(props.notice.idleMs / 60000));
</script>

<template>
  <!-- py-2 (not my-2): the scroll engine measures element height, and margins are collapsed/ignored. -->
  <div class="mx-4 py-2">
    <div class="flex items-start gap-2.5 rounded-md border border-info/30 bg-muted px-3 py-2 text-xs">
      <div class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center text-info">
        <IconDatabase :size="14" />
      </div>
      <div class="flex flex-col gap-0.5">
        <span class="font-medium text-foreground">{{ title }}</span>
        <span class="text-muted-foreground">{{ detailText }}</span>
        <span v-if="showIdleHint" class="text-muted-foreground/80">
          {{ t('cacheMiss.idleHint', { minutes: idleMinutes }) }}
        </span>
      </div>
    </div>
  </div>
</template>
