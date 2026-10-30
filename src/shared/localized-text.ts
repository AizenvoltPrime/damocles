// View-facing text core sends: an English source key of l10n/bundle.l10n*.json and its arguments, which each view or host
// renders in its own language (docs/invariants.md "Engine and message contract", "Localized text").

/** A number the renderer formats in its own locale. */
export interface LocalizedNumber {
  readonly number: number;
}

export type LocalizedArg = string | number | LocalizedNumber | LocalizedText;

export interface LocalizedText {
  // the English source text, the catalog's key
  readonly message: string;
  readonly args?: readonly LocalizedArg[];
}

// {0}, {1}, ... are replaced by the positional args in one pass; an index with no arg stays as written, as vscode.l10n.t does.
export function fillMessage(template: string, args: ReadonlyArray<string | number | boolean>): string {
  return template.replace(/\{(\d+)\}/g, (match, index: string) => {
    const arg = args[Number(index)];
    return arg === undefined ? match : String(arg);
  });
}

/** `text` in a language: `translate` answers a catalog key's translation, or undefined for English, which is the key itself. */
export function renderLocalizedText(text: LocalizedText, translate: (key: string) => string | undefined, locale: string): string {
  const args = (text.args ?? []).map((arg) => renderArg(arg, translate, locale));
  return fillMessage(translate(text.message) ?? text.message, args);
}

function renderArg(arg: LocalizedArg, translate: (key: string) => string | undefined, locale: string): string {
  if (typeof arg === 'string') return arg;
  if (typeof arg === 'number') return String(arg);
  if ('number' in arg) return arg.number.toLocaleString(locale);
  return renderLocalizedText(arg, translate, locale);
}

/** `text` in English: what a log line and an error's message carry. */
export function englishText(text: LocalizedText): string {
  return renderLocalizedText(text, () => undefined, 'en');
}

const MAX_ARGS = 64;
const MAX_DEPTH = 8;

function record(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

/**
 * `raw` as a fresh LocalizedText holding only the fields it knows, every string within maxChars and its arguments nested at
 * most MAX_DEPTH deep; undefined when it is not one. Text from another process passes it before anything renders it.
 */
export function parseLocalizedText(raw: unknown, maxChars: number): LocalizedText | undefined {
  const string = (value: unknown): string | undefined => (typeof value === 'string' && value.length <= maxChars ? value : undefined);
  const parse = (value: unknown, depth: number): LocalizedText | undefined => {
    const fields = record(value);
    const message = string(fields?.['message']);
    if (!fields || message === undefined || depth > MAX_DEPTH) return undefined;
    if (fields['args'] === undefined) return { message };
    if (!Array.isArray(fields['args']) || fields['args'].length > MAX_ARGS) return undefined;
    const args: LocalizedArg[] = [];
    for (const arg of fields['args'] as unknown[]) {
      const number = record(arg)?.['number'];
      const parsed = typeof arg === 'string' ? string(arg)
        : typeof arg === 'number' ? (Number.isFinite(arg) ? arg : undefined)
          : typeof number === 'number' ? (Number.isFinite(number) ? { number } : undefined)
            : parse(arg, depth + 1);
      if (parsed === undefined) return undefined;
      args.push(parsed);
    }
    return { message, args };
  };
  return parse(raw, 0);
}

/** A thrown error whose text reaches a view or a host's notice; `message` is its English form, for logs. */
export class LocalizedError extends Error {
  readonly text: LocalizedText;

  constructor(text: LocalizedText, options?: ErrorOptions) {
    super(englishText(text), options);
    this.name = 'LocalizedError';
    this.text = text;
  }
}
