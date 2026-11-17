// The file: URL Chrome loads for an address Damocles hands it, the one reading the permission gate and the browser tools share
// (docs/invariants.md "Permissions and plan mode", "Browser").

/** The `loadedFileUrl` answer for file: text the URL parser rejects, which names no path. */
export const UNPARSED_FILE_URL: unique symbol = Symbol('unparsed file URL');

// The text the WHATWG URL parser, and Chrome's, parses: tab, CR and LF removed anywhere, C0 controls and spaces trimmed.
function urlText(url: string): string {
  const kept = url.replace(/[\t\n\r]/g, '');
  let start = 0;
  let end = kept.length;
  while (start < end && kept.charCodeAt(start) <= 0x20) start++;
  while (end > start && kept.charCodeAt(end - 1) <= 0x20) end--;
  return kept.slice(start, end);
}

/**
 * The file: URL Chrome loads for a browser load of url: Chrome parses it as the WHATWG parser does, and on Windows first reads
 * text that starts with a drive (`C:`, `c|`) or two slashes of either kind as that path's file: URL (url_util.cc
 * `DoCanonicalize`); it loads view-source:'s inner URL, parsed afresh. undefined for a load of no file.
 */
export function loadedFileUrl(url: string): URL | typeof UNPARSED_FILE_URL | undefined {
  let text = urlText(url);
  for (;;) {
    const spelled = /^(?:[a-z][:|]|[\\/]{2})/i.test(text) ? `file:${text}` : text;
    if (!URL.canParse(spelled)) return /^file:/i.test(spelled) ? UNPARSED_FILE_URL : undefined;
    const parsed = new URL(spelled);
    if (parsed.protocol === 'view-source:') {
      text = urlText(parsed.href.slice(parsed.protocol.length));
      continue;
    }
    return parsed.protocol === 'file:' ? parsed : undefined;
  }
}
