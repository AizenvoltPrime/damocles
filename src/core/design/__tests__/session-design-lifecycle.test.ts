import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAMOCLES_DESIGN_RESULT } from '../../pi-session/session-store/constants';
import { designFolderOf, designStateDirOf } from '../design-paths';
import { updateDesignLink, writeBriefRecord } from '../design-state';
import { decisionsOnBranch, userMessageQuoted, type DesignDecisionRecord } from '../design-entries';
import * as designFiles from '../design-files';
import { clearDesigns, designHarness, fakeSession, stampDesignVersion, type FakeDesignSession } from './design-harness';

const DESIGN = 'contacts-7a7a7a7a';
const FOLDER = designFolderOf(DESIGN);
const STATE = (): string => designStateDirOf(DESIGN);
const role = { id: 'role', type: 'custom', customType: 'damocles.design', data: { v: 1, designId: DESIGN, parentSessionId: 'parent-1', ruleSet: 'full', title: 'Contacts' } };
const link = (parentSessionId: string) => ({ id: `link-${parentSessionId}`, type: 'custom', customType: 'damocles.design-link', data: { v: 1, designId: DESIGN, folder: FOLDER, parentSessionId, title: 'Contacts' } });
const decision = (id: string, title: string): DesignDecisionRecord => ({ v: 1, id, title, chosen: 'Cards', rejected: [], source: { kind: 'question', ref: 'q' }, files: [] });
const decisionResult = (record: DesignDecisionRecord) => ({ id: `d-${record.id}`, type: 'message', message: { role: 'toolResult', toolName: 'RecordDecision', toolCallId: `c-${record.id}`, content: [], details: { designDecisions: [record] } } });
const linkTo = (designSessionId: string) =>
  updateDesignLink(STATE(), () => ({ schemaVersion: 1, designId: DESIGN, folder: FOLDER, title: 'Contacts', parentSessionId: 'parent-1', designSessionId, superseded: [] }));
const finish = (version: number) => stampDesignVersion(STATE(), { sessionId: 'design-1', stillCurrent: () => true }, `hash-${version}`, [], (v) => ({
  schemaVersion: 1, version: v, designId: DESIGN, title: 'Contacts', sessionId: 'design-1', toolCallId: `c${v}`, contentHash: `hash-${version}`, decisions: [], screens: [],
  check: { errors: 0, warnings: [] }, journeys: [], summary: 's', changedSinceLast: [], finishedAt: '2026-01-01T00:00:00.000Z',
}));
const cards = (session: FakeDesignSession) => session.entries.filter((e) => e['customType'] === DAMOCLES_DESIGN_RESULT);
const decisionsFile = (): string => fs.readFileSync(path.join(FOLDER, 'decisions.md'), 'utf8');

beforeEach(() => {
  clearDesigns();
  fs.mkdirSync(FOLDER, { recursive: true });
});
afterEach(() => vi.restoreAllMocks());

describe('decisions.md belongs to the conversation that asked for it (PD-15)', () => {
  it('writes nothing for a refresh whose session was let go of or switched before its turn in the chain', async () => {
    await linkTo('design-1');
    const designA = fakeSession('design-1', [role, decisionResult(decision('D1', 'Layout'))]);
    const h = designHarness({ session: designA });
    h.design.refresh();
    await h.design.settledWrites();
    expect(decisionsFile()).toContain('D1 · Layout');

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const write = vi.spyOn(designFiles, 'writeDecisions').mockImplementationOnce(() => blocked);
    // a write already in the chain, behind which the refresh waits
    const pending = h.design.decisionsChanged([decision('D2', 'Density')]);
    h.design.refresh();
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    // the panel lets go of the conversation while the chain is held
    h.current = fakeSession('other', []);
    release();
    await pending;
    await h.design.settledWrites();
    expect(write).toHaveBeenCalledTimes(1);
    expect(decisionsFile()).toContain('D1 · Layout');
  });

  it('takes a decision whose write failed off the pending list, so the next is not numbered past it', async () => {
    await linkTo('design-1');
    const h = designHarness({ session: fakeSession('design-1', [role]) });
    vi.spyOn(designFiles, 'writeDecisions').mockRejectedValueOnce(new Error('EPERM'));
    await expect(h.design.decisionsChanged([decision('D1', 'Layout')])).rejects.toThrow('EPERM');
    expect(h.design.pendingDecisions()).toEqual([]);
    await h.design.decisionsChanged([decision('D1', 'Spacing')]);
    expect(h.design.pendingDecisions().map((d) => d.title)).toEqual(['Spacing']);
    expect(decisionsFile()).toContain('D1 · Spacing');
  });
});

describe('the state-folder watch follows the held design (D67)', () => {
  it('watches a parent that gains its link through StartDesign, so a version another process finishes is delivered', async () => {
    const parent = fakeSession('parent-1', []);
    const h = designHarness({ session: parent });
    h.design.onBound();
    expect(() => h.platform.fileWatchers.watcher(STATE(), '**/*.json')).toThrow();
    // StartDesign appends the link and publishes
    parent.entries.push(link('parent-1'));
    h.design.publish();
    const watcher = h.platform.fileWatchers.watcher(STATE(), '**/*.json');
    await finish(1);
    watcher.fireCreate(path.join(STATE(), 'versions', 'v1.json'));
    await vi.waitFor(() => expect(cards(parent)).toHaveLength(1));
    expect(h.delivered.map((d) => d.run)).toEqual([true]);
    h.design.dispose();
    expect(watcher.disposed).toBe(true);
  });
});

describe('the chat becoming idle (D67)', () => {
  it('lands a brief deferred while the design chat was busy, with its run, once the chat is idle', async () => {
    await linkTo('design-1');
    const chat = fakeSession('design-1', [role]);
    const h = designHarness({ session: chat });
    await writeBriefRecord(STATE(), { parentSessionId: 'parent-1', designSessionId: 'design-1', text: 'Add paging', reopened: false });
    h.state = 'streaming';
    await h.design.reconcile('live');
    expect(h.delivered).toEqual([]);
    h.state = 'idle';
    h.design.idle();
    await vi.waitFor(() => expect(h.delivered.map((d) => d.run)).toEqual([true]));
  });

  it('gives a design chat that is no longer current no settle draft', async () => {
    await linkTo('design-2');
    const h = designHarness({ session: fakeSession('design-1', [role]) });
    await writeBriefRecord(STATE(), { parentSessionId: 'parent-1', designSessionId: 'design-1', text: 'Add paging', reopened: false });
    await h.design.readLink();
    expect(await h.design.settleDraft()).toBeUndefined();
  });
});

describe('the seed of a new design chat (D70)', () => {
  const seed = { designId: DESIGN, title: 'Contacts', parentSessionId: 'parent-1', ruleSet: 'full' as const };

  it('makes only the first conversation a design chat; a later one of the panel stays plain', () => {
    const first = fakeSession('design-1', []);
    const h = designHarness({ seed, session: first });
    h.design.recordSeededRole(first.session);
    expect(first.entries.filter((e) => e['customType'] === 'damocles.design')).toHaveLength(1);
    const later = fakeSession('design-2', []);
    h.current = later;
    h.design.recordSeededRole(later.session);
    expect(later.entries).toEqual([]);
    expect(later.name).toBeUndefined();
    expect(h.design.isDesignChat()).toBe(false);
    expect(h.design.chatRuleSetOf([])).toBeUndefined();
  });
});

describe('a chat another Damocles process holds', () => {
  it('tells the user with the lease wording when the main chat or the design chat is open elsewhere', async () => {
    await linkTo('design-2');
    const h = designHarness({ session: fakeSession('design-1', [role]) });
    h.panels.showSession.mockResolvedValue('elsewhere');
    await h.design.openParentChat();
    await h.design.openDesignChat(DESIGN);
    expect(h.platform.notifications.calls.map((c) => c.message)).toEqual(['This conversation is open in another Damocles window.', 'This conversation is open in another Damocles window.']);
  });

  it('tells the user when the main chat or the design chat could not be shown on this device', async () => {
    await linkTo('design-2');
    const h = designHarness({ session: fakeSession('design-1', [role]) });
    h.panels.showSession.mockResolvedValue('notShown');
    await h.design.openParentChat();
    await h.design.openDesignChat(DESIGN);
    expect(h.platform.notifications.calls.map((c) => c.message)).toEqual(['The chat could not be shown on this device.', 'The chat could not be shown on this device.']);
  });
});

describe('designState (PD-23)', () => {
  it('posts a state that did not change only once, and again to a view that lost it', async () => {
    const h = designHarness({ session: fakeSession('plain', []) });
    h.design.publish();
    await vi.waitFor(() => expect(h.posted).toHaveLength(1));
    h.design.publish();
    h.design.publish();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.posted).toHaveLength(1);
    h.design.forgetPublished();
    h.design.publish();
    await vi.waitFor(() => expect(h.posted).toHaveLength(2));
  });

  it('names the main chat by its current title, read again at each publish, so a rename or an AI title shows', async () => {
    await linkTo('design-1');
    const h = designHarness({ session: fakeSession('design-1', [role]) });
    const parentTitles = () => h.posted.flatMap((message) => ((message as { type: string }).type === 'designState' ? [(message as { design: { parentTitle: string | null } }).design.parentTitle] : []));
    h.titles.set('parent-1', 'Add a contacts page with a search box and a filter by status,\n  and a detail pane');
    h.design.publish();
    await vi.waitFor(() => expect(parentTitles()).toEqual(['Add a contacts page with a search box and a filter by status, and a detail pane']));
    h.titles.set('parent-1', 'Contacts page');
    h.design.publish();
    await vi.waitFor(() => expect(parentTitles()).toEqual(['Add a contacts page with a search box and a filter by status, and a detail pane', 'Contacts page']));
  });

  it('names the main chat link.json names, after a main chat\'s rewind carried the design, and none it cannot find', async () => {
    await updateDesignLink(STATE(), () => ({ schemaVersion: 1, designId: DESIGN, folder: FOLDER, title: 'Contacts', parentSessionId: 'parent-2', designSessionId: 'design-1', superseded: [] }));
    const h = designHarness({ session: fakeSession('design-1', [role]) });
    h.titles.set('parent-1', 'Before the rewind');
    h.titles.set('parent-2', 'After the rewind');
    h.design.publish();
    await vi.waitFor(() => expect(h.posted).toContainEqual(expect.objectContaining({ type: 'designState', design: expect.objectContaining({ parentSessionId: 'parent-2' }) })));
    h.titles.delete('parent-2');
    h.design.publish();
    await vi.waitFor(() => expect(h.posted.at(-1)).toMatchObject({ type: 'designState', design: { parentSessionId: 'parent-2' } }));
  });

  it('posts a delivered draft from the committed entry pi names', async () => {
    const parent = fakeSession('parent-1', [link('parent-1')]);
    const h = designHarness({ session: parent });
    h.design.track(parent.session);
    const entry = { id: 'draft-1', parentId: null, timestamp: '', type: 'custom_message', customType: DAMOCLES_DESIGN_RESULT, content: 'v1', display: true, details: { designId: DESIGN, version: 1 } };
    parent.entries.push(entry);
    parent.emit({ type: 'entry_appended', entry });
    await vi.waitFor(() => expect(h.posted).toContainEqual(expect.objectContaining({ type: 'designResult', entryId: 'draft-1' })));
  });
});

describe('a chat decision quotes only what the user typed (PD-15)', () => {
  const userEntry = (id: string, text: string) => ({ id, type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } });
  const sidecar = (customType: string, data: Record<string, unknown>) => ({ id: `s-${customType}-${String(data['userEntryId'])}`, type: 'custom', customType, data });

  it('skips a Keep and a markup core composed, and reads a references message as its typed text', () => {
    const branch = [
      userEntry('u-keep', 'Keep: Corner radius → --radius-lg'),
      sidecar('damocles-design-tweak-kept', { userEntryId: 'u-keep', tweakId: 'radius' }),
      userEntry('u-markup', 'Markup F1 on screens/S1.html at xl · 1280 · default:\nPin 1 (change) on ui/Table: Taller rows'),
      sidecar('damocles.design-markup', { userEntryId: 'u-markup', feedbackId: 'F1' }),
      userEntry('u-ref', 'Like this one\n\n[Damocles saved the attached image as R1 (references/R1.png). Map it with MapReference.]'),
      sidecar('damocles.design-references', { userEntryId: 'u-ref', references: [] }),
      sidecar('damocles-original-input', { userEntryId: 'u-ref', original: 'Like this one' }),
      userEntry('u-typed', 'Use the compact table please'),
    ];
    expect(userMessageQuoted(branch, 'Corner radius → --radius-lg')).toBe(false);
    expect(userMessageQuoted(branch, 'Taller rows')).toBe(false);
    expect(userMessageQuoted(branch, 'Map it with MapReference')).toBe(false);
    expect(userMessageQuoted(branch, 'Like this one')).toBe(true);
    expect(userMessageQuoted(branch, 'compact table')).toBe(true);
    expect(decisionsOnBranch(branch)).toEqual([]);
  });
});
