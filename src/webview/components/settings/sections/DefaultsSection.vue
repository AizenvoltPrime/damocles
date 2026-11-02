<script setup lang="ts">
import { computed, ref, useTemplateRef } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { Lock } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { thinkingDisableApplies } from '@shared/types/constants';
import type { EffortLevel, PermissionMode } from '@shared/types/settings';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useUIStore } from '@/stores/useUIStore';
import { visibleRect } from '@/utils/visible-rect';
import SettingsRow from '../SettingsRow.vue';
import SettingSelect from '../controls/SettingSelect.vue';
import SettingSeg from '../controls/SettingSeg.vue';
import SettingSwitch from '../controls/SettingSwitch.vue';
import { effortOptions, modelOptions, permissionOptions, useUnavailableHint } from '../model-options';
import { useSettingWrite } from '../settings-writes';
import { useAllowHostYolo, useSettingsChatHost } from '../settings-view';

const { t } = useI18n();
const unavailableHint = useUnavailableHint();
const settingsStore = useSettingsStore();
const uiStore = useUIStore();
const { postMessage } = usePlatformBridge();
const write = useSettingWrite();
const {
  availableModels,
  activeModel,
  defaultModel,
  defaultThinking,
  defaultThinkingModel,
  currentSettings,
  workspaceFolders,
  defaultWorkspaceFolderKey,
  isMultiRoot,
  hostCapabilities,
} = storeToRefs(settingsStore);

const folderOptions = computed(() => workspaceFolders.value.map((folder) => ({ value: folder.key, label: folder.label, hint: folder.path })));
const thinkingModelValue = computed(() => defaultThinkingModel.value || defaultModel.value);
const thinkingModel = computed(() => availableModels.value.find((model) => model.value === thinkingModelValue.value));
const effortLevels = computed(() => thinkingModel.value?.supportedEffortLevels ?? []);
const adaptive = computed(() => thinkingModel.value?.supportsAdaptiveThinking ?? false);
const disableApplies = computed(() => thinkingDisableApplies(thinkingModel.value));
const thinkingOn = computed(() => defaultThinking.value !== null && (!defaultThinking.value.thinkingDisabled || thinkingModel.value?.backend === 'openai'));

function setDefaultFolder(folderKey: string): void {
  if (folderKey !== defaultWorkspaceFolderKey.value) postMessage({ type: 'setDefaultWorkspaceFolder', folderKey });
}

function setDefaultModel(model: string): void {
  const before = defaultModel.value;
  write('damocles.model', { type: 'setDefaultModel', model }, {
    apply: () => settingsStore.setModelState(activeModel.value, model),
    revert: () => settingsStore.setModelState(activeModel.value, before),
  });
}

function setDefaultEffort(effort: EffortLevel): void {
  const state = defaultThinking.value;
  if (!state) return;
  const model = thinkingModelValue.value;
  write('damocles.effortByModel', { type: 'setDefaultEffort', effort, model }, {
    apply: () => settingsStore.setDefaultThinking({ ...state, effort }, model),
    revert: () => settingsStore.setDefaultThinking(state, model),
  });
}

function setDefaultThinkingDisabled(disabled: boolean): void {
  const state = defaultThinking.value;
  if (!state) return;
  const model = thinkingModelValue.value;
  write('damocles.thinkingDisabled', { type: 'setDefaultThinkingDisabled', disabled }, {
    apply: () => settingsStore.setDefaultThinking({ ...state, thinkingDisabled: disabled }, model),
    revert: () => settingsStore.setDefaultThinking(state, model),
  });
}

function setDefaultPermissionMode(mode: PermissionMode): void {
  const before = currentSettings.value.defaultPermissionMode;
  write('damocles.permissionMode', { type: 'setDefaultPermissionMode', mode }, {
    apply: () => settingsStore.setDefaultPermissionMode(mode),
    revert: () => settingsStore.setDefaultPermissionMode(before),
  });
}

// A remote host refusing YOLO for this computer: a new chat there starts without it until the user allows it on the host.
const yoloRefused = computed(() => hostCapabilities.value.bypassPermissions === false);
const allowHostYolo = useAllowHostYolo();
const chatHost = useSettingsChatHost();
// only a remote chat's tab whose host the desktop host may ask about notes the refusal and asks
const yoloAsk = computed(() => (yoloRefused.value && chatHost() ? allowHostYolo() : undefined));
const yoloSwitch = useTemplateRef<InstanceType<typeof SettingSwitch>>('yoloSwitch');
const askingYolo = ref(false);

async function allowYolo(anchor: Element | null): Promise<boolean> {
  const ask = yoloAsk.value;
  if (!ask || !anchor || askingYolo.value) return false;
  askingYolo.value = true;
  try {
    return await ask(visibleRect(anchor.getBoundingClientRect()));
  } catch (error) {
    // the desktop host has told the user about a failure and logged a refusal; nothing changes
    console.warn('[settings] allowHostYolo failed:', error);
    return false;
  } finally {
    askingYolo.value = false;
  }
}

async function setDefaultYolo(enabled: boolean): Promise<void> {
  if (askingYolo.value) return;
  if (enabled && yoloAsk.value && !(await allowYolo(yoloSwitch.value?.$el as Element | null))) return;
  write('damocles.dangerouslySkipPermissions', { type: 'setDefaultDangerouslySkipPermissions', enabled }, {
    apply: () => settingsStore.setDefaultDangerouslySkipPermissions(enabled),
    revert: () => settingsStore.setDefaultDangerouslySkipPermissions(!enabled),
  });
}

function setIdeContext(enabled: boolean): void {
  write('damocles.ideContext.enabled', { type: 'setIdeContextEnabled', enabled }, {
    apply: () => {
      settingsStore.setIdeContextEnabledDefault(enabled);
      uiStore.setIdeContextDefault(enabled);
    },
    revert: () => {
      settingsStore.setIdeContextEnabledDefault(!enabled);
      uiStore.setIdeContextDefault(!enabled);
    },
  });
}
</script>

<template>
  <SettingsRow
    v-if="isMultiRoot"
    id="default-workspace-folder"
  >
    <SettingSelect
      :model-value="defaultWorkspaceFolderKey"
      :options="folderOptions"
      :label="t('settingsModal.rows.defaultWorkspaceFolder.label')"
      @update:model-value="setDefaultFolder"
    />
  </SettingsRow>
  <SettingsRow id="damocles.model">
    <SettingSelect
      :model-value="defaultModel"
      :options="modelOptions(availableModels, unavailableHint)"
      :label="t('settingsModal.rows.defaultModel.label')"
      @update:model-value="setDefaultModel"
    />
  </SettingsRow>
  <SettingsRow
    v-if="defaultThinking && thinkingOn && adaptive && effortLevels.length > 0"
    id="damocles.effortByModel"
  >
    <SettingSeg
      :model-value="defaultThinking.effort ?? effortLevels[0]!"
      :options="effortOptions(effortLevels, t)"
      :label="t('settingsModal.rows.defaultEffort.label')"
      @update:model-value="setDefaultEffort"
    />
  </SettingsRow>
  <SettingsRow
    v-if="defaultThinking"
    id="damocles.thinkingDisabled"
    :description="disableApplies ? undefined : t('settings.thinkingAlwaysOn')"
  >
    <SettingSwitch
      :model-value="disableApplies && defaultThinking.thinkingDisabled"
      :label="t('settingsModal.rows.defaultDisableThinking.label')"
      :disabled="!disableApplies"
      @update:model-value="setDefaultThinkingDisabled"
    />
  </SettingsRow>
  <SettingsRow id="damocles.permissionMode">
    <SettingSeg
      :model-value="currentSettings.defaultPermissionMode"
      :options="permissionOptions(t)"
      :label="t('settingsModal.rows.defaultPermissionMode.label')"
      @update:model-value="setDefaultPermissionMode"
    />
  </SettingsRow>
  <SettingsRow id="damocles.dangerouslySkipPermissions">
    <template
      v-if="yoloAsk"
      #note
    >
      <p
        data-testid="default-yolo-refused"
        class="sm-feedback sm-feedback-warning flex flex-wrap items-center gap-x-2 gap-y-1"
      >
        <span class="flex min-w-0 items-center gap-1.5">
          <Lock
            aria-hidden="true"
            class="size-3 shrink-0"
          />
          {{ currentSettings.defaultDangerouslySkipPermissions
            ? t('settingsModal.rows.defaultYolo.refusedOn', { host: chatHost() })
            : t('settingsModal.rows.defaultYolo.refused', { host: chatHost() }) }}
        </span>
        <Button
          v-if="currentSettings.defaultDangerouslySkipPermissions"
          type="button"
          variant="outline"
          size="sm"
          data-testid="default-yolo-allow"
          class="h-6 rounded-7 px-2 text-11 aria-disabled:pointer-events-none aria-disabled:opacity-50"
          :aria-disabled="askingYolo ? 'true' : undefined"
          @click="allowYolo($event.currentTarget as Element | null)"
        >
          {{ t('settingsModal.rows.defaultYolo.allow') }}
        </Button>
      </p>
    </template>
    <SettingSwitch
      ref="yoloSwitch"
      :model-value="currentSettings.defaultDangerouslySkipPermissions"
      :label="t('settingsModal.rows.defaultYolo.label')"
      :aria-disabled="askingYolo ? 'true' : undefined"
      @update:model-value="setDefaultYolo"
    />
  </SettingsRow>
  <SettingsRow
    v-if="hostCapabilities.ideContext"
    id="damocles.ideContext.enabled"
  >
    <SettingSwitch
      :model-value="currentSettings.ideContextEnabled"
      :label="t('settingsModal.rows.ideContext.label')"
      @update:model-value="setIdeContext"
    />
  </SettingsRow>
</template>
