// Chrome's HTTPS-Upgrades fallback for a typed address: the https load could not connect or set up TLS. A DNS failure, an
// offline network or a cancelled load would fail the same over http, and a timed-out load never falls back, as in Chrome 150
// (crbug.com/515265983), so those keep the error page.
const FALLBACK_ERROR = /^net::ERR_(?:CONNECTION_(?:REFUSED|RESET|CLOSED|ABORTED|FAILED)|EMPTY_RESPONSE|SSL_[A-Z_]+|CERT_[A-Z_]+|BAD_SSL_CLIENT_AUTH_CERT)$/;

/** The http address to load after an upgraded https load failed with errorText, or undefined when there is none. */
export function httpFallbackUrl(url: string, errorText: string | undefined): string | undefined {
  if (errorText === undefined || !FALLBACK_ERROR.test(errorText) || !URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.port !== '') return undefined;
  parsed.protocol = 'http:';
  return parsed.href;
}
