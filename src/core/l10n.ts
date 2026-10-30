import { fillMessage, LocalizedError, type LocalizedArg, type LocalizedText } from '../shared/localized-text';

/**
 * View-facing text: `message` is the English source text, the key of l10n/bundle.l10n*.json, which each view or host renders
 * in its own language. Core never renders user-facing text itself.
 */
export function l(message: string, ...args: LocalizedArg[]): LocalizedText {
  return args.length === 0 ? { message } : { message, args };
}

/** Text that is not Damocles' own (a git or provider error, a file's own words), shown as written in every language. */
export function verbatim(text: string): LocalizedText {
  return l('{0}', text);
}

/** What a caught error says to a view: a LocalizedError's text, else its message as written. */
export function errorTextOf(err: unknown): LocalizedText {
  if (err instanceof LocalizedError) return err.text;
  return verbatim(err instanceof Error ? err.message : String(err));
}

/** A one-line `headline` with `detail` lines below it; a notice with room for one line shows `headlineOf` it. */
export function withDetail(headline: LocalizedText, detail: LocalizedArg): LocalizedText {
  return l('{0}\n{1}', headline, detail);
}

/** The first line `text` shows: a `withDetail` text's headline, or foreign text's first line; else `text` itself. */
export function headlineOf(text: LocalizedText): LocalizedText {
  const [first] = text.args ?? [];
  if (text.message === '{0}\n{1}' && typeof first === 'object' && 'message' in first) return first;
  if (text.message === '{0}' && typeof first === 'string') return verbatim(first.split(/\r?\n/, 1)[0] ?? first);
  return text;
}

/** `message` as written, never translated, with its `{0}`, `{1}`... filled in: the form of text the model reads. */
export function english(message: string, ...args: Array<string | number | boolean>): string {
  return fillMessage(message, args);
}
