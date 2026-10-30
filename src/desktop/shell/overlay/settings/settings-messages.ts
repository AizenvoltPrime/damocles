import { applyLocale, loadLocale, i18n as webviewI18n } from '@/i18n';
import { shellI18n } from '../../i18n';
import type { ShellLocale } from '../../../preload/shell-channels';
import { ACCOUNT_PROVIDER_IDS } from '@shared/settings-sections';

/** The webview namespaces the settings components the overlay mounts read; none of them is a shell namespace. */
const NAMESPACES = ['settingsModal', 'settings', 'common', 'claudeAuth', 'openai', ...ACCOUNT_PROVIDER_IDS, 'providerAuth', 'providerSignIn', 'jarvisSettings', 'voiceFirstRun', 'extensionUi'] as const;

function pick(bundle: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(NAMESPACES.map((name) => [name, bundle[name]]));
}

/** The overlay's vue-i18n holds the shell messages plus these, of each webview language loaded so far, so the shared settings components read one instance. */
export function addSettingsMessages(): void {
  for (const locale of webviewI18n.global.availableLocales) {
    shellI18n.global.mergeLocaleMessage(locale, pick(webviewI18n.global.getLocaleMessage(locale) as Record<string, unknown>));
  }
}

let latest: ShellLocale | undefined;

/**
 * Loads the settings components' webview messages and core's catalog in `locale`, then sets the webview's locale, which
 * core's text renders in; of overlapping calls the last one wins, and a failed load (logged) leaves both as they were.
 */
export async function applySettingsLocale(locale: ShellLocale): Promise<void> {
  latest = locale;
  if (!(await loadLocale(locale)) || latest !== locale) return;
  addSettingsMessages();
  await applyLocale(locale);
}
