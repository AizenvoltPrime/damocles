import type { AskMessage } from '../message-dialog';
import type { HostStore } from './host-store';
import type { Project } from '../../local-services/confine';
import { parseRootKey } from '../../preload/folder-root';
import { authorityKeyOfProject } from '../../../shared/project-location';

// A project on another authority as trust reads it: its folder as the target names it and the folder key the target computed.
export interface RemoteTrustTarget {
  readonly key: string;
  readonly authorityKey: string;
  readonly folderKey: string;
  readonly fsPath: string;
  // the host's name from this computer's host store, never a name the target sent
  readonly host: string;
}

export interface RemoteTrustDeps {
  readonly store: HostStore;
  readonly ask: AskMessage;
  readonly t: (message: string, ...args: string[]) => string;
  readonly log: (line: string) => void;
}

export interface RemoteTrust {
  isTrusted(target: RemoteTrustTarget): boolean;
  request(target: RemoteTrustTarget): Promise<boolean>;
}

export interface ProjectTrustDeps {
  readonly local: { isTrusted(folder: string): boolean; requestTrust(folder: string): Promise<boolean> };
  readonly remote: RemoteTrust;
  // the listed remote project a project key names
  readonly remoteTarget: (projectKey: string) => RemoteTrustTarget | undefined;
}

/** Trust of a project or one of its worktree roots by its project's authority; a remote root never reaches the local allowlist. */
export function createProjectTrust(deps: ProjectTrustDeps): { isTrusted(project: Project): boolean; request(project: Project): Promise<boolean> } {
  const projectKey = (project: Project): string => parseRootKey(project.key)?.projectKey ?? project.key;
  return {
    isTrusted(project) {
      const key = projectKey(project);
      if (authorityKeyOfProject(key) === 'local') return deps.local.isTrusted(project.fsPath);
      const target = deps.remoteTarget(key);
      return target !== undefined && deps.remote.isTrusted(target);
    },
    request(project) {
      const key = projectKey(project);
      if (authorityKeyOfProject(key) === 'local') return deps.local.requestTrust(project.fsPath);
      const target = deps.remoteTarget(key);
      return target ? deps.remote.request(target) : Promise.resolve(false);
    },
  };
}

/** The trust question for a remote project, which names its host; a grant lands in remote-hosts.json, never trusted-folders.json. */
export function createRemoteTrust(deps: RemoteTrustDeps): RemoteTrust {
  const prompts = new Map<string, Promise<boolean>>();
  const isTrusted = (target: RemoteTrustTarget): boolean => deps.store.isTrusted(target.authorityKey, target.folderKey);

  // Don't Trust is Cancel and takes focus first, so neither Enter nor Escape grants trust.
  async function prompt(target: RemoteTrustTarget): Promise<boolean> {
    const chosen = await deps.ask({
      severity: 'warning',
      message: deps.t('Do you trust the authors of the files in {0} on {1}?', target.fsPath, target.host),
      detail: deps.t('Damocles loads a trusted folder\'s own instructions, skills, hooks, MCP servers, subagents, permission rules and settings. Until you trust it, only your user-level configuration applies there. Trusting this folder does not trust its subfolders.'),
      actions: [deps.t('Trust Folder')],
      cancelLabel: deps.t('Don\'t Trust'),
    });
    if (chosen !== 0) {
      deps.log(`[trust] declined ${target.key}`);
      return false;
    }
    await deps.store.grantTrust(target.authorityKey, target.folderKey);
    deps.log(`[trust] granted ${target.key}`);
    return true;
  }

  return {
    isTrusted,
    // asks once per pending request; resolves whether the folder is trusted afterwards
    request(target) {
      if (isTrusted(target)) return Promise.resolve(true);
      const pending = prompts.get(target.key);
      if (pending) return pending;
      const asked = prompt(target).finally(() => prompts.delete(target.key));
      prompts.set(target.key, asked);
      return asked;
    },
  };
}
