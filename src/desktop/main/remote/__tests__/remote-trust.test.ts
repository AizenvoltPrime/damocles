import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostStore } from '../host-store';
import { createRemoteTrust, type RemoteTrustTarget } from '../remote-trust';
import { TRUST_FILE } from '../../trust-store';
import type { MessageQuestion } from '../../message-dialog';

let userData: string;
let target: RemoteTrustTarget;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-remote-trust-'));
  target = { key: 'loopback|c:\\app', authorityKey: 'loopback', folderKey: 'c:\\app', fsPath: 'C:\\app', host: 'Local daemon' };
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

const t = (message: string, ...args: string[]): string => message.replace(/\{(\d+)\}/g, (_match, index: string) => args[Number(index)] ?? '');

describe('remote trust', () => {
  it('names the host, grants into remote-hosts.json only, and asks once while the question is open', async () => {
    const store = await HostStore.open(userData, () => undefined);
    let answer!: (choice: number | undefined) => void;
    const ask = vi.fn((_question: MessageQuestion) => new Promise<number | undefined>((resolve) => { answer = resolve; }));
    const trust = createRemoteTrust({ store, ask, t, log: () => undefined });
    expect(trust.isTrusted(target)).toBe(false);
    const first = trust.request(target);
    const second = trust.request(target);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(ask.mock.calls[0]![0]).toMatchObject({ severity: 'warning', message: 'Do you trust the authors of the files in C:\\app on Local daemon?', actions: ['Trust Folder'], cancelLabel: 'Don\'t Trust' });
    answer(0);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(trust.isTrusted(target)).toBe(true);
    expect((await HostStore.open(userData, () => undefined)).isTrusted('loopback', 'c:\\app')).toBe(true);
    expect(fs.existsSync(path.join(userData, TRUST_FILE))).toBe(false);
    expect(await trust.request(target)).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('gives the call whose question granted the folder an undo, which revokes that grant in remote-hosts.json only', async () => {
    const store = await HostStore.open(userData, () => undefined);
    await store.grantTrust('loopback', 'c:\\other');
    const trust = createRemoteTrust({ store, ask: async () => 0, t, log: () => undefined });
    const granted = await trust.ask(target);
    expect(granted.trusted).toBe(true);
    await granted.undo!();
    expect(trust.isTrusted(target)).toBe(false);
    const reopened = await HostStore.open(userData, () => undefined);
    expect(reopened.isTrusted('loopback', 'c:\\app')).toBe(false);
    expect(reopened.isTrusted('loopback', 'c:\\other')).toBe(true);
  });

  it('gives no undo to a call that found the folder trusted, was declined, joined another call\'s pending question, or asked one another joined', async () => {
    const store = await HostStore.open(userData, () => undefined);
    let answer!: (choice: number | undefined) => void;
    const ask = vi.fn((_question: MessageQuestion) => new Promise<number | undefined>((resolve) => { answer = resolve; }));
    const trust = createRemoteTrust({ store, ask, t, log: () => undefined });
    const declined = trust.ask(target);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    answer(undefined);
    expect(await declined).toEqual({ trusted: false });

    const first = trust.ask(target);
    const joined = trust.ask(target);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(2));
    answer(0);
    expect(await joined).toEqual({ trusted: true });
    // the asking call's undo would take the joiner's trust
    await (await first).undo?.();
    expect(trust.isTrusted(target)).toBe(true);
    expect((await HostStore.open(userData, () => undefined)).isTrusted('loopback', 'c:\\app')).toBe(true);
    expect(await trust.ask(target)).toEqual({ trusted: true });
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('gives no undo when the folder was granted elsewhere while its question was open', async () => {
    const store = await HostStore.open(userData, () => undefined);
    let answer!: (choice: number | undefined) => void;
    const ask = vi.fn((_question: MessageQuestion) => new Promise<number | undefined>((resolve) => { answer = resolve; }));
    const trust = createRemoteTrust({ store, ask, t, log: () => undefined });
    const asked = trust.ask(target);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(await store.grantTrust('loopback', 'c:\\app')).toBe(true);
    answer(0);
    expect(await asked).toEqual({ trusted: true });
  });

  it('grants nothing when the user declines or dismisses the question', async () => {
    const store = await HostStore.open(userData, () => undefined);
    const answers = [1, undefined];
    const trust = createRemoteTrust({ store, ask: async () => answers.shift(), t, log: () => undefined });
    expect(await trust.request(target)).toBe(false);
    expect(await trust.request(target)).toBe(false);
    expect(trust.isTrusted(target)).toBe(false);
  });
});

describe('HostStore.revokeTrust', () => {
  it('untrusts the folder by exact key, tells its listeners once, and writes nothing on a second call', async () => {
    const store = await HostStore.open(userData, () => undefined);
    expect(await store.grantTrust('loopback', 'c:\\app')).toBe(true);
    expect(await store.grantTrust('loopback', 'c:\\app')).toBe(false);
    await store.grantTrust('loopback', 'c:\\app\\child');
    const changed = vi.fn();
    store.onDidChange(changed);
    await store.revokeTrust('loopback', 'c:\\app');
    await store.revokeTrust('loopback', 'c:\\app');
    await store.revokeTrust('wsl+other', 'c:\\app');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(store.isTrusted('loopback', 'c:\\app')).toBe(false);
    expect(store.isTrusted('loopback', 'c:\\app\\child')).toBe(true);
  });
});
