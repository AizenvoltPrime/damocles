import { extractTextFromContent } from '../../../shared/utils';
import type { UserContentBlock } from '../../../shared/types/content';
import type { PanelQueuedMessage } from '../../preload/panel-channels';
import { isPanelToken, parseContent, type OfflineEntry, type QueuedPanel } from './remote-state';

// remote-state.json holds every page's messages and is rewritten whole on each change, so a page holds at most this many
export const MAX_HELD_PER_PANEL = 50;
// and every page together at most this many bytes of message content (images are base64 text)
export const MAX_HELD_BYTES: number = 8 * 1024 * 1024;
// core answers a flushed message as it takes it; one unanswered this long while the host stayed connected got an answer
// this queue does not read (an extension command commits no prompt)
export const VERDICT_WAIT_MS = 60_000;

// What a flush hands the chat's relay: the page's own message, naming the conversation the page showed when it was typed.
export interface QueuedSend {
  readonly type: 'sendMessage' | 'queueMessage';
  readonly content: string | UserContentBlock[];
  readonly sessionId: string | null;
}

// held: kept for the flush; ignored: not a send this queue holds; tooMany, tooLarge: a send refused past the bounds;
// unsaved: a send refused while remote-state.json takes no writes
export type HoldOutcome = 'held' | 'ignored' | 'tooMany' | 'tooLarge' | 'unsaved';

export interface OfflineQueueDeps {
  // remote-state.json's offlineQueue as the launch read it
  readonly stored: ReadonlyMap<string, QueuedPanel>;
  // writes one page's held messages (undefined removes them)
  readonly save: (panelToken: string, panel: QueuedPanel | undefined) => Promise<void>;
  // false while remote-state.json refuses every write, when a held message would live in memory alone
  readonly canSave: () => boolean;
  // the page's held messages changed: its chips follow
  readonly changed: (panelToken: string) => void;
  readonly newId: () => string;
  readonly report: (err: unknown) => void;
  readonly now?: () => number;
}

// A message a flush handed to core whose verdict has not come back yet. paused: the connection dropped since, so the wait
// for its verdict does not run out.
interface Pending {
  readonly entry: OfflineEntry;
  readonly text: string;
  at: number;
  paused: boolean;
}

interface Delivered {
  readonly authority: string;
  // oldest first
  readonly entries: Pending[];
}

const textOf = (content: string | readonly UserContentBlock[]): string => extractTextFromContent(content as string | UserContentBlock[]);
const bytesOf = (content: string | readonly UserContentBlock[]): number => Buffer.byteLength(JSON.stringify(content));

/** The page's sendMessage or queueMessage with only the fields a held message keeps; undefined for anything else or an empty one. */
function heldSend(message: unknown): Pick<OfflineEntry, 'content' | 'conversationId'> | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const { type, content, sessionId } = message as { type?: unknown; content?: unknown; sessionId?: unknown };
  if (type !== 'sendMessage' && type !== 'queueMessage') return undefined;
  if (sessionId !== null && (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > 256)) return undefined;
  const parsed = parseContent(content);
  if (parsed === undefined || (textOf(parsed).trim() === '' && (typeof parsed === 'string' || !parsed.some((block) => block.type === 'image')))) return undefined;
  return { content: parsed, conversationId: sessionId };
}

/** The messages remote chat pages sent while their host was away: docs/invariants.md "Desktop host", held messages. */
export class OfflineQueue {
  private readonly deps: OfflineQueueDeps;
  private readonly now: () => number;
  private readonly panels: Map<string, QueuedPanel>;
  private readonly delivered = new Map<string, Delivered>();

  constructor(deps: OfflineQueueDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.panels = new Map(deps.stored);
  }

  /** Holds the page's send, or refuses it past the bounds; anything else is not this queue's and goes its usual way. */
  hold(authority: string, panelToken: string, message: unknown): HoldOutcome {
    const held = heldSend(message);
    if (!held || !isPanelToken(panelToken)) return 'ignored';
    if (!this.deps.canSave()) return 'unsaved';
    const entries = this.panels.get(panelToken)?.entries ?? [];
    if (entries.length >= MAX_HELD_PER_PANEL) return 'tooMany';
    const heldBytes = [...this.panels.values()].reduce((sum, panel) => sum + panel.entries.reduce((total, entry) => total + bytesOf(entry.content), 0), 0);
    if (heldBytes + bytesOf(held.content) > MAX_HELD_BYTES) return 'tooLarge';
    this.set(panelToken, { authority, entries: [...entries, { id: this.deps.newId(), ...held, status: 'queued' }] });
    return 'held';
  }

  /** The page's chips, in the order it sent them. */
  queued(panelToken: string): PanelQueuedMessage[] {
    return (this.panels.get(panelToken)?.entries ?? []).map((entry) => ({
      id: entry.id,
      text: textOf(entry.content),
      imageCount: typeof entry.content === 'string' ? 0 : entry.content.filter((block) => block.type === 'image').length,
      status: entry.status,
    }));
  }

  /** The panel tokens of the authority with messages waiting to send. */
  waiting(authority: string): string[] {
    return [...this.panels].filter(([, panel]) => panel.authority === authority && panel.entries.some((entry) => entry.status === 'queued')).map(([token]) => token);
  }

  /** Cancel on a waiting chip, Discard on a not-sent one; false when the page has no such entry in that state. */
  remove(panelToken: string, id: string, status: OfflineEntry['status']): boolean {
    const panel = this.panels.get(panelToken);
    if (!panel?.entries.some((entry) => entry.id === id && entry.status === status)) return false;
    this.set(panelToken, { ...panel, entries: panel.entries.filter((entry) => entry.id !== id) });
    return true;
  }

  /**
   * Hands the page's waiting messages to send, in order, as the page itself posts them: the first as a send unless the
   * chat's turn still runs, the rest queued behind it.
   */
  flush(panelToken: string, busy: boolean, send: (message: QueuedSend) => void): void {
    const panel = this.panels.get(panelToken);
    const waiting = panel?.entries.filter((entry) => entry.status === 'queued') ?? [];
    if (!panel || waiting.length === 0) return;
    this.set(panelToken, { ...panel, entries: panel.entries.filter((entry) => entry.status !== 'queued') });
    const delivered = this.delivered.get(panelToken) ?? { authority: panel.authority, entries: [] };
    this.delivered.set(panelToken, delivered);
    waiting.forEach((entry, index) => {
      delivered.entries.push({ entry, text: textOf(entry.content), at: this.now(), paused: false });
      send({ type: index === 0 && !busy ? 'sendMessage' : 'queueMessage', content: typeof entry.content === 'string' ? entry.content : [...entry.content], sessionId: entry.conversationId });
    });
  }

  /** Whether the page has flushed messages core has not answered, so its next verdicts are worth reading. */
  awaitsVerdict(panelToken: string): boolean {
    this.expire(panelToken);
    return this.delivered.has(panelToken);
  }

  /**
   * A core message on its way to the page, matched to the oldest flushed message of its text, since core answers a page's
   * messages in order. A conversationChanged return of one is taken (true) and that message becomes not-sent; any other
   * verdict on one only settles it, and the page gets it as usual.
   */
  fromCore(panelToken: string, message: unknown): boolean {
    this.expire(panelToken);
    const delivered = this.delivered.get(panelToken);
    if (!delivered || typeof message !== 'object' || message === null) return false;
    const verdict = message as { type?: unknown; reason?: unknown; content?: unknown; message?: { content?: unknown } };
    if (verdict.type !== 'promptReturned' && verdict.type !== 'userMessage' && verdict.type !== 'messageQueued') return false;
    const content = parseContent(verdict.type === 'messageQueued' ? verdict.message?.content : verdict.content);
    // a give-back with no content only drops another device's echo, so it answers none of this page's messages
    if (content === undefined || content.length === 0) return false;
    const text = textOf(content);
    const index = delivered.entries.findIndex((candidate) => candidate.text === text);
    if (index < 0) return false;
    const [settled] = delivered.entries.splice(index, 1);
    if (delivered.entries.length === 0) this.delivered.delete(panelToken);
    if (verdict.type !== 'promptReturned' || verdict.reason !== 'conversationChanged') return false;
    this.notSent(panelToken, delivered.authority, [settled!.entry]);
    return true;
  }

  /** fromCore for the JSON text core posts; text that is not JSON is the page's, whose preload drops it with a warning. */
  fromCoreText(panelToken: string, json: string): boolean {
    let message: unknown;
    try {
      message = JSON.parse(json);
    } catch {
      return false;
    }
    return this.fromCore(panelToken, message);
  }

  /** The host's connection dropped (suspect or lost): the flushed messages wait for its resume, however long it takes. */
  hostLost(authority: string): void {
    for (const pending of this.pendingOf(authority)) pending.paused = true;
  }

  /** The same connection resumed: its replay carries the flushed messages, whose verdicts are awaited again. */
  hostResumed(authority: string): void {
    for (const pending of this.pendingOf(authority)) {
      pending.paused = false;
      pending.at = this.now();
    }
  }

  /**
   * The connection the flushed messages went over ended without resuming (a fresh attach, Disconnect Host, a new core): what
   * core never answered may never have reached it, so it becomes not-sent, never sent again and never dropped unseen.
   */
  connectionEnded(authority: string): void {
    for (const [token, delivered] of [...this.delivered]) {
      if (delivered.authority !== authority) continue;
      this.expire(token);
      const unanswered = this.delivered.get(token);
      if (!unanswered) continue;
      this.delivered.delete(token);
      this.notSent(token, authority, unanswered.entries.map((pending) => pending.entry));
    }
  }

  /** The page closed for good (the user closed the chat): its held messages go with it. */
  forget(panelToken: string): void {
    this.delivered.delete(panelToken);
    if (this.panels.has(panelToken)) this.set(panelToken, undefined);
  }

  /** Forget host: every page of the authority lets go of its messages; remote-state.json drops them with the host. */
  forgetAuthority(authority: string): void {
    for (const [token, delivered] of [...this.delivered]) if (delivered.authority === authority) this.delivered.delete(token);
    for (const [token, panel] of [...this.panels]) {
      if (panel.authority !== authority) continue;
      this.panels.delete(token);
      this.deps.changed(token);
    }
  }

  private pendingOf(authority: string): Pending[] {
    return [...this.delivered.values()].filter((delivered) => delivered.authority === authority).flatMap((delivered) => delivered.entries);
  }

  // answered in a way this queue does not read: core took it while the connection stayed up
  private expire(panelToken: string): void {
    const delivered = this.delivered.get(panelToken);
    if (!delivered) return;
    const now = this.now();
    const kept = delivered.entries.filter((pending) => pending.paused || now - pending.at < VERDICT_WAIT_MS);
    if (kept.length === delivered.entries.length) return;
    delivered.entries.splice(0, delivered.entries.length, ...kept);
    if (kept.length === 0) this.delivered.delete(panelToken);
  }

  private notSent(panelToken: string, authority: string, entries: readonly OfflineEntry[]): void {
    if (entries.length === 0) return;
    const held = this.panels.get(panelToken)?.entries ?? [];
    this.set(panelToken, { authority, entries: [...held, ...entries.map((entry) => ({ ...entry, status: 'notSent' as const }))] });
  }

  private set(panelToken: string, panel: QueuedPanel | undefined): void {
    const kept = panel && panel.entries.length > 0 ? panel : undefined;
    if (kept) this.panels.set(panelToken, kept);
    else this.panels.delete(panelToken);
    this.deps.save(panelToken, kept).catch(this.deps.report);
    this.deps.changed(panelToken);
  }
}
