// Stage parameters enter stage 1's text only as quoted literals; a value either shell would read past is refused first.

export class StageParameterError extends Error {
  override readonly name = 'StageParameterError';
}

// A newline would end the literal's line in a here-read script, and a NUL ends a C string before the shell sees the rest.
function assertQuotable(value: string): void {
  if (/[\n\r\0]/.test(value)) throw new StageParameterError('a stage parameter holds a line break or NUL');
}

/** A POSIX sh single-quoted literal: `'` becomes `'\''`, and nothing else is special inside the quotes. */
export function shellQuote(value: string): string {
  assertQuotable(value);
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// PowerShell also ends a single-quoted string at the typographic single quotes U+2018 to U+201B.
const PS_SINGLE_QUOTES = /['\u2018\u2019\u201a\u201b]/g;

/** A PowerShell single-quoted literal: every single quote PowerShell accepts is doubled. */
export function psQuote(value: string): string {
  assertQuotable(value);
  return `'${value.replace(PS_SINGLE_QUOTES, (quote) => quote + quote)}'`;
}
