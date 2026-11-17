import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { PiRuntime } from '../pi-runtime';
import type { PiSession } from '../pi-session';
import { designLinkEntryData } from '../../design/design-entries';
import { designFolderOf, designStateDirOf } from '../../design/design-paths';
import { updateDesignLink } from '../../design/design-state';
import { clearDesigns, stampDesignVersion } from '../../design/__tests__/design-harness';
import { DAMOCLES_DESIGN_LINK_ENTRY } from '../session-store/constants';
import { heldSettleSessions, type HeldSettleSession } from './held-settle-fixture';
import { panelSession, seatPiRuntime } from './real-pi-fixtures';

/**
 * A design delivery's run on a real pi session built as the main chat's, driven through `PiSession`'s own delivery path (D67).
 * pi defers a run asked for while it runs a run's `agent_settled` handlers (agent-session.js:1968-1969 in pi 1.5.2) and then
 * publishes that run's `agent_settled`, so a delivery offered while pi settles a stopped run waits for that settle, as a send does.
 */

const DESIGN = 'contacts-5e5e5e5e';
const CARD = 'damocles-design-result';
const RUN_FAILED = { type: 'error', message: { message: 'The design message arrived, but the agent could not start: {0}', args: [{ message: '{0}', args: ['preparation failed'] }] } };

const dirs: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};
const sessions = heldSettleSessions({ modelRuntime: () => seatPiRuntime(tempDir('dam-delivery-run-runtime-')) });
beforeEach(() => clearDesigns());
afterEach(async () => {
  sessions.dispose();
  await PiRuntime.disposeInstance();
  clearDesigns();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms))]);
}

interface Internals {
  runtime: { session: AgentSession };
  desiredModel: unknown;
  startPromise: Promise<void> | null;
  titleGenerationAttempted: boolean;
  budgetLimitForEnforcement: () => number | null;
  subscribeEvents: (session: AgentSession) => void;
  turnState: string;
}

/** A panel bound to `held`'s session as `bindSession` subscribes one. */
function boundPanel(held: HeldSettleSession, emitted: ExtensionToWebviewMessage[]): PiSession {
  const panel = panelSession(emitted);
  const inner = panel as unknown as Internals;
  inner.runtime = { session: held.session };
  inner.desiredModel = held.session.model;
  inner.subscribeEvents(held.session);
  inner.startPromise = Promise.resolve();
  inner.titleGenerationAttempted = true;
  inner.budgetLimitForEnforcement = () => null;
  return panel;
}

const turnState = (panel: PiSession): string => (panel as unknown as Internals).turnState;

/** Resolves once every reconcile the panel's design queued so far has run. */
const reconciled = (panel: PiSession): Promise<void> => panel.design.reconcile('live');

/** `session` links design `DESIGN`, whose finished v1 it has not received. */
async function linkedWithResult(session: AgentSession): Promise<void> {
  const folder = designFolderOf(DESIGN);
  session.sessionManager.appendCustomEntry(DAMOCLES_DESIGN_LINK_ENTRY, designLinkEntryData({ designId: DESIGN, folder, parentSessionId: session.sessionId, title: 'Contacts' }));
  await updateDesignLink(designStateDirOf(DESIGN), () => ({ schemaVersion: 1, designId: DESIGN, folder, title: 'Contacts', parentSessionId: session.sessionId, designSessionId: 'design-1', superseded: [] }));
  await stampDesignVersion(designStateDirOf(DESIGN), { sessionId: 'design-1', stillCurrent: () => true }, 'hash-1', [], (v) => ({
    schemaVersion: 1, version: v, designId: DESIGN, title: 'Contacts', sessionId: 'design-1', toolCallId: `c${v}`, contentHash: 'hash-1', decisions: [], screens: [],
    check: { errors: 0, warnings: [] }, journeys: [], summary: 's', changedSinceLast: [], finishedAt: '2026-01-01T00:00:00.000Z',
  }));
}

/** pi's next run preparation throws, which `_startRun` reports as a run that never started, publishing no event. */
function failNextRunPreparation(session: AgentSession): void {
  const inner = session as unknown as { _prepareRun: unknown };
  inner._prepareRun = async () => {
    delete inner._prepareRun;
    throw new Error('preparation failed');
  };
}

/** pi's run events, and each time the panel asked pi for the card's run (`ask`), in order. */
function runOrder(session: AgentSession): string[] {
  const order: string[] = [];
  session.subscribe((event) => {
    if (event.type === 'agent_start' || event.type === 'agent_settled') order.push(event.type);
  });
  const send = session.sendCustomMessage.bind(session);
  session.sendCustomMessage = (message, options) => {
    if (message.customType === CARD && options?.triggerTurn) order.push('ask');
    return send(message, options);
  };
  return order;
}

/** The branch as custom message types and message roles, in order. */
const branchShape = (session: AgentSession): string[] =>
  session.sessionManager.getBranch().flatMap((e) => (e.type === 'custom_message' ? [e.customType] : e.type === 'message' && e.message.role !== 'system' ? [e.message.role] : []));

const errorNotices = (emitted: readonly ExtensionToWebviewMessage[]) => emitted.filter((m) => m.type === 'error');
const processing = (emitted: readonly ExtensionToWebviewMessage[]): boolean[] => emitted.flatMap((m) => (m.type === 'processing' ? [m.isProcessing] : []));

/** A cancel note's run, stopped while the held `agent_settled` handler runs, so the chat is idle while pi settles that run. */
async function settlingAfterStop(responses: string[]): Promise<{ held: HeldSettleSession; release: () => void; emitted: ExtensionToWebviewMessage[]; panel: PiSession }> {
  const held = await sessions.boot(responses.map((text) => fauxAssistantMessage(text)), { mainChat: true });
  await linkedWithResult(held.session);
  const settle = held.hold();
  const emitted: ExtensionToWebviewMessage[] = [];
  const panel = boundPanel(held, emitted);
  (panel as unknown as { noteDeliveryForMain: (s: () => AgentSession) => (text: string) => void }).noteDeliveryForMain(() => held.session)('note');
  await within(settle.waiting, 10_000, 'the agent_settled handler');
  await panel.interrupt();
  expect(turnState(panel)).toBe('idle');
  emitted.length = 0;
  return { held, release: settle.release, emitted, panel };
}

describe("a design delivery's run (D67)", () => {
  describe('offered while pi settles a stopped run', () => {
    it('is asked for only once pi settled that run, and one that never starts ends its turn and lands the card with no run once, saying why once', async () => {
      const { held, release, emitted, panel } = await settlingAfterStop(['Noted.']);
      const order = runOrder(held.session);
      failNextRunPreparation(held.session);

      panel.offerDesignResult(DESIGN);
      await reconciled(panel);
      expect(order).toEqual([]);
      expect(processing(emitted)).toEqual([]);

      release();
      await vi.waitFor(() => expect(branchShape(held.session)).toEqual(['user', 'assistant', CARD]), { timeout: 10_000 });
      await vi.waitFor(() => expect(turnState(panel)).toBe('idle'), { timeout: 10_000 });
      await held.session.waitForIdle();
      await reconciled(panel);
      expect(order).toEqual(['agent_settled', 'ask']);
      expect(branchShape(held.session)).toEqual(['user', 'assistant', CARD]);
      expect(processing(emitted).at(-1)).toBe(false);
      expect(panel.turnRunning).toBe(false);
      expect(errorNotices(emitted)).toEqual([RUN_FAILED]);
    }, 30_000);

    it('runs once pi settled that run, in a turn of its own that its own settle ends', async () => {
      const { held, release, emitted, panel } = await settlingAfterStop(['Noted.', 'Seen.']);
      const order = runOrder(held.session);

      panel.offerDesignResult(DESIGN);
      await reconciled(panel);
      expect(order).toEqual([]);

      release();
      await vi.waitFor(() => expect(branchShape(held.session)).toEqual(['user', 'assistant', CARD, 'assistant']), { timeout: 10_000 });
      await held.session.waitForIdle();
      await vi.waitFor(() => expect(turnState(panel)).toBe('idle'), { timeout: 10_000 });
      await reconciled(panel);
      expect(order).toEqual(['agent_settled', 'ask', 'agent_start', 'agent_settled']);
      // the stopped run's settle, then the delivery's turn
      expect(processing(emitted)).toEqual([false, true, false]);
      expect(emitted.filter((m) => m.type === 'done')).toHaveLength(1);
      expect(errorNotices(emitted)).toEqual([]);
    }, 30_000);
  });

  it('offered while a run no send opened streams lands with its run once pi settled that run', async () => {
    const held = await sessions.boot([fauxAssistantMessage('Done.'), fauxAssistantMessage('Seen.')], { mainChat: true, beforeSettle: true });
    await linkedWithResult(held.session);
    const beforeSettle = held.holdBeforeSettle();
    const emitted: ExtensionToWebviewMessage[] = [];
    const panel = boundPanel(held, emitted);
    const order = runOrder(held.session);
    // An extension's `pi.sendMessage` with `triggerTurn` on an idle session opens a run no turn of the chat tracks.
    void held.session.sendCustomMessage({ customType: 'extension-turn', content: 'go', display: false }, { triggerTurn: true });
    await within(beforeSettle.waiting, 10_000, 'the agent_before_settle handler');

    panel.offerDesignResult(DESIGN);
    await reconciled(panel);
    expect(order).toEqual(['agent_start']);

    beforeSettle.release();
    await vi.waitFor(() => expect(branchShape(held.session)).toEqual(['extension-turn', 'assistant', CARD, 'assistant']), { timeout: 10_000 });
    await held.session.waitForIdle();
    await vi.waitFor(() => expect(turnState(panel)).toBe('idle'), { timeout: 10_000 });
    await reconciled(panel);
    expect(order).toEqual(['agent_start', 'agent_settled', 'ask', 'agent_start', 'agent_settled']);
    expect(errorNotices(emitted)).toEqual([]);
  }, 30_000);

  it('that pi refuses at once ends its turn, lands the card with no run once and says why', async () => {
    const held = await sessions.boot([], { mainChat: true });
    await linkedWithResult(held.session);
    const emitted: ExtensionToWebviewMessage[] = [];
    const panel = boundPanel(held, emitted);
    failNextRunPreparation(held.session);

    panel.offerDesignResult(DESIGN);
    await vi.waitFor(() => expect(branchShape(held.session)).toEqual([CARD]), { timeout: 10_000 });
    await vi.waitFor(() => expect(turnState(panel)).toBe('idle'), { timeout: 10_000 });
    await reconciled(panel);
    expect(branchShape(held.session)).toEqual([CARD]);
    expect(processing(emitted)).toEqual([true, false]);
    expect(errorNotices(emitted)).toEqual([RUN_FAILED]);
  }, 30_000);
});
