import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_STORE_FILE, HostStore } from '../host-store';
import { PROJECTS_FILE, ProjectList } from '../../projects';
import { TRUST_FILE, TrustStore } from '../../trust-store';
import { folderKey } from '../../../../core/workspace-folders/folder-key';

// The parsers of projects.json and trusted-folders.json as commit 6dd3c95d has them (projects.ts:11-15, trust-store.ts:21-25),
// frozen here: what an older app reads after this version wrote its stores.
function parseProjects6dd3c95d(text: string): string[] {
  const parsed = JSON.parse(text) as { version?: unknown; projects?: unknown } | null;
  if (parsed?.version !== 1 || !Array.isArray(parsed.projects)) throw new Error('unknown schema');
  return (parsed.projects as unknown[]).filter((entry): entry is string => typeof entry === 'string' && path.isAbsolute(entry));
}
function parseFolders6dd3c95d(text: string): string[] {
  const parsed = JSON.parse(text) as { version?: unknown; folders?: unknown } | null;
  if (parsed?.version !== 1 || !Array.isArray(parsed.folders)) throw new Error('unknown schema');
  return (parsed.folders as unknown[]).filter((entry): entry is string => typeof entry === 'string' && path.isAbsolute(entry));
}

const LOOPBACK = 'loopback';
let userData: string;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-hosts-'));
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

const record = (folder: string): { path: string; folderKey: string; os: 'win32' | 'linux' } => ({ path: folder, folderKey: folderKey(folder), os: process.platform === 'win32' ? 'win32' : 'linux' });
const keyOf = (folder: string): string => `loopback|${folderKey(folder)}`;

describe('HostStore', () => {
  it('keeps each authority\'s projects and trust, and reads them back', async () => {
    const app = path.join(userData, 'app');
    const store = await HostStore.open(userData, () => undefined);
    const changed = vi.fn();
    store.onDidChange(changed);
    expect(await store.addProject(LOOPBACK, record(app), keyOf(app), [])).toBe(true);
    expect(await store.addProject(LOOPBACK, record(app), keyOf(app), [keyOf(app)])).toBe(false);
    await store.grantTrust(LOOPBACK, folderKey(app));
    expect(changed).toHaveBeenCalledTimes(2);
    const reread = await HostStore.open(userData, () => undefined);
    expect(reread.projects()).toEqual([{ authorityKey: LOOPBACK, project: record(app) }]);
    expect(reread.isTrusted(LOOPBACK, folderKey(app))).toBe(true);
    expect(reread.isTrusted('ssh+x', folderKey(app))).toBe(false);
    await reread.removeProject(LOOPBACK, folderKey(app), keyOf(app));
    expect((await HostStore.open(userData, () => undefined)).projects()).toEqual([]);
  });

  it('reconciles the sidebar order with the listed projects: drops gone keys and appends unlisted ones', async () => {
    const [a, b, c] = ['a', 'b', 'c'].map((name) => folderKey(path.join(userData, name)));
    const remote = path.join(userData, 'remote');
    const store = await HostStore.open(userData, () => undefined);
    expect(store.order([a!, b!])).toEqual([a, b]);
    // the remote project joins after the local projects shown when it was added
    await store.addProject(LOOPBACK, record(remote), keyOf(remote), [a!, b!]);
    expect(store.order([a!, b!, keyOf(remote)])).toEqual([a, b, keyOf(remote)]);
    // an older version removed b from projects.json and added c
    expect(store.order([a!, c!, keyOf(remote)])).toEqual([a, keyOf(remote), c]);
  });

  it('changes nothing in memory when the write fails', async () => {
    const app = path.join(userData, 'app');
    const store = await HostStore.open(userData, () => undefined);
    fs.mkdirSync(path.join(userData, HOST_STORE_FILE));
    const changed = vi.fn();
    store.onDidChange(changed);
    await expect(store.addProject(LOOPBACK, record(app), keyOf(app), [])).rejects.toThrow();
    await expect(store.grantTrust(LOOPBACK, folderKey(app))).rejects.toThrow();
    expect(store.projects()).toEqual([]);
    expect(store.isTrusted(LOOPBACK, folderKey(app))).toBe(false);
    expect(changed).not.toHaveBeenCalled();
  });

  it('settles flush once the queued writes landed', async () => {
    const store = await HostStore.open(userData, () => undefined);
    const app = path.join(userData, 'app');
    void store.addProject(LOOPBACK, record(app), keyOf(app), []);
    void store.grantTrust(LOOPBACK, folderKey(app));
    await store.flush();
    const text = fs.readFileSync(path.join(userData, HOST_STORE_FILE), 'utf8');
    expect(JSON.parse(text)).toEqual({ version: 1, authorities: { loopback: { projects: [record(app)], trusted: [folderKey(app)] } }, order: [keyOf(app)] });
  });

  it('ignores an unreadable file and drops invalid entries', async () => {
    const log = vi.fn();
    fs.writeFileSync(path.join(userData, HOST_STORE_FILE), '{ nope');
    expect((await HostStore.open(userData, log)).projects()).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ignoring'));
    const app = path.join(userData, 'app');
    fs.writeFileSync(path.join(userData, HOST_STORE_FILE), JSON.stringify({
      version: 1,
      authorities: { local: { projects: [record(app)] }, loopback: { projects: [record(app), record(app), { path: 3 }, { ...record(path.join(userData, 'other')), os: 'aix' }], trusted: ['', 7, 'k'] } },
      order: ['x', 'x', 5],
    }));
    const store = await HostStore.open(userData, () => undefined);
    expect(store.projects()).toEqual([{ authorityKey: LOOPBACK, project: record(app) }]);
    expect(store.isTrusted(LOOPBACK, 'k')).toBe(true);
    expect(store.order(['x'])).toEqual(['x']);
  });

  it('reads a __proto__ authority key as a plain key and never an inherited member', async () => {
    fs.writeFileSync(path.join(userData, HOST_STORE_FILE), '{"version":1,"authorities":{"__proto__":{"projects":[],"trusted":["k"]}},"order":[]}');
    const store = await HostStore.open(userData, () => undefined);
    expect(store.isTrusted('__proto__', 'k')).toBe(true);
    expect(store.isTrusted('constructor', 'k')).toBe(false);
    expect(store.isTrusted('toString', 'k')).toBe(false);
    await store.grantTrust('constructor', 'k');
    expect(store.isTrusted('constructor', 'k')).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(userData, HOST_STORE_FILE), 'utf8')).authorities.__proto__).toEqual({ projects: [], trusted: ['k'] });
  });

  it('leaves projects.json and trusted-folders.json as 6dd3c95d reads them, listing the same local entries', async () => {
    const local = [path.join(userData, 'one'), path.join(userData, 'two')];
    const projects = new ProjectList(userData, () => undefined);
    const trust = new TrustStore(userData, () => Promise.resolve(undefined), (message) => message, () => undefined);
    for (const folder of local) {
      await projects.add(folder);
      await trust.grant(folder);
    }
    const projectsBefore = fs.readFileSync(path.join(userData, PROJECTS_FILE), 'utf8');
    const trustBefore = fs.readFileSync(path.join(userData, TRUST_FILE), 'utf8');
    const store = await HostStore.open(userData, () => undefined);
    const remote = path.join(userData, 'one');
    await store.addProject(LOOPBACK, record(remote), keyOf(remote), local.map(folderKey));
    await store.grantTrust(LOOPBACK, folderKey(remote));
    await Promise.all([projects.flush(), trust.flush(), store.flush()]);
    const projectsText = fs.readFileSync(path.join(userData, PROJECTS_FILE), 'utf8');
    const trustText = fs.readFileSync(path.join(userData, TRUST_FILE), 'utf8');
    expect(projectsText).toBe(projectsBefore);
    expect(trustText).toBe(trustBefore);
    expect(parseProjects6dd3c95d(projectsText)).toEqual(local);
    expect(parseFolders6dd3c95d(trustText)).toEqual(local);
    // the same folder opened through the daemon is a project of its own, beside the local one
    expect(new ProjectList(userData, () => undefined).folders().map((folder) => folder.fsPath)).toEqual(local);
    expect(store.order([...local.map(folderKey), keyOf(remote)])).toEqual([...local.map(folderKey), keyOf(remote)]);
  });
});
