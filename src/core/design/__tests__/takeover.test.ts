import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesignChatStateView } from '../../../shared/types/design';
import { designWriteBlock } from '../design-write-rule';
import { designFolderOf, designStateDirOf } from '../design-paths';
import { takeOverDesignLink, updateDesignLink } from '../design-state';
import { designContentHash, readManifest } from '../design-files';
import { clearDesigns, designHarness, fakeSession, stampDesignVersion } from './design-harness';

const DESIGN = 'contacts-abcd1234';
const FOLDER = designFolderOf(DESIGN);
const STATE = designStateDirOf(DESIGN);
const role = { id: 'role', type: 'custom', customType: 'damocles.design', data: { v: 1, designId: DESIGN, parentSessionId: 'parent-1', ruleSet: 'full', title: 'Contacts' } };
const linkTo = (designSessionId: string) =>
  updateDesignLink(STATE, () => ({ schemaVersion: 1, designId: DESIGN, folder: FOLDER, title: 'Contacts', parentSessionId: 'parent-1', designSessionId, superseded: [] }));
const designStates = (posted: unknown[]): DesignChatStateView[] =>
  posted.flatMap((m) => ((m as { type: string }).type === 'designState' ? [(m as { design: DesignChatStateView }).design] : []));

beforeEach(() => {
  clearDesigns();
  fs.mkdirSync(FOLDER, { recursive: true });
});

describe('a superseded design chat (PD-36)', () => {
  it('stands where link.json, as each check reads it, puts it: current before the takeover, superseded by the new chat after it', async () => {
    await linkTo('design-1');
    const h = designHarness({ session: fakeSession('design-1', [role]) });
    expect(await h.design.readLink()).toEqual({ kind: 'current' });
    expect(h.design.scope()).not.toHaveProperty('superseded');
    await takeOverDesignLink(STATE, 'design-1', 'design-2', new Set());
    expect(await h.design.readLink()).toEqual({ kind: 'superseded', by: 'design-2' });
    expect(h.design.standing()).toEqual({ kind: 'superseded', by: 'design-2' });
    expect(h.design.scope()).toMatchObject({ folder: FOLDER, superseded: true });
  });

  it('stands as handing over while its own takeover runs, and fails closed on a link.json that does not parse', async () => {
    await linkTo('design-1');
    const h = designHarness({ session: fakeSession('design-1', [role]) });
    const release = h.design.beginTakeover();
    expect(await h.design.readLink()).toEqual({ kind: 'handing-over' });
    expect(h.design.scope()).toMatchObject({ superseded: true });
    release();
    expect(h.design.standing()).toEqual({ kind: 'current' });
    fs.writeFileSync(path.join(STATE, 'link.json'), '{"schemaVersion":1}');
    expect(await h.design.readLink()).toEqual({ kind: 'unreadable' });
    expect(h.design.scope()).toMatchObject({ superseded: true });
  });

  it('learns of a takeover from the state-folder watch, without a send', async () => {
    await linkTo('design-1');
    const h = designHarness({ session: fakeSession('design-1', [role]) });
    h.design.onBound();
    await vi.waitFor(() => expect(designStates(h.posted).length).toBeGreaterThan(0));
    await takeOverDesignLink(STATE, 'design-1', 'design-2', new Set());
    const watcher = h.platform.fileWatchers.watchers.find((w) => w.base === STATE && !w.disposed);
    watcher!.fireChange(`${STATE}/link.json`);
    await vi.waitFor(() => expect(h.design.scope()).toMatchObject({ superseded: true }));
  });

  it('publishes superseded with the session that continues the design', async () => {
    await linkTo('design-2');
    const h = designHarness({ session: fakeSession('design-1', [role]) });
    h.design.publish();
    await vi.waitFor(() => expect(designStates(h.posted).at(-1)).toMatchObject({ superseded: true, supersededBy: 'design-2' }));
    await linkTo('design-1');
    h.design.publish();
    await vi.waitFor(() => expect(designStates(h.posted).at(-1)).toMatchObject({ superseded: false, supersededBy: null }));
  });

  it('never rebuilds decisions.md over its successor\'s', async () => {
    await linkTo('design-2');
    const decisions = path.join(FOLDER, 'decisions.md');
    fs.writeFileSync(decisions, 'the new chat\'s decisions');
    const h = designHarness({ session: fakeSession('design-1', [role]) });
    h.design.refresh();
    await h.design.settledWrites();
    await vi.waitFor(() => expect(designStates(h.posted)).toHaveLength(1));
    expect(fs.readFileSync(decisions, 'utf8')).toBe('the new chat\'s decisions');
  });

  it('opens the chat link.json names from its banner, and says so when that chat is gone', async () => {
    await linkTo('design-2');
    const h = designHarness({ session: fakeSession('design-1', [role]) });
    await h.design.openDesignChat(DESIGN);
    expect(h.panels.showSession).toHaveBeenCalledWith('design-2');
    h.panels.showSession.mockResolvedValueOnce('missing');
    await h.design.openDesignChat(DESIGN);
    expect(h.platform.notifications.calls.map((c) => c.message)).toEqual(['The chat this design continues in no longer exists.']);
  });
});

describe('the gate in a superseded design chat (PD-36)', () => {
  const scope = { folder: FOLDER, cwd: FOLDER, superseded: true } as const;

  it('blocks writes and every design tool, the folder\'s own files included, and still lets it read', () => {
    expect(designWriteBlock('Write', { file_path: path.join(FOLDER, 'design.md'), content: 'x' }, scope)).toMatch(/continues in another design chat/);
    expect(designWriteBlock('Edit', { file_path: path.join(FOLDER, 'screens', 'S1.html'), old_string: 'a', new_string: 'b' }, scope)).toMatch(/continues in another design chat/);
    for (const tool of ['RecordDecision', 'DesignCheck', 'FinishDesign', 'Inventory', 'ExtractTokens', 'ImportAsset', 'MapReference', 'DeclareTweaks']) {
      expect(designWriteBlock(tool, {}, scope)).toMatch(/continues in another design chat/);
    }
    expect(designWriteBlock('Read', { file_path: path.join(FOLDER, 'design.md') }, scope)).toBeUndefined();
    expect(designWriteBlock('Write', { file_path: path.join(FOLDER, 'design.md'), content: 'x' }, { folder: FOLDER, cwd: FOLDER })).toBeUndefined();
  });
});

describe('a new design chat\'s first bind (PD-39)', () => {
  it('records the role before the bind builds the gate and the checkpoint service, so both guard the design folder from its first turn', async () => {
    const seed = { designId: DESIGN, title: 'Contacts', parentSessionId: 'parent-1', ruleSet: 'full' as const };
    const fresh = fakeSession('design-1', []);
    const h = designHarness({ seed, session: fresh });
    expect(h.design.scope()).toBeUndefined();
    h.design.recordSeededRole(fresh.session);
    expect(h.design.role()).toMatchObject({ designId: DESIGN, folder: FOLDER, parentSessionId: 'parent-1' });
    expect(h.design.scope()).toMatchObject({ folder: FOLDER });
    // named after its design, never the main chat's title, which is only its first message during that chat's first turn
    expect(fresh.name).toBe('Design · Contacts');
    expect(fresh.entries[0]!['data']).not.toHaveProperty('parentTitle');
    // A rebind of the same conversation records nothing again.
    h.design.recordSeededRole(fresh.session);
    expect(fresh.entries.filter((e) => e['customType'] === 'damocles.design')).toHaveLength(1);
  });
});

describe('the manifest after files come back (PD-24)', () => {
  it('takes its version from the state folder, finished only while the folder holds that version\'s content', async () => {
    await linkTo('design-1');
    fs.writeFileSync(path.join(FOLDER, 'design.md'), '# v1\n');
    fs.writeFileSync(path.join(FOLDER, 'manifest.json'), JSON.stringify({ schemaVersion: 1, designId: DESIGN, plan: null, fidelity: null, status: 'draft', version: null, screens: [], updatedAt: '2026-01-01T00:00:00.000Z' }));
    const contentHash = await designContentHash(FOLDER);
    await stampDesignVersion(STATE, { sessionId: 'design-1', stillCurrent: () => true }, contentHash, [], (version) => ({
      schemaVersion: 1, version, designId: DESIGN, title: 'Contacts', sessionId: 'design-1', toolCallId: 'c1', contentHash, decisions: [], screens: [],
      check: { errors: 0, warnings: [] }, journeys: [], summary: 's', changedSinceLast: [], finishedAt: '2026-01-01T00:00:00.000Z',
    }));
    const h = designHarness({ session: fakeSession('design-1', [role]) });
    h.design.refresh({ filesRestored: true });
    await h.design.settledWrites();
    expect(await readManifest(FOLDER, DESIGN)).toMatchObject({ version: 1, status: 'finished' });
    fs.writeFileSync(path.join(FOLDER, 'design.md'), '# after v1\n');
    h.design.refresh({ filesRestored: true });
    await h.design.settledWrites();
    expect(await readManifest(FOLDER, DESIGN)).toMatchObject({ version: 1, status: 'draft' });
  });
});
