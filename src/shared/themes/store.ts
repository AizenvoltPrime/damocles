// What Browse shows of the community theme store (docs/themes.md "Community store"), as data: core sends it, main resolves its thumbnails
// to app:// URLs, the overlay words it. No Node or Electron imports.
import type { LocalizedText } from '../localized-text';
import type { LookColors, Panel } from './schema';
import type { LookKind } from './tokens';

// ok: a verified list, fetched now or within the last day; cached: the list request failed, so the last verified list
// shows, and it can still be installed from; unreachable: the request failed and no unexpired list is kept; refused: the list
// that came failed verification, so nothing of it shows; off: the store setting is off; empty: a verified list with no entries
export type StoreState = 'ok' | 'cached' | 'unreachable' | 'refused' | 'off' | 'empty';

// Outside text is cut to these many characters after cleaning; the list's payload may carry at most four times as many.
export const STORE_TEXT_LIMITS = { name: 64, author: 200, description: 1000, license: 64, reason: 500, version: 64 } as const;
export const MAX_STORE_ENTRIES = 2000;
// an entry's lists; the theme validator's output must fit them
export const MAX_ENTRY_THUMBS = 40;
export const MAX_ENTRY_FONTS = 16;
export const MAX_ENTRY_LICENSES = 64;
export const STORE_ENTRY_ID: RegExp = /^[a-z0-9][a-z0-9-]{0,63}$/;

// installed: the entry's version and file are the ones installed; update: another version or file, or the installed theme was
// marked removed and is listed again; needsNewerApp: the entry's minAppVersion is newer than this app, so core refuses to install it
export type StoreEntryStatus = 'available' | 'installed' | 'update' | 'needsNewerApp';

/** A wallpaper thumbnail core fetched and found matching its pinned sha256; a span's names the first panel it covers. */
export interface StoreThumb {
  readonly panel: Panel;
  readonly sha256: string;
}

/** One store entry; its texts are outside text, cleaned and length-limited by core. */
export interface StoreEntryView {
  readonly id: string;
  readonly name: string;
  readonly author: string;
  readonly description: string;
  readonly kinds: readonly LookKind[];
  readonly version: string;
  readonly colors: { readonly dark?: LookColors; readonly light?: LookColors };
  readonly fonts: readonly { readonly family: string; readonly license: string }[];
  readonly licenses: readonly string[];
  readonly hasCss: boolean;
  readonly hasLayout: boolean;
  readonly hasCharacters: boolean;
  // a wallpaper of a look is an animated image or a video
  readonly hasMoving: boolean;
  readonly minAppVersion: string;
  readonly thumbnails: { readonly dark?: readonly StoreThumb[]; readonly light?: readonly StoreThumb[] };
  readonly status: StoreEntryStatus;
  // installed and update: the installed theme from this entry
  readonly installedThemeId?: string;
  // update: the version that theme was installed at
  readonly installedVersion?: string;
}

export interface StoreView {
  readonly state: StoreState;
  // ok and cached: when the list shown was fetched, epoch ms
  readonly fetchedAt?: number;
  // refused and unreachable: why no list shows; cached: why the list request failed
  readonly refusedReason?: LocalizedText;
  readonly entries: readonly StoreEntryView[];
}
