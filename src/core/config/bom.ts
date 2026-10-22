// A leading BOM is not content (as in the WHATWG UTF-8 decode); Windows PowerShell 5.1's `-Encoding UTF8` writes one.
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
