import type { HandlerDependencies } from "../types";
import { announceHeldElsewhere, announceLeaseRefusal, claimStoredSession, findStoredSessionHolder, leaseRefusalFor } from "../../session-ownership";
import { resolvePiSessionFile } from "../../../pi-session/session-store";
import { log } from "../../../logger";
import { l } from "../../../l10n";

/** Resume stored session `sessionId` in panel `panelId`, moving the panel to the session's folder first. */
export async function resumeStoredSession(deps: HandlerDependencies, panelId: string, sessionId: string): Promise<void> {
  const { platform, postMessage, storageManager } = deps;
  // The panel already shows this conversation, a running turn included, which its file does not hold.
  const own = deps.getPanels().get(panelId);
  if (own?.session.holdsLiveConversation(sessionId)) {
    own.host.reveal();
    return;
  }
  const openElsewhere = findStoredSessionHolder(deps.getPanels(), { panelId }, sessionId);
  if (openElsewhere) {
    announceHeldElsewhere(platform.notifications);
    openElsewhere.host.reveal();
    return;
  }
  // Checked before the switch, which disposes the panel's conversation and may move it to another folder.
  const leaseRefusal = leaseRefusalFor(sessionId);
  if (leaseRefusal) {
    announceLeaseRefusal(platform.notifications, leaseRefusal, {
      takeover: { sessionId, canOpen: () => deps.getPanels().has(panelId), open: () => resumeStoredSession(deps, panelId, sessionId) },
    });
    return;
  }
  // The session file lives under its folder's session dir, so the panel moves there first. The claim
  // runs inside the switch, so a message the webview sent meanwhile reaches only the conversation it names.
  // An unknown session stays on the panel's folder as it is now, which may differ from the folder at dispatch.
  const listed = (await storageManager.folderOf(sessionId)) ?? deps.getPanels().get(panelId)?.folder;
  if (!listed) return;
  // The switch disposes the panel's conversation, so a file already gone is refused here; the open inside it guards the race.
  if ((await resolvePiSessionFile(listed.fsPath, sessionId)) === null) {
    void platform.notifications.error(l("This conversation could not be opened: {0}", l("its file was not found")));
    return;
  }
  // A worktree chat resumes in its working folder, from its latest entry rather than the folder that listed it (AD12).
  const binding = await deps.worktrees().resumeFolder(panelId, sessionId, listed);
  try {
    await deps.switchPanelFolder(panelId, binding.folder.key, "resume", async (instance) => {
      // Another panel or process can claim the session while this one switches; the claim then refuses.
      const refusal = claimStoredSession(platform.notifications, deps.getPanels(), { panelId, session: instance.session }, sessionId);
      if (refusal) {
        refusal.holder?.host.reveal();
        return;
      }
      // A panel pi holds another conversation in keeps that one on screen until pi has bound this one.
      const outcome = await instance.session.openResumeTarget(sessionId);
      if (outcome.kind !== "switched" && outcome.kind !== "deferred") return;
      postMessage(instance.host, { type: "resumeAccepted", sessionId });
      // The stored file's place reaches the webview before the replay, so its first render is the right composer.
      if (binding.state !== undefined) instance.session.worktree.publishStored(binding.state, sessionId);

      try {
        const rewindableIds = await deps.historyManager.loadSessionHistory(instance.folder.fsPath, sessionId, instance.host, instance.session);
        // The replay told the user why it read nothing, so the start below opens a new conversation instead.
        if (rewindableIds !== null || !instance.session.letGoOfUnreadTarget(sessionId)) {
          instance.session.seedCheckpoints(rewindableIds ?? []);
          postMessage(instance.host, { type: "sessionStarted", sessionId, stored: rewindableIds !== null });
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        log("[MessageRouter] Error loading session history:", err);
        postMessage(instance.host, { type: "sessionStarted", sessionId });
      }
      // Not awaited: the start blocks this thread in long stretches, and one that cannot open the conversation tells the user.
      if (outcome.kind === "deferred") void instance.session.initializeEarly();
    });
  } finally {
    binding.settle(deps.getPanels().get(panelId));
  }
}
