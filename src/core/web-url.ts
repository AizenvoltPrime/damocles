/**
 * The canonical href of an http or https URL, or undefined for any other scheme and for text that does not parse.
 * Only these leave the app through ShellService.openExternal: a file:, custom-scheme or javascript: URL could launch a local handler.
 */
export function webUrlHref(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}
