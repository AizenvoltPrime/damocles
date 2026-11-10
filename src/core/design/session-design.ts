// A chat session's design facts (PD-23): its role or its own link, both read from its branch, the delivery of what the state
// folder owes it (PD-27), and `designState`, whose one publisher this is (`PiSession.publishDesignState`).
import * as path from 'node:path';
import type { AgentSession, SessionEntry } from '@earendil-works/pi-coding-agent';
import type { Disposable } from '../../platform/disposable';
import type { Platform } from '../../platform/platform';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import { SCREEN_FILE } from '../../shared/design-paths';
import { MAX_CHANGED_PATHS } from '../../shared/design-render';
import { designChatName, type DesignChatStateView, type DesignLinkStateView, type DesignPreviewImage, type DesignVersionChoice, type FinishDesignDelivery, type TweaksDeclaration } from '../../shared/types/design';
import { TOOL_ASK_USER_QUESTION, TOOL_DECLARE_TWEAKS, TOOL_EDIT, TOOL_RECORD_DECISION } from '../../shared/tool-names';
import type { DesignVersionAsk } from '../permission-handler/managers/design-version-manager';
import { LocalizedError, type LocalizedText } from '../../shared/localized-text';
import { l } from '../l10n';
import { log } from '../logger';
import { DAMOCLES_DESIGN_BRIEF, DAMOCLES_DESIGN_ENTRY, DAMOCLES_DESIGN_RESULT, DAMOCLES_DESIGN_VERSION_CHOICE, DAMOCLES_USER_RENAMED_ENTRY } from '../pi-session/session-store/constants';
import { sessionLeaseBlocker } from '../pi-session/session-store/session-lease';
import { PiRuntime, type LiveSessionMutator } from '../pi-session/pi-runtime';
import { resolveToCwd } from '../pi-session/tools/search-tools';
import {
  activeConflicts,
  currentDecisions,
  decisionsOnBranch,
  decisionView,
  designEntryMessage,
  designRoleEntryData,
  hasDesignRoleEntry,
  designRoleOf,
  MAX_TITLE_CHARS,
  approvedVersionAfterLink,
  deliveredResultKey,
  ownDesignLink,
  resultAwaitingContinue,
  unansweredVersionPause,
  versionChoiceEntryData,
  versionChoiceMade,
  type DesignLink,
  type DesignRole,
  type DesignVersionPause,
} from './design-entries';
import { markDesignEdited, readManifest, syncManifestVersion, writeDecisions } from './design-files';
import { DecisionRefusedError, DESIGN_CONTINUES_ELSEWHERE, type DecisionLedger } from './decisions';
import { withDesignWrite } from './design-writes';
import { designFolderOf, designStateDirOf } from './design-paths';
import { changesBetween, claimDesignLink, readDesignLink, readLatestVersion, type DesignVersionRecord } from './design-state';
import { designBriefMessage, designResultMessage, designVersionInstruction, owedBriefs, owedDesignResults, type DesignCustomMessage } from './delivery';
import { askedQuestions, designPreviewPathOf, DesignPreviewImages } from './question-previews';
import { journeyOnBranch } from './journey';
import { tweaksOnBranch } from './tweaks';
import { designRuleSet, designRuleSetById, type DesignRuleSet } from './rule-set';
import type { DesignScope } from './design-write-rule';
import type { DesignSeed, DesignPanels, SessionShown } from './tools/start-design';
import type { DesignPromptInputs } from '../pi-session/agent-start';

export const DESIGN_ENABLED_SETTING = 'damocles.design.enabled';

/** How a live session can take a delivery now. */
export type DeliveryState = 'idle' | 'streaming' | 'gone';

export interface SessionDesignDeps {
  readonly cwd: string;
  readonly platform: Pick<Platform, 'settings' | 'capabilities' | 'notifications' | 'fileWatchers' | 'design' | 'designPreview'>;
  /** A new design chat's identity, written as its role entry at the first bind of a fresh conversation. */
  readonly seed: DesignSeed | undefined;
  /** The live session; undefined before the start and after the release. */
  session(): AgentSession | undefined;
  emit(message: ExtensionToWebviewMessage): void;
  deliveryState(session: AgentSession, trigger: ReconcileTrigger): DeliveryState;
  /**
   * Appends `messages` to idle `session` with nothing awaited, and with `run` starts one run in the chat's current mode,
   * as a send would. Returns false, appending nothing, when the session can take no delivery now.
   */
  deliver(session: AgentSession, messages: readonly DesignCustomMessage<unknown>[], run: boolean): boolean;
  /** The parent's file still exists, looked up from this chat's working folder. */
  sessionExists(sessionId: string): Promise<boolean>;
  /** pi's `shellPath`, read per call. */
  shellPath(): string | undefined;
  panels(): DesignPanels | undefined;
  /** Raises the version pause's prompt (PD-29) until the user answers or `signal` aborts, which resolves undefined. */
  askVersion(ask: DesignVersionAsk, signal: AbortSignal): Promise<DesignVersionChoice | undefined>;
  /** The chat's plan mode, on before the run an answer of `replan` starts, so the plan-mode hold forces a new ExitPlanMode. */
  activatePlanMode(): Promise<void>;
  /** The chat's core panel id, which a preview tab of its design belongs to (PD-33). */
  panelId(): string | undefined;
}

// a Write or Edit of the design folder reaches the open previews once the edits pause this long
const DESIGN_CHANGED_DEBOUNCE_MS = 150;
// pi's `write` (Damocles' replacement under pi's name) takes `path`, Damocles' `Edit` takes `file_path`.
const FOLDER_WRITE_TOOLS: ReadonlySet<string> = new Set(['write', TOOL_EDIT]);
// a result of one of these changes the preview's tweaks (a declaration, or a decision that locks a control)
const TWEAK_RESULT_TOOLS: ReadonlySet<string> = new Set([TOOL_DECLARE_TWEAKS, TOOL_RECORD_DECISION, TOOL_ASK_USER_QUESTION]);

/** Why a reconcile runs: a bind or a prompt start appends what is owed with no run; a live offer may start one. */
export type ReconcileTrigger = 'bind' | 'prompt' | 'live';

/**
 * Whether a design chat is the one `link.json` names (PD-36): `superseded` once a takeover named another session, `handing-over`
 * while this chat's own rewind takeover runs, `unreadable` for a link.json that does not parse.
 */
/** An Open preview's outcome: opened, or refused with the reason the user reads. */
export type DesignPreviewOpening = { readonly opened: true } | { readonly refused: LocalizedText };

export type DesignStanding = { readonly kind: 'current' } | { readonly kind: 'superseded'; readonly by: string } | { readonly kind: 'handing-over' } | { readonly kind: 'unreadable' };

export class SessionDesign implements Disposable {
  // Per design id, the chats of this process holding it (its role or own link); the last one to let go closes its served URL.
  private static readonly holders = new Map<string, Set<SessionDesign>>();
  private readonly deps: SessionDesignDeps;
  private held: string | undefined;
  private reconciling: Promise<void> = Promise.resolve();
  private watchers: { key: string; disposables: Disposable[] } | undefined;
  private publishRun = 0;
  // The design entries of the bound conversation already on screen: the history replay's and those posted live.
  private postedEntries = new Set<string>();
  private disposed = false;
  private handingOver = false;
  // link.json of this chat's design as last read; every send, rewind, compaction, reconcile and decisions write reads it first.
  private linkSeen: { readonly designId: string; readonly holder: string | null } | { readonly designId: string; readonly unreadable: true } | undefined;
  // The folder writes this chat queued (decisions.md, the manifest's fidelity and status), which a restore waits for before it takes
  // the folder's write lane.
  private folderWrites: Promise<void> = Promise.resolve();
  // A parent whose run a version pause ends at its next turn boundary; its card and prompt land once the run settled (PD-29).
  private pausing: AgentSession | undefined;
  // The open version pause prompt, keyed by `deliveredResultKey`; its signal ends with the session's binding.
  private versionPrompt: { readonly key: string; readonly session: AgentSession; readonly stop: AbortController } | undefined;
  // The screens whose preview tab this chat opened at their first write, so a later write only reloads it.
  private readonly previewedScreens = new Set<string>();
  // The folder files written since the last design.changed, sent once the writes pause.
  private changedPaths = new Set<string>();
  private changedTimer: ReturnType<typeof setTimeout> | undefined;
  // The question thumbnails this chat captured; the captures still running end with the chat.
  private readonly previewImages = new DesignPreviewImages();
  private readonly lifetime = new AbortController();
  // The role the branch ending at `leaf` records; entries never change once appended, so a leaf names one branch.
  private roleRead: { readonly session: AgentSession; readonly leaf: string | null; readonly role: DesignRole | undefined; readonly hasEntry: boolean } | undefined;
  // The conversation the seed made a design chat; no other conversation of the panel is seeded.
  private seededSession: string | undefined;
  // The last `designState` emitted, so a publish that changed nothing posts nothing.
  private lastPublished: string | undefined;

  constructor(deps: SessionDesignDeps) {
    this.deps = deps;
  }

  /** `damocles.design.enabled`, a user-scope setting. */
  enabled(): boolean {
    return this.deps.platform.settings.get<boolean>(DESIGN_ENABLED_SETTING, true) === true;
  }

  /** The host's rule set. */
  hostRuleSet(): DesignRuleSet {
    return designRuleSet(this.deps.platform.capabilities);
  }

  private branch(): readonly unknown[] {
    return this.deps.session()?.sessionManager.getBranch() ?? [];
  }

  /** The chat's design role, read from its branch. */
  role(): DesignRole | undefined {
    return this.readRole().role;
  }

  /** Whether the branch holds a role entry at all, readable or not: a design chat, which never becomes a normal chat. */
  isDesignChat(): boolean {
    return this.readRole().hasEntry;
  }

  /** Whether the panel holds a design seed no conversation recorded yet, so its next fresh conversation becomes a design chat. */
  seedPending(): boolean {
    return this.deps.seed !== undefined && this.seededSession === undefined;
  }

  private readRole(): { readonly role: DesignRole | undefined; readonly hasEntry: boolean } {
    const session = this.deps.session();
    if (!session) return { role: undefined, hasEntry: false };
    const leaf = session.sessionManager.getLeafId();
    const read = this.roleRead;
    if (read?.session === session && read.leaf === leaf) return read;
    const branch = session.sessionManager.getBranch();
    const next = { session, leaf, role: designRoleOf(branch), hasEntry: hasDesignRoleEntry(branch) };
    this.roleRead = next;
    return next;
  }

  /** The parent's own link, read from its branch; a fork's inherited link is inert. */
  ownLink(): DesignLink | undefined {
    const session = this.deps.session();
    return session ? ownDesignLink(session.sessionManager.getBranch(), session.sessionId) : undefined;
  }

  /** The rule set of the design chat whose branch is `branch`, or that this chat is seeded as; undefined for any other chat. */
  chatRuleSetOf(branch: readonly unknown[]): DesignRuleSet | undefined {
    const id = designRoleOf(branch)?.ruleSet ?? (this.seededSession === undefined ? this.deps.seed?.ruleSet : undefined);
    return id === undefined ? undefined : designRuleSetById(id);
  }

  /** The rule set a design chat recorded, else the host's. */
  ruleSet(): DesignRuleSet {
    const role = this.role();
    return role ? designRuleSetById(role.ruleSet) : this.hostRuleSet();
  }

  /**
   * Reads the design's `link.json` (PD-36) and returns where this chat stands. Every async check calls it first; the gate's
   * sync `scope()` reads what it found, which the state-folder watch and an in-process takeover keep current.
   */
  async readLink(): Promise<DesignStanding> {
    const role = this.role();
    return role ? this.readLinkOf(role) : { kind: 'current' };
  }

  private async readLinkOf(role: DesignRole): Promise<DesignStanding> {
    try {
      this.noteLinkHolder(role.designId, (await readDesignLink(designStateDirOf(role.designId)))?.designSessionId ?? null);
    } catch (err) {
      log('[SessionDesign] reading the design link failed: %O', err);
      this.linkSeen = { designId: role.designId, unreadable: true };
    }
    return this.standing();
  }

  /** Records the chat `link.json` of design `designId` names, as just read or written. */
  noteLinkHolder(designId: string, holder: string | null): void {
    this.linkSeen = { designId, holder };
  }

  /** Where this design chat stands in its design's `link.json` as last read; `current` outside a design chat and before the first read. */
  standing(): DesignStanding {
    const role = this.role();
    const session = this.deps.session();
    if (!role || !session) return { kind: 'current' };
    if (this.handingOver) return { kind: 'handing-over' };
    const seen = this.linkSeen;
    if (!seen || seen.designId !== role.designId) return { kind: 'current' };
    if ('unreadable' in seen) return { kind: 'unreadable' };
    return seen.holder !== null && seen.holder !== session.sessionId ? { kind: 'superseded', by: seen.holder } : { kind: 'current' };
  }

  /** Marks this chat as handing its design over until the returned release runs, so nothing it does meanwhile writes or delivers. */
  beginTakeover(): () => void {
    this.handingOver = true;
    return () => {
      this.handingOver = false;
    };
  }

  /** Resolves once the folder writes this chat queued have landed. */
  settledWrites(): Promise<void> {
    return this.folderWrites;
  }

  /**
   * Runs a checkpoint restore of a design chat's folder in the folder's write lane (D65), after the writes this chat queued, so no
   * decision or manifest write lands across it; a write queued meanwhile lands after it. Any other chat's restore runs as it is.
   */
  async restoring<T>(restore: () => Promise<T>): Promise<T> {
    const role = this.role();
    if (!role) return restore();
    await this.folderWrites;
    return withDesignWrite(role.folder, restore);
  }

  /**
   * The gate's design scope: set for a design chat whether or not design mode is on, since its posture never widens, and
   * unreadable for a chat whose latest role entry does not parse.
   */
  scope(): DesignScope | undefined {
    const { role, hasEntry } = this.readRole();
    if (!role) return hasEntry ? { unreadable: true } : undefined;
    const shellPath = this.deps.shellPath();
    return {
      folder: role.folder,
      cwd: this.deps.cwd,
      ...(shellPath !== undefined ? { shellPath } : {}),
      ...(this.standing().kind !== 'current' ? { superseded: true } : {}),
    };
  }

  /** The system prompt's design inputs. */
  promptInputs(): DesignPromptInputs {
    const role = this.role();
    if (role) return { design: { folder: role.folder, ruleSet: designRuleSetById(role.ruleSet) } };
    const link = this.ownLink();
    return link ? { designLink: { folder: link.folder } } : {};
  }

  /**
   * Why a design chat refuses a send now, or why no run starts for a design delivery (`delivery`): while design mode is off a
   * design chat takes neither, and a main chat takes its design's result with no run. Undefined when nothing refuses.
   */
  sendRefusal(purpose: 'send' | 'delivery'): LocalizedText | undefined {
    const { role, hasEntry } = this.readRole();
    // A role entry that does not parse would leave the chat with none of its limits, so it takes no messages (fail closed).
    if (!role && hasEntry) return l("This design chat's record cannot be read, so it takes no messages.");
    if (!role && purpose === 'send') return undefined;
    return this.enabled() ? undefined : l('Turn on design mode in Settings to continue this design.');
  }

  /** Posts `designResult` and `designBrief` as their entries commit, by whichever path pi appends them. */
  track(session: AgentSession): () => void {
    // the path each running Write or Edit named, by tool call
    const writing = new Map<string, unknown>();
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'tool_execution_start' && FOLDER_WRITE_TOOLS.has(event.toolName)) {
        const args = event.args as { file_path?: unknown; path?: unknown } | undefined;
        writing.set(event.toolCallId, args?.file_path ?? args?.path);
      }
      if (event.type === 'tool_execution_end' && writing.has(event.toolCallId)) {
        const written = writing.get(event.toolCallId);
        writing.delete(event.toolCallId);
        if (!event.isError && typeof written === 'string') this.folderFileWritten(written);
      }
      if (event.type === 'message_end' && event.message.role === 'toolResult' && TWEAK_RESULT_TOOLS.has(event.message.toolName)) queueMicrotask(() => this.tweaksChanged());
      const isDesignMessage = event.type === 'message_end' && event.message.role === 'custom' && (event.message.customType === DAMOCLES_DESIGN_RESULT || event.message.customType === DAMOCLES_DESIGN_BRIEF);
      // pi persists a message right after its message_end listeners return, and emits entry_appended once a draft committed.
      if (isDesignMessage) queueMicrotask(() => this.postNewEntries(session));
      if (event.type === 'entry_appended') {
        const entry = event.entry;
        queueMicrotask(() => this.postEntry(session, entry));
      }
    });
    // Let go of at a reset, a resume switch and the panel's end: the prompt closes, and the next bind raises it again if still owed.
    return () => {
      unsubscribe();
      if (this.pausing === session) this.pausing = undefined;
      if (this.versionPrompt?.session === session) this.closeVersionPrompt();
    };
  }

  /** A result that may change the tweaks committed: the design's previews read design.info again, with no reload. */
  private tweaksChanged(): void {
    const role = this.role();
    if (!role || this.disposed || !this.ruleSet().preview) return;
    this.deps.platform.designPreview?.changed(role.designId, []);
  }

  /** A Write or Edit of this design chat landed: its previews reload, and a screen's first write opens its tab (PD-33). */
  private folderFileWritten(written: string): void {
    const role = this.role();
    if (!role || this.disposed) return;
    const relative = path.relative(role.folder, resolveToCwd(written, this.deps.cwd));
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
    const relPath = relative.split(path.sep).join('/');
    const session = this.deps.session();
    // In the chain a restore waits on, so this read-modify-write never lands over a manifest the restore put back.
    this.folderWrites = this.folderWrites.then(async () => {
      if (this.disposed || this.deps.session() !== session) return;
      if (await markDesignEdited(role.folder, role.designId)) this.publish();
    }).catch((err: unknown) => log('[SessionDesign] marking design %s edited failed: %O', role.designId, err));
    if (this.changedPaths.size < MAX_CHANGED_PATHS) this.changedPaths.add(relPath);
    clearTimeout(this.changedTimer);
    this.changedTimer = setTimeout(() => {
      this.changedTimer = undefined;
      const paths = [...this.changedPaths];
      this.changedPaths = new Set();
      this.deps.platform.designPreview?.changed(role.designId, paths);
    }, DESIGN_CHANGED_DEBOUNCE_MS);
    if (!SCREEN_FILE.test(relPath) || this.previewedScreens.has(relPath.toLowerCase())) return;
    this.previewedScreens.add(relPath.toLowerCase());
    this.openPreview(role.designId, relPath).then((opening) => {
      if ('refused' in opening) log('[SessionDesign] the preview of %s did not open: %s', relPath, opening.refused.message);
    }, (err: unknown) => log('[SessionDesign] opening the preview of %s failed: %O', relPath, err));
  }

  /**
   * Opens the preview tab of `relPath` of design `designId` in its design chat (PD-33): this chat when it is the design chat,
   * else the design chat this parent's own link names, shown first. A refusal names why it did not open.
   */
  async openPreview(designId: string, relPath: string): Promise<DesignPreviewOpening> {
    const preview = this.deps.platform.designPreview;
    if (!preview || !this.ruleSet().preview) return { refused: l('This chat shows no design previews.') };
    if (this.role()?.designId === designId) {
      const panelId = this.deps.panelId();
      if (panelId === undefined) return { refused: l('Open the design chat to preview {0}.', relPath) };
      if (this.standing().kind !== 'current') return { refused: l('This design continues in another chat.') };
      if (!(await preview.open(panelId, designId, relPath))) return { refused: l('Open the design chat to preview {0}.', relPath) };
      return { opened: true };
    }
    if (this.ownLink()?.designId !== designId) return { refused: l('Could not preview {0}.', relPath) };
    const notOpen: DesignPreviewOpening = { refused: l('Open the design chat to preview {0}.', relPath) };
    const current = (await readDesignLink(designStateDirOf(designId)))?.designSessionId;
    if (!current) return notOpen;
    const shown = await this.deps.panels()?.showSession(current);
    if (shown === 'elsewhere') return { refused: l('This conversation is open in another Damocles window.') };
    if (shown === 'notShown') return { refused: l('The design chat could not be shown on this device, so {0} did not open.', relPath) };
    if (shown === 'missing') return { refused: l('The chat this design continues in no longer exists.') };
    if (shown !== 'shown') return notOpen;
    return (await PiRuntime.liveSessionMutator(current)?.openDesignPreview(designId, relPath)) ?? notOpen;
  }

  /** Posts the design entries of the branch not on screen yet; a delivered message's entry lands by either of pi's paths. */
  private postNewEntries(session: AgentSession): void {
    if (session !== this.deps.session() || this.disposed) return;
    let posted = false;
    for (const entry of session.sessionManager.getBranch()) posted = this.post(entry) || posted;
    if (posted) this.publish();
  }

  /** Posts `entry`, a draft pi just committed, when it is a design entry not on screen yet. */
  private postEntry(session: AgentSession, entry: SessionEntry): void {
    if (session !== this.deps.session() || this.disposed) return;
    if (this.post(entry)) this.publish();
  }

  private post(entry: SessionEntry): boolean {
    if (this.postedEntries.has(entry.id)) return false;
    const message = designEntryMessage(entry, false);
    if (!message) return false;
    this.postedEntries.add(entry.id);
    this.deps.emit(message);
    return true;
  }

  /**
   * A fresh conversation of a new design chat records its role entry and takes the link. The bind calls it before it builds the
   * gate and the checkpoint service, which read the role for the folder they guard and capture (PD-39).
   */
  recordSeededRole(session: AgentSession): void {
    const seed = this.deps.seed;
    // The seed makes one conversation a design chat; a later conversation of the panel (a delete's detach, a handover) is a plain one.
    if (!seed || (this.seededSession !== undefined && this.seededSession !== session.sessionId)) return;
    if (designRoleOf(session.sessionManager.getEntries()) || session.sessionManager.getEntries().some((entry) => entry.type === 'message')) return;
    this.seededSession = session.sessionId;
    const role: DesignRole = { designId: seed.designId, folder: designFolderOf(seed.designId), parentSessionId: seed.parentSessionId, ruleSet: seed.ruleSet, title: seed.title };
    session.sessionManager.appendCustomEntry(DAMOCLES_DESIGN_ENTRY, designRoleEntryData(role));
    session.setSessionName(designChatName(role.title));
    session.sessionManager.appendCustomEntry(DAMOCLES_USER_RENAMED_ENTRY);
    const sessionId = session.sessionId;
    this.reconciling = this.reconciling
      .then(() => claimDesignLink(designStateDirOf(role.designId), sessionId, { designId: role.designId, folder: role.folder, title: role.title, parentSessionId: role.parentSessionId }))
      .then(() => undefined, (err: unknown) => log('[SessionDesign] taking the design link failed: %O', err));
  }

  /** Every bind, after `recordSeededRole`: the state is published, decisions.md rebuilt, the state folder watched, and what the branch lacks delivered. */
  onBound(): void {
    const session = this.deps.session();
    if (!session) return;
    // What the branch holds now is the history replay's to show.
    this.postedEntries = new Set(session.sessionManager.getBranch().flatMap((entry) => (designEntryMessage(entry, false) ? [entry.id] : [])));
    this.syncHold();
    this.refresh({ filesRestored: true });
    void this.reconcile('bind');
  }

  /**
   * Rebuilds decisions.md from the active branch and publishes; at every bind, every settled turn and every files-only restore.
   * `filesRestored` (a bind, which may follow a takeover, a files-only rewind, an undo) also sets the manifest's version and
   * status from the state folder. Only the chat `link.json` names writes, so a superseded chat never overwrites its successor's,
   * and only while the session it was asked for is still bound, so a let-go or a switch never writes another branch's decisions.
   */
  refresh(options?: { readonly filesRestored: true }): void {
    const session = this.deps.session();
    const role = this.role();
    if (!session || !role) {
      this.publish();
      return;
    }
    const bound = (): boolean => !this.disposed && this.deps.session() === session;
    this.folderWrites = this.folderWrites.then(async () => {
      if (!bound()) return;
      await this.readLinkOf(role);
      if (!bound() || this.standing().kind !== 'current') return;
      await writeDecisions(role.folder, role.designId, () => decisionsOnBranch(session.sessionManager.getBranch()));
      if (!bound() || !options?.filesRestored) return;
      const latest = await readLatestVersion(designStateDirOf(role.designId));
      if (!bound()) return;
      await syncManifestVersion(role.folder, role.designId, latest);
    }).catch((err: unknown) => log('[SessionDesign] rebuilding decisions.md failed: %O', err)).then(() => {
      if (bound()) this.publish();
    });
  }

  /**
   * Where this chat's decisions are recorded (D99): its bound session's branch and its design folder. Each append checks the
   * session is still the one bound, so a let-go or a switch never takes a decision onto another branch.
   */
  decisionLedger(onWriteFailed: (err: unknown) => void): DecisionLedger | undefined {
    const session = this.deps.session();
    const role = this.role();
    if (!session || !role) return undefined;
    const bound = (): boolean => !this.disposed && this.deps.session() === session;
    return {
      folder: role.folder,
      designId: role.designId,
      branch: () => session.sessionManager.getBranch(),
      ensureCurrent: async () => {
        if (!bound()) throw new DecisionRefusedError('This design chat is no longer open, so nothing was recorded.');
        if ((await this.readLinkOf(role)).kind !== 'current') throw new DecisionRefusedError(DESIGN_CONTINUES_ELSEWHERE);
      },
      append: (customType, data) => {
        if (!bound()) throw new Error('This design chat is no longer open, so the decision was not recorded.');
        session.sessionManager.appendCustomEntry(customType, data);
      },
      changed: () => {
        if (!bound()) return;
        this.deps.platform.designPreview?.changed(role.designId, []);
        this.publish();
      },
      writeFailed: onWriteFailed,
    };
  }

  /** Publishes `designState`: the design chat's state, or the parent's link chip, or neither. */
  publish(): void {
    this.syncHold();
    const run = ++this.publishRun;
    this.compute().then((state) => {
      if (run !== this.publishRun || this.disposed) return;
      const ruleSet = this.hostRuleSet();
      const message: ExtensionToWebviewMessage = { type: 'designState', ...state, openInBrowser: ruleSet.openInBrowserFromChat, openPreview: this.ruleSet().preview && this.deps.platform.designPreview !== undefined };
      const key = JSON.stringify(message);
      if (key === this.lastPublished) return;
      this.lastPublished = key;
      this.deps.emit(message);
    }, (err: unknown) => log('[SessionDesign] publishing the design state failed: %O', err));
  }

  /** A view that lost what it was shown (a reloaded webview) hears the state again at the next publish. */
  forgetPublished(): void {
    this.lastPublished = undefined;
  }

  /**
   * Records the design this chat holds now, watches its state folder, and closes the served URL of one no chat of this process
   * holds any more. Runs wherever the held design can change (a bind, a publish), so StartDesign's new link is watched at once.
   */
  private syncHold(): void {
    const next = this.disposed ? undefined : (this.role() ?? this.ownLink())?.designId;
    this.watchStateFolder(next);
    const previous = this.held;
    if (next === previous) return;
    this.held = next;
    if (next !== undefined) {
      const holders = SessionDesign.holders.get(next) ?? new Set<SessionDesign>();
      holders.add(this);
      SessionDesign.holders.set(next, holders);
      // design.read serves only a held design, so a preview restored before this chat bound reads it now
      if (holders.size === 1) this.deps.platform.designPreview?.changed(next, []);
    }
    if (previous === undefined) return;
    const holders = SessionDesign.holders.get(previous);
    holders?.delete(this);
    if (holders?.size) return;
    SessionDesign.holders.delete(previous);
    this.deps.platform.design?.closeDesign(previous);
  }

  /** Stored chat `sessionId`'s current title on one line, cut to MAX_TITLE_CHARS; null while it has none or is not listed. */
  private async chatTitleOf(sessionId: string): Promise<string | null> {
    // a session list that failed to load must not cost the chat its whole design state
    const stored = await this.deps.panels()?.sessionTitle(sessionId).catch((err: unknown) => {
      log('[SessionDesign] reading the title of chat %s failed: %O', sessionId, err);
      return undefined;
    });
    const title = stored?.trim().replace(/\s+/g, ' ');
    return title ? title.slice(0, MAX_TITLE_CHARS) : null;
  }

  private async compute(): Promise<{ design: DesignChatStateView | null; link: DesignLinkStateView | null }> {
    const session = this.deps.session();
    const role = this.role();
    if (session && role) {
      const decisions = decisionsOnBranch(this.branch());
      const current = new Set(currentDecisions(decisions).map((decision) => decision.id));
      const [manifest, link] = await Promise.all([readManifest(role.folder, role.designId), readDesignLink(designStateDirOf(role.designId))]);
      this.noteLinkHolder(role.designId, link?.designSessionId ?? null);
      const supersededBy = link?.designSessionId != null && link.designSessionId !== session.sessionId ? link.designSessionId : null;
      const parentSessionId = link ? link.parentSessionId : role.parentSessionId;
      return {
        design: {
          designId: role.designId,
          title: role.title,
          folder: role.folder,
          parentSessionId,
          parentTitle: parentSessionId === null ? null : await this.chatTitleOf(parentSessionId),
          status: manifest.status,
          version: manifest.version,
          fidelity: manifest.fidelity,
          decisions: decisions.map((decision) => {
            const { conflicts: _stored, ...view } = decisionView(decision);
            const active = activeConflicts(decision, current);
            return active.length > 0 ? { ...view, conflicts: active } : view;
          }),
          ruleSet: role.ruleSet,
          enabled: this.enabled(),
          superseded: supersededBy !== null,
          supersededBy,
        },
        link: null,
      };
    }
    const own = this.ownLink();
    if (!own) return { design: null, link: null };
    const [manifest, link] = await Promise.all([readManifest(own.folder, own.designId), readDesignLink(designStateDirOf(own.designId))]);
    // A parent whose conversation rewind carried the design to a new chat holds an inert link.
    if (link && link.parentSessionId !== own.parentSessionId) return { design: null, link: null };
    return {
      design: null,
      link: {
        designId: own.designId,
        title: link?.title ?? own.title,
        folder: own.folder,
        designSessionId: link?.designSessionId ?? null,
        status: manifest.status,
        version: manifest.version,
        awaitingContinue: resultAwaitingContinue(this.branch(), own.designId),
      },
    };
  }

  /** Delivers what the state folder owes this chat's branch: briefs to a design chat, the latest version to a parent. */
  reconcile(trigger: ReconcileTrigger): Promise<void> {
    const run = this.reconciling.then(() => this.reconcileOnce(trigger));
    this.reconciling = run.catch((err: unknown) => log('[SessionDesign] delivering design messages failed: %O', err));
    return this.reconciling;
  }

  private async reconcileOnce(trigger: ReconcileTrigger): Promise<void> {
    const session = this.deps.session();
    if (!session || this.disposed) return;
    const branch = (): readonly unknown[] => session.sessionManager.getBranch();
    const role = designRoleOf(branch());
    const messages: DesignCustomMessage<unknown>[] = [];
    let run = false;
    let pauses = false;
    if (role) {
      await this.readLink();
      const briefs = await owedBriefs(branch, role, session.sessionId);
      messages.push(...briefs.map(designBriefMessage));
      // A brief is a request the parent's run made, so the design chat works on it as soon as it lands.
      run = briefs.length > 0 && trigger !== 'prompt';
    } else {
      const link = ownDesignLink(branch(), session.sessionId);
      const [result] = await owedDesignResults(branch, link);
      const pausedFrom = result ? this.pausedFrom(branch(), session.sessionId, result.record.version) : undefined;
      if (result) messages.push(designResultMessage(result, link!.folder, pausedFrom));
      // PD-20: a chat that was away gets the card with no run; a live one continues in its current mode (PD-51), unless the version pauses it (PD-29).
      pauses = pausedFrom !== undefined;
      run = result !== undefined && !pauses && trigger === 'live';
    }
    if (session !== this.deps.session()) return;
    if (!pauses && this.pausing === session) this.pausing = undefined;
    // From the outbox read above to the append below nothing is awaited (the subagent-results rule).
    if (messages.length > 0) {
      // A design chat that is no longer current, or is handing over, takes nothing: its successor owes what is left (PD-36).
      if (role && this.standing().kind !== 'current') return;
      if (this.deps.deliveryState(session, trigger) !== 'idle') {
        // A streaming parent ends its run at the next turn boundary, and the card lands once it settled.
        if (pauses) this.pausing = session;
        return;
      }
      if (this.deps.deliver(session, messages, run)) {
        this.pausing = undefined;
        this.postNewEntries(session);
      }
    }
    if (!role) this.syncVersionPrompt(session);
  }

  /** The version the latest approval after the own link recorded, when `version` is newer and so pauses the parent (PD-29). */
  private pausedFrom(branch: readonly unknown[], sessionId: string, version: number): number | undefined {
    const approved = approvedVersionAfterLink(branch, sessionId);
    return approved && version > approved.fromVersion ? approved.fromVersion : undefined;
  }

  /** Whether a version pause ends `session`'s run at its next turn boundary (PD-29); the turn decider and the settle boundary read it. */
  pauseOwed(session: AgentSession): boolean {
    return this.pausing === session;
  }

  /**
   * The chat became idle (a run settled, a compaction or a session replacement ended): what the state folder owes it lands now,
   * a pause owed included, which a busy chat deferred, and a version prompt a new approval made moot closes.
   */
  idle(): void {
    if (!this.deps.session() || this.disposed) return;
    void this.reconcile('live');
  }

  /** Raises the prompt the branch owes an answer, again after a reload or a restart closed it, and closes one no longer owed. */
  private syncVersionPrompt(session: AgentSession): void {
    const pause = unansweredVersionPause(session.sessionManager.getBranch(), session.sessionId);
    const key = pause ? deliveredResultKey(pause.designId, pause.toVersion) : undefined;
    if (this.versionPrompt && this.versionPrompt.key !== key) this.closeVersionPrompt();
    if (pause && !this.versionPrompt) void this.askVersion(session, pause).catch((err: unknown) => log('[SessionDesign] the design version prompt failed: %O', err));
  }

  private closeVersionPrompt(): void {
    const open = this.versionPrompt;
    this.versionPrompt = undefined;
    open?.stop.abort();
  }

  private async askVersion(session: AgentSession, pause: DesignVersionPause): Promise<void> {
    const prompt = { key: deliveredResultKey(pause.designId, pause.toVersion), session, stop: new AbortController() };
    this.versionPrompt = prompt;
    let choice: DesignVersionChoice | undefined;
    try {
      const changes = await changesBetween(designStateDirOf(pause.designId), pause.fromVersion, pause.toVersion);
      if (prompt.stop.signal.aborted) return;
      choice = await this.deps.askVersion({ ...pause, changes }, prompt.stop.signal);
    } finally {
      if (this.versionPrompt === prompt) this.versionPrompt = undefined;
    }
    if (choice !== undefined) await this.answerVersion(session, pause, choice);
  }

  /**
   * Records the answer once per branch, then starts the run it asks for: `replan` turns plan mode on first, so the plan-mode hold
   * makes the agent call ExitPlanMode, which records the new version. A parent already running takes the instruction in that run.
   */
  private async answerVersion(session: AgentSession, pause: DesignVersionPause, choice: DesignVersionChoice): Promise<void> {
    if (session !== this.deps.session() || this.disposed) return;
    const branch = session.sessionManager.getBranch();
    const link = ownDesignLink(branch, session.sessionId);
    if (link?.designId !== pause.designId || versionChoiceMade(branch, pause.designId, pause.toVersion)) return;
    session.sessionManager.appendCustomEntry(DAMOCLES_DESIGN_VERSION_CHOICE, versionChoiceEntryData(pause, choice));
    if (choice === 'replan') await this.deps.activatePlanMode();
    if (session !== this.deps.session() || this.disposed) return;
    this.deps.deliver(session, [designVersionInstruction(pause, choice, link.folder)], this.deps.deliveryState(session, 'live') === 'idle');
  }

  /** The settle-boundary draft for a streaming chat: the first owed message, which the run continues with. */
  async settleDraft(): Promise<DesignCustomMessage<unknown> | undefined> {
    const session = this.deps.session();
    if (!session) return undefined;
    const branch = (): readonly unknown[] => session.sessionManager.getBranch();
    const role = designRoleOf(branch());
    if (role) {
      const [brief] = await owedBriefs(branch, role, session.sessionId);
      // A design chat that is no longer current, or is handing over, takes nothing (PD-36).
      if (this.standing().kind !== 'current') return undefined;
      return brief ? designBriefMessage(brief) : undefined;
    }
    const link = ownDesignLink(branch(), session.sessionId);
    const [result] = await owedDesignResults(branch, link);
    if (!result) return undefined;
    // A version that pauses the parent lets the run settle; its card and prompt land after (PD-29).
    if (this.pausedFrom(branch(), session.sessionId, result.record.version) !== undefined) {
      this.pausing = session;
      return undefined;
    }
    return designResultMessage(result, link!.folder);
  }

  /** Every core holding a live linked chat watches its state folder, so a version or brief from another process arrives unasked. */
  private watchStateFolder(designId: string | undefined): void {
    if (this.watchers?.key === designId) return;
    this.unwatch();
    if (!designId) return;
    const watcher = this.deps.platform.fileWatchers.watch(designStateDirOf(designId), '**/*.json');
    const onChange = (): void => {
      void this.reconcile('live');
      this.publish();
    };
    this.watchers = { key: designId, disposables: [watcher.onDidCreate(onChange), watcher.onDidChange(onChange), watcher] };
  }

  private unwatch(): void {
    for (const disposable of this.watchers?.disposables ?? []) disposable.dispose();
    this.watchers = undefined;
  }

  /** The live mutator's `offerDesignResult`: a version of this parent's design was finished. */
  offerDesignResult(designId: string): void {
    if (this.ownLink()?.designId !== designId) return;
    void this.reconcile('live');
  }

  /** The live mutator's `offerDesignBrief`: a brief for this design chat was written. */
  offerDesignBrief(): void {
    if (!this.role()) return;
    void this.reconcile('live');
  }

  /**
   * Hands a finished version to the parent (PD-20, PD-27): live in this process, it reconciles now; held by another process,
   * that core's watch delivers it; away, the user is told; gone, nobody receives it.
   */
  async offerResult(record: DesignVersionRecord, role: DesignRole, notify: boolean): Promise<FinishDesignDelivery> {
    const reach = await this.parentReach(role);
    if (reach === null) return 'no-parent';
    if (reach.kind === 'live') {
      reach.live.offerDesignResult(record.designId);
      return 'live';
    }
    if (reach.kind === 'queued') return 'queued';
    if (!notify) return 'notified';
    const parent = reach.parent;
    void this.deps.platform.notifications
      .info(l('The design "{0}" is finished (v{1}). Open its main chat to continue.', role.title, record.version), [l('Open chat')])
      .then(async (choice) => {
        if (choice !== 0) return;
        this.warnNotShown(await this.deps.panels()?.showSession(parent), l('The main chat of this design no longer exists.'));
      })
      .catch((err: unknown) => log('[SessionDesign] opening the main chat from the notification failed: %O', err));
    return 'notified';
  }

  /** A main chat would receive a version now: `offerResult` would not answer 'no-parent'. */
  async hasParent(role: DesignRole): Promise<boolean> {
    return (await this.parentReach(role)) !== null;
  }

  /** Where the parent `link.json` names is: live in this process, held by another, or away on disk; null with none or gone. */
  private async parentReach(role: DesignRole): Promise<{ kind: 'live'; live: LiveSessionMutator } | { kind: 'queued' } | { kind: 'away'; parent: string } | null> {
    const parent = await this.parentOf(role);
    if (parent === null) return null;
    const live = PiRuntime.liveSessionMutator(parent);
    if (live) return { kind: 'live', live };
    if (sessionLeaseBlocker(parent)?.kind === 'other-process') return { kind: 'queued' };
    return (await this.deps.sessionExists(parent)) ? { kind: 'away', parent } : null;
  }

  /** The folder of design `designId` when it is this chat's own (its role, or its own link); never another chat's. */
  folderOf(designId: string): string | undefined {
    const own = this.role() ?? this.ownLink();
    return own?.designId === designId ? own.folder : undefined;
  }

  /** The folder of design `designId` when a chat of this process holds it (its role or own link), never any other folder. */
  static heldFolderOf(designId: string): string | undefined {
    for (const holder of SessionDesign.holders.get(designId) ?? []) {
      const folder = holder.folderOf(designId);
      if (folder !== undefined) return folder;
    }
    return undefined;
  }

  /** The latest tweaks declared in the design chat of this process that holds design `designId` by its role and is current; null for none. */
  static tweaksOf(designId: string): TweaksDeclaration | null {
    for (const holder of SessionDesign.holders.get(designId) ?? []) {
      if (holder.role()?.designId === designId && holder.standing().kind === 'current') return tweaksOnBranch(holder.branch());
    }
    return null;
  }

  /** The folder to serve design `designId` from when it is this chat's own; the chat then holds the design open until it lets go. */
  servedFolderOf(designId: string): string | undefined {
    this.syncHold();
    return this.folderOf(designId);
  }

  /** The main chat of a design chat's design: the one `link.json` names, which a parent's conversation rewind moves (D70). */
  private async parentOf(role: DesignRole): Promise<string | null> {
    const link = await readDesignLink(designStateDirOf(role.designId));
    return link ? link.parentSessionId : role.parentSessionId;
  }

  /** Tells the user why a chat did not show: open in another process (the lease's wording), not shown on their device, or gone. */
  private warnNotShown(shown: SessionShown | undefined, missing: LocalizedText): void {
    if (shown === 'shown') return;
    const why = shown === 'elsewhere' ? l('This conversation is open in another Damocles window.') : shown === 'notShown' ? l('The chat could not be shown on this device.') : missing;
    void this.deps.platform.notifications.warn(why);
  }

  /** Shows the current chat of design `designId`: this parent's design chat, or, from a superseded design chat, its successor. */
  async openDesignChat(designId: string): Promise<void> {
    if (this.role()?.designId === designId) {
      const current = (await readDesignLink(designStateDirOf(designId)))?.designSessionId;
      this.warnNotShown(current ? await this.deps.panels()?.showSession(current) : 'missing', l('The chat this design continues in no longer exists.'));
      return;
    }
    const link = this.ownLink();
    if (link?.designId !== designId) {
      // A fork's replayed card names the design its source chat started (PD-37), which this chat does not open.
      void this.deps.platform.notifications.warn(l('This design belongs to the chat this one was forked from. Open that chat to see it.'));
      return;
    }
    const current = (await readDesignLink(designStateDirOf(designId)))?.designSessionId;
    this.warnNotShown(current ? await this.deps.panels()?.showSession(current) : 'missing', l('This design chat no longer exists. Ask the agent to start the design again.'));
  }

  /** Shows this design chat's parent, reopening it when closed. */
  async openParentChat(): Promise<void> {
    const role = this.role();
    if (!role) return;
    const parent = await this.parentOf(role);
    if (!parent) return;
    this.warnNotShown(await this.deps.panels()?.showSession(parent), l('The main chat of this design no longer exists.'));
  }

  /**
   * The thumbnail of one design-kind option of AskUserQuestion call `toolUseId` (FULL): open (`pending`, its questions) or
   * answered on the branch, and only a screen of this chat's own design. Throws a LocalizedError the webview shows.
   */
  async questionPreviewImage(toolUseId: string, questionIndex: number, optionIndex: number, pending: unknown): Promise<DesignPreviewImage> {
    const role = this.role();
    const render = this.deps.platform.designPreview;
    if (!role || !this.ruleSet().preview || !render) throw new LocalizedError(l('This chat shows no design thumbnails.'));
    const relPath = designPreviewPathOf(pending ?? askedQuestions(this.branch(), toolUseId), questionIndex, optionIndex);
    if (relPath === undefined) throw new LocalizedError(l('This option has no design preview.'));
    return this.previewImages.image(render, role.designId, role.folder, relPath, this.lifetime.signal);
  }

  /**
   * Replays PreviewJourney call `toolCallId` of this design chat's branch in its screen's live preview tab (FULL, D93): the
   * journey is the branch's, the design this chat's own. Resolves once the replay ended; throws a LocalizedError otherwise.
   */
  async replayJourney(toolCallId: string, reducedMotion: boolean): Promise<void> {
    const role = this.role();
    const preview = this.deps.platform.designPreview;
    if (!role || !this.ruleSet().preview || !preview) throw new LocalizedError(l('This chat replays no journeys.'));
    const journey = journeyOnBranch(this.branch(), toolCallId);
    if (!journey) throw new LocalizedError(l('This journey is no longer in this chat.'));
    const panelId = this.deps.panelId();
    if (panelId === undefined || this.standing().kind !== 'current') throw new LocalizedError(l('This design continues in another chat.'));
    await preview.replayJourney(panelId, role.designId, journey.relPath, journey.state === 'default' ? null : journey.state, journey.steps, reducedMotion, this.lifetime.signal);
  }

  dispose(): void {
    this.disposed = true;
    this.lifetime.abort(new Error('The chat closed'));
    clearTimeout(this.changedTimer);
    this.syncHold();
    this.unwatch();
    this.pausing = undefined;
    this.closeVersionPrompt();
  }
}
