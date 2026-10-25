import { modelLabel, modelVendor } from '@shared/model-vendor';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { hasProviderLogo } from '@/components/icons/provider-logos';

export interface ModelIdentity {
  name: string;
  /** The provider whose logo ProviderLogo shows, or undefined for a model this panel does not list or a vendor without one. */
  logoProvider: string | undefined;
}

/** Resolves a model id or display label to its listed name and vendor logo; an unlisted model keeps its text and has no logo. */
export function useModelIdentity(): (model: string | null | undefined) => ModelIdentity | null {
  const settings = useSettingsStore();
  return (model) => {
    if (!model) return null;
    const info = settings.availableModels.find((candidate) => candidate.value === model || modelLabel(candidate) === model);
    if (!info) return { name: model, logoProvider: undefined };
    const vendor = modelVendor(info);
    return { name: info.displayName, logoProvider: hasProviderLogo(vendor) ? vendor : undefined };
  };
}
