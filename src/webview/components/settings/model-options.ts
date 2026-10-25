import { useI18n } from 'vue-i18n';
import { DEFAULT_MODELS } from '@shared/types/constants';
import { modelLabel } from '@shared/model-vendor';
import type { EffortLevel, ModelInfo, PermissionMode } from '@shared/types/settings';
import type { SegmentedOption } from '@/components/SegmentedToggle.vue';
import type { SelectOption } from './controls/SettingSelect.vue';
import { useSettingsChatHost } from './settings-view';

type Translate = (key: string, named?: Record<string, unknown>) => string;

// reka reserves '' for "no selection", so a select shows an unset setting as this value.
export const UNSET_OPTION = '__unset__';

/** `unavailable` names why a model cannot be picked; a model it gives a reason for is listed disabled with it. */
export function modelOptions(models: readonly ModelInfo[], unavailable?: (model: ModelInfo) => string | undefined): SelectOption<string>[] {
  return models.map((model) => {
    const hint = unavailable?.(model);
    const label = modelLabel(model);
    return hint === undefined ? { value: model.value, label } : { value: model.value, label, hint, disabled: true };
  });
}

/** The hint of a model core marked unavailable for this chat, which every model select lists disabled; undefined when it can be picked. */
export function unavailableHint(model: ModelInfo, t: Translate, host: string | undefined): string | undefined {
  switch (model.unavailable?.reason) {
    case 'not-in-plan':
      return t('settings.modelNotInPlan');
    case 'loopback-endpoint':
      return host === undefined ? t('settings.modelLoopbackEndpointHere') : t('settings.modelLoopbackEndpoint', { host });
    default:
      return undefined;
  }
}

/** {@link unavailableHint} for the chat the settings view is attached to. */
export function useUnavailableHint(): (model: ModelInfo) => string | undefined {
  const { t } = useI18n();
  const host = useSettingsChatHost();
  return (model) => unavailableHint(model, t, host());
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
