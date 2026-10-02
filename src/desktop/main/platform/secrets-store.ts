import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeStorage } from 'electron';
import type { LocalizationService } from '../../../platform/localization-service';
import type { NotificationService } from '../../../platform/notification-service';
import type { SecretsStore } from '../../../platform/secrets-store';
import { writeJsonConfig } from '../../../core/config/json-config-write';
import { Emitter } from './emitter';

const SCHEMA_VERSION = 1;
export const SECRETS_FILE = 'secrets.json';
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * Whether safeStorage really encrypts. Linux falls back to 'basic_text' with no keyring service, which is
 * obfuscation with a hardcoded key, so it counts as unavailable. Call after app `ready`.
 */
export function encryptionUsable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text';
}

interface StoredSecrets {
  readonly values: Map<string, string>;
  // base64 ciphertext this run could not decrypt, kept on disk until its key is stored again or deleted
  readonly undecryptable: Map<string, string>;
}

function readEncrypted(filePath: string, log: (line: string) => void): StoredSecrets {
  const stored: StoredSecrets = { values: new Map(), undecryptable: new Map() };
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return stored;
    throw err;
  }
  let parsed: { version?: unknown; entries?: unknown } | null;
  try {
    parsed = JSON.parse(text) as { version?: unknown; entries?: unknown } | null;
  } catch (err) {
    log(`[secrets] ignoring unreadable ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return stored;
  }
  if (parsed?.version !== SCHEMA_VERSION || typeof parsed.entries !== 'object' || parsed.entries === null) {
    log(`[secrets] ignoring ${filePath}: unknown schema`);
    return stored;
  }
  for (const [key, encrypted] of Object.entries(parsed.entries)) {
    if (typeof encrypted !== 'string') continue;
    try {
      stored.values.set(key, safeStorage.decryptString(Buffer.from(encrypted, 'base64')));
    } catch (err) {
      // A locked or unreachable keyring fails decryption for this run only, so the ciphertext is kept.
      log(`[secrets] could not decrypt ${key}: ${err instanceof Error ? err.message : String(err)}`);
      stored.undecryptable.set(key, encrypted);
    }
  }
  return stored;
}

/** safeStorage-encrypted secrets in a user-only file under userData; memory only when encryption is unusable. */
export function createDesktopSecretsStore(
  userDataDir: string,
  notifications: NotificationService,
  t: LocalizationService['t'],
  log: (line: string) => void,
): SecretsStore {
  const filePath = path.join(userDataDir, SECRETS_FILE);
  const isPersistent = encryptionUsable();
  const stored: StoredSecrets = isPersistent ? readEncrypted(filePath, log) : { values: new Map(), undecryptable: new Map() };
  if (stored.undecryptable.size > 0) {
    const lost = [...stored.undecryptable.keys()];
    void notifications.warn(t('Damocles could not decrypt {0} saved secret(s) ({1}); sign in or enter those keys again.', lost.length, lost.join(', ')));
  }
  if (!isPersistent) log('[secrets] no usable OS encryption; secrets stay in memory for this session');
  const changed = new Emitter<[string]>('secrets', log);

  // Memory changes only after the file has it, so a failed write leaves both as they were.
  const change = async (key: string, value: string | undefined): Promise<void> => {
    if (isPersistent) {
      await writeJsonConfig(filePath, () => {
        const entries: Record<string, string> = Object.fromEntries(stored.undecryptable);
        for (const [storedKey, storedValue] of stored.values) entries[storedKey] = safeStorage.encryptString(storedValue).toString('base64');
        delete entries[key];
        if (value !== undefined) entries[key] = safeStorage.encryptString(value).toString('base64');
        return `${JSON.stringify({ version: SCHEMA_VERSION, entries }, null, 2)}\n`;
      }, { fileMode: FILE_MODE, dirMode: DIR_MODE });
    }
    stored.undecryptable.delete(key);
    if (value === undefined) stored.values.delete(key);
    else stored.values.set(key, value);
    changed.fire(key);
  };

  return {
    isPersistent,
    get: async (key) => stored.values.get(key),
    store: (key, value) => change(key, value),
    delete: async (key) => {
      if (!stored.values.has(key) && !stored.undecryptable.has(key)) return;
      await change(key, undefined);
    },
    keys: async () => [...stored.values.keys()],
    onDidChange: (listener) => changed.add(listener),
  };
}
