<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Badge } from "@/components/ui/badge";
import { useSettingsStore } from "@/stores/useSettingsStore";
import type { SettingSource } from "@shared/types/messages";

// A value set in a project or local .damocles file wins over the user file the panel writes to.
// Several keys under one label show one badge per distinct file.
const props = defineProps<{ settingKey: string | readonly string[] }>();
const { t } = useI18n();
const settingsStore = useSettingsStore();

const sources = computed(() => {
  const keys = typeof props.settingKey === "string" ? [props.settingKey] : props.settingKey;
  const distinct = new Map<string, SettingSource>();
  for (const key of keys) {
    const source = settingsStore.settingSources[key];
    if (source) distinct.set(`${source.scope}\0${source.path}`, source);
  }
  return [...distinct.values()];
});
</script>

<template>
  <Badge
    v-for="source in sources"
    :key="`${source.scope}:${source.path}`"
    variant="outline"
    class="ml-1.5 px-1.5 py-0 align-middle text-[10px] font-normal text-muted-foreground"
    :title="t('settings.source.fromFile', { path: source.path })"
  >
    {{ source.scope === "local" ? t("settings.source.local") : t("settings.source.project") }}
    <span class="sr-only">{{ t('settings.source.fromFile', { path: source.path }) }}</span>
  </Badge>
</template>
