<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { useI18n } from "vue-i18n";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { remPx } from "@/composables/useRemPx";

const { t } = useI18n();
const { accountInfo } = storeToRefs(useSettingsStore());

// Keys are openaiTokenSource()'s values; a custom provider's tokenSource (its piProvider) gets no chip.
const OPENAI_SOURCE_LABEL_KEYS = new Map<string, string>([
  ["chatgpt-oauth", "openai.chip.chatgpt"],
  ["codex-oauth", "openai.chip.codex"],
  ["openai-api-key", "openai.chip.apiKey"],
]);

// Keys are the Claude auth modes (claudeAuthStatusChanged); "none" has no credential, so no chip.
const CLAUDE_MODE_LABEL_KEYS = new Map<string, string>([
  ["apikey", "chatHeader.account.apikey"],
  ["allowance", "chatHeader.account.allowance"],
  ["extra", "chatHeader.account.extra"],
]);

const label = computed(() => {
  const info = accountInfo.value;
  if (!info) return null;
  const key = info.subscriptionType !== undefined
    ? CLAUDE_MODE_LABEL_KEYS.get(info.subscriptionType)
    : info.tokenSource === undefined ? undefined : OPENAI_SOURCE_LABEL_KEYS.get(info.tokenSource);
  return key === undefined ? null : t(key);
});

const CHIP = "inline-flex h-4 shrink-0 items-center rounded-5 bg-(--d-accent-soft) px-1.5 text-10.5/4 font-medium text-(--d-accent-text)";
</script>

<template>
  <Popover v-if="label && accountInfo?.email">
    <PopoverTrigger
      :class="[CHIP, 'border border-transparent transition-colors hover:border-(--d-accent)']"
      :aria-label="t('chatHeader.accountChip', { source: label })"
      data-testid="account-chip"
    >
      {{ label }}
    </PopoverTrigger>
    <PopoverContent
      side="bottom"
      align="start"
      :side-offset="remPx(0.375)"
      class="w-auto rounded-9 border-(--d-border2) bg-(--d-card) px-2.5 py-1.5 text-xs text-(--d-text) shadow-(--d-shadow)"
    >
      {{ accountInfo.email }}
    </PopoverContent>
  </Popover>
  <span
    v-else-if="label"
    :class="CHIP"
    :title="t('chatHeader.accountChip', { source: label })"
    data-testid="account-chip"
  >
    {{ label }}
  </span>
</template>
