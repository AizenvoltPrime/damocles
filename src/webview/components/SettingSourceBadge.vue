<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useSettingsStore } from "@/stores/useSettingsStore";
import type { SettingSource } from "@shared/types/messages";

// A value set in a project or local .damocles file wins over the user file; the badge names that file.
// Several keys under one row show one badge per distinct file.
const props = defineProps<{
  settingKey: string | readonly string[];
  /** Grows with each confirmed write, so the badge replays its pop (M7). */
  popSeq?: number;
}>();
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

/** The folder and file name, e.g. ".damocles/settings.local.json"; the full path is in the title. */
function shortName(path: string): string {
  return path.split(/[\\/]/).slice(-2).join("/");
}
</script>

<template>
  <span
    v-for="source in sources"
    :key="`${source.scope}:${source.path}:${popSeq ?? 0}`"
    class="sm-badge sm-badge-file"
    :class="{ 'sm-badge-pop': (popSeq ?? 0) > 0 }"
    data-testid="setting-source"
    :data-scope="source.scope"
    :title="t('settings.source.fromFile', { path: source.path })"
  >{{ shortName(source.path) }}<span class="sr-only">{{ t('settings.source.fromFile', { path: source.path }) }}</span></span>
</template>
