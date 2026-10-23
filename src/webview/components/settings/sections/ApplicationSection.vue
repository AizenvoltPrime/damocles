<script setup lang="ts">
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import type { AssetSourcePrecedence, CacheWarmingMode } from '@shared/types/settings';
import { ASSET_SOURCE_PRECEDENCES } from '@shared/types/constants';
import { useSettingsStore } from '@/stores/useSettingsStore';
import SettingsRow from '../SettingsRow.vue';
import SettingSeg from '../controls/SettingSeg.vue';
import SettingInput from '../controls/SettingInput.vue';
import { parseRetentionDays } from '../parsers';
import { useSettingWrite } from '../settings-writes';

const { t } = useI18n();
const settingsStore = useSettingsStore();
const { currentSettings } = storeToRefs(settingsStore);
const write = useSettingWrite();

const warmingOptions = computed<{ value: CacheWarmingMode; label: string }[]>(() => [
  { value: 'off', label: t('settingsModal.cacheWarming.off') },
  { value: 'streaming', label: t('settingsModal.cacheWarming.streaming') },
  { value: 'idle', label: t('settingsModal.cacheWarming.idle') },
]);

function setCacheWarming(mode: CacheWarmingMode): void {
  const before = currentSettings.value.cacheWarming;
  write('damocles.cacheWarming', { type: 'setCacheWarming', mode }, {
    apply: () => settingsStore.setCacheWarmingMode(mode),
    revert: () => settingsStore.setCacheWarmingMode(before),
  });
}

const precedenceOptions = ASSET_SOURCE_PRECEDENCES.map((value) => ({ value, label: `.${value}` }));

function setPrecedence(precedence: AssetSourcePrecedence): void {
  const before = currentSettings.value.assetSourcePrecedence;
  write('damocles.assetSourcePrecedence', { type: 'setAssetSourcePrecedence', precedence }, {
    apply: () => settingsStore.setSetting('assetSourcePrecedence', precedence),
    revert: () => settingsStore.setSetting('assetSourcePrecedence', before),
  });
}

function setRetention(days: number): void {
  const before = currentSettings.value.checkpointRetentionDays;
  write('damocles.checkpoints.retentionDays', { type: 'setCheckpointRetentionDays', days }, {
    apply: () => settingsStore.setCheckpointRetentionDays(days),
    revert: () => settingsStore.setCheckpointRetentionDays(before),
  });
}
</script>

<template>
  <SettingsRow id="damocles.cacheWarming">
    <SettingSeg
      :model-value="currentSettings.cacheWarming"
      :options="warmingOptions"
      :label="t('settingsModal.rows.cacheWarming.label')"
      @update:model-value="setCacheWarming"
    />
  </SettingsRow>
  <SettingsRow id="damocles.checkpoints.retentionDays">
    <SettingInput
      :model-value="String(currentSettings.checkpointRetentionDays)"
      :parse="(raw) => parseRetentionDays(raw, t)"
      :label="t('settingsModal.rows.checkpointRetention.label')"
      :suffix="t('settingsModal.units.days')"
      inputmode="numeric"
      @commit="setRetention"
    />
  </SettingsRow>
  <SettingsRow id="damocles.assetSourcePrecedence">
    <SettingSeg
      :model-value="currentSettings.assetSourcePrecedence"
      :options="precedenceOptions"
      :label="t('settingsModal.rows.assetSourcePrecedence.label')"
      @update:model-value="setPrecedence"
    />
  </SettingsRow>
</template>
