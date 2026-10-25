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

  it('grants nothing when the user declines or dismisses the question', async () => {
    const store = await HostStore.open(userData, () => undefined);
    const answers = [1, undefined];
    const trust = createRemoteTrust({ store, ask: async () => answers.shift(), t, log: () => undefined });
    expect(await trust.request(target)).toBe(false);
    expect(await trust.request(target)).toBe(false);
    expect(trust.isTrusted(target)).toBe(false);
  });
});
