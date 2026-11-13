import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

// The log scan of the forge acceptance criteria: no log line or file may hold a token, an authorization code, a PKCE
// verifier, a device code or a client secret. Shared with the desktop e2e specs (e2e/desktop/support/forge-stub.ts).

const MIN_SECRET_CHARS = 8;

/** The secrets of `secrets` that occur in text, each shown by its first 6 characters so the report leaks none. */
export function secretsIn(text: string, secrets: readonly string[]): string[] {
  return secrets.filter((secret) => secret.length >= MIN_SECRET_CHARS && text.includes(secret)).map((secret) => `${secret.slice(0, 6)}…`);
}

/** Every file below dir (logs, stalls included) that holds one of the secrets, with the secrets' prefixes. */
export function scanLogFolder(dir: string, secrets: readonly string[]): { readonly file: string; readonly found: readonly string[] }[] {
  const hits: { file: string; found: string[] }[] = [];
  const walk = (folder: string): void => {
    for (const name of readdirSync(folder)) {
      const full = path.join(folder, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const found = secretsIn(readFileSync(full, 'utf8'), secrets);
        if (found.length > 0) hits.push({ file: full, found });
      }
    }
  };
  walk(dir);
  return hits;
}
