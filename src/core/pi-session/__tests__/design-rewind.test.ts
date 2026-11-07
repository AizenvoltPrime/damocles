import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as pi from '@earendil-works/pi-coding-agent';
import type { AgentSession, SessionManager } from '@earendil-works/pi-coding-agent';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { panelSession } from './real-pi-fixtures';
import { AutoCheckpointProducer, folderIdFor, getFolderRepoDir, getGitDir, getPreRewindEntries, type PreRewindRecord } from '../checkpoints';
import { designLinkEntryData, designRoleOf, designRoleEntryData, ownDesignLink, type DesignLink, type DesignRole } from '../../design/design-entries';
import { designFolderOf, designStateDirOf, forkDesignId } from '../../design/design-paths';
import { readDesignLink, updateDesignLink } from '../../design/design-state';
import { clearDesigns, designHarness, fakeSession, stampDesignVersion, type FakeDesignSession } from '../../design/__tests__/design-harness';

vi.mock('../../logger', () => ({ log: vi.fn() }));

type Message = Parameters<SessionManager['appendMessage']>[0];
const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }) as Message;
const assistant = (text: string): Message =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: Date.now(),
  }) as unknown as Message;

const DESIGN = 'contacts-abcd1234';
const FOLDER = designFolderOf(DESIGN);
const role: DesignRole = { designId: DESIGN, folder: FOLDER, parentSessionId: 'parent-1', ruleSet: 'full', title: 'Contacts' };

type Plan =
  | { kind: 'fork'; role: DesignRole; source: { kind: 'copy' } }
  | { kind: 'takeover'; role: DesignRole; preRewind: PreRewindRecord | null }
  | { kind: 'parent'; link: DesignLink };
interface PanelInternals {
  prepareDesignFork(p: typeof pi, plan: Plan, sourceSm: SessionManager, branchedPath: string, forkSessionId: string): Promise<boolean>;
  rewindCarriedLink(session: AgentSession, forkPoint: string | null): Promise<DesignLink | undefined>;
  readOnlyRefusal(): { message: string } | undefined;
  design: { readLink(): Promise<unknown> };
  runtime: { session: AgentSession } | null;
}

let sessionDir: string;
let emitted: ExtensionToWebviewMessage[];
let panel: PanelInternals;

/** A design chat's file: its role, a first turn and a second user message, and a branch cut before that second message. */
function designChat(): { source: SessionManager; branchedPath: string; forkId: string } {
  const source = pi.SessionManager.create(sessionDir, sessionDir);
  source.appendCustomEntry('damocles.design', designRoleEntryData(role));
  // named as SessionDesign.recordSeededRole names a new design chat
  source.appendSessionInfo('Design · Contacts');
  source.appendCustomEntry('damocles-user-renamed');
  source.appendMessage(user('first'));
  const reply = source.appendMessage(assistant('ok'));
  source.appendMessage(user('second'));
  const branchedPath = pi.SessionManager.open(source.getSessionFile()!, sessionDir).createBranchedSession(reply)!;
  return { source, branchedPath, forkId: pi.SessionManager.open(branchedPath, sessionDir).getSessionId() };
}

const linkTo = (designSessionId: string) =>
  updateDesignLink(designStateDirOf(DESIGN), () => ({ schemaVersion: 1, designId: DESIGN, folder: FOLDER, title: 'Contacts', parentSessionId: 'parent-1', designSessionId, superseded: [] }));
const entriesOf = (file: string): unknown[] => pi.SessionManager.open(file, sessionDir).getEntries();

beforeEach(() => {
  clearDesigns();
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-rewind-'));
  fs.mkdirSync(path.join(FOLDER, 'screens'), { recursive: true });
  fs.writeFileSync(path.join(FOLDER, 'design.md'), '# Contacts\n');
  emitted = [];
  panel = panelSession(emitted) as unknown as PanelInternals;
});
afterEach(() => {
  fs.rmSync(sessionDir, { recursive: true, force: true });
  fs.rmSync(getFolderRepoDir(folderIdFor(FOLDER)), { recursive: true, force: true });
});

describe('Fork from here in a design chat (PD-36)', () => {
  it('gives the branched file a new design with no parent, and tells the user when the files are a copy', async () => {
    const { source, branchedPath, forkId } = designChat();
    await linkTo(source.getSessionId());
    expect(await panel.prepareDesignFork(pi, { kind: 'fork', role, source: { kind: 'copy' } }, source, branchedPath, forkId)).toBe(true);
    const forkRole = designRoleOf(entriesOf(branchedPath));
    expect(forkRole).toMatchObject({ designId: forkDesignId(DESIGN, forkId), parentSessionId: null, title: 'Contacts' });
    expect(pi.SessionManager.open(branchedPath, sessionDir).getSessionName()).toBe('Design · Contacts');
    expect(fs.readFileSync(path.join(forkRole!.folder, 'design.md'), 'utf8')).toBe('# Contacts\n');
    expect(await readDesignLink(designStateDirOf(forkRole!.designId))).toMatchObject({ parentSessionId: null, designSessionId: forkId });
    // The parent stays linked to the original design, and the source chat stays its design chat.
    expect(await readDesignLink(designStateDirOf(DESIGN))).toMatchObject({ parentSessionId: 'parent-1', designSessionId: source.getSessionId(), superseded: [] });
    expect(designRoleOf(source.getEntries())?.designId).toBe(DESIGN);
    expect(emitted).toContainEqual(expect.objectContaining({ type: 'notification', message: { message: 'This point has no checkpoint of the design files, so the fork starts from a copy of the files as they are now.' } }));
  });
});

describe('Rewind takeover in a design chat (PD-36)', { timeout: 60_000 }, () => {
  it('names the new chat in link.json, keeps the design, and carries the restore\'s Undo rewind with its own refs', async () => {
    const { source, branchedPath, forkId } = designChat();
    await linkTo(source.getSessionId());
    const producer = new AutoCheckpointProducer({ sessionId: source.getSessionId(), sessionFile: source.getSessionFile()!, cwd: FOLDER, capturesTracked: false, maxFileSizeBytes: () => 25 * 1024 * 1024, createTurnId: () => 'turn', now: () => new Date() });
    const started = await producer.turnStart({ userEntryId: 'u2', prompt: 'second' });
    if (!started.ok) throw new Error(started.message);
    fs.writeFileSync(path.join(FOLDER, 'screens', 'S1.html'), '<html></html>\n');
    const finalized = await producer.finalizeRun();
    if (!finalized.ok || finalized.record?.kind !== 'checkpoint') throw new Error('no checkpoint');
    const restored = await producer.restore(finalized.record);
    producer.dispose();
    if (!restored.ok) throw new Error('restore failed');
    expect(fs.existsSync(path.join(FOLDER, 'screens', 'S1.html'))).toBe(false);

    expect(await panel.prepareDesignFork(pi, { kind: 'takeover', role, preRewind: restored.preRewind }, source, branchedPath, forkId)).toBe(true);

    const entries = entriesOf(branchedPath);
    expect(designRoleOf(entries)).toEqual(role);
    expect(pi.SessionManager.open(branchedPath, sessionDir).getSessionName()).toBe('Design · Contacts');
    expect(getPreRewindEntries(entries).map((r) => r.id)).toEqual([restored.preRewind.id]);
    const gitDir = getGitDir(getFolderRepoDir(folderIdFor(FOLDER)));
    const refs = execFileSync('git', [`--git-dir=${gitDir}`, 'for-each-ref', '--format=%(refname)', `refs/damocles/sessions/${forkId}/`]).toString().split('\n').filter(Boolean);
    expect(refs).toEqual([`refs/damocles/sessions/${forkId}/_rewinds/${restored.preRewind.id}/snapshot`]);
    expect(await readDesignLink(designStateDirOf(DESIGN))).toMatchObject({ designSessionId: forkId, superseded: [source.getSessionId()], parentSessionId: 'parent-1' });

    // Undo rewind in the new chat, from the record it carries, brings turn B's screen back.
    const carried = getPreRewindEntries(entries)[0]!;
    const successor = new AutoCheckpointProducer({ sessionId: forkId, sessionFile: branchedPath, cwd: FOLDER, capturesTracked: false, maxFileSizeBytes: () => 25 * 1024 * 1024, createTurnId: () => 'turn', now: () => new Date() });
    try {
      expect(await successor.restorePreRewind(carried)).toMatchObject({ ok: true });
    } finally {
      successor.dispose();
    }
    expect(fs.readFileSync(path.join(FOLDER, 'screens', 'S1.html'), 'utf8')).toBe('<html></html>\n');
  });

  it('keeps the new chat when link.json already names it and only moving the briefs failed', async () => {
    const { source, branchedPath, forkId } = designChat();
    await linkTo(source.getSessionId());
    const designState = await import('../../design/design-state');
    const takeOver = designState.takeOverDesignLink;
    const spy = vi.spyOn(designState, 'takeOverDesignLink').mockImplementation(async (...args) => {
      await takeOver(...args);
      throw new Error('EPERM writing a brief');
    });
    try {
      expect(await panel.prepareDesignFork(pi, { kind: 'takeover', role, preRewind: null }, source, branchedPath, forkId)).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(branchedPath)).toBe(true);
    expect(emitted.at(-1)).toMatchObject({ type: 'notification', notificationType: 'warning' });
    expect(emitted.some((m) => m.type === 'rewindError')).toBe(false);
  });

  // The old chat's list row reads superseded from link.json, so nothing but this tells the chat list it changed.
  it('has the old chat\'s list row read again once link.json names the new chat, and only then', async () => {
    const persisted = vi.fn();
    (panel as unknown as { options: { onSessionPersisted?: (sessionId: string) => void } }).options.onSessionPersisted = persisted;
    const { source, branchedPath, forkId } = designChat();
    await linkTo('someone-else');
    expect(await panel.prepareDesignFork(pi, { kind: 'takeover', role, preRewind: null }, source, branchedPath, forkId)).toBe(false);
    expect(persisted).not.toHaveBeenCalled();

    const retry = designChat();
    await linkTo(retry.source.getSessionId());
    expect(await panel.prepareDesignFork(pi, { kind: 'takeover', role, preRewind: null }, retry.source, retry.branchedPath, retry.forkId)).toBe(true);
    expect(persisted.mock.calls).toEqual([[retry.source.getSessionId()]]);
  });

  it('leaves the old chat current and removes the unopened branch when another chat holds the link', async () => {
    const { source, branchedPath, forkId } = designChat();
    await linkTo('someone-else');
    expect(await panel.prepareDesignFork(pi, { kind: 'takeover', role, preRewind: null }, source, branchedPath, forkId)).toBe(false);
    expect(fs.existsSync(branchedPath)).toBe(false);
    expect(await readDesignLink(designStateDirOf(DESIGN))).toMatchObject({ designSessionId: 'someone-else', superseded: [] });
    expect(emitted.at(-1)).toMatchObject({ type: 'rewindError', message: { message: 'The files were restored, but the design could not move to a new chat: {0}. Undo the rewind to put the files back.' } });
  });

  it('refuses sends, compaction, rewinds and undo in the superseded chat, by the link.json each of them reads first', async () => {
    const { source } = designChat();
    await linkTo(source.getSessionId());
    const sessionId = source.getSessionId();
    panel.runtime = { session: { sessionId, sessionManager: source, subscribe: () => () => undefined, extensionRunner: { getCommand: () => undefined } } as unknown as AgentSession };
    (panel as unknown as { startPromise: Promise<void> }).startPromise = Promise.resolve();
    await panel.design.readLink();
    expect(panel.readOnlyRefusal()).toBeUndefined();
    await linkTo('design-new');
    const superseded = { message: 'This design continues in another chat.' };
    const live = panel as unknown as {
      sendMessage(prompt: string, target: string, correlationId: string, broadcast: { content: string }): Promise<string>;
      compact(instructions: string | undefined, onAccepted: undefined, target: string): Promise<void>;
      rewindFiles(userMessageId: string): Promise<void>;
      undoRewind(preRewindId: string): Promise<void>;
    };
    expect(await live.sendMessage('more rows', sessionId, 'corr-1', { content: 'more rows' })).toBe('unsent');
    expect(emitted).toContainEqual({ type: 'error', message: superseded });
    emitted.length = 0;
    await live.compact(undefined, undefined, sessionId);
    expect(emitted).toContainEqual({ type: 'error', message: superseded });
    emitted.length = 0;
    await live.rewindFiles('any');
    await live.undoRewind('any');
    expect(emitted.filter((m) => m.type === 'rewindError')).toEqual([{ type: 'rewindError', message: superseded }, { type: 'rewindError', message: superseded }]);
  });
});

describe('Rewind in a main chat carries its design (D70)', () => {
  const LINK: DesignLink = { designId: DESIGN, folder: FOLDER, parentSessionId: 'x', title: 'Contacts' };

  /**
   * A main chat that linked the design in its first turn and has two more prompts, and the branch a rewind to its third prompt
   * cuts (after its second turn), which keeps the link. `second` is the second prompt's entry, after the link.
   */
  function parentChat(): { source: SessionManager; branchedPath: string; forkId: string; link: DesignLink; second: string } {
    const source = pi.SessionManager.create(sessionDir, sessionDir);
    const link = { ...LINK, parentSessionId: source.getSessionId() };
    source.appendMessage(user('design the contacts list'));
    source.appendCustomEntry('damocles.design-link', designLinkEntryData(link));
    source.appendMessage(assistant('started'));
    const second = source.appendMessage(user('second'));
    const reply = source.appendMessage(assistant('ok'));
    source.appendMessage(user('third'));
    const branchedPath = pi.SessionManager.open(source.getSessionFile()!, sessionDir).createBranchedSession(reply)!;
    return { source, branchedPath, forkId: pi.SessionManager.open(branchedPath, sessionDir).getSessionId(), link, second };
  }
  const liveOf = (sm: SessionManager) => ({ sessionId: sm.getSessionId(), sessionManager: sm }) as unknown as AgentSession;
  const forkPointOf = (sm: SessionManager, userEntryId: string) => sm.getEntry(userEntryId)?.parentId ?? null;
  const parentLink = (parentSessionId: string) =>
    updateDesignLink(designStateDirOf(DESIGN), () => ({ schemaVersion: 1, designId: DESIGN, folder: FOLDER, title: 'Contacts', parentSessionId, designSessionId: 'design-1', superseded: [] }));
  const finishVersion = (version: number) => stampDesignVersion(designStateDirOf(DESIGN), { sessionId: 'design-1', stillCurrent: () => true }, `hash-${version}`, [], (v) => ({
    schemaVersion: 1, version: v, designId: DESIGN, title: 'Contacts', sessionId: 'design-1', toolCallId: `c${v}`, contentHash: `hash-${version}`, decisions: [], screens: [],
    check: { errors: 0, warnings: [] }, journeys: [], summary: 's', changedSinceLast: [], finishedAt: '2026-01-01T00:00:00.000Z',
  }));
  const cards = (fake: FakeDesignSession) => fake.entries.filter((e) => e['customType'] === 'damocles-design-result');

  it('gives the new chat its own link, then names it the main chat; the next version reaches it and not the old chat', async () => {
    const { source, branchedPath, forkId, link } = parentChat();
    await parentLink(source.getSessionId());
    expect(await panel.prepareDesignFork(pi, { kind: 'parent', link }, source, branchedPath, forkId)).toBe(true);
    expect(ownDesignLink(entriesOf(branchedPath), forkId)).toMatchObject({ designId: DESIGN, parentSessionId: forkId });
    expect(await readDesignLink(designStateDirOf(DESIGN))).toMatchObject({ parentSessionId: forkId, designSessionId: 'design-1' });

    await finishVersion(1);
    const rewound = fakeSession(forkId, entriesOf(branchedPath) as Record<string, unknown>[]);
    const old = fakeSession(source.getSessionId(), source.getBranch() as unknown as Record<string, unknown>[]);
    const rewoundDesign = designHarness({ session: rewound });
    const oldDesign = designHarness({ session: old });
    await rewoundDesign.design.reconcile('live');
    await oldDesign.design.reconcile('live');
    expect(cards(rewound).map((e) => (e['details'] as { version: number }).version)).toEqual([1]);
    expect(cards(old)).toEqual([]);
    rewoundDesign.design.dispose();
    oldDesign.design.dispose();
  });

  it('carries the design only for the main chat link.json names, and from a chat it was carried to, at a point after the design\'s first link', async () => {
    const { source, branchedPath, forkId, link, second } = parentChat();
    await parentLink(source.getSessionId());
    expect(await panel.rewindCarriedLink(liveOf(source), forkPointOf(source, second))).toEqual(link);
    // the first prompt, before StartDesign: the rewound chat never started the design
    expect(await panel.rewindCarriedLink(liveOf(source), null)).toBeUndefined();

    expect(await panel.prepareDesignFork(pi, { kind: 'parent', link }, source, branchedPath, forkId)).toBe(true);
    // the old chat rewinds as any chat does, and the design stays with the chat link.json names
    expect(await panel.rewindCarriedLink(liveOf(source), forkPointOf(source, second))).toBeUndefined();
    // the new chat's own link is at the end of its file, and a rewind to an inherited prompt after StartDesign still carries
    const carriedTo = pi.SessionManager.open(branchedPath, sessionDir);
    carriedTo.appendMessage(user('fourth'));
    expect(await panel.rewindCarriedLink(liveOf(carriedTo), forkPointOf(carriedTo, second))).toEqual({ ...link, parentSessionId: forkId });
  });

  it('leaves the old chat the main chat and removes the unopened branch when another chat became the main chat meanwhile', async () => {
    const { source, branchedPath, forkId, link } = parentChat();
    await parentLink('another-parent');
    expect(await panel.prepareDesignFork(pi, { kind: 'parent', link }, source, branchedPath, forkId)).toBe(false);
    expect(fs.existsSync(branchedPath)).toBe(false);
    expect(await readDesignLink(designStateDirOf(DESIGN))).toMatchObject({ parentSessionId: 'another-parent' });
  });
});

describe('/clear in a design chat (D70)', () => {
  it('is refused with a notice, leaving link.json, decisions.md and the conversation as they are', async () => {
    const { source } = designChat();
    await linkTo(source.getSessionId());
    fs.writeFileSync(path.join(FOLDER, 'decisions.md'), '# Decisions\n');
    const linkBefore = fs.readFileSync(path.join(designStateDirOf(DESIGN), 'link.json'), 'utf8');
    panel.runtime = { session: { sessionId: source.getSessionId(), sessionManager: source } as unknown as AgentSession };
    expect((panel as unknown as { clear(): boolean }).clear()).toBe(false);
    expect(emitted).toContainEqual({ type: 'notification', notificationType: 'info', message: { message: 'A design chat keeps its conversation. Use Rewind in this chat to go back, or StartDesign in the main chat for a fresh design.' } });
    expect(panel.runtime?.session.sessionId).toBe(source.getSessionId());
    expect(fs.readFileSync(path.join(designStateDirOf(DESIGN), 'link.json'), 'utf8')).toBe(linkBefore);
    expect(fs.readFileSync(path.join(FOLDER, 'decisions.md'), 'utf8')).toBe('# Decisions\n');
  });
});
