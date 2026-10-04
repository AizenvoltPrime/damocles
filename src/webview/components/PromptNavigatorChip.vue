<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { List } from "lucide-vue-next";
import { useStreamingStore } from "@/stores/useStreamingStore";
import { usePromptNavigatorStore } from "@/stores/usePromptNavigatorStore";
import { NAVIGATOR_DISPLAY_FILTER } from "@/composables/useEnrichedPrompts";
import { metaKeyShortcut } from "@/composables/usePlatformKey";

defineProps<{ showShortcut: boolean }>();

const { t } = useI18n();
const streamingStore = useStreamingStore();
const navigatorStore = usePromptNavigatorStore();

const count = computed(() => streamingStore.messages.filter(NAVIGATOR_DISPLAY_FILTER).length);
const shortcut = metaKeyShortcut("k");
const label = computed(() => t("chatHeader.promptNavigator", { key: shortcut }));
</script>

<template>
  <button
    type="button"
    class="d-tool-btn gap-1.5 px-2"
    :title="label"
    :aria-label="`${label}, ${t('chatHeader.promptCount', { n: count }, count)}`"
    data-testid="chat-header-navigator"
    @click="navigatorStore.toggle()"
  >
    <List
      class="size-3.5"
      aria-hidden="true"
    />
    <span
      class="font-mono text-11 tabular-nums"
      aria-hidden="true"
    >{{ count }}</span>
    <kbd
      v-if="showShortcut"
      class="rounded-5 border border-(--d-border2) px-1.25 py-px font-mono text-10/3.5 text-(--d-faint)"
      aria-hidden="true"
    >{{ shortcut }}</kbd>
  </button>
</template>
