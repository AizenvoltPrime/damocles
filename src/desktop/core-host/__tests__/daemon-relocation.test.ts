import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { ProjectRelocations } from '../../../core/project-relocation';
import { parseStore } from '../../../core/project-relocation/identity-store';
import { parseJournal, RelocationStore } from '../../../core/project-relocation/store';
import { RELOCATION_STEPS, type RelocationRecord, type RelocationStepName, type RelocationStepState } from '../../../core/project-relocation/types';
import { piSessionDir } from '../../../core/pi-session/session-store/session-dir';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { createCoreEndpoint, createLoopback, createMainEndpoint, type CoreInit } from '../../core-protocol';
import { startCoreForge } from '../forge';
import type { CorePlatform } from '../platform';
import { createTrustMirror } from '../platform/mirrored';

// A daemon's core runs the same relocation on the target's ~/.damocles (docs/invariants.md "Project relocation"): its
// hostState step re-keys only its own MCP toggles, since no forge service exists there, and its trust is the clients' mirror.

const SESSION = '0b0c0d0e-0000-4000-8000-000000000001';
let dir: string;
let from: string;
let to: string;
const opened: Array<{ dispose(): void }> = [];

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-relocation-')));
  from = path.join(dir, 'acme');
  to = path.join(dir, 'acme-renamed');
});

afterEach(() => {
  for (const item of opened.splice(0)) item.dispose();
  for (const folder of [from, to]) fs.rmSync(piSessionDir(folder), { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

const journal = (): string => path.join(dir, 'project-relocations.json');
const lockDir = (): string => path.join(dir, 'locks');
const onDisk = (id: string): RelocationRecord => parseJournal(fs.readFileSync(journal(), 'utf8'), () => undefined).records.find((record) => record.id === id)!;

// The record a daemon's core wrote before it was killed: nothing moved yet, its lock left behind by the dead process.
async function interruptedRelocation(id: string, steps: (name: RelocationStepName) => RelocationStepState): Promise<void> {
  const store = new RelocationStore({ file: journal(), watcherFactory: createFakePlatform().fileWatchers, log: () => undefined });
  const all = Object.fromEntries(RELOCATION_STEPS.map((name) => [name, steps(name)])) as Record<RelocationStepName, RelocationStepState>;
  await store.add((seq) => ({ id, seq, requestedBy: 'daemon', mode: 'locate', folders: [{ kind: 'project', from, to }], chats: 1, state: 'running', steps: all, startedAt: 1 }));
  store.dispose();
}

function daemonRelocations(trust: ConstructorParameters<typeof ProjectRelocations>[0]['trust'], mcpMoves: unknown[]): ProjectRelocations {
  const relocations = new ProjectRelocations({
    requestedBy: 'daemon',
    watcherFactory: createFakePlatform().fileWatchers,
    metaIndex: { move: async () => undefined, meta: async () => null },
    memory: { relocateWorkspace: async () => ({}) },
    // as ChatPanelProvider builds it on a daemon's core, where startCoreForge gives no forge service
    hostState: { mcp: { relocateFolders: async (pairs) => void mcpMoves.push(...pairs) } },
    trust,
    projectFolders: () => [to],
    log: () => undefined,
    file: journal(),
    identitiesFile: path.join(dir, 'folder-identities.json'),
    lockDir: lockDir(),
  });
  opened.push(relocations);
  return relocations;
}

const noTrust = { isTrusted: () => false, onDidGrantTrust: () => ({ dispose: () => undefined }) };

describe('a relocation on a daemon\'s core', () => {
  it('has no forge step target: a daemon\'s core starts no forge service', () => {
    const platform = { init: { remote: { hostId: 'h1' }, paths: { forge: path.join(dir, 'forge') } } } as unknown as CorePlatform;
    expect(startCoreForge(platform, {} as Parameters<typeof startCoreForge>[1], () => undefined)).toBeUndefined();
  });

  it('rolls forward at the next start after its core was killed mid-run, re-keys its MCP toggles and records the new folder\'s identity', async () => {
    fs.mkdirSync(path.join(to, '.git'), { recursive: true });
    fs.writeFileSync(path.join(to, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/widgets.git\n');
    const sessions = piSessionDir(from);
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, `2026-01-01T10-00-00-000Z_${SESSION}.jsonl`), `${JSON.stringify({ type: 'session', version: 3, id: SESSION, timestamp: '2026-01-01T10:00:00.000Z', cwd: from })}\n`);
    await interruptedRelocation('killed', () => ({ state: 'pending' }));
    // the killed core's lock, past the lease's stale time
    const lock = path.join(lockDir(), 'killed.lock');
    fs.mkdirSync(lock, { recursive: true });
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, past, past);

    const mcpMoves: unknown[] = [];
    const relocations = daemonRelocations(noTrust, mcpMoves);
    await relocations.resumeAtStart();
    await relocations.whenIdle();

    expect(onDisk('killed')).toMatchObject({ state: 'coreDone', requestedBy: 'daemon' });
    expect(fs.readdirSync(piSessionDir(to))).toEqual([`2026-01-01T10-00-00-000Z_${SESSION}.jsonl`]);
    expect(mcpMoves).toEqual([{ from, to }]);
    await relocations.recordIdentities();
    expect(parseStore(fs.readFileSync(path.join(dir, 'folder-identities.json'), 'utf8'), () => undefined)).toEqual([expect.objectContaining({ path: to, remotes: ['github.com/acme/widgets'] })]);
  });

  it('repairs once a client\'s trust grant reaches the daemon\'s core through the trust mirror', async () => {
    await interruptedRelocation('untrusted', (name) => (name === 'repair' ? { state: 'waiting', failure: { code: 'untrusted', params: { count: 1 } } } : { state: 'done' }));
    const loop = createLoopback();
    const main = createMainEndpoint(loop.main, () => undefined);
    const core = createCoreEndpoint(loop.core, () => undefined);
    const trust = createTrustMirror(core, { mirrors: { trust: { keys: [] } } } as unknown as CoreInit, () => undefined);
    opened.push(trust);
    const relocations = daemonRelocations(trust, []);
    await relocations.whenIdle();
    expect(onDisk('untrusted').steps.repair.state).toBe('waiting');

    // the daemon publishes the union of its clients' grants, naming the folders just granted
    main.publish('trust', { keys: [folderKey(to)], granted: [to] });
    await expect.poll(() => onDisk('untrusted').steps.repair).toEqual({ state: 'done' });
    await relocations.whenIdle();
  });
});
