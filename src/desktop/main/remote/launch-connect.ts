import { authorityKeyOfProject } from '../../../shared/project-location';

export interface LaunchViews {
  // the remote projects this launch lists
  readonly remoteProjectKeys: readonly string[];
  // authority keys of the editor tabs and hot-exit backups the launch restores
  readonly editorAuthorities: readonly string[];
  // the authority keys among them of a host's files outside every project, which restore with no project listed
  readonly hostFileAuthorities: readonly string[];
  // authority keys whose terminals or chats remote-state.json keeps
  readonly terminalAuthorities: readonly string[];
  readonly chatAuthorities: readonly string[];
  // the project selected when the app last quit
  readonly selectedProjectKey: string | undefined;
  readonly isSavedHost: (authority: string) => boolean;
}

/**
 * The authorities a launch connects without asking: those whose projects have restored editor tabs, terminals or chats, the
 * last selected project's, and each saved host whose files outside every project have restored editor tabs or backups. Every
 * other remote project connects when the user selects it. Order: as the projects list them, then the other saved hosts.
 */
export function authoritiesToConnectAtLaunch(views: LaunchViews): string[] {
  const listed = [...new Set(views.remoteProjectKeys.map(authorityKeyOfProject))];
  const wanted = new Set([
    ...views.editorAuthorities,
    ...views.terminalAuthorities,
    ...views.chatAuthorities,
    ...(views.selectedProjectKey !== undefined ? [authorityKeyOfProject(views.selectedProjectKey)] : []),
  ]);
  const unlisted = new Set(views.hostFileAuthorities.filter((authority) => !listed.includes(authority) && views.isSavedHost(authority)));
  return [...listed.filter((authority) => wanted.has(authority)), ...unlisted];
}
