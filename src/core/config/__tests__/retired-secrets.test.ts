import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { installLogSink } from '../../logger';
import { deleteRetiredSecrets, RETIRED_SECRET_KEYS } from '../retired-secrets';

const logLines: string[] = [];
beforeAll(() => {
  installLogSink({ appendLine: (line: string) => void logLines.push(line), show: () => {}, dispose: () => {} });
});
beforeEach(() => {
  logLines.length = 0;
});

describe('deleteRetiredSecrets', () => {
  it('retires the Gemini Explore key', () => {
    expect(RETIRED_SECRET_KEYS).toContain('damocles.explore.apiKey.gemini');
  });

  it('deletes a stored retired key, keeps every other secret, and never logs the value', async () => {
    const { secrets } = createFakePlatform({ secrets: { 'damocles.explore.apiKey.gemini': 'AIza-secret-value', 'damocles.explore.apiKey.openrouter': 'sk-or' } });
    await deleteRetiredSecrets(secrets);
    expect(await secrets.get('damocles.explore.apiKey.gemini')).toBeUndefined();
    expect(await secrets.get('damocles.explore.apiKey.openrouter')).toBe('sk-or');
    expect(logLines.join('\n')).not.toContain('AIza-secret-value');
  });

  // The desktop store's get answers undefined for an entry it could not decrypt, which only delete removes.
  it('deletes a retired key the store cannot read', async () => {
    const { secrets } = createFakePlatform({ secrets: { 'damocles.explore.apiKey.gemini': 'undecryptable' } });
    vi.spyOn(secrets, 'get').mockResolvedValue(undefined);
    const remove = vi.spyOn(secrets, 'delete');
    await deleteRetiredSecrets(secrets);
    expect(remove).toHaveBeenCalledWith('damocles.explore.apiKey.gemini');
  });

  it('resolves for a key the store does not hold', async () => {
    const { secrets } = createFakePlatform();
    await expect(deleteRetiredSecrets(secrets)).resolves.toBeUndefined();
  });

  it('still deletes the other keys when one delete fails', async () => {
    const { secrets } = createFakePlatform({ secrets: { 'retired.a': 'a', 'retired.b': 'b' } });
    const remove = secrets.delete.bind(secrets);
    vi.spyOn(secrets, 'delete').mockImplementation((key) => (key === 'retired.a' ? Promise.reject(new Error('keyring is locked')) : remove(key)));
    await expect(deleteRetiredSecrets(secrets, ['retired.a', 'retired.b'])).resolves.toBeUndefined();
    expect(await secrets.get('retired.a')).toBe('a');
    expect(await secrets.get('retired.b')).toBeUndefined();
    expect(logLines.join('\n')).toContain('Could not delete the retired secret retired.a');
  });
});
