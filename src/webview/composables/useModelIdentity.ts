import type { ModelInfo } from '@shared/types/settings';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { providerLogoSvg } from '@/components/icons/provider-logos';

export interface ModelIdentity {
  name: string;
  /** Static vendored SVG markup, or undefined for a model this panel does not list. */
  logo: string | undefined;
}

export type ModelVendor = 'anthropic' | 'openai' | NonNullable<ModelInfo['piProvider']>;

/** The vendor whose logo and group a listed model shows under. */
export function modelVendor(model: ModelInfo): ModelVendor {
  return model.backend === 'openai' ? 'openai' : (model.piProvider ?? 'anthropic');
}

/** Resolves a model id or display label to its listed name and vendor logo; an unlisted model keeps its text and has no logo. */
export function useModelIdentity(): (model: string | null | undefined) => ModelIdentity | null {
  const settings = useSettingsStore();
  return (model) => {
    if (!model) return null;
    const info = settings.availableModels.find((candidate) => candidate.value === model || candidate.displayName === model);
    if (!info) return { name: model, logo: undefined };
    return { name: info.displayName, logo: providerLogoSvg(modelVendor(info)) };
  };
}
