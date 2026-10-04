import { inject, provide, shallowRef, watch, type InjectionKey, type Ref, type ShallowRef } from 'vue';
import type { SettingsSectionId, SettingsTarget } from '@shared/settings-sections';
import type { SettingsFileScope } from '@shared/types/messages';
import type { SettingsRowMeta } from './settings-rows';

/** Rows enter staggered by this many ms each, for the first STAGGERED_ROWS rows of a page only (M4). */
export const ROW_STAGGER_MS = 25;
export const STAGGERED_ROWS = 12;

/**
 * One rendered page of the modal: a section, or the search results across sections. The page is keyed on the section,
 * so its rows stay mounted while the query changes, and each query restarts the stagger for the rows it shows.
 */
export interface SettingsPage {
  /** Normalized; '' when no search is active. */
  readonly query: string;
  meta(id: string): SettingsRowMeta | undefined;
  /** Taken by a row each time it is shown; a row's stagger delay comes from it. */
  nextIndex(): number;
  /** The rows on screen per section, which the search header counts and the empty state reads. */
  readonly shown: ShallowRef<ReadonlyMap<string, SettingsSectionId>>;
  show(id: string, section: SettingsSectionId): void;
  hide(id: string): void;
}

const PAGE: InjectionKey<SettingsPage> = Symbol('settingsPage');

export function provideSettingsPage(query: () => string, rows: ReadonlyMap<string, SettingsRowMeta>): SettingsPage {
  let index = 0;
  // Runs before the rows' watchers and before the rows the new query mounts, which take their slots from zero.
  watch(query, () => (index = 0));
  const shown = shallowRef<ReadonlyMap<string, SettingsSectionId>>(new Map());
  const page: SettingsPage = {
    get query() {
      return query();
    },
    meta: (id) => rows.get(id),
    nextIndex: () => index++,
    shown,
    show(id, section) {
      if (shown.value.get(id) === section) return;
      shown.value = new Map(shown.value).set(id, section);
    },
    hide(id) {
      if (!shown.value.has(id)) return;
      const next = new Map(shown.value);
      next.delete(id);
      shown.value = next;
    },
  };
  provide(PAGE, page);
  return page;
}

export function useSettingsPage(): SettingsPage {
  const page = inject(PAGE, null);
  if (!page) throw new Error('A settings row rendered outside a settings page');
  return page;
}

/** Splits `text` around case-insensitive matches of `query`, for <mark> highlighting. */
export function highlightParts(text: string, query: string): { text: string; match: boolean }[] {
  if (query === '') return [{ text, match: false }];
  const lower = text.toLocaleLowerCase();
  const parts: { text: string; match: boolean }[] = [];
  let from = 0;
  for (let at = lower.indexOf(query); at !== -1; at = lower.indexOf(query, from)) {
    if (at > from) parts.push({ text: text.slice(from, at), match: false });
    parts.push({ text: text.slice(at, at + query.length), match: true });
    from = at + query.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), match: false });
  return parts;
}

/** An inline notice at the top of the modal's content, such as the Language row's restart offer (M9). */
export interface SettingsBanner {
  readonly testId: string;
  readonly text: string;
  readonly actions: readonly { readonly label: string; readonly primary?: boolean; readonly run: () => void }[];
}

export interface SettingsBannerSlot {
  show(banner: SettingsBanner): void;
  dismiss(): void;
}

const BANNER: InjectionKey<SettingsBannerSlot> = Symbol('settingsBanner');

export function provideSettingsBanner(slot: SettingsBannerSlot): void {
  provide(BANNER, slot);
}

export function useSettingsBanner(): SettingsBannerSlot {
  const slot = inject(BANNER, null);
  if (!slot) throw new Error('useSettingsBanner called outside the settings modal');
  return slot;
}

/** The request that opened the modal or reached it while open; null once the user picks a section. */
const TARGET: InjectionKey<Readonly<ShallowRef<SettingsTarget | null>>> = Symbol('settingsTarget');

export function provideSettingsTarget(target: Readonly<ShallowRef<SettingsTarget | null>>): void {
  provide(TARGET, target);
}

export function useSettingsTarget(): Readonly<ShallowRef<SettingsTarget | null>> {
  const target = inject(TARGET, null);
  if (!target) throw new Error('useSettingsTarget called outside the settings modal');
  return target;
}

/** What the Workspace section's list of values from settings files needs from the modal. */
export interface SettingsFiles {
  /** The damocles.* keys a row of a shown section writes; a file's value for any other key is listed. */
  readonly rowKeys: Readonly<Ref<ReadonlySet<string>>>;
  /** Opens a settings file the way the footer's Edit settings.json menu does. */
  open(scope: SettingsFileScope): void;
}

const FILES: InjectionKey<SettingsFiles> = Symbol('settingsFiles');

export function provideSettingsFiles(files: SettingsFiles): void {
  provide(FILES, files);
}

export function useSettingsFiles(): SettingsFiles {
  const files = inject(FILES, null);
  if (!files) throw new Error('useSettingsFiles called outside the settings modal');
  return files;
}
