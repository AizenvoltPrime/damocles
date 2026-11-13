// Main's side of Git hosting accounts for projects (docs/invariants.md "GitHub and GitLab accounts"): the shell's and the
// overlay's forge channels, the Choose account dialog for this computer's core, and the ask before the user's own git operations. A
// repository's remote endpoints come from its own authority's core (ssh aliases resolve on the target); every account
// decision is this computer's core's. Renderers name repositories by id and never see a token or a remote URL.
import type { Disposable } from '../../../platform/disposable';
import { endpointsFromRemotes, locateServer, type MatchableServer } from '../../../core/forge/remote-url';
import type { ChooseAccountAnswer, ChooseAccountRequest, ForgeGitOperation, HostDefaultsView, RemoteEndpoint, RepoAccountsView } from '../../../shared/forge/bindings';
import type { CiAction, CiState, CiStatusView, CiTarget, CommitStatusView, JobLogView } from '../../../shared/forge/ci';
import type { LocalizedText } from '../../../shared/localized-text';
import { l } from '../../../core/l10n';
import { FORGE_LINK_ACTIONS, FULL_SHA, type CommitOnRemote, type ForgeLinkRequest, type ForgeLinkResult, type ForgeLinkTarget } from '../../../shared/forge/links';
import { isReferencePath, MAX_REFERENCE_NUMBER, referenceLabel, type ForgeReference } from '../../../shared/forge/references';
import { MAX_AUTHOR_EMAIL_CHARS, MAX_AUTHOR_NAME_CHARS, MAX_HISTORY_AUTHORS, type AuthorAvatars, type ContainingChange, type HistoryAuthor, type HistoryForgeContext } from '../../../shared/forge/history';
import type { CloneAccountsView, ClonePasteAnswer, CloneSearchAnswer, CloneSource, CloneStartAnswer } from '../../../shared/forge/clone';
import { isRepoPath } from '../../preload/scm-channels';
import type { OverlayAnswer } from '../../preload/overlay-channels';
import type { CiCommitStatus, CiLog, CiRepo, CiStatus } from '../../../core/forge/ci-watch';
import { MAX_OVERLAY_COORDINATE, type OverlayRect } from '../../preload/overlay-channels';
import type { HostColor } from '../../../shared/host-colors';
import { authorityKeyOfProject } from '../../../shared/project-location';
import type { CiChanged, ForgeChanged } from '../../preload/forge-channels';
import type { ShellJobLogTab } from '../../preload/shell-channels';
import type { CoreClient } from '../core-client';
import type { ForgeAccountAsker } from '../overlay';
import type { ScmRepositoryRef, ScmServiceClient } from '../scm/scm-client';
import { parseRootKey } from '../../preload/folder-root';
import type { ClonePickerRequest, ForgeOverlayActions } from './forge-overlay-channels';
import type { FlowStart, ForkState, PublishOwnersAnswer, PublishState, PublishVisibility } from '../../../shared/forge/publish';
import type { OverlayRequest } from '../../preload/overlay-channels';
import { PublishFlow } from './publish-flow';
import { ProtectedPushFlow } from './protected-push-flow';
import type { BranchNameCheck, ProtectedPushState } from '../../../shared/forge/protected-push';
import { SCM_COMMIT_PROTECTED_BRANCHES_FEATURE, type RemoteBranchProtection } from '../../../shared/forge/branch-protection';

/** The daemon feature that serves scm.call remoteEndpoints; an older daemon is read through remotes, aliases unresolved. */
export const REMOTE_ENDPOINTS_FEATURE = 'scm.remoteEndpoints';
/** The daemon feature that serves scm.call commitOnRemote; an older daemon's links are made without the published check. */
export const COMMIT_ON_REMOTE_FEATURE = 'scm.commitOnRemote';
// a burst of config writes (git remote add, set-url) reads the endpoints again once
const CONFIG_SETTLE_MS = 500;
// a commit waits this long for core's answer from memory, so a restarting core or a slow target lets it go on unprompted
const PROTECTION_WAIT_MS = 2_000;

export interface ForgeHostDeps {
  /** This computer's core, waited for through a restart. */
  readonly core: <T>(label: string, work: (client: CoreClient) => Promise<T>) => Promise<T>;
  readonly scm: Pick<ScmServiceClient, 'repository' | 'remoteEndpoints' | 'remotes' | 'commitOnRemote' | 'resolveTypedCommit' | 'onDidChange' | 'addRemote' | 'removeRemote' | 'renameRemote' | 'push' | 'artifacts' | 'remoteBranches' | 'createBranch' | 'currentStatus'>;
  /** What the authority's daemon listed in its welcome; undefined for 'local' or a host not connected. */
  readonly features: (authorityKey: string) => readonly string[] | undefined;
  /** The project's name as the project list shows it. */
  readonly projectName: (projectKey: string) => string;
  /** A saved remote host's badge; undefined for 'local' or an authority no saved host has. */
  readonly savedHost: (authorityKey: string) => { readonly hostName: string; readonly color?: HostColor } | undefined;
  readonly asker: ForgeAccountAsker;
  /** Settings › Models & accounts › Git hosting, at the server's row with its sign-in panel open when signIn. */
  readonly openAccounts: (target: { readonly serverId?: string; readonly signIn?: boolean }) => void;
  /** Core's text in main's language. */
  readonly render: (text: LocalizedText) => string;
  /** The user's browser, for an address main built (a user's click). */
  readonly openExternal: (url: string) => Promise<void>;
  /**
   * The web URLs of the servers with an account (the forge mirror): main opens CI pages on their origins only. Undefined
   * while this computer's running core has not published the mirror yet.
   */
  readonly serverWebUrls: () => readonly string[] | undefined;
  /** The servers with an account as the forge mirror lists them, for matching a remote; undefined before the mirror. */
  readonly accountServers: () => readonly MatchableServer[] | undefined;
  /** Electron's clipboard: a copied permalink never crosses a renderer. */
  readonly writeClipboard: (text: string) => void;
  /** The clone picker overlay for this request; its answer once it closed: dismissed, or "Open Git hosting settings". */
  readonly showClonePicker: (request: ClonePickerRequest) => Promise<OverlayAnswer | undefined>;
  /** ScmHost.cloneFromPicker: the polite status, the folder pick, the clone and its binding. */
  readonly startClone: (clone: { readonly url: string; readonly recursive: boolean; readonly status: string; readonly account?: { readonly serverId: string; readonly accountId: string } }) => void;
  /** The job list popover of repoId, end-aligned to anchor; settles once it closes. */
  readonly showPipelinePopover: (repoId: string, anchor: OverlayRect) => Promise<void>;
  /** Opens or focuses the job's log tab (main/forge/job-log-tabs.ts), focused: a user's click. */
  readonly openJobLog: (repoId: string, jobId: number) => Promise<void>;
  /** The Publish, fork and protected-branch dialogs: shown and answered, and each one's state pushed while it is open. */
  readonly dialogs: {
    ask(request: OverlayRequest): Promise<OverlayAnswer>;
    publishState(state: PublishState): void;
    forkState(state: ForkState): void;
    protectedState(state: ProtectedPushState): void;
  };
  /** Toasts of the publish and fork flows; warn settles true when its action was chosen. */
  readonly notify: {
    info(message: string): void;
    warn(message: string, action: string): Promise<boolean>;
    error(message: string): void;
  };
  readonly log: (line: string) => void;
}

const STATUS_WATCH = 'status:';
const SHA = FULL_SHA;
const MAX_LINE = 10_000_000;
const isLine = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_LINE;
// overlay.ts's parseRect, which this module cannot import without Electron
function anchorOf(raw: unknown): OverlayRect | undefined {
  const value = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  const [x, y, width, height] = ['x', 'y', 'width', 'height'].map((key) => value?.[key]);
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= MAX_OVERLAY_COORDINATE;
  return value && Object.keys(value).length === 4 && ok(x) && ok(y) && ok(width) && ok(height) ? { x, y, width, height } : undefined;
}

const isCiId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** A CI target from a renderer, rebuilt field by field; undefined when malformed. */
export function parseCiTarget(raw: unknown): CiTarget | undefined {
  const value = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  if (!value || Object.keys(value).length !== 1) return undefined;
  if (isCiId(value['jobId'])) return { jobId: value['jobId'] };
  if (isCiId(value['pipelineId'])) return { pipelineId: value['pipelineId'] };
  if (isCiId(value['runId'])) return { runId: value['runId'] };
  if (typeof value['sha'] === 'string' && FULL_SHA.test(value['sha'])) return { sha: value['sha'] };
  return undefined;
}

export const isCiAction = (value: unknown): value is CiAction => value === 'retry' || value === 'cancel';

/** A job of the chip's pipeline as its log tab names it. */
export type CiJobName = { readonly name: string; readonly state: CiState } & Pick<ShellJobLogTab, 'pipelineNumber' | 'workflow'>;

/** Core's CI view with its text in main's language. */
export function renderCiStatus(view: CiStatus | null, render: (text: LocalizedText) => string): CiStatusView | null {
  return view?.status === 'error' ? { status: 'error', message: render(view.message) } : view;
}

export function renderJobLog(view: CiLog, render: (text: LocalizedText) => string): JobLogView {
  return view.status === 'error' ? { ...view, message: render(view.message) } : view;
}

function renderCommitStatus(view: CiCommitStatus | null, render: (text: LocalizedText) => string): CommitStatusView | null {
  return view?.status === 'error' ? { status: 'error', message: render(view.message) } : view;
}

interface CiWatchState {
  visible: boolean;
  // the repository as core last watched it, as JSON
  sent?: string;
  // whether core last heard the watch shown
  sentActive?: boolean;
  status?: CiStatusView | null;
  // the definition in flight, which a send asked meanwhile follows
  sending?: Promise<CiStatusView | null>;
  sendAgain?: boolean;
}

const isId = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');

function fields(raw: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const value = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  const keys = value ? Object.keys(value) : [];
  if (!value || !required.every((key) => Object.hasOwn(value, key)) || !keys.every((key) => required.includes(key) || optional.includes(key))) {
    throw new Error('Malformed forge call from the shell');
  }
  return value;
}

/** A clone's folder-like name from its URL's last path segment, for the Choose account dialog's title. */
function cloneName(endpoints: readonly RemoteEndpoint[]): string {
  const path = endpoints[0]?.fetch?.path ?? '';
  return path.split('/').filter((segment) => segment !== '').pop()?.replace(/\.git$/, '') ?? path;
}

/** A reference from a renderer, rebuilt field by field: a sigil, a number in range and a path the scanner would read. */
export function parseForgeReference(raw: unknown): ForgeReference {
  const { sigil, number, path } = fields(raw, ['sigil', 'number'], ['path']);
  const valid = (sigil === '#' || sigil === '!')
    && typeof number === 'number' && Number.isSafeInteger(number) && number >= 1 && number <= MAX_REFERENCE_NUMBER
    && (path === undefined || (typeof path === 'string' && isReferencePath(path)));
  if (!valid) throw new Error('Malformed forge reference');
  return { sigil, number, ...(path !== undefined ? { path: path as string } : {}) };
}

/** A link request from a renderer, rebuilt field by field; throws on anything else. */
export function parseForgeLinkRequest(raw: unknown): ForgeLinkRequest {
  const call = fields(raw, ['action', 'repoId'], ['path', 'sha', 'startLine', 'endLine', 'modified', 'reference']);
  const { action, repoId, path, sha, startLine, endLine, modified, reference } = call;
  if (action === 'openReference') {
    if (!isId(repoId) || path !== undefined || sha !== undefined || startLine !== undefined || endLine !== undefined || modified !== undefined) throw new Error('Malformed forge link request');
    return { action, repoId, reference: parseForgeReference(reference) };
  }
  const file = action === 'copyPermalink' || action === 'openFile';
  const valid = (FORGE_LINK_ACTIONS as readonly unknown[]).includes(action)
    && isId(repoId)
    && reference === undefined
    && (sha === undefined || (typeof sha === 'string' && FULL_SHA.test(sha)))
    && (file ? isRepoPath(path) && (modified === undefined || typeof modified === 'boolean') : path === undefined && startLine === undefined && endLine === undefined && modified === undefined)
    && (startLine === undefined ? endLine === undefined : isLine(startLine) && (endLine === undefined || (isLine(endLine) && startLine <= endLine)));
  if (!valid) throw new Error('Malformed forge link request');
  return {
    action: action as ForgeLinkRequest['action'],
    repoId: repoId as string,
    ...(path !== undefined ? { path: path as string } : {}),
    ...(sha !== undefined ? { sha: sha as string } : {}),
    ...(startLine !== undefined ? { startLine: startLine as number } : {}),
    ...(endLine !== undefined ? { endLine: endLine as number } : {}),
    ...(modified === true ? { modified: true } : {}),
  };
}

const isAuthorText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !value.includes('\0');

/** One history page's authors from a renderer, rebuilt field by field: at most 100, each a full sha, an email and a name. */
export function parseHistoryAuthors(raw: unknown): HistoryAuthor[] {
  if (!Array.isArray(raw) || raw.length > MAX_HISTORY_AUTHORS) throw new Error('Malformed history authors');
  return raw.map((item: unknown) => {
    const { sha, email, name } = fields(item, ['sha', 'email', 'name']);
    if (typeof sha !== 'string' || !FULL_SHA.test(sha) || !isAuthorText(email, MAX_AUTHOR_EMAIL_CHARS) || !isAuthorText(name, MAX_AUTHOR_NAME_CHARS)) {
      throw new Error('Malformed history author');
    }
    return { sha, email, name };
  });
}

export class ForgeHost implements ForgeOverlayActions, Disposable {
  private readonly deps: ForgeHostDeps;
  // each open repository's endpoints, read once until its config may have changed
  private readonly endpoints = new Map<string, Promise<readonly RemoteEndpoint[]>>();
  private readonly listeners = new Set<(changed: ForgeChanged) => void>();
  private readonly subscriptions: Disposable[];
  private readonly configTimers = new Map<string, NodeJS.Timeout>();
  private readonly ciWatches = new Map<string, CiWatchState>();
  private readonly ciListeners = new Set<(changed: CiChanged) => void>();
  private readonly ciLogListeners = new Set<(id: string, view: CiLog) => void>();
  private readonly retargetListeners = new Set<(repoId: string, jobId: number, newJobId: number) => void>();
  // main sets it from the window once the window exists
  private windowFocused = false;
  // each open clone picker's section searches in flight, by the picker's request, then account id
  private readonly cloneSearches = new Map<ClonePickerRequest, Map<string, AbortController>>();
  private readonly flows: PublishFlow;
  private readonly protectedPushes: ProtectedPushFlow;
  // open repositories, and those whose server branch protection was asked for with an account, so core reads it before the
  // first commit
  private readonly openRepos = new Set<string>();
  private readonly protectionWarmed = new Set<string>();

  constructor(deps: ForgeHostDeps) {
    this.deps = deps;
    this.flows = new PublishFlow({
      core: deps.core,
      scm: {
        repository: (repoId) => this.repository(repoId),
        remotes: (...args) => deps.scm.remotes(...args),
        addRemote: (...args) => deps.scm.addRemote(...args),
        removeRemote: (...args) => deps.scm.removeRemote(...args),
        renameRemote: (...args) => deps.scm.renameRemote(...args),
        push: (...args) => deps.scm.push(...args),
      },
      features: deps.features,
      endpoints: (repoId) => this.endpointsOf(repoId),
      serverKind: (location) => {
        const servers = deps.accountServers();
        return servers === undefined ? undefined : locateServer(location, servers)?.server.kind;
      },
      projectName: deps.projectName,
      bind: async (projectKey, bind) => {
        const saved = await deps.core('forge bindAccount', (client) => client.forgeBindAccount(projectKey, bind.serverId, bind.accountId));
        if (saved) this.fire({ projectKeys: [projectKey] });
        return saved;
      },
      openOnServer: (url) => this.openOnManagedOrigin(url),
      ask: (request) => deps.dialogs.ask(request),
      pushPublishState: (state) => deps.dialogs.publishState(state),
      pushForkState: (state) => deps.dialogs.forkState(state),
      render: deps.render,
      notify: deps.notify,
      log: deps.log,
    });
    this.protectedPushes = new ProtectedPushFlow({
      core: deps.core,
      scm: {
        repository: (repoId) => this.repository(repoId),
        currentStatus: (...args) => deps.scm.currentStatus(...args),
        artifacts: (...args) => deps.scm.artifacts(...args),
        remoteBranches: (...args) => deps.scm.remoteBranches(...args),
        createBranch: (...args) => deps.scm.createBranch(...args),
        push: (...args) => deps.scm.push(...args),
      },
      features: deps.features,
      endpoints: (repoId) => this.endpointsOf(repoId),
      openOnServer: (url) => this.openOnManagedOrigin(url),
      ask: (request) => deps.dialogs.ask(request),
      pushState: (state) => deps.dialogs.protectedState(state),
      render: deps.render,
      notify: { info: deps.notify.info, error: deps.notify.error },
      log: deps.log,
    });
    this.subscriptions = [deps.scm.onDidChange((event) => {
      if (event.kind === 'repository' && !deps.scm.repository(event.repoId)) {
        this.endpoints.delete(event.repoId);
        this.openRepos.delete(event.repoId);
        this.protectionWarmed.delete(event.repoId);
        this.ciUnwatch(event.repoId);
      } else if (event.kind === 'repository') {
        this.openRepos.add(event.repoId);
        if (!this.protectionWarmed.has(event.repoId)) this.warmWithAccount(event.repoId);
      }
      if (event.kind === 'repository' && deps.scm.repository(event.repoId) && this.ciWatches.has(event.repoId)) {
        // another branch or HEAD is another pipeline
        this.sendCiWatch(event.repoId).catch((err: unknown) => this.logCi(event.repoId, err));
      }
      if (event.kind !== 'artifacts' || event.config !== true || !this.endpoints.has(event.repoId)) return;
      clearTimeout(this.configTimers.get(event.repoId));
      this.configTimers.set(event.repoId, setTimeout(() => {
        this.configTimers.delete(event.repoId);
        void this.rereadEndpoints(event.repoId);
      }, CONFIG_SETTLE_MS));
    })];
  }

  /** This computer's core attached: its forge events from now on. */
  attach(client: CoreClient): Disposable {
    const subscriptions = [
      client.onForgeChooseAccountRows((rows) => this.deps.asker.pushForgeChooseAccountRows(rows)),
      client.onForgeBindingsChanged((change) => this.fire(change)),
      client.onForgeChanged(() => {
        this.fire({});
        for (const repoId of this.openRepos) this.warmWithAccount(repoId);
      }),
      client.onForgeCiChanged((event) => {
        if ('log' in event) {
          for (const listener of [...this.ciLogListeners]) listener(event.id, event.log);
          return;
        }
        if (!event.id.startsWith(STATUS_WATCH)) return;
        const repoId = event.id.slice(STATUS_WATCH.length);
        const watch = this.ciWatches.get(repoId);
        if (!watch) return;
        watch.status = renderCiStatus(event.status, this.deps.render);
        this.fireCi({ repoId, status: watch.status });
      }),
    ];
    // a new core holds no watch: each is defined again
    for (const [repoId, watch] of this.ciWatches) {
      delete watch.sent;
      this.sendCiWatch(repoId).catch((err: unknown) => this.logCi(repoId, err));
    }
    return { dispose: () => subscriptions.forEach((subscription) => subscription.dispose()) };
  }

  onChanged(listener: (changed: ForgeChanged) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- the shell's channels (FORGE_CHANNELS); raw payloads are checked field by field

  async repoAccounts(raw: unknown): Promise<RepoAccountsView | null> {
    const call = fields(raw, ['repoId'], ['recheck']);
    if (!isId(call['repoId']) || (call['recheck'] !== undefined && typeof call['recheck'] !== 'boolean')) throw new Error('Malformed forge repoAccounts call from the shell');
    const ref = this.repository(call['repoId']);
    if (!ref) return null;
    const endpoints = await this.openEndpoints(call['repoId']);
    if (!endpoints) return null;
    const pushRemote = ref.repo.lastStatus?.upstream?.remote;
    const view = await this.deps.core('forge repoAccounts', (client) => client.forgeRepoAccounts({
      projectKey: ref.projectKey,
      authorityKey: ref.repo.authority,
      project: this.deps.projectName(ref.projectKey),
      ...(pushRemote !== undefined ? { pushRemote } : {}),
      endpoints,
      ...(call['recheck'] === true ? { recheck: true } : {}),
    }));
    return view ?? null;
  }

  async chooseAccountFromShell(raw: unknown): Promise<boolean> {
    const call = fields(raw, ['repoId', 'serverId', 'accountId']);
    const { repoId, serverId, accountId } = call;
    if (!isId(repoId) || !isId(serverId) || (accountId !== null && !isId(accountId))) throw new Error('Malformed forge chooseAccount call from the shell');
    const ref = this.repository(repoId);
    if (!ref) return false;
    return this.deps.core('forge bindAccount', (client) => client.forgeBindAccount(ref.projectKey, serverId, accountId as string | null));
  }

  async openAccountsFromShell(raw: unknown): Promise<void> {
    const call = fields(raw, [], ['serverId', 'signIn']);
    if ((call['serverId'] !== undefined && !isId(call['serverId'])) || (call['signIn'] !== undefined && call['signIn'] !== true)) throw new Error('Malformed forge openAccounts call from the shell');
    await this.openAccounts({ ...(call['serverId'] !== undefined ? { serverId: call['serverId'] as string } : {}), ...(call['signIn'] === true ? { signIn: true } : {}) });
  }

  // ---- CI (docs/invariants.md "GitHub and GitLab accounts", CI): core watches by main's ids, and main says when each is shown

  onCiChanged(listener: (changed: CiChanged) => void): () => void {
    this.ciListeners.add(listener);
    return () => this.ciListeners.delete(listener);
  }

  /** A log watch's update from core, for main/forge/job-log-tabs.ts. */
  onCiLog(listener: (id: string, view: CiLog) => void): () => void {
    this.ciLogListeners.add(listener);
    return () => this.ciLogListeners.delete(listener);
  }

  /** A retry gave a job a new id: the job log tab of the old one follows it. */
  onJobRetargeted(listener: (repoId: string, jobId: number, newJobId: number) => void): () => void {
    this.retargetListeners.add(listener);
    return () => this.retargetListeners.delete(listener);
  }

  /** The window was focused or blurred: a blurred window polls nothing. */
  setWindowFocused(focused: boolean): void {
    if (this.windowFocused === focused) return;
    this.windowFocused = focused;
    for (const repoId of this.ciWatches.keys()) this.syncCiActive(repoId).catch((err: unknown) => this.logCi(repoId, err));
  }

  isWindowFocused(): boolean {
    return this.windowFocused;
  }

  /** A job of the pipeline the repository's chip shows, for its log tab's name before the log is read. */
  ciJob(repoId: string, jobId: number): CiJobName | undefined {
    const status = this.ciWatches.get(repoId)?.status;
    if (status?.status !== 'ready') return undefined;
    const { pipeline } = status;
    const job = pipeline.jobs.find((candidate) => candidate.id === jobId);
    if (!job) return undefined;
    // a GitHub commit's checks have no number; its job shows its workflow instead
    if (pipeline.kind === 'gitlab') return { name: job.name, state: job.state, pipelineNumber: pipeline.number };
    return { name: job.name, state: job.state, ...(job.stage !== '' ? { workflow: job.stage } : {}) };
  }

  /** Whether the repository's chip shows a pipeline (the palette's Show Pipeline). */
  pipelineShown(repoId: string): boolean {
    return this.ciWatches.get(repoId)?.status?.status === 'ready';
  }

  async ciStatusFromShell(raw: unknown): Promise<CiStatusView | null> {
    const call = fields(raw, ['repoId']);
    if (!isId(call['repoId'])) throw new Error('Malformed forge ciStatus call from the shell');
    return this.ciStatus(call['repoId']);
  }

  async ciWatchFromShell(raw: unknown): Promise<void> {
    const call = fields(raw, ['repoId', 'visible']);
    const { repoId, visible } = call;
    if (!isId(repoId) || typeof visible !== 'boolean') throw new Error('Malformed forge ciWatch call from the shell');
    if (!this.repository(repoId)) return;
    const watch = this.ciWatches.get(repoId);
    if (watch) watch.visible = visible;
    else this.ciWatches.set(repoId, { visible });
    // defined once; a change of visibility after that only shows or hides it
    if (watch?.sent === undefined || watch.sending) await this.sendCiWatch(repoId);
    else await this.syncCiActive(repoId);
  }

  async showPipelineFromShell(raw: unknown): Promise<void> {
    const call = fields(raw, ['repoId', 'anchor']);
    const anchor = anchorOf(call['anchor']);
    if (!isId(call['repoId']) || !anchor) throw new Error('Malformed forge showPipeline call from the shell');
    if (!this.repository(call['repoId'])) return;
    await this.deps.showPipelinePopover(call['repoId'], anchor);
  }

  async jobActionFromShell(raw: unknown): Promise<boolean> {
    const call = fields(raw, ['repoId', 'target', 'action']);
    const target = parseCiTarget(call['target']);
    if (!isId(call['repoId']) || !target || !isCiAction(call['action'])) throw new Error('Malformed forge jobAction call from the shell');
    return this.jobAction(call['repoId'], target, call['action']);
  }

  async openOnServerFromShell(raw: unknown): Promise<string | null> {
    const call = fields(raw, ['repoId', 'target']);
    const target = parseCiTarget(call['target']);
    if (!isId(call['repoId']) || !target) throw new Error('Malformed forge openOnServer call from the shell');
    return this.openOnServer(call['repoId'], target);
  }

  async commitStatusFromShell(raw: unknown): Promise<CommitStatusView | null> {
    const call = fields(raw, ['repoId', 'sha'], ['retry']);
    const { repoId, sha, retry } = call;
    if (!isId(repoId) || typeof sha !== 'string' || !SHA.test(sha) || (retry !== undefined && retry !== true)) throw new Error('Malformed forge commitStatus call from the shell');
    const repo = await this.ciRepo(repoId);
    if (!repo) return null;
    const view = await this.core('forge ci commitStatus', (client) => client.forgeCiCommitStatus({ repo, sha, retry: retry === true }));
    return renderCommitStatus(view, this.deps.render);
  }

  // ---- history details: the repository's endpoints from its own core, the answers from this computer's core

  async historyContextFromShell(raw: unknown): Promise<HistoryForgeContext | null> {
    const call = fields(raw, ['repoId']);
    if (!isId(call['repoId'])) throw new Error('Malformed forge historyContext call from the shell');
    const repo = await this.ciRepo(call['repoId']);
    if (!repo) return null;
    return this.core('forge history context', (client) => client.forgeHistoryContext({ repo }));
  }

  async authorAvatarsFromShell(raw: unknown): Promise<AuthorAvatars> {
    const call = fields(raw, ['repoId', 'authors']);
    if (!isId(call['repoId'])) throw new Error('Malformed forge authorAvatars call from the shell');
    const authors = parseHistoryAuthors(call['authors']);
    const repo = authors.length > 0 ? await this.ciRepo(call['repoId']) : undefined;
    if (!repo) return {};
    return this.core('forge history avatars', (client) => client.forgeHistoryAvatars({ repo, authors }));
  }

  async containingChangeFromShell(raw: unknown): Promise<ContainingChange | null> {
    const call = fields(raw, ['repoId', 'sha']);
    const { repoId, sha } = call;
    if (!isId(repoId) || typeof sha !== 'string' || !SHA.test(sha)) throw new Error('Malformed forge containingChange call from the shell');
    const repo = await this.ciRepo(repoId);
    if (!repo) return null;
    return this.core('forge history containing', (client) => client.forgeHistoryContaining({ repo, sha }));
  }

  /** The repository's CI, defining its watch (not shown) when there is none yet. */
  async ciStatus(repoId: string): Promise<CiStatusView | null> {
    if (!this.repository(repoId)) return null;
    const watch = this.ciWatches.get(repoId);
    if (watch?.status !== undefined) return watch.status;
    if (!watch) this.ciWatches.set(repoId, { visible: false });
    return this.sendCiWatch(repoId);
  }

  /** The job list opened: the repository's CI read now. */
  async pipeline(repoId: string): Promise<CiStatusView | null> {
    const watch = this.ciWatches.get(repoId);
    if (watch?.sent === undefined) return this.ciStatus(repoId);
    const view = renderCiStatus(await this.core('forge ci jobs', (client) => client.forgeCiJobs(STATUS_WATCH + repoId)), this.deps.render);
    watch.status = view;
    return view;
  }

  async jobLogOpenFromShell(raw: unknown): Promise<void> {
    const call = fields(raw, ['repoId', 'jobId']);
    if (!isId(call['repoId']) || !isCiId(call['jobId'])) throw new Error('Malformed forge jobLogOpen call from the shell');
    return this.jobLogOpen(call['repoId'], call['jobId']);
  }

  async jobLogOpen(repoId: string, jobId: number): Promise<void> {
    if (!this.repository(repoId)) return;
    await this.deps.openJobLog(repoId, jobId);
  }

  async jobAction(repoId: string, target: CiTarget, action: CiAction): Promise<boolean> {
    // a commit's checks only open
    if ('sha' in target) return false;
    const repo = await this.ciRepo(repoId);
    if (!repo) return false;
    const answer = await this.core('forge ci jobAction', (client) => client.forgeCiJobAction({ repo, target, action }));
    if (answer.ok && answer.jobId !== undefined && 'jobId' in target && answer.jobId !== target.jobId) {
      for (const listener of [...this.retargetListeners]) listener(repoId, target.jobId, answer.jobId);
    }
    return answer.ok;
  }

  /** Opens the server's page of the pipeline or job at an address main checked against the server's web origin; the server's name, or null. */
  async openOnServer(repoId: string, target: CiTarget): Promise<string | null> {
    const repo = await this.ciRepo(repoId);
    if (!repo) return null;
    const page = await this.core('forge ci webUrl', (client) => client.forgeCiWebUrl({ repo, target }));
    if (!page) return null;
    return (await this.openOnManagedOrigin(page.url)) ? page.serverName : null;
  }

  /** The guarded opener of a user's click: only an https address on the web origin of a server with an account opens. */
  private async openOnManagedOrigin(address: string): Promise<boolean> {
    const url = this.managedOrigin(address);
    if (!url) return false;
    await this.deps.openExternal(url.href);
    return true;
  }

  // ---- publish and fork on a denied push (main/forge/publish-flow.ts)

  /** Publish of a repository with no remote: the Publish dialog, noAccount when no signed-in account can publish, closed when the repository is gone. */
  publishToAccount(repoId: string, branch: string): Promise<'noAccount' | 'shown' | 'closed'> {
    return this.flows.publish(repoId, branch);
  }

  /** A push of branch to remote failed: true once the fork dialog or an organization notice took its place. */
  pushRefused(repoId: string, remote: string, branch: string, err: unknown): Promise<boolean> {
    return this.flows.pushRefused(repoId, remote, branch, err);
  }

  /** A push of localBranch to branch on remote was refused: true once the protected-branch dialog took its place. */
  pushProtected(repoId: string, remote: string, branch: string, localBranch: string, err: unknown): Promise<boolean> {
    return this.protectedPushes.pushRefused(repoId, remote, branch, localBranch, err);
  }

  publishOwners(requestId: string, accountId: string): Promise<PublishOwnersAnswer> {
    return this.flows.publishOwners(requestId, accountId);
  }

  protectedCheckName(requestId: string, name: string): Promise<BranchNameCheck> {
    return this.protectedPushes.checkName(requestId, name);
  }

  /** Starts Push to a New Branch, whose steps follow on the dialog's state pushes; ignored: nothing runs. */
  protectedPush(requestId: string, name: string): FlowStart {
    return this.protectedPushes.push(requestId, name);
  }

  publishOpen(requestId: string): boolean {
    return this.flows.isPublishOpen(requestId);
  }

  forkOpen(requestId: string): boolean {
    return this.flows.isForkOpen(requestId);
  }

  /** Starts the publish, whose steps follow on the dialog's state pushes; ignored: nothing runs. */
  publishSubmit(requestId: string, owner: string, name: string, visibility: PublishVisibility): FlowStart {
    return this.flows.publishSubmit(requestId, owner, name, visibility);
  }

  /** Starts Fork and Push, whose steps follow on the dialog's state pushes; ignored: nothing runs. */
  forkStart(requestId: string): FlowStart {
    return this.flows.forkStart(requestId);
  }

  // ---- branch protection from the server (docs/invariants.md "GitHub and GitLab accounts", branch protection)

  /** The rules this computer's core holds for the repository's remotes, for its commit; never rejects, waits at most 2 s. */
  async protectedBranches(repoId: string): Promise<readonly RemoteBranchProtection[]> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<readonly RemoteBranchProtection[]>((resolve) => {
      timer = setTimeout(() => {
        this.deps.log(`[forge] the branch protection of ${repoId} took over ${PROTECTION_WAIT_MS} ms, so the commit goes on without it`);
        resolve([]);
      }, PROTECTION_WAIT_MS);
    });
    try {
      return await Promise.race([this.readProtection(repoId), timeout]);
    } catch (err) {
      this.deps.log(`[forge] the branch protection of ${repoId} could not be read, so the commit goes on without it: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  private async readProtection(repoId: string): Promise<readonly RemoteBranchProtection[]> {
    const authority = this.repository(repoId)?.repo.authority;
    if (authority === undefined || !this.accountMirrored()) return [];
    // an older daemon's commit drops the rules, so they are not read for it
    if (authority !== 'local' && !this.deps.features(authority)?.includes(SCM_COMMIT_PROTECTED_BRANCHES_FEATURE)) return [];
    const repo = await this.ciRepo(repoId);
    if (!repo) return [];
    return this.core('forge branchProtection', (client) => client.forgeBranchProtection({ repo }));
  }

  // Marked warmed only when an account is mirrored, so a repository that opened before the forge mirror is warmed when it arrives.
  private warmWithAccount(repoId: string): void {
    if (!this.accountMirrored()) return;
    this.protectionWarmed.add(repoId);
    this.warmProtection(repoId);
  }

  /** Core reads a repository's rules in the background, so its first commit can ask. */
  private warmProtection(repoId: string): void {
    this.readProtection(repoId).catch((err: unknown) => this.deps.log(`[forge] reading the branch protection of ${repoId} failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** What core needs of a repository for CI: its project, endpoints, push remote, branch and HEAD. */
  async ciRepo(repoId: string): Promise<CiRepo | undefined> {
    const ref = this.repository(repoId);
    if (!ref) return undefined;
    const endpoints = await this.openEndpoints(repoId);
    if (!endpoints) return undefined;
    const status = ref.repo.lastStatus;
    const pushRemote = status?.upstream?.remote;
    // the branch as the server names it: the upstream's, else the local one
    const branch = status?.upstream?.branch ?? (status?.head?.type === 'branch' ? status.head.name : undefined);
    const sha = status?.commit?.hash;
    return {
      projectKey: ref.projectKey,
      authorityKey: ref.repo.authority,
      project: this.deps.projectName(ref.projectKey),
      ...(pushRemote !== undefined ? { pushRemote } : {}),
      endpoints,
      ...(branch !== undefined ? { branch } : {}),
      ...(sha !== undefined && SHA.test(sha) ? { sha } : {}),
    };
  }

  private ciUnwatch(repoId: string): void {
    const watch = this.ciWatches.get(repoId);
    if (!watch) return;
    this.ciWatches.delete(repoId);
    if (watch.sent !== undefined) this.core('forge ci unwatch', (client) => client.forgeCiUnwatch(STATUS_WATCH + repoId)).catch((err: unknown) => this.logCi(repoId, err));
  }

  /**
   * Defines the repository's watch in core, or updates it when the repository changed since; one definition per repository
   * is in flight, and a send asked meanwhile goes once it settled.
   */
  private sendCiWatch(repoId: string): Promise<CiStatusView | null> {
    const watch = this.ciWatches.get(repoId);
    if (!watch) return Promise.resolve(null);
    if (watch.sending) {
      watch.sendAgain = true;
      return watch.sending;
    }
    const sending = (async () => {
      let view = await this.defineCiWatch(repoId, watch);
      while (watch.sendAgain && this.ciWatches.get(repoId) === watch) {
        watch.sendAgain = false;
        view = await this.defineCiWatch(repoId, watch);
      }
      return view;
    })().finally(() => {
      delete watch.sending;
      watch.sendAgain = false;
      // shown or hidden while the definition was in flight
      this.syncCiActive(repoId).catch((err: unknown) => this.logCi(repoId, err));
    });
    watch.sending = sending;
    return sending;
  }

  private async defineCiWatch(repoId: string, watch: CiWatchState): Promise<CiStatusView | null> {
    const repo = await this.ciRepo(repoId);
    if (!repo) return null;
    const sent = JSON.stringify(repo);
    if (watch.sent === sent) return watch.status ?? null;
    watch.sent = sent;
    const active = watch.visible && this.windowFocused;
    watch.sentActive = active;
    try {
      const view = renderCiStatus(await this.core('forge ci watch', (client) => client.forgeCiWatch({ id: STATUS_WATCH + repoId, repo, active })), this.deps.render);
      if (this.ciWatches.get(repoId) !== watch) return null;
      const changed = JSON.stringify(view) !== JSON.stringify(watch.status);
      watch.status = view;
      if (changed) this.fireCi({ repoId, status: view });
      return view;
    } catch (err) {
      delete watch.sent;
      delete watch.sentActive;
      throw err;
    }
  }

  /** Tells core whether a defined watch is shown, when that changed since core last heard it. */
  private async syncCiActive(repoId: string): Promise<void> {
    const watch = this.ciWatches.get(repoId);
    if (watch?.sent === undefined || watch.sending) return;
    const active = watch.visible && this.windowFocused;
    if (watch.sentActive === active) return;
    watch.sentActive = active;
    await this.core('forge ci watch', (client) => client.forgeCiWatch({ id: STATUS_WATCH + repoId, active }));
  }

  private core<T>(label: string, work: (client: CoreClient) => Promise<T>): Promise<T> {
    return this.deps.core(label, work);
  }

  private fireCi(changed: CiChanged): void {
    for (const listener of [...this.ciListeners]) listener(changed);
  }

  private logCi(repoId: string, err: unknown): void {
    this.deps.log(`[forge] CI of ${repoId} failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ---- the overlay's channels (forge-overlay-channels.ts), whose payloads it checked

  async hostDefaults(authorityKey: string): Promise<HostDefaultsView> {
    this.requireSavedHost(authorityKey);
    return this.deps.core('forge hostDefaults', (client) => client.forgeHostDefaults(authorityKey));
  }

  async setHostDefault(authorityKey: string, serverId: string, accountId: string | null): Promise<boolean> {
    this.requireSavedHost(authorityKey);
    return this.deps.core('forge setHostDefault', (client) => client.forgeSetHostDefault(authorityKey, serverId, accountId));
  }

  openAccounts(target: { readonly serverId?: string; readonly signIn?: boolean }): Promise<void> {
    this.deps.openAccounts(target);
    return Promise.resolve();
  }

  // ---- this computer's core's CoreRequest forge.chooseAccount (HostUi.chooseForgeAccount)

  chooseAccount(request: ChooseAccountRequest, signal: AbortSignal): Promise<ChooseAccountAnswer> {
    const authority = request.projectKey !== undefined ? authorityKeyOfProject(request.projectKey) : 'local';
    const where = authority !== 'local' ? this.deps.savedHost(authority) : undefined;
    return this.deps.asker.chooseForgeAccount({ ...request, ...(where ? { where } : {}) }, signal);
  }

  // ---- before the user's own git operations (ScmHost); false: the user cancelled, and the operation must not run. The
  // account does not change git's credentials yet, so a failure to resolve it is logged and the operation runs as before.

  async prepareGitOperation(repoId: string, operation: Exclude<ForgeGitOperation, 'clone'>, remotes: readonly string[]): Promise<boolean> {
    const ref = this.repository(repoId);
    if (!ref) return true;
    try {
      const endpoints = await this.endpointsOf(repoId);
      const result = await this.deps.core('forge prepareGitOperation', (client) => client.forgePrepareGitOperation({
        operation,
        projectKey: ref.projectKey,
        authorityKey: ref.repo.authority,
        project: this.deps.projectName(ref.projectKey),
        remotes: [...remotes],
        endpoints,
      }));
      if (result.signInServerId !== undefined) this.deps.openAccounts({ serverId: result.signInServerId, signIn: true });
      return result.proceed;
    } catch (err) {
      this.deps.log(`[forge] resolving the account for ${operation} failed, so it runs without asking: ${err instanceof Error ? err.message : String(err)}`);
      return true;
    }
  }

  /** Before Clone: the account for the URL's server, asked once when nothing settles it; its explicit choice for bindClone. */
  async prepareClone(url: string): Promise<{ readonly proceed: boolean; readonly bind?: { readonly serverId: string; readonly accountId: string | null } }> {
    const endpoints = endpointsFromRemotes([{ name: 'origin', fetchUrl: url }]);
    if (endpoints[0]?.fetch === undefined) return { proceed: true };
    try {
      const result = await this.deps.core('forge prepareGitOperation', (client) => client.forgePrepareGitOperation({
        operation: 'clone',
        authorityKey: 'local',
        project: cloneName(endpoints),
        remotes: [],
        endpoints,
      }));
      if (result.signInServerId !== undefined) this.deps.openAccounts({ serverId: result.signInServerId, signIn: true });
      return { proceed: result.proceed, ...(result.bind ? { bind: result.bind } : {}) };
    } catch (err) {
      this.deps.log(`[forge] resolving the account for clone failed, so it runs without asking: ${err instanceof Error ? err.message : String(err)}`);
      return { proceed: true };
    }
  }

  /** The clone's project was added: the Choose account dialog's explicit choice, or the clone picker's account, becomes its binding; announce: the dialog's. */
  async bindClone(projectKey: string, bind: { readonly serverId: string; readonly accountId: string | null }, announce: boolean): Promise<void> {
    const saved = await this.deps.core('forge bindAccount', (client) => client.forgeBindAccount(projectKey, bind.serverId, bind.accountId));
    if (!saved) return;
    this.fire(announce ? { projectKeys: [projectKey], chosen: { projectKey, serverId: bind.serverId, accountId: bind.accountId, operation: 'clone' } } : { projectKeys: [projectKey] });
  }

  // ---- links (docs/invariants.md "GitHub and GitLab accounts", links): core builds the address on a managed server, the
  // project's own core says whether the commit is published, and main opens or copies it; no renderer sees it

  /** A user's click or command: opens or copies the link, or says why not. */
  async link(request: ForgeLinkRequest): Promise<ForgeLinkResult> {
    const unavailable = (text: LocalizedText): ForgeLinkResult => ({ kind: 'unavailable', reason: this.deps.render(text) });
    const ref = this.repository(request.repoId);
    if (!ref) return unavailable(l('The repository is no longer open.'));
    if (request.action === 'openReference') return this.openReference(request.repoId, request.reference!, unavailable);
    // read now on the repository's own core: the status mirror can still hold the HEAD before a commit made outside Damocles
    const head = await this.deps.scm.resolveTypedCommit(request.repoId, 'HEAD');
    const sha = request.sha ?? head;
    if (sha === undefined || !FULL_SHA.test(sha)) return unavailable(l('This repository has no commit to link to yet.'));
    const repo = await this.ciRepo(request.repoId);
    if (!repo) return unavailable(l('The repository is no longer open.'));
    const target: ForgeLinkTarget = request.action === 'openCommit'
      ? { kind: 'commit', sha }
      : { kind: 'file', sha, path: request.path!, ...(request.startLine !== undefined ? { range: { start: request.startLine, end: request.endLine ?? request.startLine } } : {}) };
    const built = await this.core('forge link', (client) => client.forgeLink({ repo, target }));
    if ('unavailable' in built) return unavailable(built.unavailable);
    const label = target.kind === 'file' ? target.path : sha.slice(0, 7);
    // a file's lines can differ from the commit's only when the link is at HEAD
    const check = await this.commitOnRemote(request.repoId, ref.repo.authority, sha, target.kind === 'file' && sha === head ? target.path : undefined, built.remote);
    if (check && !check.onRemote) return { kind: 'unpushed', serverName: built.serverName, label, canPush: check.ahead };
    const url = this.managedOrigin(built.url);
    if (!url) return unavailable(l('Damocles cannot build a link for this repository.'));
    const dirty = check?.dirty === true || request.modified === true;
    if (request.action === 'copyPermalink') {
      this.deps.writeClipboard(url.href);
      return { kind: 'copied', serverName: built.serverName, label, dirty };
    }
    await this.deps.openExternal(url.href);
    return { kind: 'opened', serverName: built.serverName, label, dirty };
  }

  /** An issue or merge request a commit message names, on the repository's server: core builds the page, main opens it. */
  private async openReference(repoId: string, reference: ForgeReference, unavailable: (text: LocalizedText) => ForgeLinkResult): Promise<ForgeLinkResult> {
    const repo = await this.ciRepo(repoId);
    if (!repo) return unavailable(l('The repository is no longer open.'));
    const built = await this.core('forge link', (client) => client.forgeLink({ repo, target: { kind: 'reference', reference } }));
    if ('unavailable' in built) return unavailable(built.unavailable);
    const url = this.managedOrigin(built.url);
    if (!url) return unavailable(l('Damocles cannot build a link for this repository.'));
    await this.deps.openExternal(url.href);
    return { kind: 'opened', serverName: built.serverName, label: referenceLabel(reference), dirty: false };
  }

  /** The address when it is https on the web origin of a server with an account, else undefined (logged). */
  private managedOrigin(address: string): URL | undefined {
    const url = URL.canParse(address) ? new URL(address) : undefined;
    const origins = new Set((this.deps.serverWebUrls() ?? []).flatMap((webUrl) => (URL.canParse(webUrl) ? [new URL(webUrl).origin] : [])));
    if (url && url.protocol === 'https:' && origins.has(url.origin)) return url;
    this.deps.log('[forge] not opening a page outside its server\'s web origin');
    return undefined;
  }

  /** The published check on the repository's own core; undefined when its daemon predates scm.commitOnRemote (no warning). */
  private async commitOnRemote(repoId: string, authority: string, sha: string, path: string | undefined, remote: string): Promise<CommitOnRemote | undefined> {
    if (authority !== 'local' && !this.deps.features(authority)?.includes(COMMIT_ON_REMOTE_FEATURE)) {
      this.deps.log(`[forge] ${authority} cannot say whether a commit is published; the link is made without checking`);
      return undefined;
    }
    return this.deps.scm.commitOnRemote(repoId, sha, path, remote);
  }

  // ---- the clone picker: rows by core's opaque keys; the clone address goes from core to main's clone only

  /**
   * Any Git hosting account exists: Git: Clone opens the picker then. Before this computer's core published the forge
   * mirror, core's own read answers, once it has read its forge files or failed to.
   */
  async hasAccount(): Promise<boolean> {
    const mirrored = this.deps.serverWebUrls();
    if (mirrored !== undefined) return mirrored.length > 0;
    const { servers } = await this.core('forge servers', (client) => client.forgeServersRead());
    return servers.some((server) => server.hasAccount);
  }

  private accountMirrored(): boolean {
    return (this.deps.serverWebUrls() ?? []).length > 0;
  }

  /** Opens the picker; "Open Git hosting settings" opens them once it closed. Its searches still running end with it. */
  async showClonePicker(recursive: boolean): Promise<void> {
    const picker: ClonePickerRequest = { kind: 'cloneFromAccount', recursive };
    const searches = new Map<string, AbortController>();
    this.cloneSearches.set(picker, searches);
    let answer: OverlayAnswer | undefined;
    try {
      answer = await this.deps.showClonePicker(picker);
    } finally {
      this.cloneSearches.delete(picker);
      for (const search of searches.values()) search.abort();
    }
    if (answer?.kind === 'cloneFromAccount') this.deps.openAccounts({});
  }

  cloneAccounts(): Promise<CloneAccountsView> {
    return this.core('forge clone accounts', (client) => client.forgeCloneAccounts());
  }

  async cloneSearch(picker: ClonePickerRequest, accountId: string, query: string, requestId: number): Promise<CloneSearchAnswer> {
    const searches = this.cloneSearches.get(picker);
    if (!searches) throw new Error('The clone picker that searched is closed');
    // a section's newer search supersedes its older one, which then rejects as aborted
    searches.get(accountId)?.abort();
    const search = new AbortController();
    searches.set(accountId, search);
    let outcome: Awaited<ReturnType<CoreClient['forgeCloneSearch']>>;
    try {
      outcome = await this.core('forge clone search', (client) => client.forgeCloneSearch({ accountId, query }, search.signal));
    } finally {
      if (searches.get(accountId) === search) searches.delete(accountId);
    }
    return 'rows' in outcome ? { requestId, accountId, rows: outcome.rows } : { requestId, accountId, error: outcome.error };
  }

  clonePaste(text: string): Promise<ClonePasteAnswer> {
    return this.core('forge clone paste', (client) => client.forgeClonePaste(text));
  }

  /**
   * Enter on a row or a pasted address in picker, the request that was open when Enter came: core gives the checked URL; main
   * then clones (ScmHost.cloneFromPicker), unless that picker closed while core answered.
   */
  async cloneStart(picker: ClonePickerRequest, source: CloneSource): Promise<CloneStartAnswer> {
    const target = await this.core('forge clone target', (client) => client.forgeCloneTarget({ source }));
    // a picker's searches map lives exactly while it is open
    if (!this.cloneSearches.has(picker)) return { kind: 'cancelled' };
    if (!target.ok) return { kind: 'refused', reason: this.deps.render(target.reason) };
    this.deps.startClone({ url: target.url, recursive: picker.recursive, status: this.deps.render(target.status), ...(target.account ? { account: target.account } : {}) });
    return { kind: 'started' };
  }

  // ---- forget hooks

  forgetProject(projectKey: string): Promise<void> {
    return this.deps.core('forge forgetProject', (client) => client.forgeForgetProject(projectKey));
  }

  forgetHost(authorityKey: string): Promise<void> {
    return this.deps.core('forge forgetHost', (client) => client.forgeForgetHost(authorityKey));
  }

  dispose(): void {
    this.flows.dispose();
    this.protectedPushes.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
    for (const timer of this.configTimers.values()) clearTimeout(timer);
    this.configTimers.clear();
    this.listeners.clear();
    this.endpoints.clear();
    this.ciWatches.clear();
    this.ciListeners.clear();
    this.ciLogListeners.clear();
    this.retargetListeners.clear();
    for (const searches of this.cloneSearches.values()) for (const search of searches.values()) search.abort();
    this.cloneSearches.clear();
  }

  private fire(changed: ForgeChanged): void {
    for (const listener of [...this.listeners]) listener(changed);
  }

  private requireSavedHost(authorityKey: string): void {
    if (!this.deps.savedHost(authorityKey)) throw new Error('Host defaults are kept only for saved remote hosts');
  }

  /** An open repository with its project's key: a chat worktree's repository is its project's (a root key names both). */
  private repository(repoId: string): ScmRepositoryRef | undefined {
    const ref = this.deps.scm.repository(repoId);
    const projectKey = ref ? parseRootKey(ref.projectKey)?.projectKey : undefined;
    return ref && projectKey !== undefined && projectKey !== ref.projectKey ? { ...ref, projectKey } : ref;
  }

  private endpointsOf(repoId: string): Promise<readonly RemoteEndpoint[]> {
    let held = this.endpoints.get(repoId);
    if (!held) {
      held = this.readEndpoints(repoId);
      this.endpoints.set(repoId, held);
      // a failed read is not kept: the next ask reads again
      held.catch(() => {
        if (this.endpoints.get(repoId) === held) this.endpoints.delete(repoId);
      });
    }
    return held;
  }

  // A read of a repository that closed while it ran (a chat worktree's root leaving source control, or its folder removed)
  // answers as one main no longer has, as ScmHost's reads do; any other failure rejects.
  private async openEndpoints(repoId: string): Promise<readonly RemoteEndpoint[] | undefined> {
    try {
      return await this.endpointsOf(repoId);
    } catch (err) {
      if (this.repository(repoId)) throw err;
      this.deps.log(`[forge] a read of ${repoId}, which closed meanwhile, answers as closed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  private async readEndpoints(repoId: string): Promise<readonly RemoteEndpoint[]> {
    const authority = this.repository(repoId)?.repo.authority ?? 'local';
    if (authority !== 'local' && !this.deps.features(authority)?.includes(REMOTE_ENDPOINTS_FEATURE)) {
      return endpointsFromRemotes(await this.deps.scm.remotes(repoId));
    }
    return this.deps.scm.remoteEndpoints(repoId);
  }

  private async rereadEndpoints(repoId: string): Promise<void> {
    const before = this.endpoints.get(repoId);
    this.endpoints.delete(repoId);
    const ref = this.repository(repoId);
    if (!ref) return;
    try {
      const [previous, next] = await Promise.all([before, this.endpointsOf(repoId)]);
      if (JSON.stringify(previous) === JSON.stringify(next)) return;
      this.fire({ projectKeys: [ref.projectKey] });
      this.warmProtection(repoId);
      if (this.ciWatches.has(repoId)) await this.sendCiWatch(repoId);
    } catch (err) {
      this.deps.log(`[forge] reading the remotes of ${repoId} again failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
