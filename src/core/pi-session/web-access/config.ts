import { platform } from '../../platform-host';

/**
 * Whether the native web tools are on; on by default (package.json). Read live on every active-set
 * computation and re-applied by the Tools settings listener (`ChatPanelProvider.toolSettingsChanged`), so toggling the
 * setting adds/removes the web tools on the next turn — no install, no reload (Phase 7).
 */
export function isWebSearchEnabled(): boolean {
  return platform().settings.get<unknown>('damocles.pi.webSearch.enabled', true) === true;
}
