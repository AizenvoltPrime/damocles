import { parseFileDragTarget, type FileDragPayload } from '../../shared/file-drag';
import { authorityKeyOfProject } from '../../shared/project-location';

/**
 * A file main mentions in a chat: a project file by key, or a file outside every project by its path on the authority that
 * holds it, which core's target never carries.
 */
export type AuthorityMentionTarget = { readonly projectKey: string; readonly relativePath: string } | { readonly path: string; readonly authority: string };

/** Where a mentioned or dropped project file lives, when that is not where the chat runs; undefined when both are one authority. */
export function crossedAuthority(chatAuthority: string, projectKey: string): string | undefined {
  const from = authorityKeyOfProject(projectKey);
  return from === chatAuthority ? undefined : from;
}

/** Where a mentioned file lives, by its project key or the authority its path is on, when that is not where the chat runs. */
export function crossedByMention(chatAuthority: string, target: AuthorityMentionTarget): string | undefined {
  if ('projectKey' in target) return crossedAuthority(chatAuthority, target.projectKey);
  return target.authority === chatAuthority ? undefined : target.authority;
}

// A chat page's file drop (mentionDropped), as the shell names it; core's mention resolver refuses one without a project key.
function droppedFile(message: unknown): { readonly projectKey: string; readonly relativePath: unknown } | undefined {
  const dropped = message as { readonly type?: unknown; readonly projectKey?: unknown; readonly relativePath?: unknown } | null;
  if (typeof dropped !== 'object' || dropped === null || dropped.type !== 'mentionDropped' || typeof dropped.projectKey !== 'string') return undefined;
  return { projectKey: dropped.projectKey, relativePath: dropped.relativePath };
}

/**
 * The authority of a file a chat page's message names from another authority (a file dropped into the composer); undefined for
 * any other message, content attachments (pasted images, attached text) included, which carry no path.
 */
export function crossedByViewMessage(chatAuthority: string, message: unknown): string | undefined {
  const dropped = droppedFile(message);
  return dropped && crossedAuthority(chatAuthority, dropped.projectKey);
}

/**
 * A file of a remote chat's own host dropped into its composer: the page names it by the shell's key, which a remote core
 * knows only without its authority prefix, so main mentions it through that core's client. Undefined for any other message.
 */
export function ownRemoteDrop(chatAuthority: string, message: unknown): FileDragPayload | undefined {
  const dropped = droppedFile(message);
  if (chatAuthority === 'local' || !dropped || crossedAuthority(chatAuthority, dropped.projectKey) !== undefined) return undefined;
  return parseFileDragTarget(dropped.projectKey, dropped.relativePath);
}
