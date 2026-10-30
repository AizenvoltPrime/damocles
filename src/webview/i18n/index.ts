import { createI18n } from 'vue-i18n';
import type { WebviewToExtensionMessage } from '@shared/types/messages';
import en from './locales/en.json';

type SupportedLocale = 'en' | 'el';
type CoreCatalog = Readonly<Record<string, string>>;

const SUPPORTED_LOCALES: readonly SupportedLocale[] = ['en', 'el'] as const;

function isSupportedLocale(locale: string): locale is SupportedLocale {
  return SUPPORTED_LOCALES.includes(locale as SupportedLocale);
}

export const i18n = createI18n({
  legacy: false,
  locale: 'en' satisfies SupportedLocale,
  fallbackLocale: 'en' satisfies SupportedLocale,
  messages: { en } as Partial<Record<SupportedLocale, typeof en>>,
});

// English ships in the entry and core's English is each catalog key itself; any other language is its own lazy chunk.
const LOADERS: Readonly<Record<Exclude<SupportedLocale, 'en'>, () => Promise<readonly [typeof en, CoreCatalog]>>> = {
  el: () => Promise.all([import('./locales/el.json'), import('../../../l10n/bundle.l10n.el.json')]).then(([view, core]) => [view.default, core.default] as const),
};

const coreCatalogs = new Map<string, CoreCatalog>();
const loads = new Map<SupportedLocale, Promise<boolean>>();
let requested: SupportedLocale = 'en';

/** Core's catalog for `locale` once it has loaded; undefined for English, whose keys are the text itself. */
export function coreCatalog(locale: string): CoreCatalog | undefined {
  return coreCatalogs.get(locale);
}

function loaded(locale: SupportedLocale): boolean {
  return locale === 'en' || coreCatalogs.has(locale);
}

/** Whether applyLocale shows `locale` at once: English, or a language whose catalogs have loaded. */
export function localeReady(locale: string): boolean {
  return loaded(normalizeLocale(locale));
}

/** Loads `locale`'s catalogs without showing it; false, logged, when a chunk fails to load, which a later call tries again. */
export function loadLocale(locale: string): Promise<boolean> {
  const target = normalizeLocale(locale);
  return loaded(target) ? Promise.resolve(true) : load(target as Exclude<SupportedLocale, 'en'>);
}

function load(locale: Exclude<SupportedLocale, 'en'>): Promise<boolean> {
  const pending = loads.get(locale) ?? LOADERS[locale]().then(
    ([view, core]) => {
      i18n.global.setLocaleMessage(locale, view);
      coreCatalogs.set(locale, core);
      return true;
    },
    (err: unknown) => {
      loads.delete(locale);
      console.error(`[i18n] the ${locale} catalogs did not load, so the view keeps its language:`, err);
      return false;
    },
  );
  loads.set(locale, pending);
  return pending;
}

/** Narrowed to the one message this module sends, so `postMessage` can be handed over directly
 *  instead of being widened to a shape the extension host does not accept. */
type MessageSender = (message: Extract<WebviewToExtensionMessage, { type: "setLanguagePreference" }>) => void;

let sendMessage: MessageSender | null = null;

export function initLocaleMessaging(messageSender: MessageSender) {
  sendMessage = messageSender;
}

function normalizeLocale(locale: string): SupportedLocale {
  const normalized = locale.split('-')[0] ?? '';
  return isSupportedLocale(normalized) ? normalized : 'en';
}

// The page's language too: text-transform: uppercase drops Greek accents only under lang="el".
function showLocale(locale: SupportedLocale): void {
  i18n.global.locale.value = locale;
  document.documentElement.lang = locale;
}

/**
 * Shows `locale` once its catalogs have loaded, at once when they already have; of overlapping switches the last one asked
 * for wins. A language whose catalogs fail to load is logged and not shown, so the view keeps the language it renders in.
 */
export function applyLocale(locale: string): Promise<void> {
  const target = normalizeLocale(locale);
  requested = target;
  if (loaded(target)) {
    showLocale(target);
    return Promise.resolve();
  }
  return load(target as Exclude<SupportedLocale, 'en'>).then((ok) => {
    if (ok && requested === target) showLocale(target);
  });
}

export function setLocale(locale: string): Promise<void> {
  const normalizedLocale = normalizeLocale(locale);
  if (sendMessage) {
    sendMessage({ type: "setLanguagePreference", locale: normalizedLocale });
  }
  return applyLocale(normalizedLocale);
}

/** Mounts the view once the language its host built the page in (`<html lang>`) is ready, so its first render is in it. */
export function mountInInitialLocale(mount: () => void): Promise<void> {
  return applyLocale(document.documentElement.lang).then(mount);
}
