import type { NotificationService } from "../../platform/notification-service";
import type { ChatSession } from "../chat-session";
import type { HostInstance } from "./types";
import {
  acquireSessionLease,
  releaseSessionLease,
  sessionLeaseBlocker,
  type SessionLeaseBlocker,
  type SessionLeaseHolder,
} from "../pi-session/session-store/session-lease";
import { log } from "../logger";
import { t } from "../l10n";

/** The panel other than `requester` that holds stored session `sessionId`, if any. Read-only. */
export function findStoredSessionHolder(
  panels: Map<string, HostInstance>,
  requester: { panelId: string },
  sessionId: string,
): HostInstance | undefined {
  for (const [panelId, instance] of panels) {
    if (panelId !== requester.panelId && instance.session.holdsSession(sessionId)) return instance;
  }
  return undefined;
}

/** Tell the user why a request to open a stored conversation revealed another panel instead. */
export function announceHeldElsewhere(notifications: NotificationService): void {
  void notifications.info(t("This conversation is already open in another panel."));
}

/** Why this process cannot take a stored conversation's lease now; `unreadable` when the lease itself failed. */
export type LeaseRefusal = SessionLeaseBlocker | { readonly kind: "unreadable"; readonly reason: string };

/** Whole seconds until `epochMs`, at least one. */
function secondsUntil(epochMs: number): number {
  return Math.max(1, Math.ceil((epochMs - Date.now()) / 1000));
}

/** Tell the user why a stored conversation was not opened. `retryScheduled`: it opens by itself once `heldUntilMs` passes. */
export function announceLeaseRefusal(notifications: NotificationService, refusal: LeaseRefusal, retryScheduled = false): void {
  switch (refusal.kind) {
    case "writing":
      void notifications.info(t("This conversation is being deleted or changed. Try again in a moment."));
      return;
    case "unreadable":
      void notifications.error(t("This conversation could not be opened: {0}", refusal.reason));
      return;
    case "other-process":
      if (refusal.heldUntilMs === undefined) {
        void notifications.info(t("This conversation is open in another Damocles window."));
      } else if (retryScheduled) {
        void notifications.info(t("The Damocles window that had this conversation open stopped responding. It opens here in about {0} seconds.", secondsUntil(refusal.heldUntilMs)));
      } else {
        void notifications.info(t("The Damocles window that had this conversation open stopped responding. Try again in {0} seconds.", secondsUntil(refusal.heldUntilMs)));
      }
      return;
  }
}

/** What keeps a panel of this process from claiming `sessionId` now, read without taking the lease. Never throws. */
export function leaseRefusalFor(sessionId: string): LeaseRefusal | undefined {
  try {
    return sessionLeaseBlocker(sessionId);
  } catch (err) {
    log("[session-ownership] reading the lease of session %s failed: %O", sessionId, err);
    return { kind: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
}

function takeLease(sessionId: string, holder: SessionLeaseHolder): LeaseRefusal | undefined {
  try {
    return acquireSessionLease(sessionId, holder) ? undefined : { kind: "other-process" };
  } catch (err) {
    log("[session-ownership] taking the lease of session %s failed: %O", sessionId, err);
    return { kind: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
}

/** A refused claim: `holder` is the panel of this process that holds the session, `lease` why its lease was not taken. */
export interface ClaimRefusal {
  readonly holder?: HostInstance;
  readonly lease?: LeaseRefusal;
}

/**
 * Point `requester`'s session at stored session `sessionId`, unless another panel of this process holds it,
 * or its lease cannot be taken (another process holds it, this process is deleting or rewriting it, or the
 * lease failed). Every path that binds a panel to a stored session goes through here, so a conversation has
 * one writer. Returns the refusal, after telling the user. Never throws.
 */
export function claimStoredSession(
  notifications: NotificationService,
  panels: Map<string, HostInstance>,
  requester: { panelId: string; session: ChatSession },
  sessionId: string,
): ClaimRefusal | undefined {
  // The check, the lease and the bind must stay in one synchronous step, or two panels could both pass the check.
  const holder = findStoredSessionHolder(panels, requester, sessionId);
  if (holder) {
    announceHeldElsewhere(notifications);
    return { holder };
  }
  const lease = leaseRefusalFor(sessionId) ?? takeLease(sessionId, requester.session);
  if (lease) {
    announceLeaseRefusal(notifications, lease);
    return { lease };
  }
  requester.session.setResumeSession(sessionId);
  return undefined;
}

/**
 * Run `work`, which writes or removes stored session `sessionId`'s file with no panel of this process
 * writing it live, while holding the session's lease as its writer: no other process writes it meanwhile,
 * and no panel of this process claims it until `work` settles. Panels of this process that already hold
 * it share the lease, so it stays held while they detach. False, after telling the user, when another
 * process holds it or another write of this process is running on it.
 */
export async function whileSessionLeased(
  notifications: NotificationService,
  sessionId: string,
  work: () => Promise<void>,
): Promise<boolean> {
  // The write is short and awaited; a lease lost during it has no live session to detach.
  const writer: SessionLeaseHolder = { onSessionLeaseLost: () => undefined };
  const blocker = sessionLeaseBlocker(sessionId);
  if (blocker || !acquireSessionLease(sessionId, writer, { writer: true })) {
    announceLeaseRefusal(notifications, blocker ?? { kind: "other-process" });
    return false;
  }
  try {
    await work();
    return true;
  } finally {
    releaseSessionLease(sessionId, writer);
  }
}
