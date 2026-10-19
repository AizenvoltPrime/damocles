import { promises as fs } from 'node:fs';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

// pi rewrites models-store.json in place under its lock, so an unlocked read can land between the truncate and the write.
const READ_ATTEMPTS = 5;
const RETRY_DELAY_MS = 20;

/**
 * pi's `PI_OFFLINE` switch as its model runtime read it at creation (core/model-runtime.js:97), the value every
 * refresh without `allowNetwork` applies (:600). pi exposes it only as a private field.
 */
export function piModelNetworkEnabled(modelRuntime: ModelRuntime): boolean {
  return (modelRuntime as unknown as { modelNetworkEnabled?: unknown }).modelNetworkEnabled !== false;
}

/**
 * When pi last saved a networked catalog for `providerId` in its models store (`ModelsStoreEntry.checkedAt`), or
 * undefined when it never did. Throws when the file cannot be read or still does not parse after a few attempts.
 */
export async function savedCatalogCheckedAt(storePath: string, providerId: string): Promise<number | undefined> {
  for (let attempt = 1; ; attempt++) {
    let text: string;
    try {
      text = await fs.readFile(storePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    try {
      const saved = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as Record<string, { checkedAt?: unknown } | undefined>;
      const checkedAt = saved[providerId]?.checkedAt;
      return typeof checkedAt === 'number' ? checkedAt : undefined;
    } catch (err) {
      if (attempt >= READ_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}
