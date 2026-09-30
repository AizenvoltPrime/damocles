import { platform } from './platform-host';

export function t(message: string, ...args: Array<string | number | boolean>): string {
  return platform().localization.t(message, ...args);
}
