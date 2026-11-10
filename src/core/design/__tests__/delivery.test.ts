import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAMOCLES_DESIGN_BRIEF, DAMOCLES_DESIGN_RESULT } from '../../pi-session/session-store/constants';
import { designFolderOf, designStateDirOf } from '../design-paths';
import { takeOverDesignLink, updateDesignLink, writeBriefRecord, type DesignVersionRecord } from '../design-state';
import { deliveredBriefs } from '../design-entries';
import { designBriefMessage, designResultMessage, designVersionInstruction } from '../delivery';
import { DECISIONS_FILE_NOTE } from '../design-files';
import { designLinkSection } from '../guidance';
import { PiRuntime, type LiveSessionMutator } from '../../pi-session/pi-runtime';
import { clearDesigns, designHarness, fakeSession, stampDesignVersion, type FakeDesignSession } from './design-harness';

// Set to stand in for a parent another process holds; undefined defers to the real lease.
const heldElsewhere = vi.hoisted(() => ({ blocker: undefined as { kind: 'other-process' } | undefined }));
vi.mock('../../pi-session/session-store/session-lease', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../pi-session/session-store/session-lease')>();
  return { ...actual, sessionLeaseBlocker: ((sessionId: string) => heldElsewhere.blocker ?? actual.sessionLeaseBlocker(sessionId)) as typeof actual.sessionLeaseBlocker };
});

const DESIGN = 'contacts-abcd1234';
const STATE = (): string => designStateDirOf(DESIGN);

const link = (parentSessionId: string) => ({ id: 'link', type: 'custom', customType: 'damocles.design-link', data: { v: 1, designId: DESIGN, folder: designFolderOf(DESIGN), parentSessionId, title: 'Contacts' } });
const role = (parentSessionId: string | null) => ({ id: 'role', type: 'custom', customType: 'damocles.design', data: { v: 1, designId: DESIGN, folder: designFolderOf(DESIGN), parentSessionId, ruleSet: 'full', title: 'Contacts' } });

function version(version: number, sessionId = 'design-1'): (v: number) => DesignVersionRecord {
  return () => ({
    schemaVersion: 1, version, designId: DESIGN, title: 'Contacts', sessionId, toolCallId: `call-${version}`, contentHash: `hash-${version}`,
    decisions: [{ id: 'D1', title: 'Fidelity', chosen: 'Static mockup' }], screens: ['S1'], check: { errors: 0, warnings: [] }, journeys: [],
    summary: 'The list.', changedSinceLast: [], finishedAt: '2026-01-01T00:00:00.000Z',
  });
}
const finish = (n: number, sessionId?: string) => stampDesignVersion(STATE(), { sessionId: sessionId ?? 'design-1', stillCurrent: () => true }, `hash-${n}`, [{ id: 'D1', title: 'Fidelity', chosen: `v${n}` }], version(n, sessionId));
const cards = (session: FakeDesignSession, customType = DAMOCLES_DESIGN_RESULT) => session.entries.filter((e) => e['type'] === 'custom_message' && e['customType'] === customType);

beforeEach(clearDesigns);
afterEach(() => vi.restoreAllMocks());

describe('design results reach the parent exactly once per branch (PD-20, PD-27)', () => {
  it('delivers to an idle live parent with one run, and nothing on a second reconcile or a reused version', async () => {
    const parent = fakeSession('parent-1', [link('parent-1')]);
    const h = designHarness({ session: parent });
    await finish(1);
    await Promise.all([h.design.reconcile('live'), h.design.reconcile('live')]);
    expect(h.delivered.map((d) => d.run)).toEqual([true]);
    expect(cards(parent)).toHaveLength(1);
    expect(cards(parent)[0]?.['details']).toMatchObject({ designId: DESIGN, version: 1, previousVersion: null });
    await finish(1);
    await h.design.reconcile('live');
    expect(cards(parent)).toHaveLength(1);
  });

  it('posts the card live as its entry commits, never one the history replay shows', async () => {
    const parent = fakeSession('parent-1', [link('parent-1')]);
    const h = designHarness({ session: parent });
    await finish(1);
    h.design.track(parent.session);
    h.design.onBound();
    await vi.waitFor(() => expect(h.posted.filter((m) => (m as { type: string }).type === 'designResult')).toHaveLength(1));
    // A rebind of the same conversation, a reload, finds the card on the branch: the replay shows it, nothing posts it again.
    h.design.onBound();
    await h.design.reconcile('live');
    expect(h.posted.filter((m) => (m as { type: string }).type === 'designResult')).toHaveLength(1);
  });

  it('holds the card for the settle boundary while the parent streams, and gives it once', async () => {
    const parent = fakeSession('parent-1', [link('parent-1')]);
    const h = designHarness({ session: parent });
    h.state = 'streaming';
    await finish(1);
    await h.design.reconcile('live');
    expect(h.delivered).toEqual([]);
    const draft = await h.design.settleDraft();
    expect(draft).toMatchObject({ customType: DAMOCLES_DESIGN_RESULT, display: true, details: { version: 1 } });
    parent.entries.push({ id: 'draft', type: 'custom_message', customType: draft!.customType, details: draft!.details });
    expect(await h.design.settleDraft()).toBeUndefined();
  });

  it('appends with no run when a parent away opens again, and only the latest version', async () => {
    const parent = fakeSession('parent-1', [link('parent-1')]);
    const h = designHarness({ session: parent });
    await finish(1);
    await finish(2);
    await h.design.reconcile('bind');
    expect(h.delivered.map((d) => [d.run, (d.messages[0]?.details as { version: number }).version])).toEqual([[false, 2]]);
  });

  it('delivers again on a branch a rewind left without the card', async () => {
    const parent = fakeSession('parent-1', [link('parent-1')]);
    const h = designHarness({ session: parent });
    await finish(1);
    await h.design.reconcile('live');
    parent.entries.splice(1);
    await h.design.reconcile('prompt');
    expect(cards(parent)).toHaveLength(1);
    expect(h.delivered.map((d) => d.run)).toEqual([true, false]);
  });

  it('delivers nothing to a fork, whose inherited link is inert (PD-37)', async () => {
    const fork = fakeSession('fork-1', [link('parent-1')]);
    const h = designHarness({ session: fork });
    await finish(1);
    await h.design.reconcile('live');
    expect(h.delivered).toEqual([]);
  });

  it('takes a version another process finished from the watch on the state folder', async () => {
    const parent = fakeSession('parent-1', [link('parent-1')]);
    const h = designHarness({ session: parent });
    h.design.onBound();
    await h.design.reconcile('bind');
    expect(h.delivered).toEqual([]);
    await finish(1);
    const watcher = h.platform.fileWatchers.watchers.find((w) => w.base === STATE() && !w.disposed);
    expect(watcher).toBeDefined();
    watcher!.fireCreate(`${STATE()}/versions/v1.json`);
    await vi.waitFor(() => expect(h.delivered.map((d) => d.run)).toEqual([true]));
  });

  it('says how a finished version travels: live here, held by another process, away, or to no parent', async () => {
    const designChat = fakeSession('design-1', [role('parent-1')]);
    const { record } = await finish(1);
    const h = designHarness({ session: designChat });
    const offered = vi.fn();
    const spy = vi.spyOn(PiRuntime, 'liveSessionMutator').mockReturnValue({ offerDesignResult: offered } as unknown as LiveSessionMutator);
    expect(await h.design.offerResult(record, h.design.role()!, true)).toBe('live');
    expect(offered).toHaveBeenCalledWith(DESIGN);
    spy.mockReturnValue(undefined);
    expect(await h.design.offerResult(record, h.design.role()!, false)).toBe('notified');
    expect(h.platform.notifications.calls).toEqual([]);
    expect(await h.design.offerResult(record, h.design.role()!, true)).toBe('notified');
    expect(h.platform.notifications.calls.map((c) => [c.message, c.actions])).toEqual([['The design "Contacts" is finished (v1). Open its main chat to continue.', ['Open chat']]]);
    expect(await designHarness({ session: designChat, sessionExists: false }).design.offerResult(record, h.design.role()!, true)).toBe('no-parent');
    expect(await h.design.offerResult(record, { ...h.design.role()!, parentSessionId: null }, true)).toBe('no-parent');
  });

  it('says a main chat exists for the approval exactly where a version would not go to no parent: live, held elsewhere, away; not gone or forked', async () => {
    const designChat = fakeSession('design-1', [role('parent-1')]);
    const { record } = await finish(1);
    const h = designHarness({ session: designChat });
    const gone = designHarness({ session: designChat, sessionExists: false });
    const ownRole = h.design.role()!;
    const both = async (design: typeof h.design, r = ownRole) => [await design.hasParent(r), await design.offerResult(record, r, false)];
    const spy = vi.spyOn(PiRuntime, 'liveSessionMutator').mockReturnValue({ offerDesignResult: vi.fn() } as unknown as LiveSessionMutator);
    expect(await both(h.design)).toEqual([true, 'live']);
    spy.mockReturnValue(undefined);
    heldElsewhere.blocker = { kind: 'other-process' };
    try {
      expect(await both(gone.design)).toEqual([true, 'queued']);
    } finally {
      heldElsewhere.blocker = undefined;
    }
    expect(await both(h.design)).toEqual([true, 'notified']);
    expect(await both(gone.design)).toEqual([false, 'no-parent']);
    expect(await both(h.design, { ...ownRole, parentSessionId: null })).toEqual([false, 'no-parent']);
  });

  it('opens the parent from the notification\'s Open chat', async () => {
    const designChat = fakeSession('design-1', [role('parent-1')]);
    const { record } = await finish(1);
    const h = designHarness({ session: designChat });
    vi.spyOn(PiRuntime, 'liveSessionMutator').mockReturnValue(undefined);
    h.platform.notifications.answerWith(() => 'Open chat');
    await h.design.offerResult(record, h.design.role()!, true);
    await vi.waitFor(() => expect(h.panels.showSession).toHaveBeenCalledWith('parent-1'));
  });
});

describe('briefs reach their design chat exactly once', () => {
  it('delivers the briefs addressed to this chat, oldest first, and starts it on them', async () => {
    const designChat = fakeSession('design-1', [role('parent-1')]);
    const h = designHarness({ session: designChat });
    await updateDesignLink(STATE(), () => ({ schemaVersion: 1, designId: DESIGN, folder: designFolderOf(DESIGN), title: 'Contacts', parentSessionId: 'parent-1', designSessionId: 'design-1', superseded: [] }));
    const first = await writeBriefRecord(STATE(), { parentSessionId: 'parent-1', designSessionId: 'design-1', text: 'Design the list', reopened: false });
    await writeBriefRecord(STATE(), { parentSessionId: 'parent-1', designSessionId: 'old-chat', text: 'not mine', reopened: false });
    await h.design.reconcile('bind');
    await h.design.reconcile('live');
    expect(h.delivered.map((d) => [d.run, d.messages.map((m) => (m.details as { briefId: string }).briefId)])).toEqual([[true, [first.briefId]]]);
    expect(cards(designChat, DAMOCLES_DESIGN_BRIEF)[0]?.['content']).toMatch(/^Brief from the main chat\. It is a request, not a message from the user/);
  });
});

describe('a design chat whose role entry does not parse (F7)', () => {
  it('takes no messages, failing closed rather than becoming a normal chat', () => {
    const broken = fakeSession('design-1', [{ id: 'r', type: 'custom', customType: 'damocles.design', data: { v: 2, designId: '../x' } }]);
    const h = designHarness({ session: broken });
    expect(h.design.role()).toBeUndefined();
    expect(h.design.sendRefusal('send')).toEqual({ message: "This design chat's record cannot be read, so it takes no messages." });
    // The gate's scope fails closed too, for runs that start from no send and for the agents they start.
    expect(h.design.scope()).toEqual({ unreadable: true });
    expect(designHarness({ session: fakeSession('plain', []) }).design.scope()).toBeUndefined();
    expect(designHarness({ session: fakeSession('plain', []) }).design.sendRefusal('send')).toBeUndefined();
    expect(designHarness({ session: fakeSession('d', [role('p')]), enabled: false }).design.sendRefusal('send')).toEqual({ message: 'Turn on design mode in Settings to continue this design.' });
  });
});

describe('a rewind takeover keeps the delivered set D (PD-27, PD-36)', () => {
  it('re-delivers nothing to the parent, delivers nothing from or to the superseded chat, and gives the new chat only the briefs the old one never received', async () => {
    await updateDesignLink(STATE(), () => ({ schemaVersion: 1, designId: DESIGN, folder: designFolderOf(DESIGN), title: 'Contacts', parentSessionId: 'parent-1', designSessionId: 'design-1', superseded: [] }));
    const parent = fakeSession('parent-1', [link('parent-1')]);
    const p = designHarness({ session: parent });
    await finish(1);
    await p.design.reconcile('live');
    expect(cards(parent)).toHaveLength(1);

    // The old chat received b1 after the turn the user rewinds to; b2 was written but had not reached it.
    const oldChat = fakeSession('design-1', [role('parent-1')]);
    const rewindPoint = [...oldChat.entries];
    const old = designHarness({ session: oldChat });
    await writeBriefRecord(STATE(), { parentSessionId: 'parent-1', designSessionId: 'design-1', text: 'add a filter', reopened: true });
    await old.design.reconcile('live');
    expect(cards(oldChat, DAMOCLES_DESIGN_BRIEF)).toHaveLength(1);
    const b2 = await writeBriefRecord(STATE(), { parentSessionId: 'parent-1', designSessionId: 'design-1', text: 'add paging', reopened: true });

    await takeOverDesignLink(STATE(), 'design-1', 'design-2', deliveredBriefs(oldChat.entries));
    expect(await old.design.readLink()).toEqual({ kind: 'superseded', by: 'design-2' });

    // A brief a stale writer still addressed to the old chat is not delivered there.
    await writeBriefRecord(STATE(), { parentSessionId: 'parent-1', designSessionId: 'design-1', text: 'stale', reopened: true });
    await old.design.reconcile('live');
    expect(cards(oldChat, DAMOCLES_DESIGN_BRIEF)).toHaveLength(1);

    await p.design.reconcile('live');
    await p.design.reconcile('bind');
    expect(cards(parent)).toHaveLength(1);

    const newChat = fakeSession('design-2', rewindPoint);
    const fresh = designHarness({ session: newChat });
    await fresh.design.reconcile('bind');
    expect(cards(newChat, DAMOCLES_DESIGN_BRIEF).map((e) => (e['details'] as { briefId: string }).briefId)).toEqual([b2.briefId]);

    // The superseded chat can stamp no version; versions are untouched, so the new chat's next finish is v2, which the parent gets once.
    await expect(finish(2, 'design-1')).rejects.toThrow(/continues in another design chat/);
    await finish(2, 'design-2');
    await p.design.reconcile('live');
    await p.design.reconcile('live');
    expect(cards(parent).map((e) => (e['details'] as { version: number }).version)).toEqual([1, 2]);
  });
});

describe('what the parent and the designer read (D99)', () => {
  const record: DesignVersionRecord = {
    schemaVersion: 1, version: 2, designId: DESIGN, title: 'Contacts', sessionId: 'design-1', toolCallId: 'call-2', contentHash: 'h',
    decisions: [{ id: 'D1', title: 'Fidelity', chosen: 'Static mockup' }, { id: 'D23', title: 'Accent', chosen: 'taupe', replaces: ['D18'] }],
    uncheckedDecisions: ['D23', 'D24'], screens: ['S1'], check: { errors: 0, warnings: [] }, journeys: [], summary: 's', changedSinceLast: [], finishedAt: '2026-01-01T00:00:00.000Z',
  };

  it('lists the current decisions only, says a decision outranks the brief, and names the decisions approved unchecked (acceptance)', () => {
    const message = designResultMessage({ record, changes: [{ kind: 'decisionAdded', id: 'D23', title: 'Accent', chosen: 'taupe', replaces: ['D18'] }] }, designFolderOf(DESIGN));
    expect(message.content).toContain('Current decisions: D1 Fidelity: Static mockup; D23 Accent: taupe (replaces D18).');
    expect(message.content).toContain(DECISIONS_FILE_NOTE);
    expect(message.content).toContain('Where a decision differs from your brief, the decision holds: the user made it after the brief.');
    expect(message.content).toContain('The user approved with decisions D23 and D24 unchecked for conflicts.');
    expect(message.content).toContain('Changed since v1: D23 Accent · taupe (replaces D18).');
    expect(message.details).toMatchObject({ decisions: [{ id: 'D1' }, { id: 'D23', replaces: ['D18'] }], uncheckedDecisions: ['D23', 'D24'] });
  });

  it('tells the main chat that decisions.md\'s replaced decisions no longer apply wherever it is sent to read the file', () => {
    expect(designVersionInstruction({ designId: DESIGN, fromVersion: 1, toVersion: 2 }, 'replan', designFolderOf(DESIGN)).content).toContain(DECISIONS_FILE_NOTE);
    expect(designLinkSection(designFolderOf(DESIGN))).toContain(DECISIONS_FILE_NOTE);
  });

  it('names the brief\'s id in its content, with the source that cites it (acceptance)', () => {
    const brief = designBriefMessage({ schemaVersion: 1, briefId: 'b1-0a1b2c3d', seq: 1, parentSessionId: 'parent-1', designSessionId: 'design-1', text: 'Revamp the UI', reopened: false, createdAt: '2026-01-01T00:00:00.000Z' });
    expect(brief.content).toContain('Brief id: b1-0a1b2c3d. Cite it as RecordDecision source {kind: "brief", ref: "b1-0a1b2c3d"}.');
  });
});
