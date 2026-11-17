// What a host's attach does with each chat remote-state.json kept for it (docs/invariants.md "Remote daemon and wire").

export interface KeptChatProjects {
  // the project is listed, or a move's host part re-keyed the chat to its new folder before the list names it
  readonly known: (projectKey: string) => boolean;
  readonly absent: (projectKey: string) => boolean;
}

/** open: reopened on the host's core; closed: kept until its folder is back or its move is done; dropped: its project left the list. */
export type KeptChatFate = 'open' | 'closed' | 'dropped';

export function keptChatFate(projectKey: string | undefined, projects: KeptChatProjects): KeptChatFate {
  if (projectKey === undefined) return 'open';
  // a key no project lists reads present
  if (!projects.known(projectKey)) return 'dropped';
  return projects.absent(projectKey) ? 'closed' : 'open';
}
