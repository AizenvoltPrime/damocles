// What the theme editor holds for one session beyond its draft: what main told of each file it imported, the flashing
// allowances given, and every call to main that is still running. ThemeEditor.vue owns it, so a section that unmounts when
// its tab hides loses none of it, and an import that answers after a tab switch still lands in the draft.
import { reactive } from 'vue';
import type { SpriteImport } from '@shared/themes/characters';
import type { FontImport, FontRole } from '@shared/themes/fonts';
import type { ThemeFile } from '@shared/themes/schema';
import type { FlashRecord, ImageStats, WallpaperImport, WallpaperPalette } from '@shared/themes/wallpapers';
import type { DamoclesOverlayApi, ThemeEditorFontResult } from '../../../preload/overlay-channels';
import { failureText } from '../settings/themes/theme-text';

export interface KnownImage {
  readonly stats: ImageStats;
  readonly palette?: WallpaperPalette;
  readonly flash?: FlashRecord;
  readonly name?: string;
}

/**
 * Where an imported file goes: the draft as it is when the import answers, with the file placed at the destination the
 * section captured before it asked. A string is why it cannot be placed, undefined that its destination is gone. It runs
 * after its section may have unmounted, so it reads nothing but its arguments and what it captured.
 */
export type Place<T> = (draft: ThemeFile, imported: T) => ThemeFile | string | undefined;

export interface EditorImportsOptions {
  readonly api: DamoclesOverlayApi;
  // the open session's id, which every call names and every answer is checked against
  readonly sessionId: () => number | undefined;
  readonly draft: () => ThemeFile;
  readonly edit: (next: ThemeFile) => void;
  readonly t: (key: string, values?: Record<string, unknown>) => string;
}

export interface EditorImports {
  // by sha256: the wallpapers imported in this session, the sprites' flash checks, and the allowances given
  readonly images: Readonly<Record<string, KnownImage>>;
  readonly sprites: Readonly<Record<string, FlashRecord>>;
  readonly allowed: Readonly<Record<string, FlashRecord>>;
  readonly busy: { readonly image: boolean; readonly sprite: boolean; readonly font: FontRole | undefined; readonly allowing: boolean };
  // a moving wallpaper's flash check, 0 to 1, while its import waits on it
  readonly checking: number | undefined;
  // what each section shows as its failure
  readonly failure: { readonly wallpapers?: string; readonly characters?: string; readonly type?: { readonly role: FontRole; readonly text: string } };
  // a section's own refusal, shown where its failures are and kept while its tab is hidden; and the end of one
  fail(section: 'wallpapers' | 'characters', text: string): void;
  clear(section: 'wallpapers' | 'characters' | 'type'): void;
  importImage(place: Place<WallpaperImport>): Promise<boolean>;
  importSprite(strip: { readonly frames: number; readonly fps: number } | undefined, place: Place<SpriteImport>): Promise<boolean>;
  importFont(role: FontRole, request: (sessionId: number) => Promise<ThemeEditorFontResult>, place: Place<FontImport>): Promise<boolean>;
  allowFlash(section: 'wallpapers' | 'characters', sha256: string): Promise<void>;
  progress(fraction: number): void;
  // a new session: nothing of the last one stays
  reset(): void;
}

export function createEditorImports(options: EditorImportsOptions): EditorImports {
  const state = reactive({
    images: {} as Record<string, KnownImage>,
    sprites: {} as Record<string, FlashRecord>,
    allowed: {} as Record<string, FlashRecord>,
    busy: { image: false, sprite: false, font: undefined as FontRole | undefined, allowing: false },
    checking: undefined as number | undefined,
    failure: {} as { wallpapers?: string; characters?: string; type?: { readonly role: FontRole; readonly text: string } },
  });

  // One call to main: its ok answer, or undefined after the failure was shown, the dialog was cancelled, or the session ended.
  async function call<R extends { readonly ok: boolean }>(request: (sessionId: number) => Promise<R>, fail: (text: string) => void): Promise<Extract<R, { readonly ok: true }> | undefined> {
    const sessionId = options.sessionId();
    if (sessionId === undefined) return undefined;
    let result: R;
    try {
      result = await request(sessionId);
    } catch (err) {
      if (options.sessionId() === sessionId) fail(failureText(options.t, err, 'action'));
      return undefined;
    }
    if (options.sessionId() !== sessionId) return undefined;
    if (result.ok) return result as Extract<R, { readonly ok: true }>;
    if ('error' in result && typeof result.error === 'string') fail(result.error);
    return undefined;
  }

  function placed<T>(place: Place<T>, imported: T, fail: (text: string) => void): boolean {
    const next = place(options.draft(), imported);
    if (typeof next === 'string') fail(next);
    else if (next) options.edit(next);
    return typeof next === 'object';
  }

  return Object.assign(state, {
    fail(section: 'wallpapers' | 'characters', text: string): void {
      state.failure[section] = text;
    },
    clear(section: 'wallpapers' | 'characters' | 'type'): void {
      delete state.failure[section];
    },
    async importImage(place: Place<WallpaperImport>): Promise<boolean> {
      if (state.busy.image) return false;
      const fail = (text: string): void => {
        state.failure.wallpapers = text;
      };
      const busy = state.busy;
      busy.image = true;
      state.checking = undefined;
      delete state.failure.wallpapers;
      try {
        const result = await call((sessionId) => options.api.themeEditor.importImageFile(sessionId), fail);
        if (!result) return false;
        const { image } = result;
        state.images[image.sha256] = { stats: image.stats, palette: image.palette, ...(image.flash ? { flash: image.flash } : {}), name: result.name };
        return placed(place, image, fail);
      } finally {
        busy.image = false;
        if (state.busy === busy) state.checking = undefined;
      }
    },
    async importSprite(strip: { readonly frames: number; readonly fps: number } | undefined, place: Place<SpriteImport>): Promise<boolean> {
      if (state.busy.sprite) return false;
      const fail = (text: string): void => {
        state.failure.characters = text;
      };
      const busy = state.busy;
      busy.sprite = true;
      delete state.failure.characters;
      try {
        const result = await call((sessionId) => options.api.themeEditor.importSpriteFile(sessionId, strip), fail);
        if (!result) return false;
        if (result.sprite.flash) state.sprites[result.sprite.sha256] = result.sprite.flash;
        return placed(place, result.sprite, fail);
      } finally {
        busy.sprite = false;
      }
    },
    async importFont(role: FontRole, request: (sessionId: number) => Promise<ThemeEditorFontResult>, place: Place<FontImport>): Promise<boolean> {
      if (state.busy.font !== undefined) return false;
      const fail = (text: string): void => {
        state.failure.type = { role, text };
      };
      const busy = state.busy;
      busy.font = role;
      delete state.failure.type;
      try {
        const result = await call(request, fail);
        return result ? placed(place, result.font, fail) : false;
      } finally {
        busy.font = undefined;
      }
    },
    async allowFlash(section: 'wallpapers' | 'characters', sha256: string): Promise<void> {
      if (state.busy.allowing) return;
      const busy = state.busy;
      busy.allowing = true;
      delete state.failure[section];
      try {
        const result = await call((sessionId) => options.api.themeEditor.allowFlash(sessionId, sha256), (text) => {
          state.failure[section] = text;
        });
        if (result) state.allowed[sha256] = result.flash;
      } finally {
        busy.allowing = false;
      }
    },
    progress(fraction: number): void {
      if (state.busy.image) state.checking = fraction;
    },
    reset(): void {
      state.images = {};
      state.sprites = {};
      state.allowed = {};
      // a new object: a call of the session before clears its own flags, never this session's
      state.busy = { image: false, sprite: false, font: undefined, allowing: false };
      state.checking = undefined;
      state.failure = {};
    },
  });
}
