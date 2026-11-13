// History details of a repository on its server (docs/invariants.md "GitHub and GitLab accounts", history
// details): author pictures by opaque key, references as links and the merged change that contains a commit. A renderer
// names the repository by id and never sees a picture or page address.

/** The repository's server as history shows it; null from historyContext: its remotes are on no server with an account. */
export interface HistoryForgeContext {
  readonly kind: 'github' | 'gitlab';
  readonly serverName: string;
  /** damocles.desktop.forge.showAvatars: off, nothing asks for author pictures. */
  readonly showAvatars: boolean;
}

export interface HistoryAuthor {
  readonly sha: string;
  readonly email: string;
  readonly name: string;
}

/** Lower-cased email to the opaque avatar key served at app://damocles/forge/avatar/<key>; authors with no picture are absent. */
export type AuthorAvatars = Readonly<Record<string, string>>;

/** The merged pull request (GitHub, `#n`) or merge request (GitLab, `!n`) that brought a commit in. */
export interface ContainingChange {
  readonly kind: 'pullRequest' | 'mergeRequest';
  readonly number: number;
  readonly serverName: string;
}

/** Authors per authorAvatars call: one history page, deduplicated by email. */
export const MAX_HISTORY_AUTHORS = 100;
/** RFC 5321's longest address. */
export const MAX_AUTHOR_EMAIL_CHARS = 320;
export const MAX_AUTHOR_NAME_CHARS = 256;
/** Author picture keys core holds for main to serve; main's own LRU keeps 300 pictures. */
export const MAX_AUTHOR_KEYS = 1000;
