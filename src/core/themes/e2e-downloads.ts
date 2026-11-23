// The e2e hooks' stand-in for the network: https://e2e.test/<name> reads <folder>/<name>. A caller honors it only while
// CoreInit.e2eHooks is on.
import * as path from 'node:path';
import { readCappedFile } from './archive';

export const E2E_HOST = 'e2e.test';
const E2E_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

/** The file name an e2e URL reads, or undefined when its path is not one plain name. */
export function e2eFileName(url: URL): string | undefined {
  const name = url.pathname.slice(1);
  return E2E_NAME.test(name) ? name : undefined;
}

/** The bytes of `<folder>/<name>`, at most `max`. */
export const readE2eFile = (folder: string, name: string, max: number): Promise<Uint8Array> => readCappedFile(path.join(folder, name), max);
