import { DEFAULT_MODELS } from '@shared/types/constants';
import type { EffortLevel, ModelInfo, PermissionMode } from '@shared/types/settings';
import type { SegmentedOption } from '@/components/SegmentedToggle.vue';
import type { SelectOption } from './controls/SettingSelect.vue';

type Translate = (key: string) => string;

// reka reserves '' for "no selection", so a select shows an unset setting as this value.
export const UNSET_OPTION = '__unset__';

/** `unavailable` names why a model cannot be picked; a model it gives a reason for is listed disabled with it. */
export function modelOptions(models: readonly ModelInfo[], unavailable?: (model: ModelInfo) => string | undefined): SelectOption<string>[] {
  return models.map((model) => {
    const hint = unavailable?.(model);
    return hint === undefined ? { value: model.value, label: model.displayName } : { value: model.value, label: model.displayName, hint, disabled: true };
  });
}

/** Whether catalog `model` takes `effort`; '' and a model outside the catalog take none. */
export function supportsEffort(model: string, effort: EffortLevel): boolean {
  return DEFAULT_MODELS.find((candidate) => candidate.value === model)?.supportedEffortLevels?.includes(effort) ?? false;
}

export function effortOptions(levels: readonly EffortLevel[], t: Translate): SegmentedOption<EffortLevel>[] {
  return levels.map((level) => ({ value: level, label: t(`settingsModal.effort.${level}`) }));
}

export function permissionOptions(t: Translate): SegmentedOption<PermissionMode>[] {
  return (['default', 'acceptEdits', 'plan'] as const).map((mode) => ({ value: mode, label: t(`settings.permissionOptions.${mode}.label`) }));
}
