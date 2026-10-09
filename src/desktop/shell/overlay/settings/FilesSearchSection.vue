<script setup lang="ts">
import { computed, inject } from 'vue';
import { useI18n } from 'vue-i18n';
import { FileJson } from 'lucide-vue-next';
import SettingsRow from '@/components/settings/SettingsRow.vue';
import SettingButton from '@/components/settings/controls/SettingButton.vue';
import SettingInput from '@/components/settings/controls/SettingInput.vue';
import SettingSeg from '@/components/settings/controls/SettingSeg.vue';
import SettingSelect, { type SelectOption } from '@/components/settings/controls/SettingSelect.vue';
import SettingSwitch from '@/components/settings/controls/SettingSwitch.vue';
import { useSettingsPage } from '@/components/settings/settings-view';
import {
  DEFAULT_FILES_EXCLUDE,
  DEFAULT_SEARCH_EXCLUDE,
  DESKTOP_CONFIGURATION,
  FILES_EXCLUDE_SETTING,
  SEARCH_ACTIONS_POSITIONS,
  SEARCH_ACTIONS_POSITION_SETTING,
  SEARCH_COLLAPSE_RESULTS,
  SEARCH_COLLAPSE_RESULTS_SETTING,
  SEARCH_DEFAULT_VIEW_MODES,
  SEARCH_DEFAULT_VIEW_MODE_SETTING,
  SEARCH_EDITOR_CONTEXT_LINES_SETTING,
  SEARCH_EDITOR_DOUBLE_CLICK,
  SEARCH_EDITOR_DOUBLE_CLICK_SETTING,
  SEARCH_EDITOR_FOCUS_RESULTS_SETTING,
  SEARCH_EDITOR_REUSE_PRIOR_SETTING,
  SEARCH_EXCLUDE_SETTING,
  SEARCH_MAX_RESULTS_SETTING,
  SEARCH_MODES,
  SEARCH_MODE_SETTING,
  SEARCH_ON_TYPE_DEBOUNCE_SETTING,
  SEARCH_ON_TYPE_SETTING,
  SEARCH_SEED_ON_FOCUS_SETTING,
  SEARCH_SEED_WITH_NEAREST_WORD_SETTING,
  SEARCH_SHOW_LINE_NUMBERS_SETTING,
  SEARCH_SMART_CASE_SETTING,
  SEARCH_SORT_ORDERS,
  SEARCH_SORT_ORDER_SETTING,
  SEARCH_USE_REPLACE_PREVIEW_SETTING,
} from '../../../main/desktop-configuration';
import { useDesktopPrefs } from './desktop-prefs';
import { integerSetting } from './integer-setting';
import { EDIT_SETTINGS_FILE } from './settings-file-link';

// A glob map shows its patterns and edits in settings.json, as VS Code does for its object settings.
// The Search group holds VS Code's search.* and search.searchEditor.* settings as damocles.desktop.search(Editor).*.
const { t } = useI18n();
const prefs = useDesktopPrefs();
const page = useSettingsPage();
const editSettingsFile = inject(EDIT_SETTINGS_FILE)!;

// The value main read, else the declared default; main validated it against the declaration on write.
const valueOf = (key: string): unknown => prefs.values.value[key] ?? DESKTOP_CONFIGURATION[key]?.default;
const choice = <V extends string>(key: string, values: readonly V[]): V => values.find((value) => value === valueOf(key)) ?? (DESKTOP_CONFIGURATION[key]!.default as V);
const numberOf = (key: string): string => String(valueOf(key));

function patternsOf(key: string, fallback: Readonly<Record<string, boolean>>): Array<{ pattern: string; on: boolean }> {
  const value = prefs.values.value[key];
  const map = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : fallback;
  return Object.entries(map).map(([pattern, on]) => ({ pattern, on: on === true }));
}
const globMaps = computed(() => [
  { key: FILES_EXCLUDE_SETTING, label: 'settingsHost.rows.filesExclude.label', testid: 'files-exclude', patterns: patternsOf(FILES_EXCLUDE_SETTING, DEFAULT_FILES_EXCLUDE) },
  { key: SEARCH_EXCLUDE_SETTING, label: 'settingsHost.rows.search.exclude.label', testid: 'search-exclude', patterns: patternsOf(SEARCH_EXCLUDE_SETTING, DEFAULT_SEARCH_EXCLUDE) },
]);

const optionsOf = <V extends string>(group: string, values: readonly V[]): SelectOption<V>[] => values.map((value) => ({ value, label: t(`settingsHost.search.${group}.${value}`) }));
const switches = [
  SEARCH_SMART_CASE_SETTING,
  SEARCH_ON_TYPE_SETTING,
  SEARCH_SHOW_LINE_NUMBERS_SETTING,
  SEARCH_SEED_ON_FOCUS_SETTING,
  SEARCH_SEED_WITH_NEAREST_WORD_SETTING,
  SEARCH_USE_REPLACE_PREVIEW_SETTING,
] as const;
// The rows' i18n keys follow the setting's path after damocles.desktop (settingsHost.rows.search.mode).
const rowLabel = (key: string): string => t(`settingsHost.rows.${key.slice('damocles.desktop.'.length)}.label`);
</script>

<template>
  <SettingsRow
    v-for="map in globMaps"
    :id="map.key"
    :key="map.key"
  >
    <div class="flex max-w-80 flex-col items-end gap-2">
      <ul
        :data-testid="`${map.testid}-patterns`"
        :aria-label="t(map.label)"
        class="flex flex-wrap justify-end gap-1.5"
      >
        <li
          v-for="entry in map.patterns"
          :key="entry.pattern"
          class="rounded-md border border-(--d-border) bg-(--d-bg) px-1.75 py-0.5 font-mono text-11"
          :class="entry.on ? 'text-(--d-text)' : 'text-(--d-faint-text) line-through'"
          :title="entry.on ? undefined : t('settingsHost.filesExclude.off')"
        >
          {{ entry.pattern }}
        </li>
        <li
          v-if="map.patterns.length === 0"
          class="text-12 text-(--d-faint-text)"
        >
          {{ t('settingsHost.filesExclude.none') }}
        </li>
      </ul>
      <SettingButton
        :data-testid="`${map.testid}-edit`"
        @click="editSettingsFile('user', map.key)"
      >
        <FileJson
          class="size-3"
          aria-hidden="true"
        />
        {{ t('settingsHost.editInSettingsJson') }}
      </SettingButton>
    </div>
  </SettingsRow>

  <div
    v-if="!page.query"
    class="sm-group-head"
    data-testid="settings-group-search"
  >
    {{ t('settingsHost.groups.search') }}
  </div>
  <SettingsRow :id="SEARCH_MODE_SETTING">
    <SettingSelect
      :model-value="choice(SEARCH_MODE_SETTING, SEARCH_MODES)"
      :options="optionsOf('mode', SEARCH_MODES)"
      :label="rowLabel(SEARCH_MODE_SETTING)"
      @update:model-value="(value) => prefs.set(SEARCH_MODE_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="SEARCH_SORT_ORDER_SETTING">
    <SettingSelect
      :model-value="choice(SEARCH_SORT_ORDER_SETTING, SEARCH_SORT_ORDERS)"
      :options="optionsOf('sortOrder', SEARCH_SORT_ORDERS)"
      :label="rowLabel(SEARCH_SORT_ORDER_SETTING)"
      @update:model-value="(value) => prefs.set(SEARCH_SORT_ORDER_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="SEARCH_COLLAPSE_RESULTS_SETTING">
    <SettingSelect
      :model-value="choice(SEARCH_COLLAPSE_RESULTS_SETTING, SEARCH_COLLAPSE_RESULTS)"
      :options="optionsOf('collapseResults', SEARCH_COLLAPSE_RESULTS)"
      :label="rowLabel(SEARCH_COLLAPSE_RESULTS_SETTING)"
      @update:model-value="(value) => prefs.set(SEARCH_COLLAPSE_RESULTS_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="SEARCH_DEFAULT_VIEW_MODE_SETTING">
    <SettingSeg
      :model-value="choice(SEARCH_DEFAULT_VIEW_MODE_SETTING, SEARCH_DEFAULT_VIEW_MODES)"
      :options="optionsOf('viewMode', SEARCH_DEFAULT_VIEW_MODES)"
      :label="rowLabel(SEARCH_DEFAULT_VIEW_MODE_SETTING)"
      @update:model-value="(value) => prefs.set(SEARCH_DEFAULT_VIEW_MODE_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="SEARCH_ACTIONS_POSITION_SETTING">
    <SettingSeg
      :model-value="choice(SEARCH_ACTIONS_POSITION_SETTING, SEARCH_ACTIONS_POSITIONS)"
      :options="optionsOf('actionsPosition', SEARCH_ACTIONS_POSITIONS)"
      :label="rowLabel(SEARCH_ACTIONS_POSITION_SETTING)"
      @update:model-value="(value) => prefs.set(SEARCH_ACTIONS_POSITION_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow
    v-for="key in switches"
    :id="key"
    :key="key"
  >
    <SettingSwitch
      :model-value="valueOf(key) === true"
      :label="rowLabel(key)"
      @update:model-value="(value) => prefs.set(key, value)"
    />
  </SettingsRow>
  <SettingsRow :id="SEARCH_ON_TYPE_DEBOUNCE_SETTING">
    <SettingInput
      :model-value="numberOf(SEARCH_ON_TYPE_DEBOUNCE_SETTING)"
      :parse="integerSetting(SEARCH_ON_TYPE_DEBOUNCE_SETTING, t)"
      :label="rowLabel(SEARCH_ON_TYPE_DEBOUNCE_SETTING)"
      inputmode="numeric"
      @commit="(value: number) => prefs.set(SEARCH_ON_TYPE_DEBOUNCE_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="SEARCH_MAX_RESULTS_SETTING">
    <SettingInput
      :model-value="numberOf(SEARCH_MAX_RESULTS_SETTING)"
      :parse="integerSetting(SEARCH_MAX_RESULTS_SETTING, t)"
      :label="rowLabel(SEARCH_MAX_RESULTS_SETTING)"
      inputmode="numeric"
      @commit="(value: number) => prefs.set(SEARCH_MAX_RESULTS_SETTING, value)"
    />
  </SettingsRow>

  <div
    v-if="!page.query"
    class="sm-group-head"
    data-testid="settings-group-search-editor"
  >
    {{ t('settingsHost.groups.searchEditor') }}
  </div>
  <SettingsRow :id="SEARCH_EDITOR_DOUBLE_CLICK_SETTING">
    <SettingSelect
      :model-value="choice(SEARCH_EDITOR_DOUBLE_CLICK_SETTING, SEARCH_EDITOR_DOUBLE_CLICK)"
      :options="optionsOf('doubleClick', SEARCH_EDITOR_DOUBLE_CLICK)"
      :label="rowLabel(SEARCH_EDITOR_DOUBLE_CLICK_SETTING)"
      @update:model-value="(value) => prefs.set(SEARCH_EDITOR_DOUBLE_CLICK_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow :id="SEARCH_EDITOR_CONTEXT_LINES_SETTING">
    <SettingInput
      :model-value="numberOf(SEARCH_EDITOR_CONTEXT_LINES_SETTING)"
      :parse="integerSetting(SEARCH_EDITOR_CONTEXT_LINES_SETTING, t)"
      :label="rowLabel(SEARCH_EDITOR_CONTEXT_LINES_SETTING)"
      inputmode="numeric"
      @commit="(value: number) => prefs.set(SEARCH_EDITOR_CONTEXT_LINES_SETTING, value)"
    />
  </SettingsRow>
  <SettingsRow
    v-for="key in [SEARCH_EDITOR_REUSE_PRIOR_SETTING, SEARCH_EDITOR_FOCUS_RESULTS_SETTING]"
    :id="key"
    :key="key"
  >
    <SettingSwitch
      :model-value="valueOf(key) === true"
      :label="rowLabel(key)"
      @update:model-value="(value) => prefs.set(key, value)"
    />
  </SettingsRow>
</template>
