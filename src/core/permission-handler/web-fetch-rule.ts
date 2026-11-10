// Claude Code's `WebFetch(domain:<host>)` rules (docs/invariants.md "Permissions and plan mode").
import type { PermissionBehavior } from '../../shared/types/permissions';
import { TOOL_WEB_FETCH } from '../../shared/tool-names';

export const DOMAIN_SPECIFIER = 'domain:';

const IPV4_MAPPED = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/;

/** A URL parser's hostname as a domain rule compares it, one trailing dot dropped; undefined when it is no plain host. */
function plainHost(hostname: string): string | undefined {
  const host = hostname.replace(/\.$/, '');
  if (host === '' || host.endsWith('.')) return undefined;
  const mapped = IPV4_MAPPED.exec(host);
  if (!mapped) return host;
  const [high, low] = [parseInt(mapped[1]!, 16), parseInt(mapped[2]!, 16)];
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/** A rule's `<host>` as `plainHost` spells it (ASCII lower case, punycode, any port ignored); undefined when it is no plain host. */
export function ruleHost(host: string): string | undefined {
  const url = `https://${host}/`;
  if (host === '' || /[\s/?#@\\*]/.test(host) || !URL.canParse(url)) return undefined;
  return plainHost(new URL(url).hostname);
}

/** Each URL a WebFetch call names (`url`, `urls`), by host as `plainHost` spells it; undefined for one that does not parse. */
function fetchedHosts(input: Record<string, unknown>): (string | undefined)[] {
  const urls = [input['url'], ...(Array.isArray(input['urls']) ? input['urls'] : [])].filter((url) => url !== undefined);
  return urls.map((url) => (typeof url === 'string' && URL.canParse(url) ? plainHost(new URL(url).hostname) : undefined));
}

/**
 * An allow rule matches a call whose every URL is on the rule's exact host, a deny or ask rule one with any URL there. A URL or
 * rule host that is no plain host cannot be decided, so a deny or ask rule matches it.
 */
function matchesDomainRule(input: Record<string, unknown>, domain: string, behavior: PermissionBehavior): boolean {
  const wanted = ruleHost(domain);
  const hosts = fetchedHosts(input);
  if (behavior === 'allow') return wanted !== undefined && hosts.length > 0 && hosts.every((host) => host === wanted);
  return wanted === undefined || hosts.some((host) => host === undefined || host === wanted);
}

/**
 * Whether rule `ruleTool(specifier)` matches WebFetch call `input`. A `WebFetch` specifier other than `domain:<host>` cannot be
 * decided, so as a deny or ask rule it matches every call and as an allow rule none.
 */
export function matchesWebFetchSpecifier(ruleTool: string, specifier: string, input: Record<string, unknown>, behavior: PermissionBehavior): boolean {
  if (specifier.startsWith(DOMAIN_SPECIFIER)) return matchesDomainRule(input, specifier.slice(DOMAIN_SPECIFIER.length), behavior);
  return ruleTool === TOOL_WEB_FETCH && behavior !== 'allow';
}

/** Why a `WebFetch(specifier)` allow rule can approve nothing, or null when it can approve a call. */
export function inertWebFetchAllowSpecifier(specifier: string): string | null {
  if (!specifier.startsWith(DOMAIN_SPECIFIER)) return 'is a WebFetch rule whose specifier is not domain:<host>, so it approves nothing';
  return ruleHost(specifier.slice(DOMAIN_SPECIFIER.length)) === undefined ? 'is a WebFetch domain rule that names no plain host, so it approves nothing' : null;
}
