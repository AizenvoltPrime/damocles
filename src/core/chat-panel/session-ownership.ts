import type { NotificationService } from "../../platform/notification-service";
import type { ChatSession } from "../chat-session";
import type { HostInstance } from "./types";
import {
  SESSION_RELEASE_REQUEST_TTL_MS,
  acquireSessionLease,
  readSessionLeaseOwner,
  sessionLeaseBlocker,
  withdrawSessionReleaseRequest,
  writeSessionReleaseRequest,
  writeUnderSessionLease,
  type SessionLeaseHolder,
  type SessionReleaseRequest,
  type SessionWriteRefusal,
} from "../pi-session/session-store/session-lease";
import { log } from "../logger";
import { l } from "../l10n";

// The wait counts its own polls, not wall-clock time, so a system suspend never cuts it short.
const HANDOFF_POLL_MS = 250;
const HANDOFF_POLLS = Math.ceil(SESSION_RELEASE_REQUEST_TTL_MS / HANDOFF_POLL_MS);

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
  void notifications.info(l("This conversation is already open in another panel."));
}

/** Why this process cannot take a stored conversation's lease now; `unreadable` when the lease itself failed. */
export type LeaseRefusal = SessionWriteRefusal | { readonly kind: "unreadable"; readonly reason: string };

/** An open of stored session `sessionId` refused by another process's lease, which the user may take over. */
export interface LeaseTakeover {
  readonly sessionId: string;
  /** False once the panel or chat the conversation would open in is gone. */
  readonly canOpen: () => boolean;
  /** Open the conversation, through the same path that was refused; it claims the session itself. */
  readonly open: () => Promise<void>;
}

export interface LeaseRefusalOptions {
  /** The conversation opens by itself once `heldUntilMs` passes. */
  readonly retryScheduled?: boolean;
  /** Offered as "Open here" while another live process holds the session; only an open path passes it. */
  readonly takeover?: LeaseTakeover;
}

/** Whole seconds until `epochMs`, at least one. */
function secondsUntil(epochMs: number): number {
  return Math.max(1, Math.ceil((epochMs - Date.now()) / 1000));
}

/** Tell the user why a stored conversation was not opened. Never waits for the user's choice. */
export function announceLeaseRefusal(notifications: NotificationService, refusal: LeaseRefusal, options: LeaseRefusalOptions = {}): void {
  switch (refusal.kind) {
    case "writing":
      void notifications.info(l("This conversation is being deleted or changed. Try again in a moment."));
      return;
    case "unreadable":
      void notifications.error(l("This conversation could not be opened: {0}", refusal.reason));
      return;
    case "panel":
      void notifications.info(l("This conversation is opening or closing in a panel. Try again in a moment."));
      return;
    case "other-process":
      if (refusal.heldUntilMs === undefined) {
        // A holder that wrote no owner record (an older Damocles) cannot be asked, so nothing is offered.
        if (options.takeover && readSessionLeaseOwner(options.takeover.sessionId)) offerTakeover(notifications, options.takeover);
        else void notifications.info(l("This conversation is open in another Damocles window."));
      } else if (options.retryScheduled) {
        void notifications.info(l("The Damocles window that had this conversation open stopped responding. It opens here in about {0} seconds.", secondsUntil(refusal.heldUntilMs)));
      } else {
        void notifications.info(l("The Damocles window that had this conversation open stopped responding. Try again in {0} seconds.", secondsUntil(refusal.heldUntilMs)));
      }
      return;
  }
}

function offerTakeover(notifications: NotificationService, takeover: LeaseTakeover): void {
  notifications
    .info(l("This conversation is open in another Damocles window. Opening it here closes it there and stops any turn running in it."), [l("Open here")])
    .then((choice) => (choice === 0 ? takeOverSession(notifications, takeover) : undefined))
    .catch((err: unknown) => log("[session-ownership] opening session %s here failed: %O", takeover.sessionId, err));
}

/** The user chose "Open here": ask whichever process holds the session now to let go, then open it. Every outcome reaches the user. */
async function takeOverSession(notifications: NotificationService, takeover: LeaseTakeover): Promise<void> {
  const { sessionId } = takeover;
  if (!takeover.canOpen()) return;
  // Read again: the choice can come long after the toast, when another process, or none, holds the session.
  const refusal = leaseRefusalFor(sessionId);
  if (refusal?.kind === "other-process" && refusal.heldUntilMs === undefined) {
    const owner = readSessionLeaseOwner(sessionId);
    if (!owner) {
      announceLeaseRefusal(notifications, refusal);
      return;
    }
    if ((await requestSessionHandoff(sessionId, owner.nonce)) === "timeout") {
      void notifications.info(l("The other Damocles window did not close this conversation. Close it there, then open it here."));
      return;
    }
    if (!takeover.canOpen()) return;
  } else if (refusal) {
    announceLeaseRefusal(notifications, refusal);
    return;
  }
  await takeover.open();
}

function readRefusal(sessionId: string): LeaseRefusal | undefined {
  try {
    return sessionLeaseBlocker(sessionId);
  } catch (err) {
    log("[session-ownership] reading the lease of session %s failed: %O", sessionId, err);
    return { kind: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Which process holds `sessionId`, for the log of a refusal. */
function logHolder(sessionId: string, refusal: LeaseRefusal): void {
  if (refusal.kind === "panel") log("[session-ownership] session %s is held by a panel of this process with no live session to write through", sessionId);
  if (refusal.kind !== "other-process") return;
  const owner = readSessionLeaseOwner(sessionId);
  const heartbeat = refusal.heldUntilMs === undefined ? "live" : "stopped";
  if (owner) {
    log("[session-ownership] session %s is held by pid %d on %s since %s (heartbeat %s)", sessionId, owner.pid, owner.hostname, new Date(owner.acquiredAt).toISOString(), heartbeat);
  } else {
    log("[session-ownership] session %s is held by a process that left no owner record (heartbeat %s)", sessionId, heartbeat);
  }
}

/** What keeps a panel of this process from claiming `sessionId` now, read without taking the lease. Never throws. */
export function leaseRefusalFor(sessionId: string): LeaseRefusal | undefined {
  const refusal = readRefusal(sessionId);
  if (refusal) logHolder(sessionId, refusal);
  return refusal;
}

function takeLease(sessionId: string, holder: SessionLeaseHolder): LeaseRefusal | undefined {
  try {
    if (acquireSessionLease(sessionId, holder)) return undefined;
  } catch (err) {
    log("[session-ownership] taking the lease of session %s failed: %O", sessionId, err);
    return { kind: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
  const refusal: LeaseRefusal = { kind: "other-process" };
  logHolder(sessionId, refusal);
  return refusal;
}

/**
 * Ask the process holding stored session `sessionId`, whose owner record names `nonce`, to hand it over,
 * and wait until the lease is free: `released`, or `timeout` once the request has expired unanswered.
 * The caller then claims through `claimStoredSession`, which another process may still win. Never throws.
 */
export async function requestSessionHandoff(sessionId: string, nonce: string): Promise<"released" | "timeout"> {
  const request: SessionReleaseRequest = { v: 1, nonce, requestedAt: Date.now(), requesterPid: process.pid };
  let written = false;
  let writeFailed = false;
  try {
    for (let poll = 0; ; poll++) {
      if (readRefusal(sessionId) === undefined) return "released";
      if (poll >= HANDOFF_POLLS) break;
      if (!written) {
        try {
          writeSessionReleaseRequest(sessionId, request);
          written = true;
        } catch (err) {
          if (!writeFailed) log("[session-ownership] asking for session %s failed: %O", sessionId, err);
          writeFailed = true;
        }
      }
      // Unref'd, so a host shutting down is not kept alive by a takeover nobody will see.
      await new Promise((resolve) => setTimeout(resolve, HANDOFF_POLL_MS).unref());
    }
    log("[session-ownership] the holder of session %s did not hand it over within %dms", sessionId, SESSION_RELEASE_REQUEST_TTL_MS);
    return "timeout";
  } finally {
    if (written) withdrawSessionReleaseRequest(sessionId, request);
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

/** `writeUnderSessionLease`, telling the user when it is refused. False when refused. */
export async function whileSessionLeased(
  notifications: NotificationService,
  sessionId: string,
  work: () => Promise<void>,
  options: { readonly joinPanels?: boolean } = {},
): Promise<boolean> {
  const refusal = await writeUnderSessionLease(sessionId, work, options);
  if (!refusal) return true;
  logHolder(sessionId, refusal);
  announceLeaseRefusal(notifications, refusal);
  return false;
}
