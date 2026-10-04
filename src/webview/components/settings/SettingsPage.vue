<script setup lang="ts">
import { computed, watch, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import type { SettingsSectionId } from '@shared/settings-sections';
import ThisChatSection from './sections/ThisChatSection.vue';
import DefaultsSection from './sections/DefaultsSection.vue';
import AccountsSection from './sections/AccountsSection.vue';
import TeamsSection from './sections/TeamsSection.vue';
import WorkspaceSection from './sections/WorkspaceSection.vue';
import ApplicationSection from './sections/ApplicationSection.vue';
import IntegrationsSection from './sections/IntegrationsSection.vue';
import VoiceSection from './sections/VoiceSection.vue';
import type { HostSettings, SettingsRowMeta, SettingsSectionMeta } from './settings-rows';
import { provideSettingsPage } from './settings-view';

const props = defineProps<{
  /** One section, or every section while a search runs. */
  sections: readonly SettingsSectionMeta[];
  /** Normalized for matching; `typed` is what the user typed, for the empty state. */
  query: string;
  typed: string;
  host: HostSettings;
  rows: ReadonlyMap<string, SettingsRowMeta>;
}>();

const emit = defineEmits<{
  (e: 'matches', count: number): void;
}>();

const { t } = useI18n();
const page = provideSettingsPage(() => props.query, props.rows);

const SHARED: Partial<Record<SettingsSectionId, Component>> = {
  chat: ThisChatSection,
  defaults: DefaultsSection,
  accounts: AccountsSection,
  teams: TeamsSection,
  workspace: WorkspaceSection,
  application: ApplicationSection,
  integrations: IntegrationsSection,
  voice: VoiceSection,
};

function components(section: SettingsSectionId): Component[] {
  const own = SHARED[section] ?? props.host.sections.find((entry) => entry.id === section)?.component;
  const extra = props.host.rows.filter((entry) => entry.section === section).map((entry) => entry.component);
  return own ? [own, ...extra] : extra;
}

const shownPerSection = computed(() => {
  const counts = new Map<SettingsSectionId, number>();
  for (const section of page.shown.value.values()) counts.set(section, (counts.get(section) ?? 0) + 1);
  return counts;
});

watch(() => page.shown.value.size, (count) => emit('matches', count), { immediate: true });
</script>

<template>
  <section
    v-for="section in sections"
    :key="section.id"
    :aria-label="query ? t(section.label) : undefined"
  >
    <h3
      v-if="query && shownPerSection.get(section.id)"
      class="sm-group-head"
    >
      {{ t(section.label) }}
    </h3>
    <component
      :is="component"
      v-for="(component, index) in components(section.id)"
      :key="index"
    />
  </section>
  <p
    v-if="query && page.shown.value.size === 0"
    class="sm-empty"
    role="status"
  >
    {{ t('settingsModal.empty', { q: typed.trim() }) }}
  </p>
</template>
