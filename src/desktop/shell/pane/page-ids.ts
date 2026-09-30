import type { PanePage } from '../../preload/pane-channels';

export const PAGE_PANEL_ID = 'pane-page';

export function pageDomId(pageId: string): string {
  return `pane-page-tab-${pageId}`;
}

const BLANK = 'about:blank';
// Bidi embedding, override and isolate controls: a page title must not reorder the text around or inside it.
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;

/** The page's title, else its address, else `fallback` for a blank page; page text is shown without bidi controls. */
export function pageTitle(page: PanePage, fallback: string): string {
  const title = page.title.replace(BIDI_CONTROLS, '');
  if (title.trim() !== '' && title !== BLANK) return title;
  return page.url !== '' && page.url !== BLANK ? page.url.replace(BIDI_CONTROLS, '') : fallback;
}

// Mirrors the host's openExternal rule only to disable the button; main is the authority.
export function isWebUrl(url: string): boolean {
  return URL.canParse(url) && ['http:', 'https:'].includes(new URL(url).protocol);
}

// A bare host is sent as typed (main adds https://); an address naming any other scheme is refused without asking main.
export function isSendableAddress(address: string): boolean {
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(address)?.[1]?.toLowerCase();
  return scheme === undefined || scheme === 'http' || scheme === 'https' || address === 'about:blank';
}
