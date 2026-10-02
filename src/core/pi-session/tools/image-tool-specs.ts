import type { ImageApi, ImageModel } from '@earendil-works/pi-ai';
import type { ToolCatalogEntry } from '@shared/types/tools';
import { TOOL_GENERATE_IMAGE } from '../../../shared/tool-names';

/**
 * The image tool's active-set name and Tools-panel row, and nothing else. Only type imports and the
 * leaf `tool-names` module, so `tools/deferred-tools.ts` can compose the name without loading the tool
 * body (see the import-discipline guard in `tool-search.test.ts`).
 */

export const IMAGE_PI_TOOL_NAMES: readonly string[] = [TOOL_GENERATE_IMAGE];

/** pi's image models are OpenRouter's; the key is the `damocles.explore.apiKey.openrouter` runtime key. */
export const IMAGE_PROVIDER = 'openrouter';

/**
 * Whether Damocles offers this catalog model: every price finite and non-negative, and a positive output
 * token price, because the image is the output and pi's token-priced `usage` is the recorded spend whenever
 * OpenRouter's response carries no billed `usage.cost`.
 * A negative price is OpenRouter's "variable price" sentinel (`openrouter/auto`), which pi turns into a
 * negative cost that disables the budget limit; a zero output price means per-image billing pi records as $0.
 */
export function isOfferedImageModel(model: ImageModel<ImageApi>): boolean {
  const prices = Object.values(model.cost);
  return prices.every((price) => Number.isFinite(price) && price >= 0) && model.cost.output > 0;
}

export const IMAGE_SETTINGS_SECTION = 'damocles.imageGeneration';
/** User scope only: package.json lists it in `restrictedConfigurations` with `scope: application`. */
export const IMAGE_ENABLED_SETTING = 'damocles.imageGeneration.enabled';
export const IMAGE_MODEL_SETTING = 'damocles.imageGeneration.model';

export const IMAGE_TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  {
    name: TOOL_GENERATE_IMAGE,
    label: 'Generate image',
    description: 'Generate an image with an OpenRouter model and save it as a new file.',
    group: 'image',
    toggleable: true,
  },
];
