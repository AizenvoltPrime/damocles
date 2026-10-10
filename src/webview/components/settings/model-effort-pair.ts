import { computed, type ComputedRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { DEFAULT_MODELS } from '@shared/types/constants';
import type { WebviewToExtensionMessage } from '@shared/types/messages';
import type { EffortLevel } from '@shared/types/settings';
import type { SelectOption } from './controls/SettingSelect.vue';
import { effortOptions, supportsEffort, UNSET_OPTION } from './model-options';
import { useSettingWrite } from './settings-writes';

/** A model setting ('' is its unset choice) and its effort (null is unset). */
export interface ModelEffort {
  model: string;
  effort: EffortLevel | null;
}

export interface ModelEffortPairOptions {
  read: () => ModelEffort;
  store: (next: ModelEffort) => void;
  modelKey: string;
  effortKey: string;
  modelMessage: (model: string) => WebviewToExtensionMessage;
  effortMessage: (effort: EffortLevel | null) => WebviewToExtensionMessage;
  /** The effort select's label for null. */
  effortUnsetLabel: () => string;
}

export interface ModelEffortPair {
  modelValue: ComputedRef<string>;
  effortValue: ComputedRef<string>;
  /** Empty when the model takes no effort, which hides the effort select. */
  effortChoices: ComputedRef<SelectOption<string>[]>;
  setModel: (value: string) => void;
  setEffort: (value: string) => void;
}

/**
 * The model and effort selects of one user setting pair. A model change drops an effort the new model does not take,
 * as the host's `supportedStoredEffort` does, and a failed write puts back only the fields that write changed.
 */
export function useModelEffortPair(options: ModelEffortPairOptions): ModelEffortPair {
  const { t } = useI18n();
  const write = useSettingWrite();

  const modelValue = computed(() => options.read().model || UNSET_OPTION);
  const effortValue = computed(() => options.read().effort ?? UNSET_OPTION);
  const effortChoices = computed<SelectOption<string>[]>(() => {
    const levels = DEFAULT_MODELS.find((model) => model.value === options.read().model)?.supportedEffortLevels ?? [];
    return levels.length === 0 ? [] : [{ value: UNSET_OPTION, label: options.effortUnsetLabel() }, ...effortOptions(levels, t)];
  });

  function set(next: Partial<ModelEffort>, key: string, message: WebviewToExtensionMessage): void {
    const before = options.read();
    const changed: Partial<ModelEffort> = {
      ...('model' in next ? { model: before.model } : {}),
      ...('effort' in next ? { effort: before.effort } : {}),
    };
    write(key, message, {
      apply: () => options.store({ ...options.read(), ...next }),
      revert: () => options.store({ ...options.read(), ...changed }),
    });
  }

  function setModel(value: string): void {
    const model = value === UNSET_OPTION ? '' : value;
    const { effort } = options.read();
    const keepsEffort = effort !== null && supportsEffort(model, effort);
    set(keepsEffort ? { model } : { model, effort: null }, options.modelKey, options.modelMessage(model));
  }

  function setEffort(value: string): void {
    const effort = value === UNSET_OPTION ? null : (value as EffortLevel);
    set({ effort }, options.effortKey, options.effortMessage(effort));
  }

  return { modelValue, effortValue, effortChoices, setModel, setEffort };
}
