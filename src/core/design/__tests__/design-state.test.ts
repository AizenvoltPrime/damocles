import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commitDesignVersion,
  DESIGN_MOVED_FINISH,
  probeDesignVersion,
  claimDesignLink,
  createForkDesignLink,
  readBriefRecords,
  readDesignLink,
  takeOverDesignLink,
  writeBriefToCurrentChat,
  readLatestVersion,
  updateDesignLink,
  withDesignStateLock,
  writeBriefRecord,
  type DesignVersionProbe,
  type DesignVersionRecord,
} from '../design-state';
import { stampDesignVersion } from './design-harness';

type NewProbe = Extract<DesignVersionProbe, { kind: 'new' }>;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function stateDir(): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'design-state-')), 'contacts-abcd1234');
  dirs.push(path.dirname(dir));
  return dir;
}

const record = (version: number, contentHash: string, renderHashes: Record<string, string> | null = { 'screens/S1.html': 'render-hash' }): DesignVersionRecord => ({
  schemaVersion: 1,
  version,
  designId: 'contacts-abcd1234',
  title: 'Contacts',
  sessionId: 'design-1',
  toolCallId: `call-${version}`,
  contentHash,
  decisions: [{ id: 'D1', title: 'Fidelity', chosen: 'Static mockup' }],
  screens: ['S1'],
  ...(renderHashes ? { renderHashes } : {}),
  check: { errors: 0, warnings: [] },
  journeys: [],
  summary: 'The list.',
  changedSinceLast: [],
  finishedAt: '2026-01-01T00:00:00.000Z',
});

const CHAT = { sessionId: 'design-1', stillCurrent: () => true };

describe('the design state folder', () => {
  it('reuses the latest version when neither the content nor the decisions changed (PD-24)', async () => {
    const dir = stateDir();
    const decisions = [{ id: 'D1', title: 'Fidelity', chosen: 'Static mockup' }];
    const first = await stampDesignVersion(dir, CHAT, 'hash-a', decisions, (v) => record(v, 'hash-a'));
    const again = await stampDesignVersion(dir, CHAT, 'hash-a', decisions, (v) => record(v, 'hash-a'));
    expect([first.record.version, first.reused, again.record.version, again.reused]).toEqual([1, false, 1, true]);
    const changed = await stampDesignVersion(dir, CHAT, 'hash-b', decisions, (v, previous) => ({ ...record(v, 'hash-b'), changedSinceLast: previous ? ['S1 changed'] : [] }));
    expect([changed.record.version, changed.reused, changed.record.changedSinceLast]).toEqual([2, false, ['S1 changed']]);
    const newDecision = await stampDesignVersion(dir, CHAT, 'hash-b', [...decisions, { id: 'D2', title: 'Density', chosen: 'Compact' }], (v) => record(v, 'hash-b'));
    expect(newDecision.record.version).toBe(3);
    expect((await readLatestVersion(dir))?.version).toBe(3);
  });

  it('records a new version over one without render hashes, which DesignParity cannot compare', async () => {
    const dir = stateDir();
    const decisions = [{ id: 'D1', title: 'Fidelity', chosen: 'Static mockup' }];
    await stampDesignVersion(dir, CHAT, 'hash-a', decisions, (v) => record(v, 'hash-a', null));
    const again = await stampDesignVersion(dir, CHAT, 'hash-a', decisions, (v) => record(v, 'hash-a'));
    expect([again.record.version, again.reused, again.record.renderHashes]).toEqual([2, false, { 'screens/S1.html': 'render-hash' }]);
  });

  it('never hands two finishes one number under contention, and numbers each new version after the latest', async () => {
    const dir = stateDir();
    const probes = await Promise.all(Array.from({ length: 8 }, (_, i) => probeDesignVersion(dir, CHAT, `hash-${i}`, [])));
    const commits = await Promise.allSettled(probes.map((probe, i) => commitDesignVersion(dir, CHAT, probe as NewProbe, async () => `hash-${i}`, (v) => record(v, `hash-${i}`))));
    expect(commits.filter((c) => c.status === 'fulfilled').map((c) => c.value.version)).toEqual([1]);
    expect(commits.filter((c) => c.status === 'rejected').map((c) => String(c.reason))).toEqual(Array.from({ length: 7 }, () => `Error: ${DESIGN_MOVED_FINISH}`));
    for (let i = 2; i <= 4; i++) await stampDesignVersion(dir, CHAT, `next-${i}`, [], (v) => record(v, `next-${i}`));
    expect(fs.readdirSync(path.join(dir, 'versions')).sort()).toEqual(['v1.json', 'v2.json', 'v3.json', 'v4.json']);
  });

  it('probes without writing, and a commit refuses, writing nothing, when the folder or the versions moved since the probe', async () => {
    const dir = stateDir();
    const decisions = [{ id: 'D1', title: 'Fidelity', chosen: 'Static mockup' }];
    const probe = await probeDesignVersion(dir, CHAT, 'hash-a', decisions);
    expect(probe).toEqual({ kind: 'new', previous: undefined, contentHash: 'hash-a' });
    expect(fs.existsSync(path.join(dir, 'versions'))).toBe(false);
    await expect(commitDesignVersion(dir, CHAT, probe as NewProbe, async () => 'hash-edited', (v) => record(v, 'hash-a'))).rejects.toThrow(DESIGN_MOVED_FINISH);
    expect(fs.existsSync(path.join(dir, 'versions'))).toBe(false);
    await stampDesignVersion(dir, CHAT, 'hash-other', decisions, (v) => record(v, 'hash-other'));
    await expect(commitDesignVersion(dir, CHAT, probe as NewProbe, async () => 'hash-a', (v) => record(v, 'hash-a'))).rejects.toThrow(DESIGN_MOVED_FINISH);
    expect(fs.readdirSync(path.join(dir, 'versions'))).toEqual(['v1.json']);
    const next = await probeDesignVersion(dir, CHAT, 'hash-a', decisions);
    expect(next).toMatchObject({ kind: 'new', previous: { version: 1, contentHash: 'hash-other' } });
    expect((await commitDesignVersion(dir, CHAT, next as NewProbe, async () => 'hash-a', (v, previous) => ({ ...record(v, 'hash-a'), changedSinceLast: previous ? [`after v${previous.version}`] : [] }))))
      .toMatchObject({ version: 2, changedSinceLast: ['after v1'] });
  });

  it('serializes the lock: a body runs only after the one before it released', async () => {
    const dir = stateDir();
    const order: string[] = [];
    let release!: () => void;
    const held = withDesignStateLock(dir, async () => {
      order.push('first in');
      await new Promise<void>((resolve) => { release = resolve; });
      order.push('first out');
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = withDesignStateLock(dir, async () => { order.push('second'); });
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await Promise.all([held, second]);
    expect(order).toEqual(['first in', 'first out', 'second']);
  });

  it('lets a new design chat claim the link, superseding the old one and taking the unclaimed briefs', async () => {
    const dir = stateDir();
    await updateDesignLink(dir, () => ({ schemaVersion: 1, designId: 'contacts-abcd1234', folder: '/f', title: 'Contacts', parentSessionId: 'parent-1', designSessionId: 'old-chat', superseded: [] }));
    const forOld = await writeBriefRecord(dir, { parentSessionId: 'parent-1', designSessionId: 'old-chat', text: 'first', reopened: false });
    const pending = await writeBriefRecord(dir, { parentSessionId: 'parent-1', designSessionId: null, text: 'second', reopened: false, context: { kind: 'takeover' } });
    const link = await claimDesignLink(dir, 'new-chat', { designId: 'contacts-abcd1234', folder: '/f', title: 'Contacts', parentSessionId: 'parent-1' });
    expect([link.designSessionId, link.superseded]).toEqual(['new-chat', ['old-chat']]);
    expect(await readDesignLink(dir)).toEqual(link);
    const briefs = await readBriefRecords(dir);
    expect(briefs.map((b) => [b.briefId, b.designSessionId])).toEqual([[forOld.briefId, 'old-chat'], [pending.briefId, 'new-chat']]);
    expect(briefs[1]?.context).toEqual({ kind: 'takeover' });
  });

  it('skips a brief file that is not JSON, so the other briefs still read and the link can still be claimed', async () => {
    const dir = stateDir();
    const good = await writeBriefRecord(dir, { parentSessionId: 'parent-1', designSessionId: null, text: 'first', reopened: false });
    fs.writeFileSync(path.join(dir, 'briefs', 'b-broken.json'), '{"schemaVersion":1,');
    expect((await readBriefRecords(dir)).map((b) => b.briefId)).toEqual([good.briefId]);
    const link = await claimDesignLink(dir, 'new-chat', { designId: 'contacts-abcd1234', folder: '/f', title: 'Contacts', parentSessionId: 'parent-1' });
    expect(link.designSessionId).toBe('new-chat');
    expect((await readBriefRecords(dir)).map((b) => b.designSessionId)).toEqual(['new-chat']);
  });

  it('gives a chat link.json no longer names, or one handing over, neither a new version nor the latest again (PD-36)', async () => {
    const dir = stateDir();
    const decisions = [{ id: 'D1', title: 'Fidelity', chosen: 'Static mockup' }];
    await stampDesignVersion(dir, CHAT, 'hash-a', decisions, (v) => record(v, 'hash-a'));
    await expect(probeDesignVersion(dir, { sessionId: 'design-1', stillCurrent: () => false }, 'hash-a', decisions)).rejects.toThrow(/continues in another design chat/);
    // A takeover while the approval was open: the probe passed, the commit refuses.
    let current = true;
    const handingOver = { sessionId: 'design-1', stillCurrent: () => current };
    const probe = await probeDesignVersion(dir, handingOver, 'hash-b', decisions);
    current = false;
    await expect(commitDesignVersion(dir, handingOver, probe as NewProbe, async () => 'hash-b', (v) => record(v, 'hash-b'))).rejects.toThrow(/continues in another design chat/);
    const beforeTakeover = await probeDesignVersion(dir, CHAT, 'hash-b', decisions);
    await updateDesignLink(dir, () => ({ schemaVersion: 1, designId: 'contacts-abcd1234', folder: '/f', title: 'Contacts', parentSessionId: 'parent-1', designSessionId: 'design-2', superseded: ['design-1'] }));
    await expect(probeDesignVersion(dir, CHAT, 'hash-a', decisions)).rejects.toThrow(/continues in another design chat/);
    await expect(commitDesignVersion(dir, CHAT, beforeTakeover as NewProbe, async () => 'hash-b', (v) => record(v, 'hash-b'))).rejects.toThrow(/continues in another design chat/);
    expect((await readLatestVersion(dir))?.version).toBe(1);
  });

  it('refuses a link.json that does not parse rather than overwriting it', async () => {
    const dir = stateDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'link.json'), '{"schemaVersion":1}');
    await expect(readDesignLink(dir)).rejects.toThrow(/not a design link/);
    await expect(updateDesignLink(dir, (current) => current!)).rejects.toThrow(/not a design link/);
  });
});

describe('rewind takeover and design fork links (PD-36)', () => {
  const linked = (dir: string, designSessionId: string, superseded: string[] = []) =>
    updateDesignLink(dir, () => ({ schemaVersion: 1, designId: 'contacts-abcd1234', folder: '/d', title: 'Contacts', parentSessionId: 'parent-1', designSessionId, superseded }));

  it('names the new chat, supersedes the old one, and hands over only the briefs the old branch never delivered', async () => {
    const dir = stateDir();
    await linked(dir, 'old-chat', ['older-chat']);
    const delivered = await writeBriefRecord(dir, { parentSessionId: 'parent-1', designSessionId: 'old-chat', text: 'delivered before the rewind', reopened: false });
    const pending = await writeBriefRecord(dir, { parentSessionId: 'parent-1', designSessionId: 'old-chat', text: 'never delivered', reopened: true });
    const elsewhere = await writeBriefRecord(dir, { parentSessionId: 'parent-1', designSessionId: 'older-chat', text: 'an older chat', reopened: false });
    const link = await takeOverDesignLink(dir, 'old-chat', 'new-chat', new Set([delivered.briefId]));
    expect(link).toMatchObject({ designSessionId: 'new-chat', superseded: ['older-chat', 'old-chat'], parentSessionId: 'parent-1', title: 'Contacts' });
    expect(await readDesignLink(dir)).toEqual(link);
    const owner = new Map((await readBriefRecords(dir)).map((b) => [b.briefId, b.designSessionId]));
    expect(owner).toEqual(new Map([[delivered.briefId, 'old-chat'], [pending.briefId, 'new-chat'], [elsewhere.briefId, 'older-chat']]));
  });

  it('refuses a takeover from a chat that no longer holds the link, changing nothing', async () => {
    const dir = stateDir();
    await linked(dir, 'other-chat', ['old-chat']);
    await expect(takeOverDesignLink(dir, 'old-chat', 'new-chat', new Set())).rejects.toThrow(/no longer holds/);
    expect(await readDesignLink(dir)).toMatchObject({ designSessionId: 'other-chat', superseded: ['old-chat'] });
    await expect(takeOverDesignLink(stateDir(), 'old-chat', 'new-chat', new Set())).rejects.toThrow(/no longer holds/);
  });

  it('gives a fork a link with no parent, and never replaces one that exists', async () => {
    const dir = stateDir();
    expect(await createForkDesignLink(dir, 'fork-1', { designId: 'contacts-abcd1234-f0badf00', folder: '/f', title: 'Contacts' })).toEqual({
      schemaVersion: 1, designId: 'contacts-abcd1234-f0badf00', folder: '/f', title: 'Contacts', parentSessionId: null, designSessionId: 'fork-1', superseded: [],
    });
    await expect(createForkDesignLink(dir, 'fork-2', { designId: 'contacts-abcd1234-f0badf00', folder: '/f', title: 'Contacts' })).rejects.toThrow(/already has a link/);
    expect((await readDesignLink(dir))?.designSessionId).toBe('fork-1');
  });

  it('addresses a reopened brief to the chat link.json names under the lock, never one a takeover just superseded', async () => {
    const dir = stateDir();
    expect(await writeBriefToCurrentChat(dir, { parentSessionId: 'parent-1', text: 'none yet', reopened: true })).toBeUndefined();
    await linked(dir, 'old-chat');
    await takeOverDesignLink(dir, 'old-chat', 'new-chat', new Set());
    expect(await writeBriefToCurrentChat(dir, { parentSessionId: 'parent-1', text: 'add paging', reopened: true })).toMatchObject({ designSessionId: 'new-chat', text: 'add paging' });
    expect((await readBriefRecords(dir)).map((b) => b.designSessionId)).toEqual(['new-chat']);
  });
});
