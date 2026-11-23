// A theme install link, `damocles://theme/install?url=<https URL>`, and the https URL it carries: untrusted input, so anything
// that is not exactly that form opens nothing (docs/invariants.md "Desktop themes"). Main and the overlay judge by these rules.

export const THEME_LINK_SCHEME = 'damocles';
export const THEME_LINK_PREFIX: string = `${THEME_LINK_SCHEME}:`;
const MAX_LINK_CHARS = 4096;
const MAX_TARGET_CHARS = 2048;
// a raw link or its target with whitespace, a control character, a quote or a backslash is refused rather than left to the
// URL parser, which strips or rewrites them
// eslint-disable-next-line no-control-regex
const REFUSED_CHARS = /[\u0000-\u0020\u007f-\u009f"\\]/u;

/** Whether a command line argument is a link of the app's scheme, whatever it names. */
export function isThemeLinkArg(arg: string): boolean {
  return arg.slice(0, THEME_LINK_PREFIX.length).toLowerCase() === THEME_LINK_PREFIX;
}

export type ThemeLinkParse = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly reason: string };

const refused = (reason: string): ThemeLinkParse => ({ ok: false, reason });

/** The https URL a theme install link names; refused for every other link. */
export function parseThemeLink(raw: unknown): ThemeLinkParse {
  if (typeof raw !== 'string') return refused('not text');
  if (raw.length > MAX_LINK_CHARS) return refused(`over ${MAX_LINK_CHARS} characters`);
  if (REFUSED_CHARS.test(raw)) return refused('whitespace, a control character, a quote or a backslash');
  if (!URL.canParse(raw)) return refused('not a URL');
  const link = new URL(raw);
  if (link.protocol !== THEME_LINK_PREFIX) return refused('another scheme');
  // as written, before the parser resolves dot segments or empty hosts
  if (!raw.slice(THEME_LINK_PREFIX.length).startsWith('//theme/install?')) return refused('another host or path');
  // a non-special scheme keeps its host as written, so the case check is exact
  if (link.username !== '' || link.password !== '' || link.port !== '' || link.host !== 'theme') return refused('another host');
  if (link.pathname !== '/install') return refused('another path');
  if (link.hash !== '') return refused('a fragment');
  const keys = [...link.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== 'url') return refused('parameters other than one url');
  return parseInstallTarget(link.searchParams.get('url') ?? '');
}

/** An https URL to install a theme from, as a link carries it or Settings' Install from link was given it. */
export function parseInstallTarget(target: string): ThemeLinkParse {
  if (target.length === 0 || target.length > MAX_TARGET_CHARS) return refused('an empty or overlong url');
  if (REFUSED_CHARS.test(target)) return refused('a url with whitespace, a control character, a quote or a backslash');
  if (!URL.canParse(target)) return refused('a url that does not parse');
  const url = new URL(target);
  if (url.protocol !== 'https:') return refused('a url that is not https');
  if (url.username !== '' || url.password !== '') return refused('a url with credentials');
  if (url.hostname === '') return refused('a url without a host');
  url.hash = '';
  return { ok: true, url: url.href };
}

/** What Settings' Install from link accepts: an https URL, or a whole theme link, which the user may have copied. */
export function parsePastedInstallUrl(raw: unknown): ThemeLinkParse {
  if (typeof raw !== 'string') return refused('not text');
  return raw.slice(0, THEME_LINK_PREFIX.length).toLowerCase() === THEME_LINK_PREFIX ? parseThemeLink(raw) : parseInstallTarget(raw);
}
