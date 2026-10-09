// An address bar's text and a page address panels.json keeps.
export const MAX_BROWSER_URL_LENGTH = 8192;
// A scheme, not a host's port (localhost:3000).
const ADDRESS_SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):(?!\d+(?:[/?#]|$))/;
// Schemes read as one without a following //, as Chrome's omnibox reads the schemes it knows; any other one starts a user
// name, as in user:pass@example.com (AutocompleteInput::Parse).
const KNOWN_SCHEMES: ReadonlySet<string> = new Set(['about', 'blob', 'chrome', 'data', 'devtools', 'file', 'filesystem', 'ftp', 'http', 'https', 'javascript', 'mailto', 'sms', 'tel', 'view-source', 'ws', 'wss']);
// Top-level names no public registry assigns, which Chrome finds through the public suffix list: RFC 6761's special-use
// names, ICANN's .internal and the undelegated names intranets use.
const UNREGISTERED_TLDS: ReadonlySet<string> = new Set(['localhost', 'local', 'test', 'example', 'invalid', 'internal', 'lan', 'home', 'corp', 'intranet', 'private']);
// The URL parser writes an IPv4 host as four decimal numbers and an IPv6 host in brackets.
const IP_HOST = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[.*\])$/;

/** A typed address as a URL; upgraded marks an https URL loaded over http when the https load cannot connect. */
export interface TypedAddress {
  readonly url: string;
  readonly upgraded: boolean;
}

// Chrome's AutocompleteInput::ShouldUpgradeToHttps: an IP address, a single-label or unregistered name, or a port stays on http.
function withoutScheme(text: string): TypedAddress | undefined {
  if (!URL.canParse(`http://${text}`)) return undefined;
  const url = new URL(`http://${text}`);
  const host = url.hostname.replace(/\.$/, '');
  const labels = host.split('.');
  const local = url.port !== '' || IP_HOST.test(host) || labels.length < 2 || UNREGISTERED_TLDS.has(labels.at(-1)!);
  if (local) return { url: url.href, upgraded: false };
  url.protocol = 'https:';
  return { url: url.href, upgraded: true };
}

// The scheme the text starts with, in lower case; undefined for a host, a port or a user name.
function addressScheme(text: string): string | undefined {
  const match = ADDRESS_SCHEME.exec(text);
  if (!match) return undefined;
  const scheme = match[1]!.toLowerCase();
  return KNOWN_SCHEMES.has(scheme) || text.startsWith('//', match[0].length) ? scheme : undefined;
}

/**
 * The address bar's text as a URL, as Chrome reads a typed address: one with a scheme as typed with the scheme in lower case,
 * else by its host. Each host still checks the result with isNavigableUrl.
 */
export function typedAddress(typed: string): TypedAddress | undefined {
  const text = typed.trim();
  if (text === '' || typed.length > MAX_BROWSER_URL_LENGTH) return undefined;
  const scheme = addressScheme(text);
  if (scheme === undefined) return withoutScheme(text);
  // Chrome's FixupURL reads about:blank in any case.
  const url = `${scheme}${text.slice(scheme.length)}`;
  return { url: scheme === 'about' && url.toLowerCase() === 'about:blank' ? 'about:blank' : url, upgraded: false };
}

// Chrome's potentially trustworthy hosts: an http page on this computer is not marked not secure.
const LOOPBACK_HOST = /^(?:localhost|.+\.localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;

/** An http page served from anywhere but this computer, which the address bar marks not secure as Chrome does. */
export function isNotSecurePage(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const { protocol, hostname } = new URL(url);
  return protocol === 'http:' && !LOOPBACK_HOST.test(hostname.replace(/\.$/, ''));
}
