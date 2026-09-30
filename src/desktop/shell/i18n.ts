import { createI18n } from 'vue-i18n';
import type { ShellLocale } from '../preload/shell-channels';
import en from './locales/en.json';
import el from './locales/el.json';

export const shellI18n = createI18n({
  legacy: false,
  locale: 'en' satisfies ShellLocale,
  fallbackLocale: 'en' satisfies ShellLocale,
  messages: { en, el },
});

export function applyShellLocale(locale: ShellLocale): void {
  shellI18n.global.locale.value = locale;
  document.documentElement.lang = locale;
}
