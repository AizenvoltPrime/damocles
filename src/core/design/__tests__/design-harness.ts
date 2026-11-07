import * as fs from 'node:fs';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { vi } from 'vitest';
import { createFakePlatform, type FakePlatform } from '../../../__mocks__/fake-platform';
import { DAMOCLES_DESIGNS_DIR } from '../../paths';
import { SessionDesign, type DeliveryState, type ReconcileTrigger } from '../session-design';
import type { DesignCustomMessage } from '../delivery';
import type { DesignPanels, DesignSeed, SessionShown } from '../tools/start-design';
import type { DesignVersionAsk } from '../../permission-handler/managers/design-version-manager';
import type { DesignResultDecision, DesignVersionChoice } from '../../../shared/types/design';
import { commitDesignVersion, probeDesignVersion, type DesignVersionRecord, type DesignWriter } from '../design-state';

/** Stamps a version as an approved FinishDesign does: the latest again when unchanged, else the next, the folder taken as unchanged. */
export async function stampDesignVersion(
  stateDir: string,
  chat: DesignWriter,
  contentHash: string,
  decisions: readonly DesignResultDecision[],
  build: (version: number, previous: DesignVersionRecord | undefined) => DesignVersionRecord,
): Promise<{ record: DesignVersionRecord; reused: boolean }> {
  const probe = await probeDesignVersion(stateDir, chat, contentHash, decisions);
  if (probe.kind === 'reuse') return { record: probe.record, reused: true };
  return { record: await commitDesignVersion(stateDir, chat, probe, async () => contentHash, build), reused: false };
}

/** A pi session as SessionDesign reads it: an id, a branch it appends to, and its event listeners. */
export interface FakeDesignSession {
  readonly sessionId: string;
  readonly entries: Record<string, unknown>[];
  name: string | undefined;
  emit(event: unknown): void;
  readonly session: AgentSession;
}

let entryCounter = 0;

export function fakeSession(sessionId: string, entries: Record<string, unknown>[] = []): FakeDesignSession {
  const listeners = new Set<(event: unknown) => void>();
  const fake: FakeDesignSession = {
    sessionId,
    entries,
    name: undefined,
    emit: (event) => { for (const listener of [...listeners]) listener(event); },
    session: undefined as unknown as AgentSession,
  };
  const append = (fields: Record<string, unknown>): string => {
    const id = `entry-${++entryCounter}`;
    entries.push({ id, parentId: entries.at(-1)?.['id'] ?? null, timestamp: new Date().toISOString(), ...fields });
    return id;
  };
  (fake as { session: AgentSession }).session = {
    sessionId,
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => entries,
      // pi's leaf names one branch; the fake's entries change in place, so their count and last id stand in for it
      getLeafId: () => `${entries.length}:${String(entries.at(-1)?.['id'] ?? '')}`,
      appendCustomEntry: (customType: string, data?: unknown) => append({ type: 'custom', customType, data }),
    },
    setSessionName: (name: string) => { fake.name = name; },
    subscribe: (listener: (event: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as AgentSession;
  return fake;
}

/** Appends a delivered custom message as pi does, then emits its message_end. */
export function appendCustomMessage(fake: FakeDesignSession, message: DesignCustomMessage<unknown>): void {
  fake.entries.push({ id: `entry-${++entryCounter}`, parentId: null, timestamp: new Date().toISOString(), type: 'custom_message', customType: message.customType, content: message.content, display: true, details: message.details });
  fake.emit({ type: 'message_end', message: { role: 'custom', customType: message.customType } });
}

/** A version prompt the harness raised; `answer` is the user's click. */
export interface AskedVersion {
  readonly ask: DesignVersionAsk;
  readonly signal: AbortSignal;
  answer(choice: DesignVersionChoice): void;
}

export interface DesignHarness {
  readonly design: SessionDesign;
  readonly platform: FakePlatform;
  readonly delivered: { messages: readonly DesignCustomMessage<unknown>[]; run: boolean }[];
  /** Every version prompt raised, in order. */
  readonly asked: AskedVersion[];
  /** `plan-mode` and `deliver` in the order they happened. */
  readonly calls: string[];
  readonly posted: unknown[];
  state: DeliveryState;
  current: FakeDesignSession | undefined;
  readonly panels: DesignPanels & { showSession: ReturnType<typeof vi.fn>; openDesignChat: ReturnType<typeof vi.fn> };
  /** Each stored chat's current title, by session id, as `panels.sessionTitle` reads it. */
  readonly titles: Map<string, string>;
}

export function designHarness(options: { seed?: DesignSeed; session?: FakeDesignSession; enabled?: boolean; sessionExists?: boolean; cwd?: string } = {}): DesignHarness {
  const platform = createFakePlatform({ settings: { user: { 'damocles.design.enabled': options.enabled ?? true } } });
  const delivered: DesignHarness['delivered'] = [];
  const asked: AskedVersion[] = [];
  const calls: string[] = [];
  const posted: unknown[] = [];
  const titles = new Map<string, string>();
  const panels = {
    openDesignChat: vi.fn(async () => 'design-session'),
    showSession: vi.fn(async (): Promise<SessionShown> => 'shown'),
    sessionTitle: async (sessionId: string) => titles.get(sessionId),
  };
  const harness: DesignHarness = {
    platform,
    delivered,
    asked,
    calls,
    posted,
    state: 'idle',
    current: options.session,
    panels,
    titles,
    design: undefined as unknown as SessionDesign,
  };
  (harness as { design: SessionDesign }).design = new SessionDesign({
    cwd: options.cwd ?? process.cwd(),
    panelId: () => 'design-panel',
    platform,
    seed: options.seed,
    session: () => harness.current?.session,
    emit: (message) => posted.push(message),
    deliveryState: (_session, _trigger: ReconcileTrigger) => harness.state,
    deliver: (_session, messages, run) => {
      calls.push('deliver');
      delivered.push({ messages, run });
      for (const message of messages) appendCustomMessage(harness.current!, message);
      return true;
    },
    sessionExists: async () => options.sessionExists ?? true,
    shellPath: () => undefined,
    panels: () => panels,
    askVersion: (ask, signal) => new Promise<DesignVersionChoice | undefined>((resolve) => {
      asked.push({ ask, signal, answer: resolve });
      signal.addEventListener('abort', () => resolve(undefined), { once: true });
    }),
    activatePlanMode: async () => {
      calls.push('plan-mode');
    },
  });
  return harness;
}

/** Clears every design and state folder under the test home. */
export function clearDesigns(): void {
  fs.rmSync(DAMOCLES_DESIGNS_DIR, { recursive: true, force: true });
}
