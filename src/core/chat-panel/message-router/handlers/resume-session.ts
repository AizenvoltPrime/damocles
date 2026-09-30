import type { HandlerDependencies } from "../types";
import { announceHeldElsewhere, announceLeaseRefusal, claimStoredSession, findStoredSessionHolder, leaseRefusalFor } from "../../session-ownership";
import { log } from "../../../logger";

/** Resume stored session `sessionId` in panel `panelId`, moving the panel to the session's folder first. */
export async function resumeStoredSession(deps: HandlerDependencies, panelId: string, sessionId: string): Promise<void> {
  const { platform, postMessage, storageManager } = deps;
  const openElsewhere = findStoredSessionHolder(deps.getPanels(), { panelId }, sessionId);
  if (openElsewhere) {
    announceHeldElsewhere(platform.notifications);
    openElsewhere.host.reveal();
    return;
  }
  // Checked before the switch, which disposes the panel's conversation and may move it to another folder.
  const leaseRefusal = leaseRefusalFor(sessionId);
  if (leaseRefusal) {
    announceLeaseRefusal(platform.notifications, leaseRefusal);
    return;
  }
  // The session file lives under its folder's session dir, so the panel moves there first. The claim
  // runs inside the switch, so a message the webview sent meanwhile reaches the resumed session.
  // An unknown session stays on the panel's folder as it is now, which may differ from the folder at dispatch.
  const folder = (await storageManager.folderOf(sessionId)) ?? deps.getPanels().get(panelId)?.folder;
  if (!folder) return;
  await deps.switchPanelFolder(panelId, folder.key, "resume", async (instance) => {
    // Another panel or process can claim the session while this one switches; the claim then refuses.
    const refusal = claimStoredSession(platform.notifications, deps.getPanels(), { panelId, session: instance.session }, sessionId);
    if (refusal) {
      refusal.holder?.host.reveal();
      return false;
    }
    // The webview keeps its current conversation on screen until this arrives.
    postMessage(instance.host, { type: "resumeAccepted", sessionId });

    try {
      const rewindableIds = await deps.historyManager.loadSessionHistory(instance.folder.fsPath, sessionId, instance.host, instance.session);
      instance.session.seedCheckpoints(rewindableIds ?? []);
      postMessage(instance.host, { type: "sessionStarted", sessionId, stored: rewindableIds !== null });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return true;
      log("[MessageRouter] Error loading session history:", err);
      postMessage(instance.host, { type: "sessionStarted", sessionId });
    }
    return true;
  });
}
