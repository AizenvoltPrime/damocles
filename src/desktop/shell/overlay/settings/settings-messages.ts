import webviewEn from '@/i18n/locales/en.json';
import webviewEl from '@/i18n/locales/el.json';
import { shellI18n } from '../../i18n';

/** The webview namespaces the settings components the overlay mounts read; none of them is a shell namespace. */
const NAMESPACES = ['settingsModal', 'settings', 'common', 'claudeAuth', 'openai', 'stepfun', 'deepseek', 'typesafe', 'openrouter', 'jarvisSettings', 'extensionUi'] as const;

function pick(bundle: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(NAMESPACES.map((name) => [name, bundle[name]]));
}

/** The overlay's vue-i18n holds the shell messages plus these, so the shared settings components read one instance. */
export function addSettingsMessages(): void {
  shellI18n.global.mergeLocaleMessage('en', pick(webviewEn));
  shellI18n.global.mergeLocaleMessage('el', pick(webviewEl));
}
