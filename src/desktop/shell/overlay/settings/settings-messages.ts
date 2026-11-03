import { applyLocale, loadLocale, i18n as webviewI18n } from '@/i18n';
import { loadShellLocale, shellI18n } from '../../i18n';
import { ACCOUNT_PROVIDER_IDS } from '@shared/settings-sections';

/** The webview namespaces the settings components the overlay mounts read (the host tab's MCP panel included); only `overlay` is also a shell namespace, whose keys the merge adds beside the shell's. */
const NAMESPACES = ['settingsModal', 'settings', 'common', 'claudeAuth', 'openai', ...ACCOUNT_PROVIDER_IDS, 'providerAuth', 'providerSignIn', 'jarvisSettings', 'voiceFirstRun', 'extensionUi', 'mcp', 'overlays', 'overlay'] as const;

function pick(bundle: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(NAMESPACES.map((name) => [name, bundle[name]]));
}

/** The overlay's vue-i18n holds the shell messages plus these, of each webview language loaded so far, so the shared settings components read one instance. */
export function addSettingsMessages(): void {
  for (const locale of webviewI18n.global.availableLocales) {
    shellI18n.global.mergeLocaleMessage(locale, pick(webviewI18n.global.getLocaleMessage(locale) as Record<string, unknown>));
  }
}

let latest: string | undefined;
let pending: Promise<void> | undefined;

/** The latest applySettingsLocale while it is under way, which a settings request waits for (createLocaleHold's gate). */
export function settingsLocalePending(): Promise<void> | undefined {
  return pending;
}

/**
 * Loads the settings components' webview messages, core's catalog and the shell's catalog in `locale`, then sets the
 * webview's locale, which core's text renders in; of overlapping calls the last one wins, and a failed load (logged) leaves
 * both as they were.
 */
export function applySettingsLocale(locale: string): Promise<void> {
  latest = locale;
  const applied = Promise.all([loadLocale(locale), loadShellLocale(locale)]).then(async (loaded) => {
    if (!loaded.every(Boolean) || latest !== locale) return;
    addSettingsMessages();
    await applyLocale(locale);
  }).finally(() => {
    if (pending === applied) pending = undefined;
  });
  pending = applied;
  return applied;
}
