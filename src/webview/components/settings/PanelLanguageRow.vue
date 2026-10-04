<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { i18n, setLocale } from '@/i18n';
import SettingsRow from './SettingsRow.vue';
import type { SegmentedOption } from '@/components/SegmentedToggle.vue';
import SettingSeg from './controls/SettingSeg.vue';

type PanelLocale = 'en' | 'el';

const { t } = useI18n();

// Endonyms, so each language is recognizable whatever the UI language is.
const options: readonly SegmentedOption<PanelLocale>[] = [
  { value: 'en', label: 'English' },
  { value: 'el', label: 'Ελληνικά' },
];
const locale = computed<PanelLocale>(() => (i18n.global.locale.value === 'el' ? 'el' : 'en'));
</script>

<template>
  <SettingsRow id="chat-panel-language">
    <SettingSeg
      :model-value="locale"
      :options="options"
      :label="t('settingsModal.rows.panelLanguage.label')"
      @update:model-value="setLocale"
    />
  </SettingsRow>
</template>
