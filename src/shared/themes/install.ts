// What the install card, the export flow and core exchange about sharing themes (docs/themes.md "Sharing"), as data: core sends
// it, the renderers word it. No Node or Electron imports.
import type { LocalizedText } from '../localized-text';
import type { ThemeContrastIssue } from './agent';
import type { CssDroppedPart } from './css-types';
import type { CssRegion, Panel, ThemeFile } from './schema';
import type { LookKind } from './tokens';

// The `.damocles-theme` file name extension, without its dot.
export const THEME_ARCHIVE_EXTENSION = 'damocles-theme';

/**
 * Where an install came from: a file the user picked, a URL pasted in Settings, a damocles:// link, the agent's ThemeSet, or
 * Browse's Install or Update of a community store entry.
 */
export type ThemeInstallSourceKind = 'file' | 'url' | 'link' | 'agent' | 'store';

/** What prepare reads: a file on this computer, or an https URL pasted in Settings or carried by a damocles:// link. */
export type ThemeInstallFrom =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'link'; readonly url: string };

export interface ThemeInstallSource {
  readonly kind: ThemeInstallSourceKind;
  // the https host the file came from, shown prominently; absent for a file
  readonly host?: string;
  // the picked file's or the URL path's last segment
  readonly fileName?: string;
}

// damocles: a .damocles-theme file; vscode: a VS Code color theme (.json, JSONC or a .vsix's theme)
export type ThemeInstallFormat = 'damocles' | 'vscode';

// none: a still image needs no flash check; pending: the theme renderer is checking it; unchecked: the check failed, so the file
// never plays until a later check passes
export type ThemeInstallFlash = 'none' | 'pending' | 'clear' | 'flagged' | 'unchecked';

/** Where a wallpaper sits: one look's panels, as its own image or as a span across them. */
export interface ThemeInstallPlacement {
  readonly look: LookKind;
  readonly panels: readonly Panel[];
  readonly span: boolean;
}

export interface ThemeInstallWallpaper {
  readonly sha256: string;
  readonly kind: 'image' | 'animated' | 'video';
  readonly mime: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly frames?: number;
  readonly durationMs?: number;
  readonly placements: readonly ThemeInstallPlacement[];
  readonly flash: ThemeInstallFlash;
  // a flagged file: where the first flash run starts
  readonly atMs?: number;
  // a flagged file this computer's user allowed to flash (cache/<sha256>/flash.json), never a theme file or the agent
  readonly allowed?: true;
  // the 480 px thumbnail as a data:image/webp URL once the theme renderer analyzed it; no staged blob is served before commit
  readonly thumb?: string;
}

/** A font the theme names: bundled in the file, or an installed font by name, which this computer may lack. */
export interface ThemeInstallFont {
  readonly family: string;
  readonly role: 'ui' | 'mono';
  readonly source: 'bundled' | 'installed';
  readonly bytes?: number;
  readonly license: { readonly spdx?: string; readonly text?: string; readonly author?: string; readonly source?: string };
}

/** One region of the theme's custom CSS: its size as the file holds it and what the sanitizer would drop. */
export interface ThemeInstallCss {
  readonly region: CssRegion;
  readonly bytes: number;
  readonly dropped: readonly CssDroppedPart[];
}

/** The theme's own texts, from outside this computer: one line each, control and bidi characters gone, length-limited. */
export interface ThemeInstallAbout {
  readonly name: string;
  readonly description?: string;
  readonly author?: string;
  readonly version?: string;
  readonly license?: string;
}

/** An installed theme with the same name; Keep both installs as keepBothName, Replace takes the installed one's id. */
export interface ThemeInstallClash {
  readonly themeId: string;
  readonly name: string;
  readonly keepBothName: string;
  // a built-in theme is never replaced: only Keep both is offered
  readonly replaceable: boolean;
  // the installed one differs from what was installed (or is the user's own), so Replace keeps it as a copy named keepBothName
  readonly keepsCopy: boolean;
}

export interface ThemeInstallPreview {
  readonly installId: string;
  readonly source: ThemeInstallSource;
  readonly format: ThemeInstallFormat;
  readonly about: ThemeInstallAbout;
  // validated, origin stripped, custom CSS as the sanitizer keeps it; ThemeMiniature draws it. Its blobs are not served before commit.
  readonly theme: ThemeFile;
  readonly wallpapers: readonly ThemeInstallWallpaper[];
  readonly fonts: readonly ThemeInstallFont[];
  readonly css: readonly ThemeInstallCss[];
  // how many more parts the sanitizer would drop than the regions of `css` list together; absent when they list them all
  readonly cssDroppedMore?: number;
  readonly characters?: { readonly name: string; readonly count: number };
  // the theme has a window arrangement (theme.layout): the card offers "Use this theme's window arrangement", off by default
  readonly arrangement: boolean;
  readonly contrast: readonly ThemeContrastIssue[];
  // the file's size as read, or the archive's uncompressed total
  readonly totalBytes: number;
  readonly warnings: readonly LocalizedText[];
  readonly clash?: ThemeInstallClash;
  // a store entry whose file matched its pin in the signed list
  readonly store?: ThemeInstallStore;
}

/** A store install; an Update replaces the installed theme from the same entry and keeps its id. */
export interface ThemeInstallStore {
  readonly entryId: string;
  readonly version: string;
  readonly update?: {
    readonly themeId: string;
    readonly fromVersion: string;
    // the installed theme was edited since it was installed: those edits are saved first as a copy of this name
    readonly yourEditsName?: string;
  };
}

/** How far the flash check of a staged install's moving wallpaper is, 0 to 1, while it runs. */
export interface ThemeInstallProgress {
  readonly installId: string;
  readonly sha256: string;
  readonly fraction: number;
}

export type ThemeInstallClashChoice = 'keepBoth' | 'replace';

/** The card's answer; onClash is required when the preview has a clash. */
export type ThemeInstallAnswer =
  | { readonly choice: 'install'; readonly onClash?: ThemeInstallClashChoice; readonly useArrangement: boolean }
  | { readonly choice: 'cancel' };

export interface ThemeInstallCommit {
  readonly installId: string;
  readonly onClash?: ThemeInstallClashChoice;
  readonly useArrangement: boolean;
}

export interface ThemeInstalled {
  readonly themeId: string;
  readonly name: string;
  // Replace: the id is the replaced theme's, so its references hold
  readonly replaced: boolean;
  // Replace of an edited theme: the edits kept under a new id
  readonly keptCopy?: { readonly themeId: string; readonly name: string };
}

export type ThemeInstallPrepared = { readonly preview: ThemeInstallPreview } | { readonly refused: LocalizedText };
// `preview`: the name clash changed since the card showed it; the install stays staged and the card asks again with this preview
export type ThemeInstallCommitted = { readonly installed: ThemeInstalled } | { readonly refused: LocalizedText; readonly preview?: ThemeInstallPreview };

// confirm: OFL, Apache or Ubuntu Font Licence, packed after one confirm; warn: packed after the user accepts that sharing is their
// responsibility; refused: Restricted License embedding, too large, a collection or unreadable; nameOnly: an installed font whose
// bytes were not given, exported as its name, which the receiving computer must have
export type ThemeExportVerdict = 'confirm' | 'warn' | 'refused' | 'nameOnly';

export interface ThemeExportFont {
  readonly family: string;
  readonly role: 'ui' | 'mono';
  readonly source: 'bundled' | 'installed';
  readonly verdict: ThemeExportVerdict;
  readonly spdx?: string;
  readonly licenseUrl?: string;
  // the font's own license text, cut to EXPORT_LICENSE_TEXT_CHARS
  readonly licenseText?: string;
  readonly refusal?: LocalizedText;
}

export const EXPORT_LICENSE_TEXT_CHARS = 2000;

// An export carries at most this many installed fonts: a theme names a ui and a mono font.
export const MAX_EXPORT_FONTS = 2;

/** An installed font's bytes as the overlay read them with queryLocalFonts(), one face per family. */
export interface ThemeExportFontBytes {
  readonly family: string;
  readonly bytes: Uint8Array;
}

export interface ThemeExportPlan {
  readonly themeId: string;
  readonly name: string;
  // the file name the save dialog proposes: the theme name with what Windows refuses removed, plus .damocles-theme
  readonly fileName: string;
  readonly fonts: readonly ThemeExportFont[];
}

export type ThemeExportPlanned = { readonly plan: ThemeExportPlan } | { readonly refused: LocalizedText };
export type ThemeExportWritten = { readonly written: { readonly bytes: number } } | { readonly refused: LocalizedText };
