import { randomUUID } from 'node:crypto';
import type { UsageThresholdCrossing } from '../../core/pi-session/usage-thresholds';
import type { ChatActivity, PendingPrompt, TurnOutcome } from '../../core/pi-session/session-state';
import type { AttentionKind, ExtensionToWebviewMessage } from '../../shared/types/messages';
import { OVERLAY_CHANNELS, type OverlayRequest, type OverlayToast } from '../preload/overlay-channels';
import {
  chimeTone,
  KIND_LIFE_MS,
  TOAST_OPEN_ACTION,
  type ChimeTone,
  type NotificationBell,
  type NotificationBody,
  type NotificationCenterState,
  type NotificationChat,
  type NotificationEntry,
  type NoticeSeverity,
} from '../preload/notifications';

// Global KeyValueState key; Do not disturb outlives the run, the entries do not (D26).
export const DO_NOT_DISTURB_KEY = 'damocles.desktop.notifications.doNotDisturb';
// The run's log keeps the newest entries up to this many.
export const MAX_ENTRIES = 500;
// How long main keeps a core notice's toast before resolving it undefined.
export const NOTICE_LIFE_MS: Readonly<Record<NoticeSeverity | 'withActions', number>> = {
  info: 8_000,
  warning: 12_000,
  error: 20_000,
  // a toast that asks for a choice stays long enough to be answered after a glance away
  withActions: 120_000,
};
// Characters of free text (a prompt summary, an error) an entry keeps.
const MAX_TEXT = 1000;

const ATTENTION_KINDS: ReadonlySet<NotificationBody['kind']> = new Set(['approval', 'plan', 'question', 'team']);

export interface ToastSink {
  show(toast: OverlayToast): void;
  dismiss(id: string): void;
}

/** The chat an entry is about, as main resolved it when the entry was raised. */
export interface ChatRef extends NotificationChat {
  // the desktop panel, while it stays loaded
  readonly panelId: string;
  // the stored conversation, which selects the chat again once it unloaded
  readonly sessionId?: string;
}

// What choosing an entry does (plan AD10's Action column).
export type EntryAction =
  | { readonly kind: 'attention'; readonly chat: ChatRef; readonly attention: AttentionKind }
  | { readonly kind: 'team'; readonly chat: ChatRef; readonly teamId: string }
  | { readonly kind: 'chat'; readonly chat: ChatRef }
  // no chat: the selected chat's Subscription usage
  | { readonly kind: 'usage'; readonly chat?: ChatRef }
  | { readonly kind: 'none' };

// A loaded chat as main identifies it: by its desktop panel, and by its stored conversation once it has one.
export interface ChatKey {
  readonly panelId: string;
  readonly sessionId?: string;
}

export interface NotificationCenterDeps {
  readonly doNotDisturb: () => boolean;
  readonly setDoNotDisturb: (on: boolean) => Promise<void>;
  // damocles.desktop.notifications.enabled
  readonly popupsEnabled: () => boolean;
  readonly windowFocused: () => boolean;
  readonly chatSelected: (corePanelId: string) => boolean;
  // the selected chat while the window has focus, whose entries are read as they arrive
  readonly viewedChat: () => ChatKey | undefined;
  // flashes the taskbar button, or stops it
  readonly flash: (on: boolean) => void;
  // undefined when the panel is no loaded chat
  readonly describeChat: (corePanelId: string) => Promise<ChatRef | undefined>;
  // the desktop popup window (D52), where every toast shows; undefined while the main window is closed or until the popup
  // page loads, when windowOpened or pendingToasts replays what waits
  readonly popups: () => ToastSink | undefined;
  // a popup arrived while Do not disturb is off and pop-ups are on; main plays its sound when the sound setting is on
  readonly chime: (tone: ChimeTone) => void;
  // D54: whether this usage warning was shown before, in this launch or an earlier one
  readonly usageWarningShown: (crossing: UsageThresholdCrossing) => boolean;
  readonly recordUsageWarning: (crossing: UsageThresholdCrossing) => void;
  readonly run: (action: EntryAction) => void;
  // the entries, the bell or Do not disturb changed
  readonly changed: () => void;
  readonly log: (line: string) => void;
  readonly now?: () => number;
}

interface Entry {
  readonly id: string;
  readonly at: number;
  read: boolean;
  seen: boolean;
  readonly body: NotificationBody;
  readonly action: EntryAction;
}

function chatOfAction(action: EntryAction): ChatRef | undefined {
  return action.kind === 'none' ? undefined : action.chat;
}

function sameChat(ref: ChatRef, chat: ChatKey): boolean {
  return ref.panelId === chat.panelId || (ref.sessionId !== undefined && ref.sessionId === chat.sessionId);
}

// A toast shows one entry and shares its id.
interface LiveToast {
  readonly id: string;
  readonly at: number;
  readonly lifeMs: number;
  readonly body: NotificationBody;
  readonly action: EntryAction;
  // a core notice's caller, answered with an action label or undefined
  readonly answer: ((action: string | undefined) => void) | undefined;
  remaining: number;
  // when the running countdown leg started; undefined while it waits for the popup page or is held
  started: number | undefined;
  timer: NodeJS.Timeout | undefined;
  held: boolean;
}

function bounded(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  return trimmed.length > MAX_TEXT ? `${trimmed.slice(0, MAX_TEXT - 1)}…` : trimmed;
}

function chatOf(ref: ChatRef): NotificationChat {
  return { project: ref.project, title: ref.title };
}

/** The entry and action a pending prompt raises: a prompt a team agent raised is the team's, whatever it asks. */
export function promptEntry(prompt: PendingPrompt, chat: ChatRef): { readonly body: NotificationBody; readonly action: EntryAction } {
  const summary = bounded(prompt.summary);
  const owner = prompt.owner;
  if (owner.kind === 'team') {
    const agentName = bounded(owner.agentName);
    return {
      body: { kind: 'team', chat: chatOf(chat), ...(summary ? { summary } : {}), ...(agentName ? { agentName } : {}) },
      action: { kind: 'team', chat, teamId: owner.teamId },
    };
  }
  const kind: AttentionKind = prompt.kind === 'input' ? 'question' : prompt.kind;
  return { body: { kind, chat: chatOf(chat), ...(summary ? { summary } : {}) }, action: { kind: 'attention', chat, attention: kind } };
}

/** The entry a settled turn raises, if any; the caller raises `done` only for a chat the user is not looking at. */
export function outcomeEntry(outcome: TurnOutcome, chat: ChatRef): { readonly body: NotificationBody; readonly action: EntryAction } | undefined {
  const open: EntryAction = { kind: 'chat', chat };
  switch (outcome.kind) {
    case 'completed':
      return { body: { kind: 'done', chat: chatOf(chat), ...(outcome.durationMs !== undefined ? { durationMs: outcome.durationMs } : {}) }, action: open };
    case 'error': {
      const message = bounded(outcome.message);
      return { body: { kind: 'error', chat: chatOf(chat), reason: 'error', ...(message ? { message } : {}) }, action: open };
    }
    case 'rateLimit': {
      const windowLabel = bounded(outcome.windowLabel);
      return {
        body: {
          kind: 'error',
          chat: chatOf(chat),
          reason: 'rateLimit',
          ...(windowLabel ? { windowLabel } : {}),
          ...(outcome.resetsAt !== undefined ? { resetsAt: outcome.resetsAt } : {}),
        },
        action: open,
      };
    }
    case 'budget':
      return { body: { kind: 'limit', chat: chatOf(chat), reason: 'budget' }, action: { kind: 'usage', chat } };
    case 'cancelled':
      return undefined;
  }
}

export function usageEntry(crossing: UsageThresholdCrossing): { readonly body: NotificationBody; readonly action: EntryAction } {
  const planName = bounded(crossing.planName);
  return {
    body: {
      kind: 'limit',
      reason: 'usage',
      windowLabel: bounded(crossing.windowLabel) ?? '',
      threshold: crossing.threshold,
      utilization: Math.round(crossing.utilization),
      ...(crossing.resetsAt !== undefined ? { resetsAt: crossing.resetsAt } : {}),
      ...(planName ? { planName } : {}),
    },
    action: { kind: 'usage' },
  };
}

export interface EntryActionDeps<P> {
  readonly selected: () => P | undefined;
  // selects the chat, loading it again when it was unloaded, and resolves its view; undefined when the selection was
  // refused (another process's lease, a deleted chat), which shows its own toast
  readonly select: (chat: ChatRef) => Promise<P | undefined>;
  // resolves once the view can take messages; false when its chat closed first
  readonly whenReady: (panel: P) => Promise<boolean>;
  readonly post: (panel: P, message: ExtensionToWebviewMessage) => void;
}

function entryMessage(action: EntryAction): ExtensionToWebviewMessage | undefined {
  switch (action.kind) {
    case 'attention': return { type: 'focusAttention', kind: action.attention };
    case 'team': return { type: 'openTeamOverlay', teamId: action.teamId };
    case 'usage': return { type: 'runChatCommand', command: 'subscriptionUsage' };
    case 'chat':
    case 'none':
      return undefined;
  }
}

/**
 * Runs an entry's action: selects its chat, then posts what its kind asks for to that chat's own view once it is ready.
 * The selection can move while the chat loads, and a message such as focusAttention must never land in another chat, so
 * nothing is posted unless that chat is still the selected one.
 */
export async function runEntryAction<P>(action: EntryAction, deps: EntryActionDeps<P>): Promise<void> {
  if (action.kind === 'none') return;
  const panel = action.chat === undefined ? deps.selected() : await deps.select(action.chat);
  const message = entryMessage(action);
  if (panel === undefined || message === undefined) return;
  if (!(await deps.whenReady(panel)) || deps.selected() !== panel) return;
  deps.post(panel, message);
}

/**
 * The current run's notifications (plan AD10): entries with unread and seen state, Do not disturb, the kind table's
 * toasts and their lives, and the desktop popup policy (D52). Every toast shows only in the popup window, whether or not
 * the main window is focused; main owns its life and the popup page only renders it, under the entry's id.
 */
export class NotificationCenter {
  private readonly deps: NotificationCenterDeps;
  private readonly now: () => number;
  // newest first
  private entries: Entry[] = [];
  // in arrival order
  private readonly toasts = new Map<string, LiveToast>();
  // per core panel: the prompts it has pending and the entry each raised
  private readonly pendingPrompts = new Map<string, Map<string, string>>();
  // per core panel: the id of every prompt that raised an entry, so each prompt notifies once
  private readonly notifiedPrompts = new Map<string, Set<string>>();
  // entries that flashed the taskbar button and still wait on the user
  private readonly flashing = new Set<string>();
  private attention = 0;

  constructor(deps: NotificationCenterDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** Each new pending prompt raises one entry; a prompt that resolves withdraws its toast and keeps its entry. */
  activity(corePanelId: string, activity: ChatActivity): void {
    let pending = this.pendingPrompts.get(corePanelId);
    const current = new Set(activity.pendingPrompts.map((prompt) => prompt.id));
    for (const [promptId, entryId] of pending ?? []) {
      if (current.has(promptId)) continue;
      pending?.delete(promptId);
      this.withdraw(entryId);
    }
    for (const prompt of activity.pendingPrompts) {
      let notified = this.notifiedPrompts.get(corePanelId);
      if (notified?.has(prompt.id)) continue;
      if (!notified) {
        notified = new Set();
        this.notifiedPrompts.set(corePanelId, notified);
      }
      notified.add(prompt.id);
      if (!pending) {
        pending = new Map();
        this.pendingPrompts.set(corePanelId, pending);
      }
      const entryId = randomUUID();
      pending.set(prompt.id, entryId);
      const stillPending = (): boolean => this.pendingPrompts.get(corePanelId)?.get(prompt.id) === entryId;
      void this.deps.describeChat(corePanelId).then((chat) => {
        if (!chat) return;
        const { body, action } = promptEntry(prompt, chat);
        // A prompt answered while main looked up its chat is logged without a toast.
        this.raise(body, action, { id: entryId, quiet: !stillPending() });
      }, (err: unknown) => this.deps.log(`[notifications] describing a chat failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  /** A chat closed; its prompts can no longer resolve through activity, so their popups and flash go and their entries stay. */
  panelClosed(corePanelId: string): void {
    const pending = this.pendingPrompts.get(corePanelId);
    this.pendingPrompts.delete(corePanelId);
    this.notifiedPrompts.delete(corePanelId);
    for (const entryId of pending?.values() ?? []) this.withdraw(entryId);
  }

  turnSettled(corePanelId: string, outcome: TurnOutcome): void {
    if (outcome.kind === 'cancelled') return;
    if (outcome.kind === 'completed' && this.deps.chatSelected(corePanelId) && this.deps.windowFocused()) return;
    void this.deps.describeChat(corePanelId).then((chat) => {
      if (!chat) return;
      const raised = outcomeEntry(outcome, chat);
      if (raised) this.raise(raised.body, raised.action);
    }, (err: unknown) => this.deps.log(`[notifications] describing a chat failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** A usage warning shows once per window reset across launches (D54); one accepted is recorded even when silenced, since its entry collects. */
  usageThreshold(crossing: UsageThresholdCrossing): void {
    if (this.deps.usageWarningShown(crossing)) {
      this.deps.log(`[notifications] the ${crossing.threshold}% usage warning for this window was shown before`);
      return;
    }
    const { body, action } = usageEntry(crossing);
    this.raise(body, action);
    this.deps.recordUsageWarning(crossing);
  }

  /** A core notification: always an entry and a toast, answered with one of its actions or undefined. */
  notice(severity: NoticeSeverity, message: string, actions: readonly string[]): Promise<string | undefined> {
    return new Promise((resolve) => {
      this.raise({ kind: 'notice', severity, message, actions: [...actions] }, { kind: 'none' }, { answer: resolve });
    });
  }

  /**
   * An answer to a toast from the popup window, which has dropped it: one of a notice's actions, TOAST_OPEN_ACTION for a
   * kind's action, or undefined.
   */
  resolveToast(id: string, action: string | undefined): void {
    const live = this.toasts.get(id);
    if (!live) return;
    const allowed = action === undefined
      || (live.body.kind === 'notice' ? live.body.actions.includes(action) : action === TOAST_OPEN_ACTION);
    if (!allowed) {
      this.deps.log(`[notifications] ignored an answer that is not one of toast ${id}'s actions`);
      return;
    }
    this.finish(live, action);
    if (action === TOAST_OPEN_ACTION) this.choose(live.id, live.action);
  }

  holdToast(id: string, held: boolean): void {
    const live = this.toasts.get(id);
    if (!live || live.held === held) return;
    live.held = held;
    if (held) this.pause(live);
    else if (live.started === undefined && live.timer === undefined && this.deps.popups() !== undefined) this.countDown(live);
  }

  /**
   * Toasts still showing, for a popup page that has just (re)loaded; a countdown not yet started or held starts now. A
   * fresh page holds nothing and never releases a hold the page before it reported.
   */
  pendingToasts(): readonly OverlayToast[] {
    return [...this.toasts.values()].map((live) => {
      live.held = false;
      this.countDown(live);
      return this.snapshot(live);
    });
  }

  /** The main window opened: toasts that waited for it go to the popup window, whose page replays them once it loads. */
  windowOpened(): void {
    if (this.toasts.size === 0) return;
    const sink = this.deps.popups();
    if (sink) for (const toast of this.pendingToasts()) sink.show(toast);
  }

  /** A row of the center: marks it read and runs its action. */
  open(entryId: string): void {
    const entry = this.entries.find((candidate) => candidate.id === entryId);
    if (entry) this.act(entry.id, entry.action);
  }

  /** The user is looking at this chat (selected, window focused): its entries are read (D52). */
  chatViewed(chat: ChatKey): void {
    let changed = false;
    for (const entry of this.entries) {
      const ref = chatOfAction(entry.action);
      if (!ref || !sameChat(ref, chat)) continue;
      this.stopFlash(entry.id);
      if (entry.read && entry.seen) continue;
      entry.read = true;
      entry.seen = true;
      changed = true;
    }
    if (changed) this.deps.changed();
  }

  /** The window gained focus: the taskbar button stops flashing; the popups stay until their lives end or are answered. */
  windowFocused(): void {
    this.stopFlashing();
  }

  /** The center opened: every entry counts as seen, so the bell's badge clears. */
  markSeen(): void {
    if (this.entries.every((entry) => entry.seen)) return;
    for (const entry of this.entries) entry.seen = true;
    this.deps.changed();
  }

  clear(): void {
    if (this.entries.length === 0) return;
    this.entries = [];
    this.deps.changed();
  }

  async setDoNotDisturb(on: boolean): Promise<void> {
    if (this.deps.doNotDisturb() !== on) await this.deps.setDoNotDisturb(on);
    this.popupPolicyChanged();
  }

  /**
   * Do not disturb or Notify me changed. While either silences, the seven kinds' toasts and the flash go and the entries
   * keep collecting; notices stay.
   */
  popupPolicyChanged(): void {
    if (this.silenced()) {
      for (const live of [...this.toasts.values()]) {
        if (live.body.kind === 'notice') continue;
        this.finish(live, undefined);
        this.hide(live);
      }
      this.stopFlashing();
    }
    this.deps.changed();
  }

  state(): NotificationCenterState {
    return {
      entries: this.entries.map((entry): NotificationEntry => ({ id: entry.id, at: entry.at, read: entry.read, body: entry.body })),
      doNotDisturb: this.deps.doNotDisturb(),
      popupsOff: !this.deps.popupsEnabled(),
    };
  }

  bell(): NotificationBell {
    return {
      unseen: this.entries.filter((entry) => !entry.seen).length,
      doNotDisturb: this.deps.doNotDisturb(),
      popupsOff: !this.deps.popupsEnabled(),
      attention: this.attention,
    };
  }

  dispose(): void {
    for (const live of [...this.toasts.values()]) this.finish(live, undefined);
  }

  // Notices always pop up; the seven kinds pop up, and anything rings or flashes, only while Do not disturb is off and
  // pop-ups are on. An entry about the chat the user is looking at arrives read.
  private raise(body: NotificationBody, action: EntryAction, options: { readonly id?: string; readonly quiet?: boolean; readonly answer?: (action: string | undefined) => void } = {}): void {
    const viewed = this.deps.viewedChat();
    const chat = chatOfAction(action);
    const read = viewed !== undefined && chat !== undefined && sameChat(chat, viewed);
    const entry: Entry = { id: options.id ?? randomUUID(), at: this.now(), read, seen: read, body, action };
    this.entries = [entry, ...this.entries].slice(0, MAX_ENTRIES);
    const allowed = !this.silenced();
    const toast = !options.quiet && (body.kind === 'notice' || allowed);
    if (toast) {
      const lifeMs = body.kind === 'notice'
        ? (body.actions.length > 0 ? NOTICE_LIFE_MS.withActions : NOTICE_LIFE_MS[body.severity])
        : KIND_LIFE_MS[body.kind];
      this.present({
        id: entry.id,
        at: entry.at,
        lifeMs,
        body,
        action,
        answer: options.answer,
        remaining: lifeMs,
        started: undefined,
        timer: undefined,
        held: false,
      });
      if (ATTENTION_KINDS.has(body.kind)) this.attention++;
    } else {
      options.answer?.(undefined);
    }
    if (toast && allowed) this.deps.chime(chimeTone(body));
    // Only an entry that waits on the user flashes, and only while the window is unfocused; the others count and pop up.
    if (toast && allowed && ATTENTION_KINDS.has(body.kind) && !this.deps.windowFocused()) {
      this.flashing.add(entry.id);
      this.deps.flash(true);
    }
    this.deps.changed();
  }

  private silenced(): boolean {
    return this.deps.doNotDisturb() || !this.deps.popupsEnabled();
  }

  private stopFlash(entryId: string): void {
    if (!this.flashing.delete(entryId) || this.flashing.size > 0) return;
    this.deps.flash(false);
  }

  private stopFlashing(): void {
    if (this.flashing.size === 0) return;
    this.flashing.clear();
    this.deps.flash(false);
  }

  // A toast waits in main until the popup page can show it; its countdown starts once it does.
  private present(live: LiveToast): void {
    this.toasts.set(live.id, live);
    const sink = this.deps.popups();
    if (!sink) return;
    this.countDown(live);
    sink.show(this.snapshot(live));
  }

  private hide(live: LiveToast): void {
    this.deps.popups()?.dismiss(live.id);
  }

  private countDown(live: LiveToast): void {
    if (live.timer !== undefined) return;
    live.started = this.now();
    live.timer = setTimeout(() => {
      this.finish(live, undefined);
      this.hide(live);
    }, live.remaining);
  }

  private pause(live: LiveToast): void {
    if (live.timer === undefined || live.started === undefined) return;
    clearTimeout(live.timer);
    live.remaining = Math.max(0, live.remaining - (this.now() - live.started));
    live.timer = undefined;
    live.started = undefined;
  }

  private snapshot(live: LiveToast): OverlayToast {
    const elapsed = live.started === undefined ? 0 : this.now() - live.started;
    return { id: live.id, at: live.at, lifeMs: live.lifeMs, remainingMs: Math.max(0, live.remaining - elapsed), body: live.body };
  }

  private finish(live: LiveToast, action: string | undefined): void {
    if (this.toasts.get(live.id) !== live) return;
    this.toasts.delete(live.id);
    clearTimeout(live.timer);
    live.timer = undefined;
    live.answer?.(action);
  }

  // The prompt behind an entry resolved: its popup and flash go, the entry stays.
  private withdraw(entryId: string): void {
    const live = this.toasts.get(entryId);
    if (live) {
      this.finish(live, undefined);
      this.hide(live);
    }
    this.stopFlash(entryId);
  }

  // The entry was chosen outside its toast, which then goes.
  private act(entryId: string, action: EntryAction): void {
    const live = this.toasts.get(entryId);
    if (live) {
      this.finish(live, undefined);
      this.hide(live);
    }
    this.choose(entryId, action);
  }

  private choose(entryId: string, action: EntryAction): void {
    this.stopFlash(entryId);
    const entry = this.entries.find((candidate) => candidate.id === entryId);
    if (entry && !(entry.read && entry.seen)) {
      entry.read = true;
      entry.seen = true;
      this.deps.changed();
    }
    this.deps.run(action);
  }
}

// The overlay host as the center's channels use it.
export interface CenterOverlay {
  handle(channel: string, handler: (...args: unknown[]) => unknown): void;
  isOpen(kind: OverlayRequest['kind']): boolean;
}

/** The bell's center channels act only while it is open, so no other overlay state can clear the log or change Do not disturb. */
export function handleCenterChannels(overlay: CenterOverlay, center: NotificationCenter): void {
  const whileOpen = <A extends unknown[], R>(act: (...args: A) => R) => (...args: A): R => {
    if (!overlay.isOpen('notifications')) throw new Error('The notification center is not open');
    return act(...args);
  };
  overlay.handle(OVERLAY_CHANNELS.notificationsGet, whileOpen(() => center.state()));
  overlay.handle(OVERLAY_CHANNELS.notificationsClear, whileOpen(() => center.clear()));
  overlay.handle(OVERLAY_CHANNELS.notificationsDnd, whileOpen((on: unknown) => {
    if (typeof on !== 'boolean') throw new Error('Malformed Do not disturb value');
    return center.setDoNotDisturb(on);
  }));
}
