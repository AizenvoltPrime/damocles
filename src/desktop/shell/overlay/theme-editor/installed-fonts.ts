// The fonts installed on this computer, through the Local Font Access API; main grants local-fonts only to the theme editor
// dock's page and the overlay's main frame (docs/invariants.md "Desktop host").
import { FONT_NAME, MAX_FONT_BYTES, reservedFontName } from '@shared/themes/fonts';

interface LocalFontData {
  readonly family: string;
  readonly style: string;
  readonly fullName: string;
  readonly postscriptName: string;
  blob(): Promise<Blob>;
}

type QueryLocalFonts = () => Promise<LocalFontData[]>;

let faces: Promise<LocalFontData[]> | undefined;

function query(): Promise<LocalFontData[]> {
  const fn = (globalThis as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts;
  if (typeof fn !== 'function') return Promise.reject(new Error('queryLocalFonts is not available'));
  faces ??= fn().catch((err: unknown) => {
    faces = undefined;
    throw err;
  });
  return faces;
}

/** Drops the list read for the dock's last session, so fonts installed since are listed. */
export function forgetInstalledFonts(): void {
  faces = undefined;
}

/** Every installed family a theme may name, once, sorted by name; rejects when the page may not list them. */
export async function installedFamilies(): Promise<string[]> {
  const families = new Set((await query()).map((face) => face.family).filter((family) => family.trim() !== '' && FONT_NAME.test(family) && !reservedFontName(family)));
  return [...families].sort((a, b) => a.localeCompare(b));
}

/**
 * The file of an installed family's regular face, or its first face; `tooLarge` past what a theme bundles, checked before
 * the file is read; undefined when the family is not installed.
 */
export async function installedFontFile(family: string): Promise<Uint8Array | 'tooLarge' | undefined> {
  const matching = (await query()).filter((face) => face.family === family);
  const face = matching.find((candidate) => /^(?:regular|normal|book|roman)$/i.test(candidate.style)) ?? matching[0];
  if (!face) return undefined;
  const blob = await face.blob();
  return blob.size > MAX_FONT_BYTES ? 'tooLarge' : new Uint8Array(await blob.arrayBuffer());
}
