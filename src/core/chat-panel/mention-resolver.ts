import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { FileConfinement, LinkRule } from '../../platform/file-confinement';
import type { NotificationService } from '../../platform/notification-service';
import type { TrustService } from '../../platform/trust-service';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import { hasUnsafeWindowsSegment, isRelativeFilePath } from '../../shared/relative-path';
import { folderKey } from '../workspace-folders/folder-key';
import type { WorkspaceFolderRegistry } from '../workspace-folders/folder-registry';
import { isInsideRealRoot } from '../workspace-folders/real-root';
import { l } from '../l10n';
import { worktreeProjectOf } from '../worktrees/personal-config';

// A file a renderer or main names for a chat mention: a project by key and a relative path, or a path main already holds.
export type MentionTarget = { readonly projectKey: string; readonly relativePath: string } | { readonly path: string };

export type MentionResolution =
  | { readonly ok: true; readonly path: string; readonly display: string }
  | { readonly ok: false; readonly reason: 'outsideProject' | 'outsideChat' | 'projectCopy' | 'missing' };

// Strictly below realRoot: a mention names a file, never the folder itself, whose display would be empty.
function inside(realRoot: string, realTarget: string): boolean {
  return isInsideRealRoot(realRoot, realTarget) && folderKey(realRoot) !== folderKey(realTarget);
}

async function realpathOrMissing(target: string): Promise<string | undefined> {
  try {
    return await fs.realpath(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw err;
  }
}

export interface MentionDeps {
  readonly folders: Pick<WorkspaceFolderRegistry, 'resolve'>;
  // the host's link rule; core never follows a link in a named file itself (a link that leads to a share is refused)
  readonly confinement: FileConfinement;
  // a link leading out of the folder confined in is followed only while that folder and the chat's are trusted (D1)
  readonly trust: Pick<TrustService, 'isTrusted'>;
}

// A confinement failure: 'failed' (a read error that is no missing file) is the caller's to report.
function refusal(relativePath: string, reason: 'outside' | 'missing' | 'failed', outside: 'outsideProject' | 'outsideChat'): MentionResolution {
  if (reason === 'failed') throw new Error(`${relativePath} could not be resolved`);
  return { ok: false, reason: reason === 'missing' ? 'missing' : outside };
}

/**
 * The one mention rule (a drop on the composer, Files' Mention in chat, the editor's mention button, Quick Open's @):
 * the file, confined by the host, must lie inside its project and inside the chat's folder; the display is the path an @
 * autocomplete pick inserts, relative to the chat's folder. While the chat's folder and the named project are both trusted a link
 * leading out of the project is followed (D1): the chat-folder check and the display then read the path through the link, and
 * AD12 the realpath.
 */
export async function resolveMention(deps: MentionDeps, target: MentionTarget, chatFolder: string): Promise<MentionResolution> {
  const realChat = await realpathOrMissing(chatFolder);
  const ruleFor = (folder: string): LinkRule => (deps.trust.isTrusted(chatFolder) && deps.trust.isTrusted(folder) ? 'throughLinks' : 'withinProject');
  let realFile: string;
  // the path the user named: realFile, or the path through the link when the realpath leaves the folder
  let named: string;
  if ('path' in target) {
    if (!path.isAbsolute(target.path)) return { ok: false, reason: 'outsideProject' };
    if (realChat === undefined) return { ok: false, reason: 'missing' };
    // main holds the path as a real path; it is confined under the chat's folder like any named file
    if (!inside(realChat, target.path)) return { ok: false, reason: 'outsideChat' };
    const relativePath = path.relative(realChat, target.path).split(path.sep).join('/');
    const confined = await deps.confinement.confineExisting(realChat, relativePath, ruleFor(chatFolder));
    if (!confined.ok) return refusal(relativePath, confined.reason, 'outsideChat');
    realFile = confined.path;
    named = confined.via ? path.join(realChat, ...relativePath.split('/')) : realFile;
  } else {
    const project = deps.folders.resolve(target.projectKey);
    if (!project || !project.projectScope || !isRelativeFilePath(target.relativePath)) return { ok: false, reason: 'outsideProject' };
    if (process.platform === 'win32' && hasUnsafeWindowsSegment(target.relativePath)) return { ok: false, reason: 'outsideProject' };
    const confined = await deps.confinement.confineExisting(project.fsPath, target.relativePath, ruleFor(project.fsPath));
    if (!confined.ok) return refusal(target.relativePath, confined.reason, 'outsideProject');
    realFile = confined.path;
    if (confined.via) {
      // the project folder's realpath, which the confinement already took
      const realProject = await realpathOrMissing(project.fsPath);
      if (realProject === undefined) return { ok: false, reason: 'missing' };
      named = path.join(realProject, ...target.relativePath.split('/'));
    } else {
      named = realFile;
    }
  }
  if (realChat === undefined) return { ok: false, reason: 'missing' };
  if (!inside(realChat, named)) return { ok: false, reason: await outsideChatReason(chatFolder, realFile) };
  // a link in a worktree chat's folder onto its project folder's copy
  if (named !== realFile && (await outsideChatReason(chatFolder, realFile)) === 'projectCopy') return { ok: false, reason: 'projectCopy' };
  return { ok: true, path: realFile, display: path.relative(realChat, named).split(path.sep).join('/') };
}

// AD12's wrong-copy guard: the project folder's copy of a file a worktree chat has its own copy of.
async function outsideChatReason(chatFolder: string, realFile: string): Promise<'projectCopy' | 'outsideChat'> {
  const project = worktreeProjectOf(chatFolder);
  const realProject = project !== undefined ? await realpathOrMissing(project) : undefined;
  return realProject !== undefined && inside(realProject, realFile) ? 'projectCopy' : 'outsideChat';
}

/** Resolves a mention for a chat and posts insertMention to it, or tells the user why nothing was inserted. */
export async function mentionInChat(
  deps: MentionDeps & { readonly notifications: NotificationService; readonly post: (message: ExtensionToWebviewMessage) => void },
  target: MentionTarget,
  chatFolder: string,
): Promise<boolean> {
  const resolved = await resolveMention(deps, target, chatFolder);
  if (resolved.ok) {
    deps.post({ type: 'insertMention', path: resolved.path, display: resolved.display });
    return true;
  }
  const message = resolved.reason === 'missing' ? l('The file no longer exists.')
    : resolved.reason === 'projectCopy' ? l('This file is in the project folder. This chat works in its worktree.')
      : l("This file is outside this chat's project");
  void deps.notifications.warn(message);
  return false;
}
