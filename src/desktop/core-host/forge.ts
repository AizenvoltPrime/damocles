// Git hosting accounts in this computer's Damocles Core only (docs/invariants.md "GitHub and GitLab accounts"): a daemon's
// core never builds them, so no forge token is ever stored on a target.
import * as path from 'node:path';
import { createForgeService, type ChooseAccountUi, type ForgeBuildOAuth, type ForgeService } from '../../core/forge';
import { createDelegator } from '../../core/forge/delegate';
import { locationOf, matchServer, parseRemoteUrl } from '../../core/forge/remote-url';
import type { ForgeServer } from '../../core/forge/types';
import { isInsideFolder } from '../../shared/project-location';
import type { CoreInit } from '../core-protocol';
import type { CorePlatform } from './platform';
import type { CoreScm } from './scm';

// esbuild defines it in the core-host bundle only (esbuild.config.ts, from DAMOCLES_FORGE_* at build time)
declare const __DAMOCLES_FORGE_OAUTH__: ForgeBuildOAuth | undefined;

function buildOAuth(): ForgeBuildOAuth {
  return typeof __DAMOCLES_FORGE_OAUTH__ === 'undefined' ? {} : __DAMOCLES_FORGE_OAUTH__;
}

const hostOs = { os: process.platform };

/** The listed local project whose repositories have a remote on server at repoPath; with several, the one holding cwd. */
async function projectByRemote(scm: CoreScm, server: ForgeServer, repoPath: string, cwd: string, signal: AbortSignal, log: (line: string) => void): Promise<string | undefined> {
  const repositories = [...scm.projectFolders()].flatMap(([projectKey, projectPath]) => {
    if (typeof scm.service.trustedProjectAt(projectPath) !== 'string') return [];
    return (scm.service.view(projectKey)?.repos ?? []).map((repo) => ({ projectKey, projectPath, repoId: repo.repoId }));
  });
  // each repository's remotes are read once per change of its git config, never per request
  const hits = await Promise.all(repositories.map(async ({ projectKey, projectPath, repoId }) => {
    let remotes: Awaited<ReturnType<typeof scm.service.cachedRemotes>>;
    try {
      remotes = await scm.service.cachedRemotes(repoId);
    } catch (err) {
      log(`[forge] the remotes of ${projectPath} could not be read for a git credential request: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    const hit = remotes.some((remote) => [remote.fetchUrl, remote.pushUrl].some((url) => {
      const parsed = url !== undefined ? parseRemoteUrl(url) : undefined;
      return parsed !== undefined && matchServer(locationOf(parsed), [server])?.repoPath === repoPath;
    }));
    return hit ? projectKey : undefined;
  }));
  signal.throwIfAborted();
  const found = [...new Set(hits.filter((projectKey) => projectKey !== undefined))];
  return found.find((projectKey) => isInsideFolder(hostOs, scm.projectFolders().get(projectKey)!, cwd)) ?? found[0];
}

/** The built-in servers pointed at the forge stub, taken only with the e2e hooks on, as main sends them (main/forge/e2e-forge-servers.ts). */
export function e2eForgeOverrides(init: Pick<CoreInit, 'e2eHooks' | 'e2eForgeServers'>): CoreInit['e2eForgeServers'] {
  return init.e2eHooks ? init.e2eForgeServers : undefined;
}

/** The forge service of this computer's core, serving forge.avatar and publishing the forge mirror; undefined in a daemon's core. */
export function startCoreForge(platform: CorePlatform, scm: CoreScm, log: (line: string) => void): ForgeService | undefined {
  const forgeDir = platform.init.paths.forge;
  if (platform.init.remote !== undefined || forgeDir === undefined) return undefined;
  const overrides = e2eForgeOverrides(platform.init);
  const forge = createForgeService({
    forgeDir,
    secrets: platform.secrets,
    settings: platform.settings,
    // read at call time: the proxy dispatcher is installed on the global one
    fetch: (input, init) => fetch(input, init),
    userAgent: `Damocles/${platform.init.appInfo.version}`,
    openExternal: (url) => platform.shell.openExternal(url),
    writeClipboard: (text) => platform.clipboard.writeText(text),
    revealPath: (absolutePath) => platform.shell.revealPath(absolutePath),
    buildOAuth: buildOAuth(),
    ...(overrides ? { overrides } : {}),
    log,
  });
  const { endpoint } = platform;
  const ui: ChooseAccountUi = {
    choose: (request, ask) => endpoint.request('forge.chooseAccount', request, ask),
    rows: (rows) => endpoint.emit('forge.chooseAccountRows', rows),
  };
  const { git } = platform.init;
  forge.connectGit({
    delegator: createDelegator({
      git: () => (git.available ? git.path : undefined),
      trustedProjectAt: (cwd) => {
        const project = scm.service.trustedProjectAt(cwd);
        return typeof project === 'string' ? project : undefined;
      },
      askpass: () => scm.askpassFor('your credential manager'),
      log,
    }),
    projectByRemote: (authorityKey, server, repoPath, cwd, signal) => (authorityKey === 'local' ? projectByRemote(scm, server, repoPath, cwd, signal, log) : Promise.resolve(undefined)),
    projectHolding: (authorityKey, cwd) => {
      if (authorityKey !== 'local') return undefined;
      const holding = [...scm.projectFolders()].filter(([, folder]) => isInsideFolder(hostOs, folder, cwd)).sort((a, b) => b[1].length - a[1].length);
      return holding[0]?.[0];
    },
    projectLabel: (projectKey) => {
      const folder = projectKey !== undefined ? scm.projectFolders().get(projectKey) : undefined;
      return folder !== undefined ? path.basename(folder) : '';
    },
    ui,
  });
  scm.connectCredentials({
    answer: async (request, origin, signal) => {
      const result = await forge.gitCredential(request, origin, { authorityKey: 'local' }, signal);
      if ('consent' in result) throw new Error('A credential request of this computer asked for a relay consent');
      return result.answer;
    },
    managed: (origin) => forge.managedServers(origin.kind === 'agentShell' ? undefined : origin.projectKey),
  });
  forge.onChange(() => endpoint.publish('forge', forge.mirror()));
  // published before the forge.history.avatars answer that names a new key, so main serves it when the shell asks
  forge.onAuthorAvatarKeys(() => endpoint.publish('forgeAuthorAvatars', { keys: forge.authorAvatarKeys() }));
  forge.onBindingsChanged((change) => endpoint.emit('forge.bindingsChanged', change));
  endpoint.serve('forge.avatar', ({ key }) => forge.avatar(key));
  endpoint.serve('forge.repoAccounts', (input) => forge.repoAccounts(input));
  endpoint.serve('forge.bindAccount', ({ projectKey, serverId, accountId }) => forge.bindAccount(projectKey, serverId, accountId));
  endpoint.serve('forge.hostDefaults', ({ authorityKey }) => forge.hostDefaults(authorityKey));
  endpoint.serve('forge.setHostDefault', ({ authorityKey, serverId, accountId }) => forge.setHostDefault(authorityKey, serverId, accountId));
  // the Choose account dialog goes through main: the CoreRequest forge.chooseAccount, its rows as forge.chooseAccountRows events
  endpoint.serve('forge.prepareGitOperation', (input, signal) => forge.prepareGitOperation(input, ui, signal));
  endpoint.serve('forge.forgetProject', ({ projectKey }) => forge.forgetProject(projectKey));
  endpoint.serve('forge.forgetHost', ({ authorityKey }) => forge.forgetHost(authorityKey));
  endpoint.serve('forge.keepHosts', ({ authorityKeys }) => forge.keepHosts(authorityKeys));
  // a terminal's helper (authorityKey 'local') or a target's takeover, which main relays
  endpoint.serve('forge.gitCredential', ({ request, origin, authorityKey, projectKey, consentedAccountId }, signal) =>
    forge.gitCredential(request, origin, { authorityKey, ...(projectKey !== undefined ? { projectKey } : {}), ...(consentedAccountId !== undefined ? { consentedAccountId } : {}) }, signal));
  // CI watches by main's ids; main says when each is shown (Source Control visible, window focused, tab shown)
  forge.onCiChanged((event) => endpoint.emit('forge.ci.changed', event));
  endpoint.serve('forge.ci.watch', ({ id, repo, active }) => forge.ci.watch(id, repo, active));
  endpoint.serve('forge.ci.unwatch', ({ id }) => forge.ci.unwatch(id));
  endpoint.serve('forge.ci.jobs', ({ id }) => forge.ci.jobs(id));
  endpoint.serve('forge.ci.jobLog', ({ id, repo, jobId }) => forge.ci.jobLog(id, repo, jobId));
  endpoint.serve('forge.ci.jobAction', ({ repo, target, action }) => forge.ci.jobAction(repo, target, action));
  endpoint.serve('forge.ci.commitStatus', ({ repo, sha, retry }) => forge.ci.commitStatus(repo, sha, retry));
  endpoint.serve('forge.ci.webUrl', ({ repo, target }) => forge.ci.webUrl(repo, target));
  endpoint.serve('forge.link', ({ repo, target }) => forge.link(repo, target));
  endpoint.serve('forge.history.context', ({ repo }) => forge.historyContext(repo));
  endpoint.serve('forge.history.avatars', ({ repo, authors }, signal) => forge.authorAvatars(repo, authors, signal));
  endpoint.serve('forge.history.containing', ({ repo, sha }, signal) => forge.containingChange(repo, sha, signal));
  // answered from memory; a missing or stale entry is read in the background, never while a commit waits
  endpoint.serve('forge.branchProtection', ({ repo }) => forge.branchProtection(repo));
  // a refused push waits for this, so a missing or stale entry is read once now
  endpoint.serve('forge.pushProtection', ({ repo, remote, branch }, signal) => forge.pushProtection(repo, remote, branch, signal));
  endpoint.serve('forge.clone.accounts', () => forge.clone.accounts());
  endpoint.serve('forge.clone.search', ({ accountId, query }, signal) => forge.clone.search(accountId, query, signal));
  endpoint.serve('forge.clone.paste', ({ text }) => forge.clone.paste(text));
  endpoint.serve('forge.clone.target', ({ source }) => forge.clone.target(source));
  endpoint.serve('forge.publishAccounts', () => forge.publishing.accounts());
  endpoint.serve('forge.publishOwners', ({ accountId }, signal) => forge.publishing.owners(accountId, signal));
  endpoint.serve('forge.createRepository', (input, signal) => forge.publishing.createRepository(input, signal));
  endpoint.serve('forge.pushAccess', ({ repo, remote }, signal) => forge.publishing.pushAccess(repo, remote, signal));
  endpoint.serve('forge.fork', (input, signal) => forge.publishing.fork(input, signal));
  endpoint.serve('forge.openMergeRequest', (input, signal) => forge.publishing.mergeRequestPage(input, signal));
  endpoint.serve('forge.openOrgAccess', ({ accountId, org }) => forge.openPage({ page: 'orgAccess', accountId, org }));
  void forge.load().catch((err: unknown) => log(`[forge] loading the Git hosting accounts failed: ${err instanceof Error ? err.message : String(err)}`));
  // answered once the forge files were read or failed to, never after the secrets, which a locked keychain can hold
  endpoint.serve('forge.servers', async () => {
    await forge.filesRead();
    return { servers: forge.mirror().servers.map(({ id, webUrl, gitHosts, hasAccount }) => ({ id, webUrl, gitHosts: [...gitHosts], hasAccount })) };
  });
  return forge;
}
