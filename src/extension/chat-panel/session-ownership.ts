import * as vscode from "vscode";
import type { ChatSession } from "../chat-session";
import type { HostInstance } from "./types";

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
export function announceHeldElsewhere(): void {
  void vscode.window.showInformationMessage(vscode.l10n.t("This conversation is already open in another panel."));
}

/**
 * Point `requester`'s session at stored session `sessionId`, unless another panel already holds it.
 * Every path that binds a panel to a stored session goes through here, so a conversation has one
 * writer. Returns the holding panel when the claim is refused, after telling the user.
 */
export function claimStoredSession(
  panels: Map<string, HostInstance>,
  requester: { panelId: string; session: ChatSession },
  sessionId: string,
): HostInstance | undefined {
  // The check and the bind must stay in one synchronous step, or two panels could both pass the check.
  const holder = findStoredSessionHolder(panels, requester, sessionId);
  if (holder) {
    announceHeldElsewhere();
    return holder;
  }
  requester.session.setResumeSession(sessionId);
  return undefined;
}
