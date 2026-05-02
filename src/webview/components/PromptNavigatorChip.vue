<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { List } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { useStreamingStore } from "@/stores/useStreamingStore";
import { usePromptNavigatorStore } from "@/stores/usePromptNavigatorStore";
import { USER_PROMPT_FILTER } from "@/composables/useEnrichedPrompts";
import { metaKeyShortcut } from "@/composables/usePlatformKey";

const { t } = useI18n();
const streamingStore = useStreamingStore();
const navigatorStore = usePromptNavigatorStore();

const count = computed(() => streamingStore.messages.filter(USER_PROMPT_FILTER).length);
const shortcut = metaKeyShortcut("k");

function handleClick(): void {
  navigatorStore.toggle();
}
</script>

<template>
  <Button
    variant="ghost"
    size="sm"
    class="h-6 gap-1.5 px-1.5 text-muted-foreground hover:text-foreground hover:bg-muted"
    :title="t('promptNavigator.chipTooltip', { key: shortcut })"
    @click="handleClick"
  >
    <List class="w-3.5 h-3.5" />
    <span class="text-[10px] font-mono leading-none">{{ count }}</span>
    <kbd class="text-[9px] font-mono px-1 pt-[5px] pb-[3px] rounded border border-border bg-input leading-none">{{ shortcut }}</kbd>
  </Button>
</template>
