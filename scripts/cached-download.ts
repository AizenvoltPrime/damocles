// A download kept in a cache file and accepted only when `valid` holds for its bytes, so a pinned hash covers the cached copy too.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** The bytes at `url`, from `cached` when they pass `valid`, else downloaded, checked and written there. */
export async function cachedDownload(url: string, cached: string, valid: (data: Buffer) => boolean): Promise<Buffer> {
  mkdirSync(dirname(cached), { recursive: true });
  if (existsSync(cached)) {
    const data = readFileSync(cached);
    if (valid(data)) return data;
  }
  console.log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (!valid(data)) throw new Error(`${url} does not match its pinned hash`);
  writeFileSync(cached, data);
  return data;
}
