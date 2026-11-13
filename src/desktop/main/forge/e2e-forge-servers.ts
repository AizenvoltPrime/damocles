// The e2e hook of the Git hosting accounts, honored only in a development build run with DAMOCLES_E2E_HOOKS=1; a packaged
// build never reads it, so no built-in server can be redirected there.
import type { ForgeServerOverride } from '../../../core/forge/types';

export type ForgeE2eServers = Readonly<Partial<Record<'github.com' | 'gitlab.com', ForgeServerOverride>>>;

const isHttps = (value: unknown): value is string => typeof value === 'string' && URL.canParse(value) && new URL(value).protocol === 'https:' && !value.endsWith('/');
const isClientValue = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(value);

/**
 * DAMOCLES_E2E_FORGE_SERVERS: JSON pointing the built-in servers at a stub, `{ "github.com"?: { webUrl, apiUrl?, oauth?:
 * { clientId, clientSecret? } }, "gitlab.com"?: ... }`. A value that does not parse fails the start, as a
 * broken hook should.
 */
export function forgeE2eServers(options: { readonly packaged: boolean; readonly env: Readonly<Record<string, string | undefined>> }): ForgeE2eServers | undefined {
  const raw = options.env['DAMOCLES_E2E_FORGE_SERVERS'];
  if (options.packaged || raw === undefined) return undefined;
  // a spec that forgot the hooks would send its stub tokens to the real servers
  if (options.env['DAMOCLES_E2E_HOOKS'] !== '1') throw new Error('DAMOCLES_E2E_FORGE_SERVERS needs DAMOCLES_E2E_HOOKS=1');
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('DAMOCLES_E2E_FORGE_SERVERS must be a JSON object');
  const overrides: Partial<Record<'github.com' | 'gitlab.com', ForgeServerOverride>> = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (id !== 'github.com' && id !== 'gitlab.com') throw new Error(`DAMOCLES_E2E_FORGE_SERVERS names ${id}, which is not a built-in server`);
    const entry = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
    const oauth = entry['oauth'] as Record<string, unknown> | undefined;
    if (!isHttps(entry['webUrl']) || (entry['apiUrl'] !== undefined && !isHttps(entry['apiUrl']))) throw new Error(`DAMOCLES_E2E_FORGE_SERVERS ${id} needs https URLs without a trailing slash`);
    if (oauth !== undefined && (!isClientValue(oauth['clientId']) || (oauth['clientSecret'] !== undefined && !isClientValue(oauth['clientSecret'])))) {
      throw new Error(`DAMOCLES_E2E_FORGE_SERVERS ${id} has a malformed oauth entry`);
    }
    overrides[id] = {
      webUrl: entry['webUrl'],
      ...(entry['apiUrl'] !== undefined ? { apiUrl: entry['apiUrl'] as string } : {}),
      ...(oauth !== undefined
        ? { oauth: { clientId: oauth['clientId'] as string, ...(oauth['clientSecret'] !== undefined ? { clientSecret: oauth['clientSecret'] as string } : {}) } }
        : {}),
    };
  }
  return overrides;
}
