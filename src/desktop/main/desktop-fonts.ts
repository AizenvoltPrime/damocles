// No imports: vite.shell.config.ts imports this table to copy the files, and theme.ts declares the same files in @font-face.

export interface DesktopFontFile {
  readonly family: string;
  readonly pkg: string;
  // the file under the package's files/ directory
  readonly source: string;
  // the file name under dist/desktop-shell/fonts/
  readonly output: string;
  // equal to the package's own wght.css for this file (theme-parity.test.ts checks it)
  readonly unicodeRange: string;
}

const GEIST = '@fontsource-variable/geist';
const GEIST_MONO = '@fontsource-variable/geist-mono';
const INTER = '@fontsource-variable/inter';

const CYRILLIC_EXT = 'U+0460-052F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F';
const CYRILLIC = 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116';
const VIETNAMESE = 'U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB';
const LATIN_EXT = 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';
const LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';

function subsets(family: string, pkg: string, prefix: string, ranges: Readonly<Record<string, string>>): DesktopFontFile[] {
  return Object.entries(ranges).map(([subset, unicodeRange]) => ({
    family,
    pkg,
    source: `${prefix}-${subset}-wght-normal.woff2`,
    output: `${prefix}-${subset}.woff2`,
    unicodeRange,
  }));
}

// Geist has no Greek glyphs, so Inter's greek subsets follow it in --d-font.
export const DESKTOP_FONT_FILES: readonly DesktopFontFile[] = [
  ...subsets('Geist Variable', GEIST, 'geist', { 'cyrillic-ext': CYRILLIC_EXT, cyrillic: CYRILLIC, vietnamese: VIETNAMESE, 'latin-ext': LATIN_EXT, latin: LATIN }),
  ...subsets('Geist Mono Variable', GEIST_MONO, 'geist-mono', {
    'cyrillic-ext': CYRILLIC_EXT,
    cyrillic: CYRILLIC,
    symbols2: 'U+2000-2001,U+2004-2008,U+200A,U+23B8-23BD,U+2500-259F',
    vietnamese: VIETNAMESE,
    'latin-ext': LATIN_EXT,
    latin: LATIN,
  }),
  ...subsets('Inter Variable', INTER, 'inter', {
    'greek-ext': 'U+1F00-1FFF',
    greek: 'U+0370-0377,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03FF',
  }),
];

export const DESKTOP_FONT_LICENSES: ReadonlyArray<{ readonly pkg: string; readonly output: string }> = [
  { pkg: GEIST, output: 'geist-OFL.txt' },
  { pkg: GEIST_MONO, output: 'geist-mono-OFL.txt' },
  { pkg: INTER, output: 'inter-OFL.txt' },
];
