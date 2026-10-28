import { authorityKeyOfProject } from '../../../shared/project-location';

export interface LaunchViews {
  // the remote projects this launch lists
  readonly remoteProjectKeys: readonly string[];
  // authority keys of the editor tabs and hot-exit backups the launch restores
  readonly editorAuthorities: readonly string[];
  // authority keys whose terminals or chats remote-state.json keeps
  readonly terminalAuthorities: readonly string[];
  readonly chatAuthorities: readonly string[];
  // the project selected when the app last quit
  readonly selectedProjectKey: string | undefined;
}

/**
 * The authorities a launch connects without asking: those whose projects have restored editor tabs, terminals or chats, and
 * the last selected project's. Every other remote project connects when the user selects it. Order: as the projects list them.
 */
export function authoritiesToConnectAtLaunch(views: LaunchViews): string[] {
  const listed = [...new Set(views.remoteProjectKeys.map(authorityKeyOfProject))];
  const wanted = new Set([
    ...views.editorAuthorities,
    ...views.terminalAuthorities,
    ...views.chatAuthorities,
    ...(views.selectedProjectKey !== undefined ? [authorityKeyOfProject(views.selectedProjectKey)] : []),
  ]);
  return listed.filter((authority) => wanted.has(authority));
}
