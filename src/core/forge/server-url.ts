import { isIP } from 'node:net';
import type { LocalizedText } from '../../shared/localized-text';
import { l } from '../l10n';
import type { ForgeFlavor, ForgeKind } from './types';

// The rules for a server URL the user types (docs/invariants.md "GitHub and GitLab accounts", network rules).

export type ServerUrlProblem = 'empty' | 'notHttps' | 'userinfo' | 'query' | 'fragment' | 'whitespace' | 'invalid' | 'path' | 'githubPath' | 'builtIn';

export interface ServerUrl {
  /** The canonical form without the scheme: lowercase host, no default port, the path without a trailing slash. */
  readonly id: string;
  readonly hostname: string;
  /** host[:port], as the URL's `host`. */
  readonly host: string;
  /** "" or "/prefix". */
  readonly path: string;
  /** https://<id> */
  readonly webUrl: string;
}

const MAX_URL_CHARS = 2048;
// eslint-disable-next-line no-control-regex
const WHITESPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f]/;
const PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/;
const DNS_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const GITHUB_DOT_COM_HOSTS: ReadonlySet<string> = new Set(['github.com', 'www.github.com', 'api.github.com']);
const GITLAB_DOT_COM_HOSTS: ReadonlySet<string> = new Set(['gitlab.com', 'www.gitlab.com']);
const GHE_TENANT = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.ghe\.com$/;

function isHostname(hostname: string): boolean {
  if (hostname.startsWith('[') && hostname.endsWith(']')) return isIP(hostname.slice(1, -1)) === 6;
  if (isIP(hostname) === 4) return true;
  const labels = hostname.split('.');
  return hostname.length <= 253 && labels.length >= 1 && labels.every((label) => DNS_LABEL.test(label));
}

/** A typed server URL in canonical form, or the rule it breaks. A bare host means https. */
export function parseServerUrl(input: string): { readonly ok: true; readonly url: ServerUrl } | { readonly ok: false; readonly problem: ServerUrlProblem } {
  const typed = input.trim();
  if (typed === '') return { ok: false, problem: 'empty' };
  if (typed.length > MAX_URL_CHARS) return { ok: false, problem: 'invalid' };
  if (WHITESPACE_OR_CONTROL.test(typed)) return { ok: false, problem: 'whitespace' };
  // WHATWG URL reads a backslash as a slash, which the path rules below would not see
  if (typed.includes('\\')) return { ok: false, problem: 'invalid' };
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(typed);
  if (schemeMatch && schemeMatch[1]!.toLowerCase() !== 'https') return { ok: false, problem: 'notHttps' };
  const raw = schemeMatch ? typed : `https://${typed}`;
  if (raw.includes('#')) return { ok: false, problem: 'fragment' };
  if (raw.includes('?')) return { ok: false, problem: 'query' };
  if (!URL.canParse(raw)) return { ok: false, problem: 'invalid' };
  const url = new URL(raw);
  if (url.username !== '' || url.password !== '' || /^https:\/\/[^/]*@/i.test(raw)) return { ok: false, problem: 'userinfo' };
  if (!isHostname(url.hostname)) return { ok: false, problem: 'invalid' };
  const rawPath = raw.replace(/^https:\/\/[^/]*/i, '');
  const trimmedPath = rawPath.replace(/\/+$/, '');
  const segments = trimmedPath === '' ? [] : trimmedPath.slice(1).split('/');
  if (segments.some((segment) => segment === '.' || segment === '..' || !PATH_SEGMENT.test(segment))) return { ok: false, problem: 'path' };
  const path = segments.length === 0 ? '' : `/${segments.join('/')}`;
  const id = `${url.host}${path}`;
  return { ok: true, url: { id, hostname: url.hostname, host: url.host, path, webUrl: `https://${id}` } };
}

/** A web URL exactly as parseServerUrl writes it: https, canonical host, no trailing slash. */
export function isCanonicalWebUrl(value: string): boolean {
  const parsed = parseServerUrl(value);
  return parsed.ok && parsed.url.webUrl === value;
}

/** The flavour a server of `kind` at `url` has, or why it cannot be added: a built-in host, or a GitHub URL with a path. */
export function flavorOf(kind: ForgeKind, url: ServerUrl): { readonly ok: true; readonly flavor: ForgeFlavor } | { readonly ok: false; readonly problem: ServerUrlProblem } {
  if (kind === 'gitlab') return GITLAB_DOT_COM_HOSTS.has(url.hostname) && url.path === '' ? { ok: false, problem: 'builtIn' } : { ok: true, flavor: 'gitlab' };
  if (GITHUB_DOT_COM_HOSTS.has(url.hostname)) return { ok: false, problem: 'builtIn' };
  if (url.path !== '') return { ok: false, problem: 'githubPath' };
  return { ok: true, flavor: GHE_TENANT.test(url.hostname) && url.host === url.hostname ? 'ghe.com' : 'ghes' };
}

/** The server form's message for a refused URL: it names the fix. */
export function serverUrlProblemText(problem: ServerUrlProblem): LocalizedText {
  switch (problem) {
    case 'empty': return l('Enter the server address, such as https://gitlab.example.com.');
    case 'notHttps': return l('Use an https:// address. Damocles does not connect to servers over plain http.');
    case 'userinfo': return l('Remove the user name and password from the address. Sign in after adding the server.');
    case 'query': return l('Remove the part after "?" from the address.');
    case 'fragment': return l('Remove the part after "#" from the address.');
    case 'whitespace': return l('Remove the spaces from the address.');
    case 'path': return l('Use only letters, digits, dots, dashes and underscores in the path, such as https://example.com/gitlab.');
    case 'githubPath': return l('Use the server address without a path, such as https://github.example.com.');
    case 'builtIn': return l('This server is already in the list. Use its Add account button.');
    case 'invalid': return l('Enter a valid server address, such as https://gitlab.example.com.');
  }
}

/** A host typed in "Other git hosts": a DNS name or IP literal with an optional port, canonical lowercase. */
export function parseGitHost(input: string): string | undefined {
  const typed = input.trim().toLowerCase();
  if (typed === '' || typed.length > 260 || WHITESPACE_OR_CONTROL.test(typed) || /[/?#@]/.test(typed)) return undefined;
  if (!URL.canParse(`https://${typed}`)) return undefined;
  const url = new URL(`https://${typed}`);
  return isHostname(url.hostname) && url.pathname === '/' ? url.host : undefined;
}
