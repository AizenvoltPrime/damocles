// The notification center's data, shared by main (which builds it) and the overlay and shell apps (which render it).
// Entries are structured: every renderer localizes them, the desktop popup window (D52) included.
import type { HostTone } from '../../shared/host-tones';

export const NOTIFICATION_KINDS = ['approval', 'plan', 'question', 'team', 'done', 'error', 'limit'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

// How long each kind's toast stays before main times it out (plan AD10).
export const KIND_LIFE_MS: Readonly<Record<NotificationKind, number>> = {
  approval: 12_000,
  plan: 12_000,
  question: 12_000,
  team: 12_000,
  done: 7_000,
  error: 12_000,
  limit: 9_000,
};

export type NoticeSeverity = 'info' | 'warning' | 'error';

export interface NotificationProject {
  readonly key: string;
  readonly name: string;
}

export interface NotificationChat {
  readonly project: NotificationProject;
  // '' is a chat with no title yet, which renderers label "New chat"
  readonly title: string;
  // a remote chat's host as this computer's host store names and colors it, never a name a core sent
  readonly host?: string;
  readonly hostTone?: HostTone;
}

export type NotificationBody =
  | { readonly kind: 'approval' | 'plan' | 'question'; readonly chat: NotificationChat; readonly summary?: string }
  | { readonly kind: 'team'; readonly chat: NotificationChat; readonly summary?: string; readonly agentName?: string }
  | { readonly kind: 'done'; readonly chat: NotificationChat; readonly durationMs?: number }
  | { readonly kind: 'error'; readonly chat: NotificationChat; readonly reason: 'error'; readonly message?: string }
  // the full usage window the pause waits on and its reset (epoch ms), when core found one (D55)
  | { readonly kind: 'error'; readonly chat: NotificationChat; readonly reason: 'rateLimit'; readonly windowLabel?: string; readonly resetsAt?: number }
  | { readonly kind: 'limit'; readonly chat: NotificationChat; readonly reason: 'budget' }
  | {
      readonly kind: 'limit';
      readonly reason: 'usage';
      readonly windowLabel: string;
      readonly threshold: 80 | 95;
      // 0-100
      readonly utilization: number;
      readonly resetsAt?: number;
      readonly planName?: string;
    }
  // A core NotificationService call: its text is already localized, and an action answers the caller. host: a remote core's,
  // named by this computer's host store
  | { readonly kind: 'notice'; readonly severity: NoticeSeverity; readonly title?: string; readonly message: string; readonly actions: readonly string[]; readonly host?: string; readonly hostTone?: HostTone };

// A remote host as a notification names it: this computer's host store's name and safety color.
export interface NotificationHost {
  readonly name: string;
  readonly tone?: HostTone;
}

export interface NotificationEntry {
  // issued by main
  readonly id: string;
  // epoch ms
  readonly at: number;
  readonly read: boolean;
  readonly body: NotificationBody;
  // a notice main keeps until it is answered (the engine halted): the row offers its actions until then
  readonly awaitingAnswer?: true;
}

export interface NotificationCenterState {
  // newest first
  readonly entries: readonly NotificationEntry[];
  readonly doNotDisturb: boolean;
  // damocles.desktop.notifications.enabled is off
  readonly popupsOff: boolean;
}

// The title bar bell.
export interface NotificationBell {
  // entries not seen since the center last opened
  readonly unseen: number;
  readonly doNotDisturb: boolean;
  readonly popupsOff: boolean;
  // grows by one for each new entry that asks for the user while pop-ups are on; the bell wiggles when it grows
  readonly attention: number;
}

// The answer a toast of the seven kinds gives when its action is chosen.
export const TOAST_OPEN_ACTION = 'open';

// A toast's answer: the index of the notice action chosen, or TOAST_OPEN_ACTION for a kind's own action.
export type ToastAnswer = number | typeof TOAST_OPEN_ACTION;

// The sound a desktop popup plays (D52): a prompt waiting on the user, a chat done or informed, a chat stopped or warned.
export type ChimeTone = 'attention' | 'done' | 'warning';
// A burst of popups plays its most urgent tone, in the popup page and in the tone main holds until that page loads.
export const CHIME_URGENCY: Readonly<Record<ChimeTone, number>> = { done: 0, warning: 1, attention: 2 };

export function chimeTone(body: NotificationBody): ChimeTone {
  switch (body.kind) {
    case 'approval':
    case 'plan':
    case 'question':
    case 'team':
      return 'attention';
    case 'done':
      return 'done';
    case 'error':
    case 'limit':
      return 'warning';
    case 'notice':
      return body.severity === 'info' ? 'done' : 'warning';
  }
}
