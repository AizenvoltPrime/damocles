import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_STORE_FILE, HostStore } from '../host-store';
import { keepKnownHosts } from '../keep-hosts';

let userData: string;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-keep-hosts-'));
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

const client = () => ({ forgeKeepHosts: vi.fn(async () => ({})), themesKeepHosts: vi.fn(async () => undefined) });
const PROJECT = { path: '/srv/app', folderKey: '/srv/app', os: 'linux' as const };

describe('what a core start tells core to keep', () => {
  it('names the authorities of the saved hosts and of the listed projects', async () => {
    const store = await HostStore.open(userData, () => undefined);
    await store.addProject('ssh+prod', PROJECT, 'ssh+prod|/srv/app', () => []);
    const core = client();
    await keepKnownHosts(store, core as never, () => undefined);
    expect(core.forgeKeepHosts).toHaveBeenCalledWith(['ssh+prod']);
    expect(core.themesKeepHosts).toHaveBeenCalledWith(['ssh+prod']);
  });

  // An empty list would make core drop every remote project's look and pins, and rewrite the history snapshots without them.
  it('tells core nothing when remote-hosts.json does not parse, since the hosts it holds are unknown, not gone', async () => {
    const store = await HostStore.open(userData, () => undefined);
    await store.addProject('ssh+prod', PROJECT, 'ssh+prod|/srv/app', () => []);
    fs.writeFileSync(path.join(userData, HOST_STORE_FILE), '{ "version": 1, "authorities": ');
    const lines: string[] = [];
    const unreadable = await HostStore.open(userData, () => undefined);
    expect(unreadable.unreadable()).toBeDefined();
    expect(unreadable.projects()).toEqual([]);
    const core = client();
    await keepKnownHosts(unreadable, core as never, (line) => lines.push(line));
    expect(core.forgeKeepHosts).not.toHaveBeenCalled();
    expect(core.themesKeepHosts).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('remote-hosts.json could not be read');
  });

  it('tells core nothing while the host store is not open', async () => {
    const core = client();
    await keepKnownHosts(undefined, core as never, () => undefined);
    expect(core.forgeKeepHosts).not.toHaveBeenCalled();
    expect(core.themesKeepHosts).not.toHaveBeenCalled();
  });

  it('names no authority once every host and remote project is gone from a file that reads', async () => {
    const core = client();
    await keepKnownHosts(await HostStore.open(userData, () => undefined), core as never, () => undefined);
    expect(core.forgeKeepHosts).toHaveBeenCalledWith([]);
    expect(core.themesKeepHosts).toHaveBeenCalledWith([]);
  });
});
