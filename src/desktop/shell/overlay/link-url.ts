// A link request's URL as its notice shows it: the host and port stand out from the scheme and any user name before them
// and the path and query after them, so a look-alike such as https://github.com@evil.example or github.com.evil.example reads as it is.
export type LinkUrlPart = { readonly role: 'host' | 'other'; readonly text: string };

// the origins already warned about, oldest first, so a notice that renders again logs nothing more
export const MAX_WARNED_ORIGINS = 32;
const warned = new Set<string>();

/**
 * The parts join back to url. Main sends a canonical href; one this renderer's parser reads otherwise is shown whole, never
 * thrown in the render that would drop every toast with it.
 */
export function linkUrlParts(url: string): readonly LinkUrlPart[] {
  const parsed = URL.canParse(url) ? new URL(url) : undefined;
  if (parsed?.href !== url) {
    // a URL can carry tokens, so only its origin is logged
    const origin = parsed?.origin ?? 'text that is no URL';
    if (!warned.has(origin)) {
      if (warned.size >= MAX_WARNED_ORIGINS) warned.delete(warned.values().next().value!);
      warned.add(origin);
      console.warn("[toasts] a link request carries a URL that is not this renderer's canonical href, at", origin);
    }
    return [{ role: 'other', text: url }];
  }
  const userinfo = parsed.username !== '' || parsed.password !== '' ? `${parsed.username}${parsed.password !== '' ? `:${parsed.password}` : ''}@` : '';
  const before = `${parsed.protocol}//${userinfo}`;
  // host keeps an IPv6 address's brackets, an internationalized name's punycode and a port other than the default, as href does
  const host = parsed.host;
  return [
    { role: 'other', text: before },
    { role: 'host', text: host },
    { role: 'other', text: url.slice(before.length + host.length) },
  ].filter((part): part is LinkUrlPart => part.text !== '');
}
