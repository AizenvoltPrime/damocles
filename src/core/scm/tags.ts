// Tag argv (VS Code's extensions/git/src/git.ts tag, deleteTag, getRemoteRefs and push --tags; commands.ts _createTag). A
// tag's message goes in on stdin, which makes it annotated.
import { endOfOptions, isSafeRevision, revision, type GitVersion } from './git-runner';
import { isObjectName } from './artifacts';
import { remoteArg } from './sync';

/** A lightweight tag at HEAD or at commit, or with a message an annotated one (`-a -F -`, the message on stdin). */
export function createTagArgs(name: string, annotated: boolean, version: GitVersion, commit?: string): string[] {
  return ['tag', ...(annotated ? ['-a', '-F', '-'] : []), ...endOfOptions(version), revision(name), ...(commit !== undefined ? [revision(commit)] : [])];
}

export function deleteTagArgs(name: string, version: GitVersion): string[] {
  return ['tag', '-d', ...endOfOptions(version), revision(name)];
}

/** Push Tags: `push --tags`, to the remote git picks (VS Code's pushTags with no remote). */
export const PUSH_TAGS_ARGS: readonly string[] = ['push', '--tags'];

export function remoteTagsArgs(remote: string): string[] {
  return ['ls-remote', '--tags', remoteArg(remote)];
}

export interface RemoteTag {
  readonly name: string;
  // an annotated tag's peeled `^{}` object, never the tag object
  readonly commit: string;
}

/**
 * `ls-remote --tags` lines (VS Code's getRemoteRefs, then deleteRemoteTag's dedupe): an annotated tag's peeled `^{}` line
 * counts once under its name, and a name revision() refuses is left out.
 */
export function parseRemoteTags(stdout: string): RemoteTag[] {
  const tags = new Map<string, RemoteTag>();
  for (const line of stdout.split('\n')) {
    const match = /^([0-9a-f]{40}|[0-9a-f]{64})\trefs\/tags\/(.+)$/.exec(line.trimEnd());
    if (!match || !isObjectName(match[1]!)) continue;
    const peeled = match[2]!.endsWith('^{}');
    const name = peeled ? match[2]!.slice(0, -'^{}'.length) : match[2]!;
    if (!isTagName(name) || (tags.has(name) && !peeled)) continue;
    tags.set(name, { name, commit: match[1]! });
  }
  return [...tags.values()];
}

const isTagName = (name: string): boolean => isSafeRevision(name) && isSafeRevision(`refs/tags/${name}`);
