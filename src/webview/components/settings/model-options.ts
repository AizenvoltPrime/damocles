import type { EffortLevel, ModelInfo, PermissionMode } from '@shared/types/settings';
import type { SegmentedOption } from '@/components/SegmentedToggle.vue';
import type { SelectOption } from './controls/SettingSelect.vue';

type Translate = (key: string) => string;

export function modelOptions(models: readonly ModelInfo[]): SelectOption<string>[] {
  return models.map((model) => ({ value: model.value, label: model.displayName }));
}

export function effortOptions(levels: readonly EffortLevel[], t: Translate): SegmentedOption<EffortLevel>[] {
  return levels.map((level) => ({ value: level, label: t(`settingsModal.effort.${level}`) }));
}

export function permissionOptions(t: Translate): SegmentedOption<PermissionMode>[] {
  return (['default', 'acceptEdits', 'plan'] as const).map((mode) => ({ value: mode, label: t(`settings.permissionOptions.${mode}.label`) }));
}
