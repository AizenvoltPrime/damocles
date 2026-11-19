import type { Disposable } from '../../../platform/disposable';
import type { HostTrust } from '../core-services/host-services';
import type { AskMessage } from '../message-dialog';
import type { PendingPrompt, PromptOutcome, TrustAnswer } from '../trust-store';
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
  // resolves whether the folder is trusted afterwards
  request(target: RemoteTrustTarget): Promise<boolean>;
  // the call whose own question granted the folder gets an undo, which revokes that grant, unless another call joined the question
  ask(target: RemoteTrustTarget): Promise<TrustAnswer>;
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
  const prompts = new Map<string, PendingPrompt>();
  const isTrusted = (target: RemoteTrustTarget): boolean => deps.store.isTrusted(target.authorityKey, target.folderKey);

  // Don't Trust is Cancel and takes focus first, so neither Enter nor Escape grants trust.
  async function prompt(target: RemoteTrustTarget): Promise<PromptOutcome> {
    const chosen = await deps.ask({
      severity: 'warning',
      message: deps.t('Do you trust the authors of the files in {0} on {1}?', target.fsPath, target.host),
      detail: deps.t('Damocles loads a trusted folder\'s own instructions, skills, hooks, MCP servers, subagents, permission rules and settings. Until you trust it, only your user-level configuration applies there. Trusting this folder does not trust its subfolders.'),
      actions: [deps.t('Trust Folder')],
      cancelLabel: deps.t('Don\'t Trust'),
    });
    if (chosen !== 0) {
      deps.log(`[trust] declined ${target.key}`);
      return 'declined';
    }
    if (!(await deps.store.grantTrust(target.authorityKey, target.folderKey))) return 'trusted';
    deps.log(`[trust] granted ${target.key}`);
    return 'granted';
  }

  // asks once per pending request; a call that found the folder trusted or joined a pending question gets no undo, nor does the
  // asking call once another joined
  async function ask(target: RemoteTrustTarget): Promise<TrustAnswer> {
    if (isTrusted(target)) return { trusted: true };
    const pending = prompts.get(target.key);
    if (pending) {
      pending.joined = true;
      return { trusted: (await pending.outcome) !== 'declined' };
    }
    const asked: PendingPrompt = { outcome: prompt(target).finally(() => prompts.delete(target.key)), joined: false };
    prompts.set(target.key, asked);
    const outcome = await asked.outcome;
    if (outcome !== 'granted' || asked.joined) return { trusted: outcome !== 'declined' };
    return {
      trusted: true,
      undo: async () => {
        await deps.store.revokeTrust(target.authorityKey, target.folderKey);
        deps.log(`[trust] revoked ${target.key}`);
      },
    };
  }

  return {
    isTrusted,
    request: async (target) => (await ask(target)).trusted,
    ask,
  };
}

// A folder an authority's core may read as trusted while the host store trusts it.
export interface HostTrustFolder {
  readonly folderKey: string;
  readonly fsPath: string;
}

export interface RemoteHostTrustDeps {
  readonly authorityKey: string;
  readonly store: Pick<HostStore, 'isTrusted' | 'onDidChange'>;
  // the authority's listed projects, the new folder of each move, and each folder a Locate or an add holds
  readonly folders: () => readonly HostTrustFolder[];
  readonly onDidChangeFolders: (listener: () => void) => Disposable;
  readonly requestTrust: (folderPath: string) => Promise<boolean>;
}

/**
 * The authority's trust as its core reads it: the folders the host store trusts among `folders`. A change grants the keys it
 * adds and revokes the keys it takes out, each change republishing the whole set.
 */
export function remoteHostTrust(deps: RemoteHostTrustDeps): HostTrust {
  const trusted = (): Map<string, string> => new Map(deps.folders().filter((folder) => deps.store.isTrusted(deps.authorityKey, folder.folderKey)).map((folder) => [folder.folderKey, folder.fsPath]));
  return {
    trustedKeys: () => [...trusted().keys()],
    onDidChange: (listener) => {
      let before = trusted();
      const changed = (): void => {
        const now = trusted();
        const granted = [...now].filter(([key]) => !before.has(key)).map(([, fsPath]) => fsPath);
        const revoked = [...before].filter(([key]) => !now.has(key)).map(([, fsPath]) => fsPath);
        before = now;
        if (granted.length > 0 || revoked.length > 0) listener({ granted, revoked });
      };
      const subscriptions = [deps.store.onDidChange(changed), deps.onDidChangeFolders(changed)];
      return { dispose: () => { for (const subscription of subscriptions) subscription.dispose(); } };
    },
    requestTrust: deps.requestTrust,
  };
}
