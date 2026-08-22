import { createI18n } from 'vue-i18n';
import type { WebviewToExtensionMessage } from '@shared/types/messages';
import en from './locales/en.json';
import el from './locales/el.json';

type SupportedLocale = 'en' | 'el';

const SUPPORTED_LOCALES: readonly SupportedLocale[] = ['en', 'el'] as const;

function isSupportedLocale(locale: string): locale is SupportedLocale {
  return SUPPORTED_LOCALES.includes(locale as SupportedLocale);
}

export const i18n = createI18n({
  legacy: false,
  locale: 'en' satisfies SupportedLocale,
  fallbackLocale: 'en' satisfies SupportedLocale,
  messages: {
    en,
    el,
  },
});

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

export function setLocale(locale: string) {
  const normalizedLocale = normalizeLocale(locale);
  i18n.global.locale.value = normalizedLocale;

  if (sendMessage) {
    sendMessage({ type: "setLanguagePreference", locale: normalizedLocale });
  }
}

export function applyLocale(locale: string): void {
  i18n.global.locale.value = normalizeLocale(locale);
}
