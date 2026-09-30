import { platform } from '../../platform-host';

/**
 * Whether the user opted into the native web tools. Off by default, matching Damocles' convention for
 * optional capabilities (browser, team, voice, compass, explore). Read live on every active-set
 * computation and re-read via a config-change listener (`PiRuntime.refreshWebSearch`), so toggling the
 * setting adds/removes the web tools on the next turn — no install, no reload (Phase 7).
 */
export function isWebSearchEnabled(): boolean {
  return platform().settings.get<boolean>('damocles.pi.webSearch.enabled') === true;
}
