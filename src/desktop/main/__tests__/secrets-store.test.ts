import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const safeStorage = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
  encryptString: vi.fn((plain: string) => Buffer.from(`enc:${plain}`)),
  decryptString: vi.fn((buffer: Buffer) => buffer.toString().replace(/^enc:/, '')),
}));
vi.mock('electron', () => ({ safeStorage }));

import type { NotificationService } from '../../../platform/notification-service';
import { formatMessage } from '../platform/localization-service';
import { SECRETS_FILE, createDesktopSecretsStore } from '../platform/secrets-store';

let userData: string;
const originalPlatform = process.platform;
const warn = vi.fn(async () => undefined);
const notifications = { info: vi.fn(), warn, error: vi.fn() } as unknown as NotificationService;
const t = (message: string, ...args: Array<string | number | boolean>): string => `[el] ${formatMessage(message, args)}`;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-secrets-'));
  safeStorage.isEncryptionAvailable.mockReturnValue(true);
  safeStorage.getSelectedStorageBackend.mockReturnValue('gnome_libsecret');
  safeStorage.encryptString.mockClear();
  safeStorage.decryptString.mockImplementation((buffer: Buffer) => buffer.toString().replace(/^enc:/, ''));
  warn.mockClear();
});

afterEach(() => {
  setPlatform(originalPlatform);
  fs.rmSync(userData, { recursive: true, force: true });
});

describe('desktop secrets store', () => {
  // The user is told by the core wrapper that reads isPersistent (volatile-secrets-notice.ts).
  it('keeps secrets in memory only when Linux falls back to basic_text', async () => {
    setPlatform('linux');
    safeStorage.getSelectedStorageBackend.mockReturnValue('basic_text');
    const secrets = createDesktopSecretsStore(userData, notifications, t, () => undefined);
    expect(secrets.isPersistent).toBe(false);
    await secrets.store('mcp.token', 'abc');
    await secrets.store('explore.key', 'def');
    expect(await secrets.get('mcp.token')).toBe('abc');
    expect(await secrets.keys()).toEqual(['mcp.token', 'explore.key']);
    expect(fs.existsSync(path.join(userData, SECRETS_FILE))).toBe(false);
    expect(safeStorage.encryptString).not.toHaveBeenCalled();
  });

  it('ignores the backend off Linux, where basic_text does not apply', () => {
    setPlatform('win32');
    safeStorage.getSelectedStorageBackend.mockReturnValue('basic_text');
    expect(createDesktopSecretsStore(userData, notifications, t, () => undefined).isPersistent).toBe(true);
  });

  it('stays in memory when the OS offers no encryption at all', () => {
    setPlatform('darwin');
    safeStorage.isEncryptionAvailable.mockReturnValue(false);
    expect(createDesktopSecretsStore(userData, notifications, t, () => undefined).isPersistent).toBe(false);
  });

  it('persists encrypted values that a new instance decrypts, and never writes plaintext', async () => {
    setPlatform('linux');
    const secrets = createDesktopSecretsStore(userData, notifications, t, () => undefined);
    expect(secrets.isPersistent).toBe(true);
    await secrets.store('explore.key', 'sk-secret');
    expect(fs.readFileSync(path.join(userData, SECRETS_FILE), 'utf8')).not.toContain('sk-secret');
    expect(await createDesktopSecretsStore(userData, notifications, t, () => undefined).get('explore.key')).toBe('sk-secret');
    await secrets.delete('explore.key');
    expect(await createDesktopSecretsStore(userData, notifications, t, () => undefined).get('explore.key')).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it.runIf(originalPlatform !== 'win32')('creates the secrets file readable by the user only', async () => {
    const secrets = createDesktopSecretsStore(userData, notifications, t, () => undefined);
    await secrets.store('k', 'v');
    expect(fs.statSync(path.join(userData, SECRETS_FILE)).mode & 0o777).toBe(0o600);
  });
  // A locked keyring fails decryption for one run; the next run with the keyring back must still find the value.
  it('keeps ciphertext it cannot decrypt across writes until that key is stored again or deleted', async () => {
    setPlatform('linux');
    const seed = createDesktopSecretsStore(userData, notifications, t, () => undefined);
    await seed.store('mcp.token', 'tok');
    await seed.store('explore.key', 'sk');
    await seed.store('voice.key', 'vk');
    const entries = (): Record<string, string> => (JSON.parse(fs.readFileSync(path.join(userData, SECRETS_FILE), 'utf8')) as { entries: Record<string, string> }).entries;
    const lockedCiphertext = entries()['mcp.token'];

    safeStorage.decryptString.mockImplementation((buffer: Buffer) => {
      if (buffer.toString() !== 'enc:sk') throw new Error('keyring locked');
      return 'sk';
    });
    const locked = createDesktopSecretsStore(userData, notifications, t, () => undefined);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[el] Damocles could not decrypt 2 saved secret(s) (mcp.token, voice.key); sign in or enter those keys again.');
    expect(await locked.get('mcp.token')).toBeUndefined();
    await locked.store('other.key', 'o');
    expect(entries()['mcp.token']).toBe(lockedCiphertext);
    await locked.delete('voice.key');
    expect(entries()).not.toHaveProperty('voice.key');
    await locked.store('mcp.token', 'fresh');
    expect(entries()['mcp.token']).toBe(Buffer.from('enc:fresh').toString('base64'));

    safeStorage.decryptString.mockImplementation((buffer: Buffer) => buffer.toString().replace(/^enc:/, ''));
    const unlocked = createDesktopSecretsStore(userData, notifications, t, () => undefined);
    expect(await unlocked.get('mcp.token')).toBe('fresh');
    expect(await unlocked.get('explore.key')).toBe('sk');
    expect(await unlocked.keys()).toEqual(expect.arrayContaining(['mcp.token', 'explore.key', 'other.key']));
  });

  it('changes nothing in memory when the write fails', async () => {
    setPlatform('linux');
    const secrets = createDesktopSecretsStore(userData, notifications, t, () => undefined);
    await secrets.store('explore.key', 'old');
    fs.rmSync(path.join(userData, SECRETS_FILE));
    fs.mkdirSync(path.join(userData, SECRETS_FILE));
    await expect(secrets.store('explore.key', 'new')).rejects.toThrow();
    await expect(secrets.delete('explore.key')).rejects.toThrow();
    expect(await secrets.get('explore.key')).toBe('old');
  });
});
