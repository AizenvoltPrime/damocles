import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatActivity, PendingPrompt } from '../../../core/pi-session/session-state';
import type { UsageThresholdCrossing } from '../../../core/pi-session/usage-thresholds';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { OVERLAY_CHANNELS, type OverlayToast } from '../../preload/overlay-channels';
import { KIND_LIFE_MS, TOAST_OPEN_ACTION } from '../../preload/notifications';
import {
  handleCenterChannels,
  MAX_ENTRIES,
  NOTICE_LIFE_MS,
  NotificationCenter,
  runEntryAction,
  type ChatKey,
  type ChatRef,
  type EntryAction,
  type EntryActionDeps,
  type NotificationCenterDeps,
} from '../notification-center';

const CHAT: ChatRef = { panelId: 'view-1', sessionId: 's1', project: { key: 'acme', name: 'acme' }, title: 'Fix login' };

// What the popup window's page was sent; it is the only place a toast shows.
let shown: OverlayToast[];
let dismissed: string[];
let popupReady: boolean;
let chimes: string[];
let ran: EntryAction[];
let dnd: boolean;
let popups: boolean;
let focused: boolean;
let selected: string | undefined;
let viewed: ChatKey | undefined;
let flashes: boolean[];
let changes: number;

function center(overrides: Partial<NotificationCenterDeps> = {}): NotificationCenter {
  return new NotificationCenter({
    doNotDisturb: () => dnd,
    setDoNotDisturb: async (on) => {
      dnd = on;
    },
    popupsEnabled: () => popups,
    windowFocused: () => focused,
    chatSelected: (corePanelId) => corePanelId === selected,
    viewedChat: () => viewed,
    flash: (on) => flashes.push(on),
    describeChat: async () => CHAT,
    popups: () => (popupReady ? { show: (toast) => shown.push(toast), dismiss: (id) => dismissed.push(id) } : undefined),
    chime: (tone) => chimes.push(tone),
    usageWarningShown: () => false,
    recordUsageWarning: () => undefined,
    run: (action) => ran.push(action),
    changed: () => {
      changes++;
    },
    log: () => undefined,
    ...overrides,
  });
}

function prompt(id: string, kind: PendingPrompt['kind'], owner: PendingPrompt['owner'] = { kind: 'main' }, summary?: string): PendingPrompt {
  return { id, kind, owner, ...(summary ? { summary } : {}) };
}

function activity(...prompts: PendingPrompt[]): ChatActivity {
  return {
    state: prompts.length > 0 ? 'requires_action' : 'running',
    pendingKinds: [...new Set(prompts.map((p) => p.kind))].sort(),
    pendingPrompts: prompts,
    background: false,
  };
}

// describeChat resolves on a microtask; entries for prompts and outcomes land after it.
const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  shown = [];
  dismissed = [];
  popupReady = true;
  chimes = [];
  ran = [];
  dnd = false;
  popups = true;
  focused = true;
  selected = undefined;
  viewed = undefined;
  flashes = [];
  changes = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('notification center: prompts', () => {
  it('raises one entry per new pending prompt id, a team prompt as team and an input prompt as a question', async () => {
    const notifications = center();
    notifications.activity('host-1', activity(prompt('t1', 'approval', { kind: 'main' }, 'edit src/a.ts (+7 lines)')));
    notifications.activity('host-1', activity(prompt('t1', 'approval', { kind: 'main' }, 'edit src/a.ts (+7 lines)')));
    await settle();
    notifications.activity('host-1', activity(
      prompt('t1', 'approval', { kind: 'main' }, 'edit src/a.ts (+7 lines)'),
      prompt('t2', 'approval', { kind: 'team', teamId: 'team-9', agentId: 'agent-1', agentName: 'Mira' }),
      prompt('ui:3', 'input'),
    ));
    await settle();

    expect(notifications.state().entries.map((entry) => entry.body.kind)).toEqual(['question', 'team', 'approval']);
    expect(notifications.state().entries.at(-1)!.body).toEqual({ kind: 'approval', chat: { project: CHAT.project, title: 'Fix login' }, summary: 'edit src/a.ts (+7 lines)' });
    expect(shown.map((toast) => toast.body.kind)).toEqual(['approval', 'team', 'question']);
    expect(shown[0]).toMatchObject({ lifeMs: KIND_LIFE_MS.approval, remainingMs: KIND_LIFE_MS.approval });

    notifications.resolveToast(shown[1]!.id, TOAST_OPEN_ACTION);
    notifications.resolveToast(shown[2]!.id, TOAST_OPEN_ACTION);
    expect(ran).toEqual([{ kind: 'team', chat: CHAT, teamId: 'team-9' }, { kind: 'attention', chat: CHAT, attention: 'question' }]);
  });

  it('withdraws a resolved prompt\'s popup and keeps its entry', async () => {
    const notifications = center();
    notifications.activity('host-1', activity(prompt('p1', 'plan')));
    await settle();
    expect(shown).toHaveLength(1);
    notifications.activity('host-1', activity());
    expect(dismissed).toEqual([shown[0]!.id]);
    expect(notifications.state().entries).toHaveLength(1);
    // It never notifies again for the same prompt.
    notifications.activity('host-1', activity(prompt('p1', 'plan')));
    await settle();
    expect(notifications.state().entries).toHaveLength(1);
  });

  it('logs a prompt answered before main described its chat without a toast', async () => {
    const notifications = center();
    notifications.activity('host-1', activity(prompt('p1', 'question', { kind: 'main' }, 'Retry?')));
    notifications.activity('host-1', activity());
    await settle();
    expect(notifications.state().entries).toHaveLength(1);
    expect(shown).toEqual([]);
  });

  it('withdraws a closed chat\'s prompt popups and their flash, keeps their entries and forgets the chat\'s prompt ids', async () => {
    focused = false;
    const notifications = center();
    notifications.activity('host-1', activity(prompt('a', 'approval')));
    notifications.activity('host-2', activity(prompt('b', 'question')));
    await settle();
    expect(flashes).toEqual([true, true]);

    notifications.panelClosed('host-1');
    expect(dismissed).toEqual([shown[0]!.id]);
    // The other chat's prompt still waits, so the button keeps flashing.
    expect(flashes).toEqual([true, true]);
    notifications.panelClosed('host-2');
    expect(dismissed).toEqual([shown[0]!.id, shown[1]!.id]);
    expect(flashes).toEqual([true, true, false]);
    expect(notifications.state().entries).toHaveLength(2);

    // Nothing of a closed core panel is kept; its id is never reused, so a report under it would be a new prompt.
    notifications.activity('host-1', activity(prompt('a', 'approval')));
    await settle();
    expect(notifications.state().entries).toHaveLength(3);
  });
});

describe('notification center: settled turns and usage', () => {
  it('raises done only for a chat that is not selected or a window that is not focused', async () => {
    const notifications = center();
    selected = 'host-1';
    notifications.turnSettled('host-1', { kind: 'completed', durationMs: 1000 });
    await settle();
    expect(notifications.state().entries).toEqual([]);

    focused = false;
    notifications.turnSettled('host-1', { kind: 'completed' });
    await settle();
    focused = true;
    notifications.turnSettled('host-2', { kind: 'completed', durationMs: 252_000 });
    await settle();
    expect(notifications.state().entries.map((entry) => entry.body)).toEqual([
      { kind: 'done', chat: { project: CHAT.project, title: 'Fix login' }, durationMs: 252_000 },
      { kind: 'done', chat: { project: CHAT.project, title: 'Fix login' } },
    ]);
    expect(shown[0]).toMatchObject({ lifeMs: KIND_LIFE_MS.done });
  });

  it('maps an error and a rate limit to error, a budget stop to limit, and ignores a cancel', async () => {
    const notifications = center();
    selected = 'host-1';
    notifications.turnSettled('host-1', { kind: 'error', message: 'Overloaded' });
    notifications.turnSettled('host-1', { kind: 'rateLimit', resetsAt: 1_700_000_000_000 });
    notifications.turnSettled('host-1', { kind: 'budget' });
    notifications.turnSettled('host-1', { kind: 'cancelled' });
    await settle();
    expect(notifications.state().entries.map((entry) => entry.body).reverse()).toEqual([
      { kind: 'error', chat: { project: CHAT.project, title: 'Fix login' }, reason: 'error', message: 'Overloaded' },
      { kind: 'error', chat: { project: CHAT.project, title: 'Fix login' }, reason: 'rateLimit', resetsAt: 1_700_000_000_000 },
      { kind: 'limit', chat: { project: CHAT.project, title: 'Fix login' }, reason: 'budget' },
    ]);
    expect(shown.map((toast) => toast.lifeMs)).toEqual([KIND_LIFE_MS.error, KIND_LIFE_MS.error, KIND_LIFE_MS.limit]);
    notifications.resolveToast(shown[2]!.id, TOAST_OPEN_ACTION);
    expect(ran).toEqual([{ kind: 'usage', chat: CHAT }]);
  });

  it('names the full window a rate limit waits on and its reset, and no window when core found none (D55)', async () => {
    const notifications = center();
    notifications.turnSettled('host-1', { kind: 'rateLimit', windowId: 'seven_day', windowLabel: '  Weekly  ', resetsAt: 1_700_000_000_000 });
    notifications.turnSettled('host-1', { kind: 'rateLimit', windowId: 'five_hour', windowLabel: ' ' });
    await settle();
    expect(notifications.state().entries.map((entry) => entry.body).reverse()).toEqual([
      { kind: 'error', chat: { project: CHAT.project, title: 'Fix login' }, reason: 'rateLimit', windowLabel: 'Weekly', resetsAt: 1_700_000_000_000 },
      { kind: 'error', chat: { project: CHAT.project, title: 'Fix login' }, reason: 'rateLimit' },
    ]);
  });

  it('skips a usage warning shown before and records each one it accepts, even while its popup is silenced (D54)', () => {
    const recorded: UsageThresholdCrossing[] = [];
    const notifications = center({
      usageWarningShown: (crossing) => crossing.windowId === 'five_hour',
      recordUsageWarning: (crossing) => recorded.push(crossing),
    });
    const fiveHour: UsageThresholdCrossing = { provider: 'anthropic', windowId: 'five_hour', windowLabel: 'Session (5hr)', threshold: 80, utilization: 82, resetsAt: 1_700_000_000_000 };
    const weekly: UsageThresholdCrossing = { provider: 'anthropic', windowId: 'seven_day', windowLabel: 'Weekly', threshold: 95, utilization: 96, resetsAt: 1_700_500_000_000 };
    notifications.usageThreshold(fiveHour);
    expect(notifications.state().entries).toEqual([]);
    expect(shown).toEqual([]);
    expect(recorded).toEqual([]);

    dnd = true;
    notifications.usageThreshold(weekly);
    expect(notifications.state().entries.map((entry) => entry.body)).toEqual([expect.objectContaining({ kind: 'limit', windowLabel: 'Weekly' })]);
    expect(shown).toEqual([]);
    expect(recorded).toEqual([weekly]);
  });

  it('raises a usage crossing as limit for the selected chat\'s usage', () => {
    const notifications = center();
    notifications.usageThreshold({ provider: 'anthropic', windowId: 'five_hour', windowLabel: '5-hour window', threshold: 80, utilization: 85.4, resetsAt: 1_700_000_000_000, planName: 'Max 20x' });
    expect(notifications.state().entries[0]!.body).toEqual({ kind: 'limit', reason: 'usage', windowLabel: '5-hour window', threshold: 80, utilization: 85, resetsAt: 1_700_000_000_000, planName: 'Max 20x' });
    notifications.open(notifications.state().entries[0]!.id);
    expect(ran).toEqual([{ kind: 'usage' }]);
  });
});

describe('notification center: lives, overflow and the log', () => {
  it('times each kind out after its life, keeping the entry', () => {
    const notifications = center();
    notifications.usageThreshold({ provider: 'anthropic', windowId: 'seven_day', windowLabel: 'Weekly', threshold: 95, utilization: 96 });
    vi.advanceTimersByTime(KIND_LIFE_MS.limit - 1);
    expect(dismissed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(dismissed).toEqual([shown[0]!.id]);
    expect(notifications.state().entries).toHaveLength(1);
  });

  it('pauses a held toast\'s life and resumes it with what was left', () => {
    const notifications = center();
    notifications.usageThreshold({ provider: 'anthropic', windowId: 'seven_day', windowLabel: 'Weekly', threshold: 80, utilization: 81 });
    const id = shown[0]!.id;
    vi.advanceTimersByTime(4000);
    notifications.holdToast(id, true);
    vi.advanceTimersByTime(60_000);
    expect(dismissed).toEqual([]);
    notifications.holdToast(id, false);
    vi.advanceTimersByTime(KIND_LIFE_MS.limit - 4000 - 1);
    expect(dismissed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(dismissed).toEqual([id]);
  });

  it('restarts a held toast\'s life when its popup page reloads, since the new page holds nothing', () => {
    const notifications = center();
    notifications.usageThreshold({ provider: 'anthropic', windowId: 'seven_day', windowLabel: 'Weekly', threshold: 80, utilization: 81 });
    const id = shown[0]!.id;
    vi.advanceTimersByTime(4000);
    notifications.holdToast(id, true);
    vi.advanceTimersByTime(60_000);
    // The page crashed or reloaded under the pointer and replays what still shows.
    expect(notifications.pendingToasts()).toEqual([expect.objectContaining({ id, remainingMs: KIND_LIFE_MS.limit - 4000 })]);
    vi.advanceTimersByTime(KIND_LIFE_MS.limit - 4000 - 1);
    expect(dismissed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(dismissed).toEqual([id]);
  });

  it(`keeps the newest ${MAX_ENTRIES} entries of the run`, () => {
    const notifications = center();
    for (let index = 0; index <= MAX_ENTRIES; index++) notifications.usageThreshold({ provider: 'openai', windowId: `w${index}`, windowLabel: `w${index}`, threshold: 80, utilization: 80 });
    const entries = notifications.state().entries;
    expect(entries).toHaveLength(MAX_ENTRIES);
    expect(entries[0]!.body).toMatchObject({ windowLabel: `w${MAX_ENTRIES}` });
    expect(entries.at(-1)!.body).toMatchObject({ windowLabel: 'w1' });
  });

  it('counts unseen entries for the bell until the center opens, and marks a chosen entry read', () => {
    const notifications = center();
    notifications.usageThreshold({ provider: 'openai', windowId: 'codex_secondary', windowLabel: 'Weekly', threshold: 80, utilization: 80 });
    notifications.usageThreshold({ provider: 'openai', windowId: 'codex_secondary', windowLabel: 'Weekly', threshold: 95, utilization: 95 });
    expect(notifications.bell()).toMatchObject({ unseen: 2 });
    notifications.markSeen();
    expect(notifications.bell()).toMatchObject({ unseen: 0 });
    expect(notifications.state().entries.map((entry) => entry.read)).toEqual([false, false]);
    notifications.open(notifications.state().entries[1]!.id);
    expect(notifications.state().entries.map((entry) => entry.read)).toEqual([false, true]);
    // Opening from the center withdraws the entry's toast.
    expect(dismissed).toEqual([shown[0]!.id]);
    notifications.clear();
    expect(notifications.state().entries).toEqual([]);
    expect(changes).toBeGreaterThan(0);
  });

  it('rings the bell only for an entry that asks for the user while pop-ups are on', async () => {
    const notifications = center();
    notifications.activity('host-1', activity(prompt('a', 'approval')));
    await settle();
    notifications.turnSettled('host-1', { kind: 'error' });
    await settle();
    expect(notifications.bell().attention).toBe(1);
    dnd = true;
    notifications.activity('host-1', activity(prompt('b', 'question')));
    await settle();
    expect(notifications.bell().attention).toBe(1);
  });
});

describe('notification center: Do not disturb and the popup policy', () => {
  it('silences the seven kinds\' popups under Do not disturb, and still collects entries', async () => {
    dnd = true;
    focused = false;
    const notifications = center();
    notifications.activity('host-1', activity(prompt('a', 'approval')));
    notifications.turnSettled('host-2', { kind: 'completed' });
    await settle();
    expect(notifications.state().entries).toHaveLength(2);
    expect(shown).toEqual([]);
    // A core notice still pops up, without a sound; it is the answer to something the user did.
    void notifications.notice('info', 'Saved', []);
    expect(shown.map((toast) => toast.body.kind)).toEqual(['notice']);
    expect(chimes).toEqual([]);
  });

  it('treats Notify me off like Do not disturb for the seven kinds', async () => {
    popups = false;
    focused = false;
    const notifications = center();
    notifications.activity('host-1', activity(prompt('a', 'approval')));
    await settle();
    expect(shown).toEqual([]);
    expect(notifications.state()).toMatchObject({ popupsOff: true });
  });

  it('drops the kinds\' toasts and the flash, not a notice\'s, when Notify me turns off, as Do not disturb does', async () => {
    focused = false;
    const notifications = center();
    notifications.activity('host-1', activity(prompt('a', 'approval')));
    await settle();
    void notifications.notice('warning', 'Reload?', ['Reload']);
    popups = false;
    notifications.popupPolicyChanged();
    expect(dismissed).toEqual([shown[0]!.id]);
    expect(flashes).toEqual([true, false]);
    expect(notifications.pendingToasts().map((toast) => toast.body.kind)).toEqual(['notice']);
    expect(notifications.bell()).toMatchObject({ popupsOff: true });
  });

  it('drops the kinds\' toasts, not a notice\'s, when Do not disturb turns on', async () => {
    const notifications = center();
    notifications.activity('host-1', activity(prompt('a', 'approval')));
    await settle();
    void notifications.notice('warning', 'Reload?', ['Reload']);
    await notifications.setDoNotDisturb(true);
    expect(dnd).toBe(true);
    expect(dismissed).toEqual([shown[0]!.id]);
    expect(notifications.pendingToasts().map((toast) => toast.body.kind)).toEqual(['notice']);
  });

  it('shows every toast in the popup window while the main window is focused; its action runs the entry and reads it', async () => {
    const notifications = center();
    notifications.activity('host-1', activity(prompt('a', 'approval', { kind: 'main' }, 'run `npm test`')));
    notifications.turnSettled('host-2', { kind: 'error', message: 'Overloaded' });
    void notifications.notice('info', 'Saved', []);
    await settle();
    expect(shown.map((toast) => toast.body.kind)).toEqual(['notice', 'approval', 'error']);
    const approval = shown.find((toast) => toast.body.kind === 'approval')!;
    expect(approval).toMatchObject({ lifeMs: KIND_LIFE_MS.approval, body: { kind: 'approval', summary: 'run `npm test`' } });
    notifications.resolveToast(approval.id, TOAST_OPEN_ACTION);
    expect(ran).toEqual([{ kind: 'attention', chat: CHAT, attention: 'approval' }]);
    // The popup page dropped the card it answered; main sends it nothing more.
    expect(dismissed).toEqual([]);
    expect(notifications.state().entries.find((entry) => entry.id === approval.id)).toMatchObject({ read: true });
  });

  it('plays every popup\'s sound, focused or not, in the tone of what it says, and none under Do not disturb', async () => {
    const notifications = center();
    notifications.activity('host-1', activity(prompt('a', 'approval')));
    await settle();
    expect(chimes).toEqual(['attention']);
    focused = false;
    notifications.activity('host-1', activity(prompt('a', 'approval'), prompt('b', 'question')));
    notifications.turnSettled('host-2', { kind: 'completed' });
    notifications.turnSettled('host-2', { kind: 'budget' });
    void notifications.notice('info', 'Saved', []);
    void notifications.notice('error', 'Failed', []);
    await settle();
    expect(chimes).toEqual(['attention', 'done', 'warning', 'attention', 'done', 'warning']);
    dnd = true;
    notifications.turnSettled('host-2', { kind: 'completed' });
    void notifications.notice('error', 'Failed again', []);
    await settle();
    expect(chimes).toHaveLength(6);
  });

  it('leaves a showing popup in place when the main window gains focus, until its life ends', async () => {
    focused = false;
    const notifications = center();
    notifications.turnSettled('host-2', { kind: 'completed' });
    await settle();
    expect(shown.map((toast) => toast.body.kind)).toEqual(['done']);
    focused = true;
    notifications.windowFocused();
    notifications.chatViewed({ panelId: 'view-1', sessionId: 's1' });
    expect(dismissed).toEqual([]);
    expect(notifications.pendingToasts().map((toast) => toast.id)).toEqual([shown[0]!.id]);
    vi.advanceTimersByTime(KIND_LIFE_MS.done);
    expect(dismissed).toEqual([shown[0]!.id]);
  });

  it('keeps a toast raised while no main window exists waiting, and sends it to the popup window once the window opens', async () => {
    popupReady = false;
    const notifications = center();
    const answer = notifications.notice('info', 'Damocles 9.9.9 is ready.', ['Restart Now']);
    let settled = false;
    void answer.then(() => {
      settled = true;
    });
    notifications.windowOpened();
    vi.advanceTimersByTime(NOTICE_LIFE_MS.withActions * 2);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(shown).toEqual([]);
    popupReady = true;
    notifications.windowOpened();
    expect(shown).toEqual([expect.objectContaining({ body: expect.objectContaining({ kind: 'notice' }), remainingMs: NOTICE_LIFE_MS.withActions })]);
    notifications.resolveToast(shown[0]!.id, 'Restart Now');
    await expect(answer).resolves.toBe('Restart Now');
  });

  it('replays the toasts still showing to a popup page that loads, and starts their lives then', async () => {
    popupReady = false;
    const notifications = center();
    notifications.turnSettled('host-2', { kind: 'completed' });
    notifications.activity('host-1', activity(prompt('a', 'question')));
    await settle();
    expect(shown).toEqual([]);
    vi.advanceTimersByTime(KIND_LIFE_MS.question * 2);
    popupReady = true;
    expect(notifications.pendingToasts().map((toast) => [toast.body.kind, toast.remainingMs])).toEqual([['done', KIND_LIFE_MS.done], ['question', KIND_LIFE_MS.question]]);
  });
});

describe('notification center: read rules, flash (D52)', () => {
  it('reads the entries of a chat once it is viewed, and leaves other chats\' and usage entries', async () => {
    focused = false;
    const other: ChatRef = { ...CHAT, panelId: 'view-2', sessionId: 's2', title: 'Other' };
    const notifications = center({ describeChat: async (id) => (id === 'host-2' ? other : CHAT) });
    notifications.activity('host-1', activity(prompt('a', 'approval')));
    notifications.turnSettled('host-2', { kind: 'completed' });
    notifications.usageThreshold({ provider: 'openai', windowId: 'codex_secondary', windowLabel: 'Weekly', threshold: 80, utilization: 80 });
    await settle();
    expect(notifications.bell().unseen).toBe(3);

    // A reloaded chat has a new panel id and keeps its session id.
    notifications.chatViewed({ panelId: 'view-9', sessionId: 's1' });
    expect(notifications.bell().unseen).toBe(2);
    const approval = notifications.state().entries.find((entry) => entry.body.kind === 'approval')!;
    expect(approval.read).toBe(true);
  });

  it('raises an entry about the chat the user is looking at as read, and one about another chat or while unfocused as unread', async () => {
    const notifications = center();
    viewed = { panelId: 'view-1' };
    notifications.activity('host-1', activity(prompt('a', 'question')));
    await settle();
    expect(notifications.state().entries[0]!.read).toBe(true);
    expect(notifications.bell().unseen).toBe(0);
    viewed = { panelId: 'view-2', sessionId: 's2' };
    notifications.activity('host-1', activity(prompt('a', 'question'), prompt('b', 'question')));
    await settle();
    viewed = undefined;
    notifications.activity('host-1', activity(prompt('a', 'question'), prompt('b', 'question'), prompt('c', 'question')));
    await settle();
    expect(notifications.state().entries.map((entry) => entry.read)).toEqual([false, false, true]);
    expect(notifications.bell().unseen).toBe(2);
  });

  it('flashes only for an entry that waits on the user while the window is unfocused, and stops on focus', async () => {
    const notifications = center();
    notifications.activity('host-1', activity(prompt('a', 'approval')));
    await settle();
    expect(flashes).toEqual([]);
    focused = false;
    notifications.turnSettled('host-2', { kind: 'completed' });
    notifications.turnSettled('host-2', { kind: 'error' });
    notifications.usageThreshold({ provider: 'openai', windowId: 'codex_secondary', windowLabel: 'Weekly', threshold: 80, utilization: 80 });
    void notifications.notice('error', 'Failed', []);
    await settle();
    expect(flashes).toEqual([]);
    notifications.activity('host-1', activity(prompt('a', 'approval'), prompt('p', 'plan'), prompt('q', 'input'), prompt('t', 'approval', { kind: 'team', teamId: 'x', agentId: 'agent-1' })));
    await settle();
    expect(flashes).toEqual([true, true, true]);
    notifications.windowFocused();
    expect(flashes.at(-1)).toBe(false);
  });

  it('has nothing to stop when the window gains focus while nothing flashes', () => {
    const notifications = center();
    notifications.windowFocused();
    expect(flashes).toEqual([]);
  });

  it('stops the flash once every prompt that flashed is answered', async () => {
    focused = false;
    const notifications = center();
    notifications.activity('host-1', activity(prompt('a', 'approval'), prompt('b', 'question')));
    await settle();
    notifications.activity('host-1', activity(prompt('b', 'question')));
    expect(flashes).toEqual([true, true]);
    notifications.activity('host-1', activity());
    expect(flashes).toEqual([true, true, false]);
  });

  it('neither pops up nor flashes under Do not disturb or Notify me off, and still counts', async () => {
    focused = false;
    dnd = true;
    const notifications = center();
    notifications.activity('host-1', activity(prompt('a', 'approval')));
    await settle();
    dnd = false;
    popups = false;
    notifications.activity('host-1', activity(prompt('a', 'approval'), prompt('b', 'question')));
    await settle();
    expect(shown).toEqual([]);
    expect(flashes).toEqual([]);
    expect(notifications.bell().unseen).toBe(2);
  });

  it('stops a flash when Do not disturb turns on', async () => {
    focused = false;
    const notifications = center();
    notifications.activity('host-1', activity(prompt('a', 'approval')));
    await settle();
    await notifications.setDoNotDisturb(true);
    expect(flashes).toEqual([true, false]);
  });
});

describe('notification center: core notices', () => {
  it('resolves a notice with the chosen action, undefined on dismissal, and ignores an action it never offered', async () => {
    const notifications = center();
    const answer = notifications.notice('error', 'Failed', ['Retry']);
    notifications.resolveToast(shown[0]!.id, 'Delete everything');
    notifications.resolveToast(shown[0]!.id, TOAST_OPEN_ACTION);
    expect(notifications.pendingToasts()).toHaveLength(1);
    notifications.resolveToast(shown[0]!.id, 'Retry');
    await expect(answer).resolves.toBe('Retry');
    const dismissedAnswer = notifications.notice('info', 'Saved', []);
    notifications.resolveToast(shown[1]!.id, undefined);
    await expect(dismissedAnswer).resolves.toBeUndefined();
    expect(notifications.state().entries.map((entry) => entry.body.kind)).toEqual(['notice', 'notice']);
  });

  it('times a notice out in main, longer when it asks for a choice', async () => {
    const notifications = center();
    const plain = notifications.notice('info', 'Saved', []);
    const asking = notifications.notice('info', 'Open?', ['Open']);
    vi.advanceTimersByTime(NOTICE_LIFE_MS.info);
    await expect(plain).resolves.toBeUndefined();
    expect(dismissed).toEqual([shown[0]!.id]);
    vi.advanceTimersByTime(NOTICE_LIFE_MS.withActions - NOTICE_LIFE_MS.info);
    await expect(asking).resolves.toBeUndefined();
  });

  it('holds a toast raised before the popup page can show it, and starts its life once it does', async () => {
    popupReady = false;
    const notifications = center();
    const answer = notifications.notice('warning', 'Could not decrypt 1 saved secret', []);
    let settled = false;
    void answer.then(() => {
      settled = true;
    });
    vi.advanceTimersByTime(NOTICE_LIFE_MS.warning * 2);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(notifications.pendingToasts()).toEqual([expect.objectContaining({ remainingMs: NOTICE_LIFE_MS.warning })]);
    vi.advanceTimersByTime(NOTICE_LIFE_MS.warning);
    await expect(answer).resolves.toBeUndefined();
  });
});

describe('notification center channels', () => {
  it('read the entries, clear them and set Do not disturb only while the center is open', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    let open = false;
    const notifications = center();
    handleCenterChannels({ handle: (channel, handler) => handlers.set(channel, handler), isOpen: (kind) => open && kind === 'notifications' }, notifications);
    const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => handlers.get(channel)!(...args);
    void notifications.notice('info', 'Saved', []);

    await expect(invoke(OVERLAY_CHANNELS.notificationsGet)).rejects.toThrow('The notification center is not open');
    await expect(invoke(OVERLAY_CHANNELS.notificationsClear)).rejects.toThrow('The notification center is not open');
    await expect(invoke(OVERLAY_CHANNELS.notificationsDnd, true)).rejects.toThrow('The notification center is not open');
    expect(dnd).toBe(false);
    expect(notifications.state().entries).toHaveLength(1);

    open = true;
    await expect(invoke(OVERLAY_CHANNELS.notificationsGet)).resolves.toMatchObject({ entries: [expect.objectContaining({ body: expect.objectContaining({ message: 'Saved' }) })] });
    await expect(invoke(OVERLAY_CHANNELS.notificationsDnd, 'on')).rejects.toThrow('Malformed Do not disturb value');
    await invoke(OVERLAY_CHANNELS.notificationsDnd, true);
    expect(dnd).toBe(true);
    await invoke(OVERLAY_CHANNELS.notificationsClear);
    expect(notifications.state().entries).toEqual([]);
  });
});

describe('notification actions', () => {
  // Chat views by panel id; the user's selection moves through `selection`.
  let selection: string | undefined;
  let posts: Array<[string, ExtensionToWebviewMessage]>;

  function actionDeps(overrides: Partial<EntryActionDeps<string>> = {}): EntryActionDeps<string> {
    return {
      selected: () => selection,
      select: async (chat) => {
        selection = chat.panelId;
        return chat.panelId;
      },
      whenReady: async () => true,
      post: (panel, message) => posts.push([panel, message]),
      ...overrides,
    };
  }

  beforeEach(() => {
    selection = 'view-2';
    posts = [];
  });

  it('selects the entry\'s chat and posts what its kind asks for to that chat once its view is ready', async () => {
    await runEntryAction({ kind: 'attention', chat: CHAT, attention: 'approval' }, actionDeps());
    await runEntryAction({ kind: 'team', chat: CHAT, teamId: 'team-9' }, actionDeps());
    await runEntryAction({ kind: 'usage', chat: CHAT }, actionDeps());
    expect(posts).toEqual([
      ['view-1', { type: 'focusAttention', kind: 'approval' }],
      ['view-1', { type: 'openTeamOverlay', teamId: 'team-9' }],
      ['view-1', { type: 'runChatCommand', command: 'subscriptionUsage' }],
    ]);
    // A finished chat's action only selects it; a usage warning opens the selected chat's usage.
    selection = 'view-2';
    await runEntryAction({ kind: 'chat', chat: CHAT }, actionDeps());
    expect(selection).toBe('view-1');
    selection = 'view-3';
    await runEntryAction({ kind: 'usage' }, actionDeps());
    expect(posts.at(-1)).toEqual(['view-3', { type: 'runChatCommand', command: 'subscriptionUsage' }]);
  });

  it('posts nothing when the user selects another chat while the entry\'s chat loads', async () => {
    const deps = actionDeps({
      select: async (chat) => {
        // The unloaded chat restores; meanwhile the user picks a chat with a prompt of its own.
        selection = 'view-2';
        return chat.panelId;
      },
    });
    await runEntryAction({ kind: 'attention', chat: CHAT, attention: 'approval' }, deps);
    expect(posts).toEqual([]);
  });

  it('posts nothing when the selection moves before the chat\'s view is ready, or the chat closes first', async () => {
    await runEntryAction({ kind: 'attention', chat: CHAT, attention: 'question' }, actionDeps({
      whenReady: async () => {
        selection = 'view-2';
        return true;
      },
    }));
    await runEntryAction({ kind: 'team', chat: CHAT, teamId: 'team-9' }, actionDeps({ whenReady: async () => false }));
    await runEntryAction({ kind: 'attention', chat: CHAT, attention: 'question' }, actionDeps({ select: async () => undefined }));
    expect(posts).toEqual([]);
  });
});
