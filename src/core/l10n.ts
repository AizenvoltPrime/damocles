import { platform } from './platform-host';

export function t(message: string, ...args: Array<string | number | boolean>): string {
  return platform().localization.t(message, ...args);
}

/** `message` as written, never translated, with its `{0}`, `{1}`... filled in as `t` fills them: the form of text the model reads. */
export function english(message: string, ...args: Array<string | number | boolean>): string {
  return message.replace(/\{(\d+)\}/g, (match, index: string) => (args[Number(index)] === undefined ? match : String(args[Number(index)])));
}

/** A number written the way the language `t` translates into writes it. */
export function formatNumber(value: number): string {
  return value.toLocaleString(platform().localization.language);
}
