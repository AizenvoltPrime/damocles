<script setup lang="ts">
import { computed, useId } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import type { AutoCompactConfig } from '@shared/types/settings';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useSettingsStore } from '@/stores/useSettingsStore';
import SettingSourceBadge from '@/components/SettingSourceBadge.vue';
import SettingsRow from '../SettingsRow.vue';
import SettingButton from '../controls/SettingButton.vue';
import SettingSwitch from '../controls/SettingSwitch.vue';
import SettingSlider from '../controls/SettingSlider.vue';
import SettingInput from '../controls/SettingInput.vue';
import { parseBudgetUsd, parseTaskBudget } from '../parsers';
import { useSettingWrite } from '../settings-writes';
import { useSettingsFiles, useSettingsPage } from '../settings-view';

const { t } = useI18n();
const page = useSettingsPage();
const settingsStore = useSettingsStore();
const { currentSettings, workspaceWritable, hostCapabilities, settingSources } = storeToRefs(settingsStore);
const { postMessage } = usePlatformBridge();
const write = useSettingWrite();
const files = useSettingsFiles();
const fileValuesHeadingId = useId();

const fileValues = computed(() => Object.entries(settingSources.value)
  .filter(([key]) => !files.rowKeys.value.has(key))
  .map(([key, source]) => ({ key, scope: source.scope, path: source.path, value: JSON.stringify(source.value) })));

function setBudget(budgetUsd: number | null): void {
  const before = currentSettings.value.maxBudgetUsd;
  write('damocles.maxBudgetUsd', { type: 'setBudgetLimit', budgetUsd }, {
    apply: () => settingsStore.setBudgetLimit(budgetUsd),
    revert: () => settingsStore.setBudgetLimit(before),
  });
}

function setTaskBudget(budget: number | null): void {
  const before = currentSettings.value.taskBudget;
  write('damocles.taskBudget', { type: 'setTaskBudget', budget }, {
    apply: () => settingsStore.setTaskBudget(budget),
    revert: () => settingsStore.setTaskBudget(before),
  });
}

function setAutoCompact(config: AutoCompactConfig): void {
  const before = currentSettings.value.autoCompact;
  write('damocles.autoCompact', { type: 'setAutoCompact', config }, {
    apply: () => settingsStore.updateAutoCompactConfig(config),
    revert: () => settingsStore.updateAutoCompactConfig(before),
  });
}
</script>

<template>
  <div
    v-if="!workspaceWritable && !page.query"
    class="sm-banner"
    role="status"
    data-testid="settings-workspace-untrusted"
  >
    <!-- Only the chat page may send setProjectTrusted; the desktop overlay points at the Projects list's trust action. -->
    <span class="sm-banner-text">{{ hostCapabilities.settingsInPanel ? t('settingsModal.workspaceUntrusted') : t('settingsModal.workspaceUntrustedProjects') }}</span>
    <SettingButton
      v-if="hostCapabilities.settingsInPanel"
      @click="postMessage({ type: 'setProjectTrusted' })"
    >
      {{ t('settingsModal.trustFolder') }}
    </SettingButton>
  </div>
  <SettingsRow id="damocles.maxBudgetUsd">
    <SettingInput
      :model-value="currentSettings.maxBudgetUsd === null ? '' : String(currentSettings.maxBudgetUsd)"
      :parse="(raw) => parseBudgetUsd(raw, t)"
      :label="t('settingsModal.rows.budget.label')"
      prefix="$"
      :placeholder="t('settingsModal.placeholders.none')"
      inputmode="decimal"
      :disabled="!workspaceWritable"
      @commit="setBudget"
    />
  </SettingsRow>
  <SettingsRow id="damocles.autoCompact">
    <SettingSwitch
      :model-value="currentSettings.autoCompact.enabled"
      :label="t('settingsModal.rows.autoCompact.label')"
      :disabled="!workspaceWritable"
      @update:model-value="(enabled) => setAutoCompact({ ...currentSettings.autoCompact, enabled })"
    />
  </SettingsRow>
  <SettingsRow
    v-if="currentSettings.autoCompact.enabled"
    id="damocles.autoCompact.triggerPercent"
  >
    <SettingSlider
      :model-value="currentSettings.autoCompact.triggerPercent"
      :min="50"
      :max="95"
      :label="t('settingsModal.rows.autoCompactTrigger.label')"
      :format="(value) => `${value}%`"
      :disabled="!workspaceWritable"
      @update:model-value="(triggerPercent) => setAutoCompact({ ...currentSettings.autoCompact, triggerPercent })"
    />
  </SettingsRow>
  <SettingsRow id="damocles.taskBudget">
    <SettingInput
      :model-value="currentSettings.taskBudget === null ? '' : String(currentSettings.taskBudget)"
      :parse="(raw) => parseTaskBudget(raw, t)"
      :label="t('settingsModal.rows.taskBudget.label')"
      :placeholder="t('settingsModal.placeholders.unlimited')"
      inputmode="numeric"
      :disabled="!workspaceWritable"
      @commit="setTaskBudget"
    />
  </SettingsRow>
  <template v-if="fileValues.length > 0 && !page.query">
    <h3
      :id="fileValuesHeadingId"
      class="sm-group-head"
    >
      {{ t('settingsModal.fileValues.title') }}
    </h3>
    <p class="sm-row-desc">
      {{ t('settingsModal.fileValues.description') }}
    </p>
    <ul
      :aria-labelledby="fileValuesHeadingId"
      data-testid="settings-file-values"
    >
      <li
        v-for="entry in fileValues"
        :key="entry.key"
        class="sm-row"
        data-testid="settings-file-value"
        :data-key="entry.key"
      >
        <div class="sm-row-text">
          <div class="sm-row-label">
            <span class="[font-family:var(--d-mono)] text-12.5">{{ entry.key }}</span>
            <SettingSourceBadge :setting-key="entry.key" />
          </div>
          <div class="sm-row-desc break-all [font-family:var(--d-mono)]">
            {{ entry.value }}
          </div>
        </div>
        <div class="sm-row-control">
          <SettingButton @click="files.open(entry.scope)">
            {{ t('settingsModal.fileValues.open') }}<span class="sr-only"> {{ entry.path }}</span>
          </SettingButton>
        </div>
      </li>
    </ul>
  </template>
</template>
