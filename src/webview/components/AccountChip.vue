<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { useI18n } from "vue-i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useSettingsStore } from "@/stores/useSettingsStore";

const { t } = useI18n();
const { accountInfo } = storeToRefs(useSettingsStore());

// Keys are openaiTokenSource()'s values; a custom provider's tokenSource (its piProvider) gets no chip.
const OPENAI_SOURCE_LABEL_KEYS = new Map<string, string>([
  ["chatgpt-oauth", "openai.chip.chatgpt"],
  ["codex-oauth", "openai.chip.codex"],
  ["openai-api-key", "openai.chip.apiKey"],
]);

const openaiLabel = computed(() => {
  const source = accountInfo.value?.tokenSource;
  const key = source === undefined ? undefined : OPENAI_SOURCE_LABEL_KEYS.get(source);
  return key === undefined ? null : t(key);
});
</script>

<template>
  <Popover v-if="accountInfo?.subscriptionType">
    <PopoverTrigger as-child>
      <Button
        variant="ghost"
        size="sm"
        class="h-auto px-1.5 py-0.5 rounded bg-primary/20 text-primary hover:bg-primary/30 hover:text-primary"
      >
        {{ accountInfo.subscriptionType }}
      </Button>
    </PopoverTrigger>
    <PopoverContent
      v-if="accountInfo.email"
      side="right"
      :side-offset="8"
      class="w-auto p-2 text-xs"
    >
      {{ accountInfo.email }}
    </PopoverContent>
  </Popover>
  <Badge
    v-else-if="openaiLabel"
    variant="secondary"
    class="h-auto px-1.5 py-0.5 rounded bg-primary/20 text-primary font-medium hover:bg-primary/20"
    data-testid="account-chip-openai"
  >
    {{ openaiLabel }}
  </Badge>
</template>
