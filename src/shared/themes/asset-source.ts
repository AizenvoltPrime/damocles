// The one source a ThemeSet asset names, read the same way by the permission gate, the permission handler and the tool.

// Must match the aspect literals in src/core/pi-session/tools/theme-tool-specs.ts.
export const THEME_IMAGE_ASPECTS = ['16:9', '16:10', '21:9', '3:2', '4:3', '1:1', '9:16'] as const;
export type ThemeImageAspect = (typeof THEME_IMAGE_ASPECTS)[number];

export type ThemeAssetSource =
  | { readonly kind: 'file'; readonly file: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'generate'; readonly prompt: string; readonly aspect?: ThemeImageAspect }
  | { readonly kind: 'attachment'; readonly index: number };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const named = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

export const ASSET_SOURCE_REFUSAL = 'asset.from names exactly one source: { file: path }, { url: https URL }, { generate: { prompt, aspect? } } or { attachment: n }.';

/** The source of ThemeSet's `asset`; undefined when the input has no asset, `refused` when `from` is not one source of its shape. */
export function themeAssetSource(input: Record<string, unknown>): ThemeAssetSource | { readonly refused: string } | undefined {
  const asset = input['asset'];
  if (asset === undefined) return undefined;
  const from = isRecord(asset) ? asset['from'] : undefined;
  const keys = isRecord(from) ? Object.keys(from) : [];
  if (!isRecord(from) || keys.length !== 1) return { refused: ASSET_SOURCE_REFUSAL };
  const value = from[keys[0]!];
  switch (keys[0]) {
    case 'file':
      return named(value) ? { kind: 'file', file: value } : { refused: ASSET_SOURCE_REFUSAL };
    case 'url':
      return named(value) ? { kind: 'url', url: value } : { refused: ASSET_SOURCE_REFUSAL };
    case 'generate': {
      if (!isRecord(value) || !named(value['prompt']) || Object.keys(value).some((key) => key !== 'prompt' && key !== 'aspect')) return { refused: ASSET_SOURCE_REFUSAL };
      const aspect = value['aspect'];
      if (aspect !== undefined && !THEME_IMAGE_ASPECTS.includes(aspect as ThemeImageAspect)) return { refused: `aspect is one of ${THEME_IMAGE_ASPECTS.join(', ')}.` };
      return { kind: 'generate', prompt: value['prompt'], ...(aspect !== undefined ? { aspect: aspect as ThemeImageAspect } : {}) };
    }
    case 'attachment':
      return typeof value === 'number' ? { kind: 'attachment', index: value } : { refused: ASSET_SOURCE_REFUSAL };
    default:
      return { refused: ASSET_SOURCE_REFUSAL };
  }
}

export const INSTALL_SOURCE_REFUSAL = 'install is { url: https URL } alone: call it with no other field.';

/** ThemeSet install's URL, judged as a WebFetch of it; undefined without install, `refused` for any other shape or another field. */
export function themeInstallSource(input: Record<string, unknown>): Extract<ThemeAssetSource, { kind: 'url' }> | { readonly refused: string } | undefined {
  const install = input['install'];
  if (install === undefined) return undefined;
  if (!isRecord(install) || Object.keys(install).length !== 1 || !named(install['url'])) return { refused: INSTALL_SOURCE_REFUSAL };
  if (Object.keys(input).some((key) => key !== 'install')) return { refused: INSTALL_SOURCE_REFUSAL };
  return { kind: 'url', url: install['url'] };
}

/** The one source a ThemeSet call is judged by: install's URL, else the asset's. */
export function themeCallSource(input: Record<string, unknown>): ThemeAssetSource | { readonly refused: string } | undefined {
  return input['install'] !== undefined ? themeInstallSource(input) : themeAssetSource(input);
}

/** The text the image model gets for a generate source, which its approval card shows whole. */
export function themeImagePrompt(source: { readonly prompt: string; readonly aspect?: ThemeImageAspect }): string {
  return source.aspect === undefined ? source.prompt : `${source.prompt}\n\nAspect ratio ${source.aspect} (width:height).`;
}
