import { platform } from './platform-host';

export function t(message: string, ...args: Array<string | number | boolean>): string {
  return platform().localization.t(message, ...args);
}

/** A number written the way the language `t` translates into writes it. */
export function formatNumber(value: number): string {
  return value.toLocaleString(platform().localization.language);
}
