// Main's check in front of a remote chat's browser navigation. The client-network proxy is the barrier; this gives a
// refused navigation a clear reason, with the proxy's own verdict (docs/invariants.md "Ports and the remote browser").
import { resolveAddresses, resolveClientTarget, type AddressResolver, type ClientNetworkPolicy } from '../../../../core/browser/client-network-policy';
import { isNavigableUrl } from '../../../../core/browser/net-guard';
import { l } from '../../../../core/l10n';
import type { LocalizedText } from '../../../../shared/localized-text';

export type NavigationVerdict = { readonly allowed: true } | { readonly allowed: false; readonly reason: LocalizedText };

const ALLOWED: NavigationVerdict = { allowed: true };
// getaddrinfo's answers for a name with no address (Node reports EAI_NONAME and EAI_NODATA as ENOTFOUND), and c-ares's
const NO_ADDRESS: ReadonlySet<string> = new Set(['ENOTFOUND', 'ENODATA', 'EAI_NONAME', 'EAI_NODATA']);

/** Whether a remote chat's browser may open `url` (already rewritten inbound) under its host's client network policy. */
export async function checkClientNavigation(url: string, policy: ClientNetworkPolicy, resolve: AddressResolver = resolveAddresses): Promise<NavigationVerdict> {
  // a file, data or browser-internal address would show this computer's files or browser to the remote chat
  if (!isNavigableUrl(url)) return { allowed: false, reason: l('The browser of a chat on a remote host opens only http and https addresses.') };
  if (url === 'about:blank') return ALLOWED;
  const parsed = new URL(url);
  const port = parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port);
  let refused: boolean;
  try {
    refused = !(await resolveClientTarget(parsed.hostname, port, policy, resolve)).allowed;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // A name with no address reaches nothing here; Chrome shows its own error and the proxy resolves it again.
    if (code !== undefined && NO_ADDRESS.has(code)) return ALLOWED;
    return { allowed: false, reason: l('{0} could not be looked up on this computer ({1}), so the browser of a chat on a remote host does not open it.', parsed.host, code ?? (err instanceof Error ? err.message : String(err))) };
  }
  if (!refused) return ALLOWED;
  return {
    allowed: false,
    reason: l('{0} is on this computer or its local network. The browser of a chat on a remote host opens it only while "{1}" is on in the host\'s settings.', parsed.host, l('Let the agent\'s browser reach this computer\'s local network')),
  };
}
