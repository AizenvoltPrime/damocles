import { isIP } from 'node:net';
import { isBlockedIp } from '../pi-session/web-access/safe-fetch';
import { resolveAddresses, type AddressResolver, type ResolvedAddress } from './client-network-policy';

/**
 * Guards extension-host fetches against page-controlled URLs (SSRF). Favicon candidate URLs come
 * from a DOM scan of an untrusted page, so a hostile page could point them at loopback, link-local,
 * or private-range addresses to probe services reachable only from the host.
 */

/**
 * Whether `url` is safe to hand to `Page.navigate`: the one allowlist of the address bar, a restored tab and every agent
 * navigation (`agentNavigationRefusal`).
 *
 * WHY A NAVIGATION NEEDS A SCHEME POLICY AT ALL. The browser drives the user's REAL profile, and
 * everything it loads flows onward to the agent through snapshots, screenshots and the collectors. So
 * `file:///C:/Users/…/.ssh/id_rsa` is not a local convenience — it is a read of an arbitrary local
 * file into the model's context. `javascript:` executes in whatever origin is loaded, `data:`
 * synthesizes an attacker-chosen document, and `chrome:`/`about:config` reach browser internals. None
 * is what an address bar is for.
 *
 * `about:blank` is allowed as an exact value rather than by scheme, because the rest of the `about:`
 * scheme is browser internals; it is here because it is this module's own fallback and the initial
 * page of every tab.
 *
 * Anything that will not parse is rejected, so a malformed value can never fall through as "probably
 * fine".
 *
 * A file page the agent names opens only on its root's served http address or is refused
 * (`ChatServedFiles.localTarget`), and BrowserService never navigates to one.
 */
export function isNavigableUrl(url: string): boolean {
  if (url === 'about:blank') return true;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Why an agent navigation to `url` is refused before Chrome sees it, naming its scheme; undefined for an address
 * isNavigableUrl passes (docs/invariants.md "Browser").
 */
export function agentNavigationRefusal(url: string): string | undefined {
  if (isNavigableUrl(url)) return undefined;
  const instead = 'Open the page at its full http:// or https:// URL, or a file in this chat\'s project or design folder by its file:// address.';
  if (!URL.canParse(url)) return `That address is not a complete URL; the browser opens only http and https URLs and about:blank. ${instead}`;
  const scheme = new URL(url).protocol.slice(0, 40);
  const script = scheme === 'javascript:' ? ' To run script in the page, use BrowserEvaluate.' : '';
  return `The browser does not open ${scheme} addresses; it opens only http and https URLs and about:blank. ${instead}${script}`;
}

/**
 * Every address `hostname` (URL.hostname form, brackets allowed) is fetched at, resolved once with getaddrinfo and each checked
 * with isBlockedIp; undefined when any answer is blocked or the name resolves to nothing. The caller connects to these
 * addresses, never the name, so a rebinding answer cannot reach what the check refused.
 */
export async function publicAddresses(hostname: string, resolve: AddressResolver = resolveAddresses): Promise<readonly ResolvedAddress[] | undefined> {
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const family = isIP(host);
  let answers: readonly ResolvedAddress[];
  try {
    answers = family !== 0 ? [{ address: host, family }] : await resolve(host);
  } catch {
    return undefined;
  }
  if (answers.length === 0 || answers.some((answer) => isBlockedIp(answer.address))) return undefined;
  return answers;
}
