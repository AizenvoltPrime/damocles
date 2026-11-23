// The built-in example themes Damocles ships (resources/themes/<id>/, copied into dist/desktop-shell/themes/<id>/), read
// from inside app.asar through resource-fs. Read-only: a change makes a copy first.
import * as path from 'node:path';
import { BUILTIN_EXAMPLE_IDS } from '../../shared/themes/builtin';
import { validateTheme, type ThemeFile, themeErrorEnglish } from '../../shared/themes/schema';
import { readFile } from '../resource-fs';

// Must match builtinThemes() in vite.shell.config.ts and BUILTIN_THEMES_DIR in src/desktop/main/themes/theme-files.ts.
export const BUILTIN_THEMES_DIR = ['dist', 'desktop-shell', 'themes'] as const;
// Must match PACKED_EXTENSIONS in src/desktop/main/themes/theme-files.ts.
const PACKED_EXTENSIONS: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

/** A packed example's asset file, read from inside app.asar; undefined for a type no example packs. */
export async function readBuiltinAsset(resourceRoot: string, id: string, sha256: string, mime: string): Promise<Uint8Array | undefined> {
  const extension = PACKED_EXTENSIONS[mime];
  return extension === undefined ? undefined : readFile(path.join(resourceRoot, ...BUILTIN_THEMES_DIR, id, `${sha256}.${extension}`));
}

/** A packed example's LICENSE text. */
export async function readBuiltinLicense(resourceRoot: string, id: string): Promise<string> {
  return readFile(path.join(resourceRoot, ...BUILTIN_THEMES_DIR, id, 'LICENSE'), 'utf8');
}

export type BuiltinExample = { readonly id: string; readonly theme: ThemeFile } | { readonly id: string; readonly error: string };

/** Each example theme as its packed file holds it, validated as a built-in; one that does not read is an error, never thrown. */
export async function readBuiltinExamples(resourceRoot: string): Promise<BuiltinExample[]> {
  return Promise.all(BUILTIN_EXAMPLE_IDS.map(async (id): Promise<BuiltinExample> => {
    try {
      const json: unknown = JSON.parse(await readFile(path.join(resourceRoot, ...BUILTIN_THEMES_DIR, id, 'theme.json'), 'utf8'));
      const result = validateTheme(json, { builtin: true, folder: id });
      return result.ok ? { id, theme: result.theme } : { id, error: themeErrorEnglish(result.errors[0]) };
    } catch (err) {
      return { id, error: err instanceof Error ? err.message : String(err) };
    }
  }));
}
