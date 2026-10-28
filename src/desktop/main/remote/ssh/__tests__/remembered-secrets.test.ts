import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createFakeSecretsStore } from '../../../../../__mocks__/fake-platform';
import { createRememberedSecrets, rememberedSecretKey } from '../remembered-secrets';

const HOP = { hostname: '10.0.0.5', port: 2222, user: 'deploy' };
const sha256 = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

describe('remembered ssh secrets', () => {
  it('are keyed by host id, the hop\'s sha256(host, port, user), a passphrase\'s key file too, and the kind', () => {
    expect(rememberedSecretKey('h1', { hop: HOP, kind: 'password' })).toBe(`damocles.remote.ssh.h1.${sha256(['10.0.0.5', 2222, 'deploy'])}.password`);
    expect(rememberedSecretKey('h1', { hop: HOP, kind: 'passphrase', identityFile: '~/.ssh/id_ed25519' })).toBe(`damocles.remote.ssh.h1.${sha256(['10.0.0.5', 2222, 'deploy', '~/.ssh/id_ed25519'])}.passphrase`);
    expect(rememberedSecretKey('h1', { hop: HOP, kind: 'passphrase', identityFile: '/keys/a' })).not.toBe(rememberedSecretKey('h1', { hop: HOP, kind: 'passphrase', identityFile: '/keys/b' }));
    expect(rememberedSecretKey('h1', { hop: { ...HOP, port: 22 }, kind: 'password' })).not.toBe(rememberedSecretKey('h1', { hop: HOP, kind: 'password' }));
    expect(rememberedSecretKey('h1', { hop: { ...HOP, user: 'root' }, kind: 'password' })).not.toBe(rememberedSecretKey('h1', { hop: HOP, kind: 'password' }));
  });

  it('refuse a host id that could reach into another host\'s keys, rejecting rather than throwing', async () => {
    expect(() => rememberedSecretKey('h1.x', { hop: HOP, kind: 'password' })).toThrow(RangeError);
    expect(() => rememberedSecretKey('', { hop: HOP, kind: 'password' })).toThrow(RangeError);
    const secrets = createRememberedSecrets(createFakeSecretsStore()).forHost('h1.x');
    await expect(secrets.store({ hop: HOP, kind: 'password' }, 's')).rejects.toThrow(RangeError);
    await expect(createRememberedSecrets(createFakeSecretsStore()).deleteAllForHost('h1.x')).rejects.toThrow(RangeError);
  });

  it('store, read and delete through SecretsStore', async () => {
    const store = createFakeSecretsStore();
    const secrets = createRememberedSecrets(store);
    await expect(secrets.forHost('h1').store({ hop: HOP, kind: 'password' }, 's3cret')).resolves.toBe(true);
    expect([...store.entries.values()]).toEqual(['s3cret']);
    await expect(secrets.forHost('h1').get({ hop: HOP, kind: 'password' })).resolves.toBe('s3cret');
    await expect(secrets.forHost('h2').get({ hop: HOP, kind: 'password' })).resolves.toBeUndefined();
    await secrets.forHost('h1').delete({ hop: HOP, kind: 'password' });
    expect(store.entries.size).toBe(0);
  });

  it('deleteAllForHost deletes only that host\'s answers', async () => {
    const store = createFakeSecretsStore({ 'damocles.remote.ssh.h10.abc.password': 'other-host', 'remote/h1/x': 'core secret', 'openai.apiKey': 'k' });
    const secrets = createRememberedSecrets(store);
    await secrets.forHost('h1').store({ hop: HOP, kind: 'password' }, 'a');
    await secrets.forHost('h1').store({ hop: { ...HOP, port: 22 }, kind: 'passphrase', identityFile: '/k' }, 'b');
    await secrets.deleteAllForHost('h1');
    expect([...store.entries.keys()].sort()).toEqual(['damocles.remote.ssh.h10.abc.password', 'openai.apiKey', 'remote/h1/x']);
  });

  it('runs a host\'s store before a deletion called after it, so the deletion removes it', async () => {
    const store = createFakeSecretsStore();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const slow = { ...store, entries: store.entries, store: async (key: string, value: string) => { await held; await store.store(key, value); } };
    const secrets = createRememberedSecrets(slow);
    const storing = secrets.forHost('h1').store({ hop: HOP, kind: 'password' }, 'late');
    const deleting = secrets.deleteAllForHost('h1');
    release();
    await Promise.all([storing, deleting]);
    expect(store.entries.size).toBe(0);
  });

  it('refuses a store from an attempt that began before the host\'s answers were deleted, and takes one from a later attempt', async () => {
    const store = createFakeSecretsStore();
    const secrets = createRememberedSecrets(store);
    const before = secrets.forHost('h1');
    await secrets.deleteAllForHost('h1');
    await expect(before.store({ hop: HOP, kind: 'password' }, 'stale')).resolves.toBe(false);
    expect(store.entries.size).toBe(0);
    await expect(secrets.forHost('h1').store({ hop: HOP, kind: 'password' }, 'fresh')).resolves.toBe(true);
    expect([...store.entries.values()]).toEqual(['fresh']);
  });
});
