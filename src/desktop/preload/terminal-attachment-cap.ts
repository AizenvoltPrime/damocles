// The one bound on terminal text attached to a chat: the shell applies it before sending and main again on receipt.

export const MAX_TERMINAL_ATTACHMENT_LINES = 2000;
export const MAX_TERMINAL_ATTACHMENT_CHARS = 64_000;
// The omittedLines the shell may report.
export const MAX_TERMINAL_ATTACHMENT_OMITTED_LINES = 1_000_000_000;

// ESC sequences: CSI, OSC to BEL or ST, DCS/SOS/PM/APC strings to ST (each introducer and ST in 7-bit or C1 form), and the
// two-character escapes. Each class is a single negated run, so the match is linear.
// eslint-disable-next-line no-control-regex -- ESC, BEL, the C1 introducers and ST are what this matches
const ESCAPE_SEQUENCE = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]?|(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?|(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[^\x1b\x9c]*(?:\x1b\\|\x9c)?|\x1b[ -/]*[0-~]?/g;
// Controls, format (bidi, zero-width), separators and lone surrogates; \n, \t, ZWNJ and ZWJ stay.
const REFUSED = /(?![\n\t\u200C\u200D])[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

/**
 * Plain text kept from its END: CRLF and CR become \n, escape sequences and refused characters go, then whole leading lines
 * are dropped until at most MAX_TERMINAL_ATTACHMENT_LINES lines and MAX_TERMINAL_ATTACHMENT_CHARS characters remain (a lone
 * last line longer than that keeps its end). omittedLines counts the dropped lines; the caller writes any marker.
 */
export function capTerminalText(raw: string): { readonly text: string; readonly omittedLines: number } {
  const clean = raw.replace(/\r\n?/g, '\n').replace(ESCAPE_SEQUENCE, '').replace(REFUSED, '');
  const lines = clean.split('\n');
  let start = Math.max(0, lines.length - MAX_TERMINAL_ATTACHMENT_LINES);
  // characters of lines[start..] joined with '\n'
  let chars = lines.slice(start).reduce((total, line) => total + line.length + 1, -1);
  while (chars > MAX_TERMINAL_ATTACHMENT_CHARS && start < lines.length - 1) {
    chars -= lines[start]!.length + 1;
    start += 1;
  }
  const kept = lines.slice(start).join('\n');
  if (kept.length <= MAX_TERMINAL_ATTACHMENT_CHARS) return { text: kept, omittedLines: start };
  // A cut inside a surrogate pair leaves its low half first.
  return { text: kept.slice(kept.length - MAX_TERMINAL_ATTACHMENT_CHARS).replace(/^[\uDC00-\uDFFF]/, ''), omittedLines: start };
}
