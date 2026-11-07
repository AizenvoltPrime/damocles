import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DESIGN_VERSION_DETAIL_KEY, type DesignVersionStamp } from '../../../shared/types/design';
import { PLAN_VERSION_DETAIL_KEY } from '../../../shared/types/session';
import { DAMOCLES_DESIGN_RESULT, DAMOCLES_DESIGN_VERSION_CHOICE, DAMOCLES_DESIGN_VERSION_INSTRUCTION } from '../../pi-session/session-store/constants';
import { designFolderOf, designStateDirOf } from '../design-paths';
import type { DesignVersionRecord } from '../design-state';
import { approvedDesignVersion, approvedVersionAfterLink, resultAwaitingContinue, unansweredVersionPause } from '../design-entries';
import { clearDesigns, designHarness, fakeSession, stampDesignVersion, type DesignHarness, type FakeDesignSession } from './design-harness';

/** PD-16, PD-29: a design version newer than the plan approval pauses the parent and asks the user. */

const DESIGN = 'contacts-abcd1234';
const PARENT = 'parent-1';

const link = () => ({ id: 'link', type: 'custom', customType: 'damocles.design-link', data: { v: 1, designId: DESIGN, folder: designFolderOf(DESIGN), parentSessionId: PARENT, title: 'Contacts' } });

let approvals = 0;
/** An ExitPlanMode result as pi records it; `approved` false is a plan sent back. */
const exitPlan = (stamp: DesignVersionStamp | null, approved = true, planVersion: number | null = 1) => ({
  id: `exit-${++approvals}`,
  type: 'message',
  message: { role: 'toolResult', toolCallId: `call-${approvals}`, toolName: 'ExitPlanMode', isError: !approved, details: { [PLAN_VERSION_DETAIL_KEY]: planVersion, [DESIGN_VERSION_DETAIL_KEY]: stamp } },
});

const SCREENS: Record<number, Record<string, string>> = { 1: { S1: 'a' }, 2: { S1: 'b', S2: 'c' }, 3: { S1: 'b', S2: 'd' } };
const DECISIONS = (n: number) => [{ id: 'D1', title: 'Fidelity', chosen: 'Static' }, ...(n >= 2 ? [{ id: 'D2', title: 'Empty state', chosen: 'Illustration' }] : [])];

function finish(n: number): Promise<{ record: DesignVersionRecord }> {
  return stampDesignVersion(designStateDirOf(DESIGN), { sessionId: 'design-1', stillCurrent: () => true }, `hash-${n}`, DECISIONS(n), (version) => ({
    schemaVersion: 1, version, designId: DESIGN, title: 'Contacts', sessionId: 'design-1', toolCallId: `finish-${version}`, contentHash: `hash-${n}`,
    decisions: DECISIONS(n), screens: Object.keys(SCREENS[n]!), screenHashes: SCREENS[n]!, check: { errors: 0, warnings: [] }, journeys: [],
    summary: 'The list.', changedSinceLast: [], finishedAt: '2026-01-01T00:00:00.000Z',
  }));
}

const cards = (session: FakeDesignSession) => session.entries.filter((e) => e['type'] === 'custom_message' && e['customType'] === DAMOCLES_DESIGN_RESULT);
const choices = (session: FakeDesignSession) => session.entries.filter((e) => e['type'] === 'custom' && e['customType'] === DAMOCLES_DESIGN_VERSION_CHOICE);
const details = (entry: Record<string, unknown> | undefined) => entry?.['details'] as { version: number; versionPause?: { fromVersion: number } };

/** A parent that got v1 and approved a plan against it. */
async function approvedAgainstV1(): Promise<{ parent: FakeDesignSession; h: DesignHarness }> {
  const parent = fakeSession(PARENT, [link()]);
  const h = designHarness({ session: parent });
  await finish(1);
  await h.design.reconcile('live');
  parent.entries.push(exitPlan({ designId: DESIGN, version: 1 }));
  h.delivered.length = 0;
  return { parent, h };
}

beforeEach(clearDesigns);
afterEach(() => vi.restoreAllMocks());

describe('the branch readers', () => {
  it('approvedDesignVersion reads the latest approved ExitPlanMode and its stamp, skipping sent-back and not-in-plan-mode calls', () => {
    const branch = [link(), exitPlan({ designId: DESIGN, version: 1 }), exitPlan({ designId: DESIGN, version: 2 }, false), exitPlan(null, true, null)];
    expect(approvedDesignVersion(branch)).toEqual({ index: 1, stamp: { designId: DESIGN, version: 1 } });
    expect(approvedDesignVersion([link()])).toBeUndefined();
    expect(approvedDesignVersion([exitPlan({ designId: '../x', version: 1 })])?.stamp).toBeNull();
  });

  it('approvedVersionAfterLink counts only an approval after the own link, null and another design reading as 0', () => {
    expect(approvedVersionAfterLink([exitPlan({ designId: DESIGN, version: 1 }), link()], PARENT)).toBeUndefined();
    expect(approvedVersionAfterLink([link(), exitPlan({ designId: DESIGN, version: 2 })], PARENT)).toEqual({ designId: DESIGN, fromVersion: 2 });
    expect(approvedVersionAfterLink([link(), exitPlan(null)], PARENT)).toEqual({ designId: DESIGN, fromVersion: 0 });
    expect(approvedVersionAfterLink([link(), exitPlan({ designId: 'other-design', version: 4 })], PARENT)).toEqual({ designId: DESIGN, fromVersion: 0 });
    expect(approvedVersionAfterLink([link(), exitPlan(null)], 'a-fork')).toBeUndefined();
  });

  it('unansweredVersionPause needs the pause card, no choice for it, and a version newer than the approval', () => {
    const card = (version: number, pause?: number) => ({ id: `card-${version}`, type: 'custom_message', customType: DAMOCLES_DESIGN_RESULT, details: { designId: DESIGN, version, ...(pause !== undefined ? { versionPause: { fromVersion: pause } } : {}) } });
    const choice = { id: 'choice', type: 'custom', customType: DAMOCLES_DESIGN_VERSION_CHOICE, data: { v: 1, designId: DESIGN, fromVersion: 1, toVersion: 2, choice: 'finishFirst' } };
    const base = [link(), card(1), exitPlan({ designId: DESIGN, version: 1 })];
    expect(unansweredVersionPause([...base, card(2, 1)], PARENT)).toEqual({ designId: DESIGN, fromVersion: 1, toVersion: 2 });
    expect(unansweredVersionPause([...base, card(2)], PARENT)).toBeUndefined();
    expect(unansweredVersionPause([...base, card(2, 1), choice], PARENT)).toBeUndefined();
    expect(unansweredVersionPause([...base, card(2, 1), exitPlan({ designId: DESIGN, version: 2 })], PARENT)).toBeUndefined();
  });

  it('resultAwaitingContinue names the latest card of the design until a message answers it, and never a paused one', () => {
    const card = (version: number, pause?: number) => ({ id: `card-${version}`, type: 'custom_message', customType: DAMOCLES_DESIGN_RESULT, details: { designId: DESIGN, version, ...(pause !== undefined ? { versionPause: { fromVersion: pause } } : {}) } });
    const reply = { id: 'reply', type: 'message', message: { role: 'assistant', content: [] } };
    const prompt = { id: 'prompt', type: 'message', message: { role: 'user', content: 'go on' } };
    expect(resultAwaitingContinue([link(), card(1)], DESIGN)).toBe('card-1');
    expect(resultAwaitingContinue([link(), card(1), reply], DESIGN)).toBeNull();
    expect(resultAwaitingContinue([link(), card(1), prompt], DESIGN)).toBeNull();
    expect(resultAwaitingContinue([link(), card(1), reply, card(2)], DESIGN)).toBe('card-2');
    expect(resultAwaitingContinue([link(), card(1), card(2, 1)], DESIGN)).toBeNull();
    expect(resultAwaitingContinue([link(), card(1)], 'other-design')).toBeNull();
  });
});

describe('a result card\'s changes', () => {
  it('come from its version record and the one before, as structured changes, never from the record\'s English list', async () => {
    const parent = fakeSession(PARENT, [link()]);
    const h = designHarness({ session: parent });
    await finish(1);
    await h.design.reconcile('live');
    await finish(2);
    await h.design.reconcile('live');

    const [first, second] = cards(parent).map((entry) => entry['details'] as { changes: unknown });
    expect(first!.changes).toEqual([]);
    expect(second!.changes).toEqual([
      { kind: 'screenChanged', screen: 'S1' },
      { kind: 'screenAdded', screen: 'S2' },
      { kind: 'decisionAdded', id: 'D2', title: 'Empty state', chosen: 'Illustration' },
    ]);
    // The model still reads them in English.
    expect(cards(parent)[1]!['content']).toContain('Changed since v1: S1 changed; S2 added; D2 Empty state · Illustration.');
  });
});

describe('a version delivered before any approval after the link asks nothing (PD-51)', () => {
  it('appends the card and starts one run in the current mode, as slice 2 does', async () => {
    const parent = fakeSession(PARENT, [exitPlan({ designId: DESIGN, version: 1 }), link()]);
    const h = designHarness({ session: parent });
    await finish(1);
    await h.design.reconcile('live');
    expect(h.delivered.map((d) => d.run)).toEqual([true]);
    expect(details(cards(parent)[0]).versionPause).toBeUndefined();
    expect(h.design.pauseOwed(parent.session)).toBe(false);
    await Promise.resolve();
    expect(h.asked).toEqual([]);
  });
});

describe('a version newer than the approval pauses the parent (PD-29)', () => {
  it('idle: appends the update card with no run, then asks with the changes since the approved version', async () => {
    const { parent, h } = await approvedAgainstV1();
    await finish(2);
    await h.design.reconcile('live');
    expect(h.delivered.map((d) => d.run)).toEqual([false]);
    expect(details(cards(parent)[1])).toMatchObject({ version: 2, versionPause: { fromVersion: 1 } });
    await vi.waitFor(() => expect(h.asked).toHaveLength(1));
    expect(h.asked[0]!.ask).toEqual({ designId: DESIGN, fromVersion: 1, toVersion: 2, changes: [{ kind: 'screenChanged', screen: 'S1' }, { kind: 'screenAdded', screen: 'S2' }, { kind: 'decisionAdded', id: 'D2', title: 'Empty state', chosen: 'Illustration' }] });
  });

  it('streaming: owes a pause the turn decider reads, gives no settle draft, and lands card and prompt once the run settled', async () => {
    const { parent, h } = await approvedAgainstV1();
    h.state = 'streaming';
    await finish(2);
    await h.design.reconcile('live');
    expect(h.delivered).toEqual([]);
    expect(h.design.pauseOwed(parent.session)).toBe(true);
    expect(await h.design.settleDraft()).toBeUndefined();
    expect(h.asked).toEqual([]);

    h.state = 'idle';
    h.design.idle();
    await vi.waitFor(() => expect(h.asked).toHaveLength(1));
    expect(h.delivered.map((d) => d.run)).toEqual([false]);
    expect(details(cards(parent)[1]).versionPause).toEqual({ fromVersion: 1 });
    expect(h.design.pauseOwed(parent.session)).toBe(false);
  });

  it('a version that reaches a streaming parent first at its settle boundary pauses it too', async () => {
    const { parent, h } = await approvedAgainstV1();
    h.state = 'streaming';
    await finish(2);
    expect(await h.design.settleDraft()).toBeUndefined();
    expect(h.design.pauseOwed(parent.session)).toBe(true);
  });

  it('not live: the bind appends the card with no run and asks', async () => {
    const { parent, h } = await approvedAgainstV1();
    await finish(2);
    await h.design.reconcile('bind');
    expect(h.delivered.map((d) => d.run)).toEqual([false]);
    expect(cards(parent)).toHaveLength(2);
    await vi.waitFor(() => expect(h.asked).toHaveLength(1));
  });

  it('an approval made before any version records 0, so v1 pauses it and lists every screen and decision', async () => {
    const parent = fakeSession(PARENT, [link(), exitPlan(null)]);
    const h = designHarness({ session: parent });
    await finish(1);
    await h.design.reconcile('live');
    expect(h.delivered.map((d) => d.run)).toEqual([false]);
    await vi.waitFor(() => expect(h.asked).toHaveLength(1));
    expect(h.asked[0]!.ask).toMatchObject({ fromVersion: 0, toVersion: 1, changes: [{ kind: 'screenAdded', screen: 'S1' }, { kind: 'decisionAdded', id: 'D1', title: 'Fidelity', chosen: 'Static' }] });
  });
});

describe('the answer', () => {
  it('replan: records the choice, turns plan mode on, then starts one run with the instruction', async () => {
    const { parent, h } = await approvedAgainstV1();
    await finish(2);
    await h.design.reconcile('live');
    await vi.waitFor(() => expect(h.asked).toHaveLength(1));
    h.calls.length = 0;
    h.asked[0]!.answer('replan');
    await vi.waitFor(() => expect(h.calls).toEqual(['plan-mode', 'deliver']));
    expect(choices(parent).map((e) => e['data'])).toEqual([{ v: 1, designId: DESIGN, fromVersion: 1, toVersion: 2, choice: 'replan' }]);
    const instruction = h.delivered.at(-1)!;
    expect(instruction.run).toBe(true);
    expect(instruction.messages[0]).toMatchObject({ customType: DAMOCLES_DESIGN_VERSION_INSTRUCTION, display: false, details: { choice: 'replan', fromVersion: 1, toVersion: 2 } });
    expect(instruction.messages[0]!.content).toMatch(/call ExitPlanMode/);
  });

  it('finishFirst: records the choice and runs once with its instruction, plan mode untouched', async () => {
    const { parent, h } = await approvedAgainstV1();
    await finish(2);
    await h.design.reconcile('live');
    await vi.waitFor(() => expect(h.asked).toHaveLength(1));
    h.calls.length = 0;
    h.asked[0]!.answer('finishFirst');
    await vi.waitFor(() => expect(h.calls).toEqual(['deliver']));
    expect(choices(parent)).toHaveLength(1);
    expect(h.delivered.at(-1)).toMatchObject({ run: true, messages: [{ customType: DAMOCLES_DESIGN_VERSION_INSTRUCTION, details: { choice: 'finishFirst' } }] });
    expect(h.delivered.at(-1)!.messages[0]!.content).toMatch(/finish the approved plan first/);
  });

  it('a parent already running takes the instruction in that run, starting none', async () => {
    const { h } = await approvedAgainstV1();
    await finish(2);
    await h.design.reconcile('live');
    await vi.waitFor(() => expect(h.asked).toHaveLength(1));
    h.state = 'streaming';
    h.asked[0]!.answer('finishFirst');
    await vi.waitFor(() => expect(h.delivered.at(-1)?.messages[0]?.customType).toBe(DAMOCLES_DESIGN_VERSION_INSTRUCTION));
    expect(h.delivered.at(-1)!.run).toBe(false);
  });
});

describe('exactly once', () => {
  it('reconcile reruns append no second card and raise no second prompt while one is open', async () => {
    const { parent, h } = await approvedAgainstV1();
    await finish(2);
    await Promise.all([h.design.reconcile('live'), h.design.reconcile('live'), h.design.reconcile('bind')]);
    await vi.waitFor(() => expect(h.asked).toHaveLength(1));
    await h.design.reconcile('live');
    h.design.idle();
    await Promise.resolve();
    expect(cards(parent)).toHaveLength(2);
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]!.signal.aborted).toBe(false);
  });

  it('a user send before answering leaves the prompt open', async () => {
    const { h } = await approvedAgainstV1();
    await finish(2);
    await h.design.reconcile('live');
    await vi.waitFor(() => expect(h.asked).toHaveLength(1));
    await h.design.reconcile('prompt');
    h.design.idle();
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]!.signal.aborted).toBe(false);
  });

  it('a reload or an engine restart asks again for a card with no choice, and never after the answer', async () => {
    const { parent, h } = await approvedAgainstV1();
    await finish(2);
    await h.design.reconcile('live');
    await vi.waitFor(() => expect(h.asked).toHaveLength(1));

    // The same branch bound by a new core: no second card, the prompt raised again.
    const restarted = designHarness({ session: fakeSession(PARENT, parent.entries) });
    await restarted.design.reconcile('bind');
    await vi.waitFor(() => expect(restarted.asked).toHaveLength(1));
    expect(restarted.delivered).toEqual([]);
    expect(cards(parent)).toHaveLength(2);

    restarted.asked[0]!.answer('finishFirst');
    await vi.waitFor(() => expect(choices(parent)).toHaveLength(1));
    const again = designHarness({ session: fakeSession(PARENT, parent.entries) });
    await again.design.reconcile('bind');
    await Promise.resolve();
    expect(again.asked).toEqual([]);
    expect(again.delivered).toEqual([]);
  });

  it('the prompt ends when the session is let go of (a reset, a resume switch, the panel), and the next bind raises it again', async () => {
    const { parent, h } = await approvedAgainstV1();
    const untrack = h.design.track(parent.session);
    await finish(2);
    await h.design.reconcile('live');
    await vi.waitFor(() => expect(h.asked).toHaveLength(1));
    untrack();
    expect(h.asked[0]!.signal.aborted).toBe(true);
    await h.design.reconcile('bind');
    await vi.waitFor(() => expect(h.asked).toHaveLength(2));
    expect(choices(parent)).toEqual([]);
    h.design.dispose();
    expect(h.asked[1]!.signal.aborted).toBe(true);
  });

  it('a newer version replaces the open prompt, asking from the approved version', async () => {
    const { parent, h } = await approvedAgainstV1();
    await finish(2);
    await h.design.reconcile('live');
    await vi.waitFor(() => expect(h.asked).toHaveLength(1));
    await finish(3);
    await h.design.reconcile('live');
    await vi.waitFor(() => expect(h.asked).toHaveLength(2));
    expect(h.asked[0]!.signal.aborted).toBe(true);
    expect(h.asked[1]!.ask).toMatchObject({ fromVersion: 1, toVersion: 3, changes: [{ kind: 'screenChanged', screen: 'S1' }, { kind: 'screenAdded', screen: 'S2' }, { kind: 'decisionAdded', id: 'D2', title: 'Empty state', chosen: 'Illustration' }] });
    expect(details(cards(parent)[2]).versionPause).toEqual({ fromVersion: 1 });
  });

  it('a new approval that records the version closes the prompt as moot', async () => {
    const { parent, h } = await approvedAgainstV1();
    await finish(2);
    await h.design.reconcile('live');
    await vi.waitFor(() => expect(h.asked).toHaveLength(1));
    parent.entries.push(exitPlan({ designId: DESIGN, version: 2 }));
    h.design.idle();
    await vi.waitFor(() => expect(h.asked[0]!.signal.aborted).toBe(true));
  });
});
