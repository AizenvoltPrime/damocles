import * as vscode from 'vscode';

/**
 * The adopted web-tools extension (US-003 decision 2): `pi-web-access` registers `web_search`,
 * `fetch_content`, and `code_search`, working key-free out of the box via its default Exa MCP. Pinned
 * to an exact version for reproducibility; pi's package manager parses the `npm:<pkg>@<version>` form.
 */
export const WEB_ACCESS_SOURCE = 'npm:pi-web-access@0.10.7';

/**
 * Whether the user opted into the pi-web-access web tools. Off by default, matching Damocles'
 * convention for optional/external capabilities (browser, team, voice, compass, explore). Read at
 * runtime init and re-read live via a config-change listener (`PiRuntime.refreshWebSearch`).
 */
export function isWebSearchEnabled(): boolean {
  return vscode.workspace.getConfiguration('damocles').get<boolean>('pi.webSearch.enabled') === true;
}
