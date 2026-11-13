// What a typed or pasted repository address is, read the same way by core, main and the overlay (docs/invariants.md
// "Source control", git runs as argv).

export const MAX_REMOTE_URL_LENGTH = 2048;

/** git's url_is_local_not_ssh (connect.c): no ':', a '/' before the first ':', or a DOS drive prefix. */
export function isLocalPath(url: string): boolean {
  const colon = url.indexOf(':');
  const slash = url.indexOf('/');
  return colon < 0 || (slash >= 0 && slash < colon) || /^[A-Za-z]:/.test(url);
}

/** Only a local path may hold whitespace: in a URL or scp-like address ` -oProxyCommand=x:p` reads as an ssh host. */
export function isRemoteUrl(url: string): boolean {
  if (url.length === 0 || url.length > MAX_REMOTE_URL_LENGTH || url.startsWith('-') || /^\s/.test(url)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(url) || /^[A-Za-z][A-Za-z0-9+.-]*::/.test(url)) return false;
  return isLocalPath(url) || !/\s/.test(url);
}

/** Typed or pasted text as the address it names: trimmed, with a leading `git clone` (a README's command) dropped. */
export function cloneAddressOf(text: string): string {
  return text.trim().replace(/^git\s+clone\s+/, '');
}
