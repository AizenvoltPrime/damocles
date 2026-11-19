import { errorTextOf, l } from "../l10n";
import { LocalizedError, type LocalizedText } from "../../shared/localized-text";
import type { Platform } from "../../platform/platform";
import { FOLDER_IDENTITIES_PATH } from "../paths";
import { FolderIdentityStore } from "../project-relocation/identity-store";
import { checkWhenAdmitted, createFolderPresenceProbe, type FolderPresenceProbe } from "../workspace-folders/folder-presence-probe";
import { folderKey } from "../workspace-folders/folder-key";
import { log } from "../logger";

const identities = new FolderIdentityStore({ file: FOLDER_IDENTITIES_PATH, log: (line) => log("%s", line) });

// The process's one probe, which every core reader of a folder's presence shares, so its stats are counted together.
export const folderPresenceProbe: FolderPresenceProbe = createFolderPresenceProbe({ recordedMount: (folder) => identities.mountOf(folder) });

/** A chat's folder is gone from a volume that answers (moved, renamed or deleted), so no session starts in it. */
export class FolderMissingError extends LocalizedError {
  readonly folder: string;

  constructor(folder: string) {
    super(l("The folder {0} was not found. It may have been moved, renamed or deleted.", folder));
    this.name = "FolderMissingError";
    this.folder = folder;
  }
}

/** A chat's folder is on a drive, share, WSL distro or mount that is not there or did not answer in time. */
export class FolderUnavailableError extends LocalizedError {
  readonly folder: string;

  constructor(folder: string) {
    super(l("The folder {0} can't be reached: its drive, share or WSL distro does not answer.", folder));
    this.name = "FolderUnavailableError";
    this.folder = folder;
  }
}

export type FolderAbsentError = FolderMissingError | FolderUnavailableError;

export function isFolderAbsent(err: unknown): err is FolderAbsentError {
  return err instanceof FolderMissingError || err instanceof FolderUnavailableError;
}

/** The hung gate refused the chat's folder check, and still did after the wait: nothing is known about the folder. */
export class FolderChecksBusyError extends LocalizedError {
  readonly folder: string;

  constructor(folder: string) {
    super(l("Damocles can't check the folder {0} right now: its drive checks are busy. Try again in a moment.", folder));
    this.name = "FolderChecksBusyError";
    this.folder = folder;
  }
}

// a check the gate refused reads false, so the caller's work waits for a later check
export async function folderPresent(folder: string): Promise<boolean> {
  return (await folderPresenceProbe.presence(folder)) === "present";
}

function absenceError(folder: string, presence: "missing" | "unavailable"): FolderAbsentError {
  return presence === "missing" ? new FolderMissingError(folder) : new FolderUnavailableError(folder);
}

/** Refuses a session start in a folder that is not there, or whose check the hung gate still refuses after the wait. */
export async function assertFolderPresent(folder: string): Promise<void> {
  const presence = await checkWhenAdmitted(() => folderPresenceProbe.presence(folder), folderPresenceProbe);
  if (presence === "present") return;
  throw presence === "unchecked" ? new FolderChecksBusyError(folder) : absenceError(folder, presence);
}

/**
 * What a session that failed in `folder` tells the user: the folder error once the folder is not there, else `err`. pi refuses a
 * missing folder with its own `MissingSessionCwdError`, which it does not export, so its text is never parsed.
 */
export async function folderFailure(folder: string, err: unknown): Promise<unknown> {
  if (isFolderAbsent(err) || err instanceof FolderChecksBusyError) return err;
  const presence = await folderPresenceProbe.presence(folder);
  // a check the gate refused knows nothing, so pi's own error stands
  return presence === "present" || presence === "unchecked" ? err : absenceError(folder, presence);
}

/**
 * Tells the user a chat's folder is not there, with Locate… for a gone folder `locatable` names a project folder of, where the
 * host can locate a moved project folder.
 */
export function tellFolderAbsent(platform: Pick<Platform, "notifications" | "window">, err: FolderAbsentError, locatable: (folder: string) => boolean): void {
  const window = platform.window;
  const actions = window.locateProjectFolder && err instanceof FolderMissingError && locatable(err.folder) ? [l("Locate…")] : [];
  platform.notifications.error(err.text, actions).then((choice) => {
    if (choice === 0 && actions.length > 0) window.locateProjectFolder?.(folderKey(err.folder));
  }, (notifyErr: unknown) => log("[folder-presence] the folder notice failed: %O", notifyErr));
}

/** The notice for a failed session: a folder error is a whole sentence, any other failure is told inside `headline`. */
export function failureNotice(err: unknown, headline: (detail: LocalizedText) => LocalizedText): LocalizedText {
  return isFolderAbsent(err) || err instanceof FolderChecksBusyError ? err.text : headline(errorTextOf(err));
}
