import { computed, type ComputedRef } from 'vue';
import { storeToRefs } from 'pinia';
import type { ModelInfo } from '@shared/types/settings';
import { modelVendor } from '@shared/model-vendor';
import { useSettingsStore } from '@/stores/useSettingsStore';

/** The chat's models whose vendor core lists in the picker, plus the chat's current model; every model until core has said. */
export function usePickerModels(): ComputedRef<ModelInfo[]> {
  const { availableModels, activeModel, defaultModel, accountInfo } = storeToRefs(useSettingsStore());
  return computed(() => {
    const shown = accountInfo.value?.pickerProviders;
    if (!shown) return availableModels.value;
    const current = activeModel.value || defaultModel.value;
    return availableModels.value.filter((model) => model.value === current || shown.includes(modelVendor(model)));
  });
}
