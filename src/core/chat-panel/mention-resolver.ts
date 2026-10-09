import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { FileConfinement } from '../../platform/file-confinement';
import type { NotificationService } from '../../platform/notification-service';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import { hasUnsafeWindowsSegment, isRelativeFilePath } from '../../shared/relative-path';
import { folderKey } from '../workspace-folders/folder-key';
import type { WorkspaceFolderRegistry } from '../workspace-folders/folder-registry';
import { t } from '../l10n';

// A file a renderer or main names for a chat mention: a project by key and a relative path, or a path main already holds.
export type MentionTarget = { readonly projectKey: string; readonly relativePath: string } | { readonly path: string };

export type MentionResolution =
  | { readonly ok: true; readonly path: string; readonly display: string }
  | { readonly ok: false; readonly reason: 'outsideProject' | 'outsideChat' | 'missing' };

function inside(realRoot: string, realTarget: string): boolean {
  const relative = path.relative(folderKey(realRoot), folderKey(realTarget));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
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
  // the host's link rule; core never follows a link in a named file itself (desktop refuses one that leads to a share)
  readonly confinement: FileConfinement;
}

// A confinement failure: 'failed' (a read error that is no missing file) is the caller's to report.
function refusal(relativePath: string, reason: 'outside' | 'missing' | 'failed', outside: 'outsideProject' | 'outsideChat'): MentionResolution {
  if (reason === 'failed') throw new Error(`${relativePath} could not be resolved`);
  return { ok: false, reason: reason === 'missing' ? 'missing' : outside };
}

/**
 * The one mention rule (a drop on the composer, Files' Mention in chat, the editor's mention button, Quick Open's @):
 * the file, confined by the host, must lie inside its project and inside the chat's folder; the display is the path an @
 * autocomplete pick inserts, relative to the chat's folder.
 */
export async function resolveMention(deps: MentionDeps, target: MentionTarget, chatFolder: string): Promise<MentionResolution> {
  const realChat = await realpathOrMissing(chatFolder);
  let realFile: string;
  if ('path' in target) {
    if (!path.isAbsolute(target.path)) return { ok: false, reason: 'outsideProject' };
    if (realChat === undefined) return { ok: false, reason: 'missing' };
    // main holds the path as a real path; it is confined under the chat's folder like any named file
    if (!inside(realChat, target.path)) return { ok: false, reason: 'outsideChat' };
    const relativePath = path.relative(realChat, target.path).split(path.sep).join('/');
    const confined = await deps.confinement.confineExisting(realChat, relativePath);
    if (!confined.ok) return refusal(relativePath, confined.reason, 'outsideChat');
    realFile = confined.path;
  } else {
    const project = deps.folders.resolve(target.projectKey);
    if (!project || !project.projectScope || !isRelativeFilePath(target.relativePath)) return { ok: false, reason: 'outsideProject' };
    if (process.platform === 'win32' && hasUnsafeWindowsSegment(target.relativePath)) return { ok: false, reason: 'outsideProject' };
    const confined = await deps.confinement.confineExisting(project.fsPath, target.relativePath);
    if (!confined.ok) return refusal(target.relativePath, confined.reason, 'outsideProject');
    realFile = confined.path;
  }
  if (realChat === undefined) return { ok: false, reason: 'missing' };
  if (!inside(realChat, realFile)) return { ok: false, reason: 'outsideChat' };
  return { ok: true, path: realFile, display: path.relative(realChat, realFile).split(path.sep).join('/') };
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
  void deps.notifications.warn(resolved.reason === 'missing' ? t('The file no longer exists.') : t("This file is outside this chat's project"));
  return false;
}
