import { typedAddress } from '@shared/typed-address';
import type { ShellEditorTab } from '../../preload/shell-channels';

const BLANK = 'about:blank';
// Bidi embedding, override and isolate controls: a page title must not reorder the text around or inside it.
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;

/** Page text as the shell shows it, without bidi controls. */
export function pageText(text: string): string {
  return text.replace(BIDI_CONTROLS, '');
}

export function isBlankPage(url: string): boolean {
  return url === '' || url === BLANK;
}

/** A page tab's title, else its address, else `fallback` for a blank page. */
export function pageTitle(tab: Pick<ShellEditorTab, 'title' | 'browser'>, fallback: string): string {
  const title = pageText(tab.title);
  if (title.trim() !== '' && title !== BLANK) return title;
  const url = tab.browser?.url ?? '';
  return isBlankPage(url) ? fallback : pageText(url);
}

/** The page's host for the breadcrumbs, else its address. */
export function pageHost(url: string): string {
  return URL.canParse(url) && new URL(url).host !== '' ? new URL(url).host : pageText(url);
}

// Mirrors the host's openExternal rule only to disable the button; main is the authority.
export function isWebUrl(url: string): boolean {
  return URL.canParse(url) && ['http:', 'https:'].includes(new URL(url).protocol);
}

export function isSecurePage(url: string): boolean {
  return URL.canParse(url) && new URL(url).protocol === 'https:';
}

// A bare host is sent as typed (core reads it as a typed address); an address naming any other scheme is refused without asking main.
export function isSendableAddress(address: string): boolean {
  const url = typedAddress(address)?.url;
  return url === undefined || url === BLANK || /^https?:/.test(url);
}
