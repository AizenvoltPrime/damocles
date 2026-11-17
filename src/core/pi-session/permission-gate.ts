import { access, realpath } from 'node:fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { ToolCallEvent, ToolCallEventResult, AgentBeforeSettleEvent, SessionBoundaryDraft } from '@earendil-works/pi-coding-agent';
import type { PermissionHandler, CanUseToolContext } from '../permission-handler';
import type { McpToolIdentity } from '../permission-handler/types';
import type { PermissionBehavior, PermissionDetail, PermissionFact, PermissionUpdate } from '../../shared/types/permissions';
import type { MemoryService } from '../memory';
import type { CompassService } from '../compass';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import { FEEDBACK_MARKER, POLICY_BLOCK_MARKER } from '../../shared/types/constants';
import { IGNORED_TOOLS, SUBAGENT_TOOLS, TOOL_EDIT, TOOL_WRITE, TOOL_AGENT, TOOL_GENERATE_IMAGE, TOOL_GLOB, TOOL_GREP, TOOL_IMPORT_ASSET, TOOL_LS, TOOL_READ, TOOL_WEB_FETCH, LIVE_OUTPUT_TOOLS, SHELL_TOOLS, WRITE_TOOLS, FORGE_WRITE_TOOLS, isMcpResourceToolName } from '../../shared/tool-names';
import { isPlanFilePath } from '../paths';
import { networkReach } from '../local-links';
import { loadedFileUrl, UNPARSED_FILE_URL } from '../browser/loaded-file-url';
import type { ChatServedFiles } from '../browser/served-files';
import { canonicalPath, localDrivePath } from '../canonical-path';
import { l } from '../l10n';
import { mapPiToolName, normalizeToolInput, denormalizeToolInput, toolCategory } from './tool-normalization';
import type { ReadOnlyVerdict } from './readonly-shell';
import { provenReadOnlyShell, type ChatMachine } from './proven-shell';
import { readPathCandidates, resolveToCwd } from './tools/search-tools';
import { rootPointerReach } from './tools/search-walk';
import { browserUploadPath } from './tools/browser-tools';
import { worktreeIsolationBlock, type WorktreeIsolation } from './worktree-isolation';
import { GATEABLE_MODULE_NAMES } from './tools/tool-catalog';
import { DESIGN_PI_TOOL_NAMES, DESIGN_TOOLS_WITHOUT_FOLDER_WRITES } from '../design/rule-set';
import { designFilesWriteBlock, designShellRefusal, designWriteBlock, type DesignScope } from '../design/design-write-rule';
import { log } from '../logger';
import { userScopeToolNames } from './tools/deferred-tools';
import { browserClosedReason, forgeUnreachableReason, relayedMcpUnreachableReason, userScopeReach } from '../user-scope';
import { isForgeTool, type ForgeToolsPort } from './tools/forge-tools';
import type { ForgeApprovalAnswer } from '../../shared/forge/tools';
import { DESIGN_CHAT_FORGE_REFUSAL } from './tools/forge-tool-specs';
import { relayedServerOfTool } from './mcp/relayed-tool-names';
import { englishText, type LocalizedArg, type LocalizedText } from '../../shared/localized-text';
import { visibleText } from '../../shared/visible-text';
import type { DeferrableSnapshot } from './tools/tool-search-tool';
import type { ResourceReadReach } from './mcp/content';
import type { ShellCancelRegistry } from './tools/shell-cancel-registry';
import { describeStoppedBeforeRun } from './tools/cancellable-shell';
import type { ToolCallHookOutcome } from './hooks/dispatch';
import { recordTerminatedCall, type TerminateCause } from './terminated-calls';
import type { DesignPromptInputs } from './agent-start';

/** A non-aborting signal for gate calls when pi hands us no AbortSignal (`ctx.signal` is optional). */
const NEVER_ABORT: AbortSignal = new AbortController().signal;

const ABORTED_BEFORE_RUN = 'The session was aborted before this tool call could run';

/**
 * Build the `CanUseToolContext` the managers expect. `toolCallId` is pi's native, always-present id.
 * `parentToolUseId` is the spawning `Agent` tool-call id for a nested subagent call (so requestPermission /
 * permissionAutoResolved attach to the subagent card), or `null` for a primary-agent call.
 */
export function buildCanUseToolContext(
  toolCallId: string,
  signal: AbortSignal | undefined,
  parentToolUseId: string | null = null,
  mcpTool?: McpToolIdentity,
): CanUseToolContext {
  return { signal: signal ?? NEVER_ABORT, toolUseID: toolCallId, parentToolUseId, ...(mcpTool ? { mcpTool } : {}) };
}

/** The runtime inputs of the system prompt's sections on the pi path (US-007), resolved per session. */
export interface SystemPromptEnv {
  cwd: string;
  model: string;
  isGitRepo: boolean;
  platform: string;
  shell: string;
  osVersion: string;
  compassEnabled: boolean;
  /** Gates the output-form guidance. Required, not optional: an omitted flag would render the
   *  `/context` preview thinking-on while the live turn runs thinking-off. */
  thinkingDisabled: boolean;
}

/**
 * The per-panel state the shared Damocles extension routes to, looked up by sessionId. Beyond the
 * permission gate (`permissionHandler`/`isPlanMode`), it carries everything the `before_agent_start`
 * hook needs to assemble the Damocles system prompt and inject memory/compass context: the panel's
 * services, its resolved session model + environment, and a webview-message emitter.
 */
export interface PanelGateContext {
  permissionHandler: PermissionHandler;
  isPlanMode: () => boolean;
  /** The panel's memory service, when one is wired (enabled-check is the caller's). */
  memoryService?: MemoryService;
  /** The panel's compass service, when one is wired. */
  compassService?: CompassService;
  /** The resolved session model id (per-session, model-aware system prompt). */
  getSessionModel: () => string;
  /** Runtime inputs for `assembleDamoclesSystemPrompt`. */
  getSystemPromptEnv: () => SystemPromptEnv;
  /** The workspace memory's project scope files this panel's prompts under: the project of a worktree chat (`identityFolder`). */
  memoryWorkspace: () => string;
  /** The session's deterministic plan-file path, named in the plan-mode system prompt so the model
   *  maintains its plan there. */
  getPlanFilePath: () => string;
  /** Whether the multi-agent Team feature is enabled. Selects whether the team rung appears in the
   *  delivery-mechanism ladder the plan-mode and plan-execution directives carry. */
  isTeamEnabled?: () => boolean;
  /** Emit a webview message from a shared-extension hook (injection chips, etc.). */
  postMessage: (message: ExtensionToWebviewMessage) => void;
  /** True once the hard budget limit stopped the turn; a cache-warming refresh bills against that cap. */
  budgetStopRequested: () => boolean;
  /** Called from the `agent_before_settle` boundary: coordinates the background keep-alive (wait for
   *  running subagents and carry their results into one more request) and the plan-mode hold (nudge the
   *  model to call ExitPlanMode if a plan-mode turn ended without it). Returns the entry to append and
   *  continue the run with, or undefined to let the run settle. */
  onBeforeSettle?: (event: AgentBeforeSettleEvent) => Promise<SessionBoundaryDraft | undefined>;
  /**
   * Whether an `mcp__…` tool is annotated read-only (US-014.4). The panel reads it live off the MCP
   * client; a nested subagent/team agent supplies the FROZEN classifier from its per-spawn
   * `NestedMcpToolset` snapshot, so both get the same auto-allow-vs-prompt behaviour. Optional only
   * because a caller with no MCP at all (empty snapshot, MCP disabled) has nothing to classify —
   * absent ⇒ every `mcp__*` call routes to `canUseTool`, which is the fail-closed direction.
   */
  isMcpReadOnly?: (piToolName: string) => boolean;
  /**
   * The server and raw tool name behind an `mcp__…` tool, from the same descriptors as `isMcpReadOnly`,
   * which `mcp__` settings rules match. Absent, or undefined for a name with no descriptor, leaves only a
   * rule spelling the exact pi name able to match it.
   */
  mcpToolIdentity?: (piToolName: string) => McpToolIdentity | undefined;
  /** This panel's deferrable universe for `ToolSearch`; absent for subagents (no deferral). */
  deferrableTools?: () => DeferrableSnapshot;
  /**
   * The signal of the user send whose run pi is starting, which a Stop, a replacement or a disposal aborts; undefined for a
   * run no send started. pi gives `before_agent_start` no abort signal of its own. Absent for nested agents.
   */
  startingRunSignal?: () => AbortSignal | undefined;
  /**
   * How `read_mcp_resource` reaches this panel's agent now, for a resource link in a result from `server`.
   * The folder's MCP tools serve every panel in it and ask this per call; absent for nested agents, whose
   * frozen toolset answers itself.
   */
  mcpResourceReach?: (server: string) => Promise<ResourceReadReach>;
  /** Load deferred tools into this panel's active set — synchronous, called inside `ToolSearch.execute`. */
  activateDeferredTools?: (names: string[]) => void;
  /**
   * The panel's turn checkpoint. A nested agent passes its parent panel's, so its file changes never
   * land before the parent turn's baseline. Absent means no checkpoints to wait for.
   */
  checkpointBaseline?: CheckpointBaselineGate;
  /**
   * This context's handle on the panel's shell cancel store, delivering a note to the agent this gate
   * serves. The gate opens a call's entry as it starts deciding, so a Stop reaches the call before it runs.
   */
  shellCancel: ShellCancelRegistry;
  /** D62: set while the chat works in its chat worktree; read per call, since a hand-off moves the chat. */
  worktreeIsolation?: () => WorktreeIsolation | undefined;
  /** A design chat's posture (PD-4, PD-25), for it and every agent it starts; read per call. */
  designScope?: () => DesignScope | undefined;
  /** The chat's GitHub and GitLab tools: their target before rules match, a write's card before it asks. Absent: none run. */
  forgeTools?: ForgeToolsPort;
  /** The design sections' inputs (a design chat's folder and rule set, a parent's own link), read per turn. */
  designPrompt?: () => DesignPromptInputs;
  /**
   * The machine the chat's tools run on, which proving a shell command read-only and placing a file tool's path read. Absent:
   * no network host is the chat's and no PowerShell program lookup can pass, so only the fail-closed answers remain.
   */
  machine?: ChatMachine;
  /**
   * The chat's served roots and the folders it was granted, shared by its nested agents: a browser load of a file page outside
   * them asks, and the call the gate lets run grants the page's folder. Absent: no outside page asks, and the tool refuses it.
   */
  browserFiles?: Pick<ChatServedFiles, 'folderAsk' | 'grantedFile' | 'grantRefusal' | 'grant'>;
}

/** What the gate needs of a panel's turn checkpoint. */
export interface CheckpointBaselineGate {
  /** The folder the checkpoint captures; an Edit or Write outside it never waits. */
  readonly folder: string;
  /** Resolves once the current turn has its baseline, the bounded wait ran out, or `signal` aborted. Never rejects. */
  wait(signal: AbortSignal, toolName: string): Promise<void>;
}

/**
 * Tools whose interaction is owned by their own `execute()` (they drive the managers directly). The
 * gate must NOT route these through `canUseTool` — that would double-prompt. `IGNORED_TOOLS` already
 * covers AskUserQuestion/Enter/Exit-PlanMode.
 */
const GATE_ALLOW_ALWAYS: ReadonlySet<string> = new Set<string>([...IGNORED_TOOLS, ...SUBAGENT_TOOLS]);

/**
 * Ensure a deny reason renders as the existing "denied" card state rather than "failed". The webview
 * derives "denied" from a tool error containing `FEEDBACK_MARKER` (`extractUserDenialFeedback`), so we
 * guarantee the marker is present in every gate block reason (FR-9). Also reused by the ExitPlanMode
 * tool so a rejected plan renders denied + feedback.
 */
export function formatDenyReason(message: string | undefined): string {
  const base = message ?? 'Permission denied';
  if (base.includes(FEEDBACK_MARKER)) return base;
  return `The user doesn't want to proceed with this tool use. The tool use was rejected. ${FEEDBACK_MARKER} ${base}`;
}

/**
 * The counterpart for a block the runtime made on its own — a settings permission rule, plan mode, a
 * read-only agent's toolset, or a configured PreToolUse hook. Renders "denied" exactly like
 * {@link formatDenyReason}, but never claims the user rejected anything: they were not asked, and a
 * model told otherwise stops to consult a human instead of working within the constraint it hit.
 */
export function formatPolicyBlockReason(message: string | undefined): string {
  const base = message ?? 'Blocked by a permission policy';
  if (base.includes(POLICY_BLOCK_MARKER)) return base;
  return `This tool call was blocked automatically and the user was not consulted. ${POLICY_BLOCK_MARKER} ${base}`;
}

/** The slice of a panel's context the gate actually reads. `PanelGateContext` satisfies it; a nested
 *  subagent supplies the same parent handler + a parent-mode reader (inherit-parent-mode). */
export type GatePermissionContext = Pick<PanelGateContext, 'permissionHandler' | 'isPlanMode' | 'isMcpReadOnly' | 'mcpToolIdentity' | 'checkpointBaseline' | 'shellCancel' | 'worktreeIsolation' | 'designScope' | 'machine' | 'forgeTools' | 'browserFiles'> & {
  /**
   * Apply plan mode's shell rule to this caller in every mode: a command `provenReadOnlyShell` proves
   * read-only auto-runs, any other goes through `canUseTool` (prompt, settings rules, YOLO), and write
   * tools are blocked. Set for a subagent whose resolved toolset contains no write tool.
   */
  readOnlyShell?: boolean;
  /**
   * Where the gate reports a call `canUseTool` let through as running (`toolPending`), since its prompt
   * moved the call's card to awaiting approval. Absent for a team agent: its cards take no status from a
   * prompt, and `toolPending` would land on the chat's own transcript.
   */
  postMessage?: (message: ExtensionToWebviewMessage) => void;
};

/** Tools that start agents, which change files the turn's checkpoint must see first. */
const SPAWN_TOOLS: ReadonlySet<string> = new Set<string>([TOOL_AGENT, 'create_team', 'resume_team', 'team_spawn_specialist', 'team_redispatch_specialist']);

/**
 * Whether a call may change `folder` and so must wait for the turn's checkpoint baseline. Read-only
 * tools, read-only-annotated MCP tools, provably read-only shell commands, the in-process coordination
 * tools (none writes into the folder), and an Edit or Write of the plan file or of a path outside the
 * folder never wait; spawn tools, other writes, other shell and anything unknown do. A design tool waits unless it writes
 * nothing into a design folder (PD-42). `shellVerdict` is the call's `provenReadOnlyShell` verdict; a shell call without one waits.
 */
export function waitsForCheckpointBaseline(piToolName: string, input: Record<string, unknown>, isMcpReadOnly: ((name: string) => boolean) | undefined, folder: string, shellVerdict?: ReadOnlyVerdict): boolean {
  const damoclesName = mapPiToolName(piToolName);
  if (SPAWN_TOOLS.has(damoclesName)) return true;
  if (damoclesName === TOOL_EDIT || damoclesName === TOOL_WRITE) {
    const filePath = normalizeToolInput(piToolName, input)['file_path'];
    if (typeof filePath !== 'string' || !filePath) return true;
    // Resolved against the folder, as the tools resolve it, so an unrecognised prefix reads as inside and waits.
    const target = path.resolve(folder, filePath);
    return !isPlanFilePath(target) && isInsideFolder(target, folder);
  }
  if (DESIGN_PI_TOOL_NAMES.has(damoclesName)) return !DESIGN_TOOLS_WITHOUT_FOLDER_WRITES.has(damoclesName);
  const category = toolCategory(damoclesName);
  if (category === 'read') return false;
  if (damoclesName.startsWith('mcp__')) return !(isMcpReadOnly?.(damoclesName) ?? false);
  if (GATE_ALLOW_ALWAYS.has(damoclesName) || GATEABLE_MODULE_NAMES.has(damoclesName) || isForgeTool(damoclesName)) return false;
  if (category === 'shell') return shellVerdict?.readOnly !== true;
  return true;
}

function isInsideFolder(target: string, folder: string): boolean {
  const rel = path.relative(folder, target);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** What the gate reads off the host thread about a call as its PreToolUse hooks left it, once, for every check to share. */
export interface CallFacts {
  /** A shell call's `provenReadOnlyShell` verdict. */
  readonly shellVerdict?: ReadOnlyVerdict;
  /** The path of a file tool may reach a network host the chat does not live on (`networkReach`): no check touches it. */
  readonly reachesNetwork: boolean;
  /** The hosts those paths name by spelling or through a link, each once. */
  readonly networkHosts: readonly string[];
  /**
   * One of those paths may reach a host none of them names: a device path, a link to one, a server with an `@` WebDAV does not
   * read, a network drive whose server cannot be read, or a `file:` URL naming no path.
   */
  readonly unplacedReach: boolean;
  /** Those paths as the input names them (a browser load's URL as written), each once. */
  readonly networkPaths: readonly string[];
  /** The one path that reaches is where a search's repository `.git` file points (`rootPointerReach`), which the search never opens. */
  readonly repositoryPointer?: true;
  /**
   * A browser load of a file page outside the chat's roots and granted folders: the file, the folder as the page names it, and
   * its root: its canonical path, or for a path that may reach a network host the folder as written, which nothing touches until
   * the call may run.
   */
  readonly outsidePage?: { readonly file: string; readonly folder: string; readonly root: string };
  /** Why the folder of such a page is never granted: the gate blocks the call with it and asks nothing. */
  readonly pageRefusal?: string;
  /** The file of a browser load under a folder the chat was granted, which `Read` rules decide too. */
  readonly grantedPage?: string;
}

type Reach = NonNullable<Awaited<ReturnType<typeof networkReach>>>;

const LOCAL_FACTS: CallFacts = { reachesNetwork: false, networkHosts: [], unplacedReach: false, networkPaths: [] };
const NO_NETWORK_HOSTS: ReadonlySet<string> = new Set();
const UNKNOWN_MACHINE: ChatMachine = { platform: process.platform, allowedNetworkHosts: () => Promise.resolve(NO_NETWORK_HOSTS) };
const BROWSER_URL_TOOLS: ReadonlySet<string> = new Set(['BrowserOpen', 'BrowserNavigate', 'BrowserTabs']);
const UNPLACED_FILE = Symbol('unplaced file');

/**
 * The paths a tool opens or searches, each as its input names it (`written`) and as the absolute path it opens (`path`), `read`
 * when it opens them as pi's Read does; undefined for a tool that names none. A file tool's path resolves as pi resolves it
 * (`resolveToCwd`), a browser upload's as the tool does (`browserUploadPath`), and a browser load's as Chrome opens it
 * (`loadedFile`), which may name no path (`unplaced`, the URL as written).
 */
function filePathsOf(name: string, input: Record<string, unknown>, cwd: () => string): { paths: readonly { written: string; path: string }[]; read: boolean } | { unplaced: string } | undefined {
  const named = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
  const paths = (read: boolean, resolved: (written: string) => string | undefined, ...values: unknown[]) => {
    const found = values.map(named).flatMap((written) => {
      const opened = written === undefined ? undefined : resolved(written);
      return opened === undefined ? [] : [{ written: written!, path: opened }];
    });
    return found.length === 0 ? undefined : { paths: found, read };
  };
  const tool = (written: string): string => resolveToCwd(written, cwd());
  if (name === TOOL_READ) return paths(true, tool, input['file_path']);
  if (name === TOOL_GREP || name === TOOL_GLOB || name === TOOL_LS) return paths(false, tool, named(input['path']) ?? '.');
  // ImportAsset's `path` and `file` read as a Read of that path does; its `url` is no file.
  if (name === TOOL_IMPORT_ASSET) return paths(true, tool, input['path'], input['file']);
  if (WRITE_TOOLS.has(name)) return paths(false, tool, named(input['file_path']) ?? input['path']);
  // the tool refuses the whole call when any path is relative, so only absolute ones are opened
  if (name === 'BrowserUpload') return Array.isArray(input['paths']) ? paths(false, browserUploadPath, ...input['paths']) : undefined;
  const url = browserLoadUrl(name, input);
  const file = url === undefined ? undefined : loadedFile(url);
  if (file === undefined) return undefined;
  return file === UNPLACED_FILE ? { unplaced: url! } : { paths: [{ written: url!, path: file }], read: false };
}

/** The address a BrowserOpen, BrowserNavigate or BrowserTabs new tab loads; BrowserTabs loads its url only when it opens a new tab. */
function browserLoadUrl(name: string, input: Record<string, unknown>): string | undefined {
  const url = input['url'];
  return BROWSER_URL_TOOLS.has(name) && (name !== 'BrowserTabs' || input['action'] === 'new') && typeof url === 'string' && url !== '' ? url : undefined;
}

/**
 * The page facts of a browser load: a page under a granted folder, or one outside the roots and every grant with the folder a
 * run grants, or why that folder is never granted. A folder is judged as written and, unless its path may reach a network host
 * (nothing is touched there before the user's answer), as its canonical path, so a link or an 8.3 name cannot lead a grant
 * into a folder the spelling hides.
 */
function browserPageFacts(name: string, input: Record<string, unknown>, files: NonNullable<GatePermissionContext['browserFiles']>, reachesNetwork: boolean): Pick<CallFacts, 'outsidePage' | 'pageRefusal' | 'grantedPage'> | undefined {
  const url = browserLoadUrl(name, input);
  if (url === undefined) return undefined;
  const granted = files.grantedFile(url);
  if (granted !== undefined) return { grantedPage: granted };
  const ask = files.folderAsk(name, url);
  if (ask === undefined) return undefined;
  if ('refused' in ask) return { pageRefusal: ask.refused };
  const root = reachesNetwork ? ask.folder : canonicalPath(ask.folder);
  const refused = reachesNetwork ? files.grantRefusal(localDrivePath(ask.folder), false) : files.grantRefusal(root, true);
  return refused !== undefined ? { pageRefusal: refused } : { outsidePage: { file: ask.file, folder: ask.folder, root } };
}

/**
 * The file Chrome opens for a browser load of url (`loadedFileUrl`, which the browser tools read too): a file: URL's path as
 * `fileURLToPath` gives it, resolved, with no other normalisation. undefined for a load of no file; UNPLACED_FILE for a file: URL
 * that names no path or that the parser rejects.
 */
function loadedFile(url: string): string | typeof UNPLACED_FILE | undefined {
  const loaded = loadedFileUrl(url);
  if (loaded === undefined) return undefined;
  if (loaded === UNPARSED_FILE_URL) return UNPLACED_FILE;
  try {
    return path.resolve(fileURLToPath(loaded));
  } catch (err) {
    // a path Node cannot give: not absolute, an encoded separator, a host off win32, or percent-encoding that is not UTF-8
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ERR_INVALID_FILE_URL_PATH' || code === 'ERR_INVALID_FILE_URL_HOST' || err instanceof URIError) return UNPLACED_FILE;
    throw err;
  }
}

/**
 * What pi's Read of `requested` may reach. pi opens the first of its names (`readPathCandidates`) that exists, and Windows follows
 * a link at any segment but the last while it answers whether a name exists, so each name is placed before it is probed, a name
 * that may reach is never probed, and the names after it count too, since pi tries them when it is missing.
 */
async function readReach(requested: string, allowed: ReadonlySet<string>): Promise<Reach | null> {
  const reaches: Reach[] = [];
  for (const candidate of readPathCandidates(requested)) {
    const reach = await networkReach(candidate, allowed);
    if (reach !== null) reaches.push(reach);
    else if (await access(candidate).then(() => true, () => false)) break;
  }
  return reaches.length === 0 ? null : { hosts: reaches.flatMap((reach) => reach.hosts), unplaced: reaches.some((reach) => reach.unplaced) };
}

/**
 * The facts of call `name` with normalized `input`. A file tool's path resolves as the tool resolves it, a Read's as `readReach`; a
 * search's also reaches where its repository's `.git` file points (`rootPointerReach`); a browser load of a file page is placed
 * against the chat's roots and granted folders (`files`).
 */
export async function callFactsOf(name: string, input: Record<string, unknown>, machine: ChatMachine, cwd: () => string, files?: GatePermissionContext['browserFiles']): Promise<CallFacts> {
  const facts = await networkFactsOf(name, input, machine, cwd);
  const page = files === undefined ? undefined : browserPageFacts(name, input, files, facts.reachesNetwork);
  return page === undefined ? facts : { ...facts, ...page };
}

async function networkFactsOf(name: string, input: Record<string, unknown>, machine: ChatMachine, cwd: () => string): Promise<CallFacts> {
  if (SHELL_TOOLS.has(name)) return { ...LOCAL_FACTS, shellVerdict: await provenReadOnlyShell(name, input, machine, cwd()) };
  if (process.platform !== 'win32') return LOCAL_FACTS;
  const file = filePathsOf(name, input, cwd);
  if (file === undefined) return LOCAL_FACTS;
  if ('unplaced' in file) return { reachesNetwork: true, networkHosts: [], unplacedReach: true, networkPaths: [file.unplaced] };
  const allowed = await machine.allowedNetworkHosts();
  const hosts = new Set<string>();
  const reaching = new Set<string>();
  let unplaced = false;
  let pointed = false;
  const add = (written: string, reach: Reach): void => {
    reaching.add(written);
    unplaced ||= reach.unplaced;
    for (const host of reach.hosts) hosts.add(host);
  };
  for (const { written, path: requested } of file.paths) {
    const reach = file.read ? await readReach(requested, allowed) : await networkReach(requested, allowed);
    if (reach !== null) add(written, reach);
    // the walk never follows its root repository's `.git` pointer off these hosts, so the card names where it leads
    else if (name === TOOL_GREP || name === TOOL_GLOB) {
      const pointer = await rootPointerReach(requested, () => Promise.resolve(allowed));
      if (pointer !== undefined) {
        add(pointer.written, pointer.reach);
        pointed = true;
      }
    }
  }
  return { reachesNetwork: reaching.size > 0, networkHosts: [...hosts], unplacedReach: unplaced, networkPaths: [...reaching], ...(pointed ? { repositoryPointer: true as const } : {}) };
}

/**
 * The card of a call whose path may reach a network host: the action, the paths as written and the hosts they name, and that
 * opening them sends the user's Windows sign-in there. With no host it says the place is unknown, and with a path it cannot place
 * beside named hosts it adds "possibly another computer". Undefined for a tool whose prompt has a view of its own (GenerateImage).
 */
function networkPathDetail(name: string, facts: CallFacts): PermissionDetail | undefined {
  // the agent spells the paths and their hosts, so a bidi or control character shows as its escape
  const hosts = facts.networkHosts.map(visibleText);
  const paths = facts.networkPaths.map(visibleText);
  const unplaced = facts.unplacedReach;
  const several = paths.length > 1;
  // "a", "a and b", "a, b and c"
  const named = hosts.length <= 1 ? hosts[0] : l('{0} and {1}', hosts.slice(0, -1).join(', '), hosts[hosts.length - 1]!);
  const place = named !== undefined && unplaced ? l('{0} and possibly another computer', named) : named;
  if (facts.repositoryPointer) return repositoryPointerDetail(paths, hosts, unplaced, place);
  const title = networkPathTitle(name, place, several);
  if (title === undefined) return undefined;
  const pathFact: PermissionFact = { label: pathLabel(name, several), value: paths.join('\n') };
  if (place === undefined) {
    return {
      title,
      subtitle: several ? l('opening them may send your Windows sign-in to other computers') : l('opening it may send your Windows sign-in to another computer'),
      facts: [pathFact],
      approvedStatus: l('Allowed once. Your Windows sign-in may go to another computer.'),
    };
  }
  const computers: PermissionFact = unplaced
    ? { label: l('Computers'), value: hosts.join(', '), note: l('and possibly another') }
    : { label: hosts.length > 1 ? l('Computers') : l('Computer'), value: hosts.join(', ') };
  return { title, subtitle: networkPathSubtitle(several, hosts.length > 1, unplaced), facts: [pathFact, computers], approvedStatus: l('Allowed once. Your Windows sign-in goes to {0}.', place) };
}

// several: more than one path; severalHosts: they name more than one host; unplaced: one may reach a host none names
function networkPathSubtitle(several: boolean, severalHosts: boolean, unplaced: boolean): LocalizedText {
  if (unplaced) return several ? l('opening them may send your Windows sign-in to other computers') : l('opening it may send your Windows sign-in to other computers');
  if (several) return severalHosts ? l('opening them sends your Windows sign-in to those computers') : l('opening them sends your Windows sign-in to that computer');
  return severalHosts ? l('opening it sends your Windows sign-in to those computers') : l('opening it sends your Windows sign-in to that computer');
}

function pathLabel(name: string, several: boolean): LocalizedText {
  if (name === TOOL_GREP || name === TOOL_GLOB || name === TOOL_LS) return l('Folder');
  if (BROWSER_URL_TOOLS.has(name)) return l('URL');
  return several ? l('Files') : l('File');
}

/**
 * The card of a browser load of a file page outside the chat's folders: the action, the file and the folder a yes serves to the
 * chat, whose every file and subfolder the page can read until the chat closes. A page that may also reach a network host gets
 * that card (`network`) with the folder added, so one prompt answers both.
 */
function outsideFolderDetail(name: string, page: NonNullable<CallFacts['outsidePage']>, network: PermissionDetail | undefined): PermissionDetail {
  const root = visibleText(page.root);
  if (network !== undefined) {
    const folder: PermissionFact = { label: l('Folder served'), value: root, note: l('the page can read every file in it and its subfolders until the chat closes') };
    return { ...network, facts: [...(network.facts ?? []), folder], approvedStatus: l('{0} This chat\'s browser serves {1} until the chat closes.', network.approvedStatus ?? '', root) };
  }
  const title = name === 'BrowserNavigate' ? l('Go to a page outside this chat\'s folders?') : name === 'BrowserTabs' ? l('Open a tab with a page outside this chat\'s folders?') : l('Open a page outside this chat\'s folders?');
  return {
    title,
    subtitle: l('the page can read every file in its folder and its subfolders until the chat closes'),
    facts: [{ label: l('File'), value: visibleText(page.file) }, { label: l('Folder served'), value: root }],
    approvedStatus: l('Allowed. This chat\'s browser serves {0} until the chat closes.', root),
  };
}

/** The card of a search whose repository's `.git` file points off this computer: nothing is opened there, so approving sends no sign-in. */
function repositoryPointerDetail(paths: readonly string[], hosts: readonly string[], unplaced: boolean, place: LocalizedArg | undefined): PermissionDetail {
  const pointerFact: PermissionFact = { label: l('Repository'), value: paths.join('\n') };
  const subtitle = l('its .git file points there; Damocles does not open it, so that repository\'s exclude file is not applied');
  if (place === undefined) {
    return { title: l('Search a folder whose repository points to another computer?'), subtitle, facts: [pointerFact], approvedStatus: l('Allowed once. Nothing is opened on another computer.') };
  }
  const computers: PermissionFact = unplaced
    ? { label: l('Computers'), value: hosts.join(', '), note: l('and possibly another') }
    : { label: hosts.length > 1 ? l('Computers') : l('Computer'), value: hosts.join(', ') };
  return { title: l('Search a folder whose repository points to {0}?', place), subtitle, facts: [pointerFact, computers], approvedStatus: l('Allowed once. Nothing is opened on {0}.', place) };
}

// several: the call names more than one path that may reach a host
function networkPathTitle(name: string, place: LocalizedArg | undefined, several: boolean): LocalizedText | undefined {
  switch (name) {
    case TOOL_READ:
    case TOOL_IMPORT_ASSET:
      return place === undefined ? l('Read a file that may be on another computer?') : l('Read a file on {0}?', place);
    case TOOL_GREP:
    case TOOL_GLOB:
      return place === undefined ? l('Search files that may be on another computer?') : l('Search files on {0}?', place);
    case TOOL_LS:
      return place === undefined ? l('List a folder that may be on another computer?') : l('List a folder on {0}?', place);
    case TOOL_EDIT:
    case TOOL_WRITE:
      return place === undefined ? l('Change a file that may be on another computer?') : l('Change a file on {0}?', place);
    case 'BrowserUpload':
      if (place === undefined) return several ? l('Upload files that may be on other computers?') : l('Upload a file that may be on another computer?');
      return several ? l('Upload files from {0}?', place) : l('Upload a file from {0}?', place);
    default:
      if (!BROWSER_URL_TOOLS.has(name)) return undefined;
      return place === undefined ? l('Open a page that may be on another computer?') : l('Open a page on {0}?', place);
  }
}

/**
 * PreToolUse hooks plugged into the single gate handler (Section 3.3). `run` executes the configured
 * `tool_call` hooks for this event (null when none match; an abort of `signal` kills them and reports the
 * chain aborted); `onDecision` raises the transparency notice when a hook force-allows or blocks. Built
 * per tool-call by the extension wiring, which owns the panel's webview emitter. Absent when no
 * `tool_call` hook is configured, so the gate path stays zero-cost (FR-14).
 */
export interface PreToolUseHookGate {
  run: (event: ToolCallEvent, signal: AbortSignal | undefined) => Promise<ToolCallHookOutcome>;
  /** `terminate` is the hook's opt-in to ending the whole turn, not just this call — the notice must say
   *  so, because pi's terminate path settles the turn normally and leaves no other signal. */
  onDecision: (toolName: string, decision: 'allow' | 'deny', reason: string | undefined, terminate: boolean) => void;
  /** Surface any hook `systemMessage`(s) to the user (FR-16 transparency), independent of the decision. */
  notify: (messages: readonly string[]) => void;
  /**
   * Stash a hook's `additionalContext` for delivery on the matching tool result. pi's `tool_call` return
   * can only block (not inject context), so context is carried to the PostToolUse path keyed by toolCallId.
   * Called only on a proceed path (the tool will actually run), so a blocked tool leaves no orphan entry.
   */
  stashContext: (toolCallId: string, context: string) => void;
}

/**
 * The fail-closed answer for a tool call the gate cannot decide: blocked, whatever the tool. A read is
 * not exempt, because a settings deny or ask rule may name the file it reads, and an undecided check
 * cannot show that none does. Never terminating, so the model can re-plan.
 */
export function gateErrorFallback(): ToolCallEventResult {
  return { block: true, reason: formatPolicyBlockReason('This tool could not be approved, so it was blocked by default for safety.') };
}

/**
 * The central permission gate: pi `tool_call` event → Damocles `PermissionHandler.canUseTool`. Runs in
 * the shared Damocles extension, routed to the right panel by sessionId. Returns a `ToolCallEventResult`
 * (`{ block, reason }`) to deny, or `undefined` to allow.
 *
 * It NEVER mutates `event.input`: native pi tools execute with their raw input (`{ path }`, not the
 * normalized `{ file_path }`), so only a normalized COPY is handed to `canUseTool`. The managers never
 * rewrite values in Phase 2, so there is nothing to propagate back.
 *
 * `parentToolUseId` is non-null for a nested subagent's tool call (inherit-parent-mode gating): it is the
 * spawning `Agent` tool-call id, threaded into the approval flow so prompts attach to the subagent card.
 *
 * `recordSessionId` names the session whose run reads the terminating blocks (`terminated-calls.ts`); without it none is recorded.
 */
export async function runPermissionGate(
  event: ToolCallEvent,
  panel: GatePermissionContext,
  signal: AbortSignal | undefined,
  parentToolUseId: string | null = null,
  preToolUse?: PreToolUseHookGate,
  recordSessionId?: string,
): Promise<ToolCallEventResult | undefined> {
  // Opened at entry because pi emits `tool_execution_start`, which shows the card's Stop, before this gate runs.
  const stopSignal = LIVE_OUTPUT_TOOLS.has(mapPiToolName(event.toolName)) ? panel.shellCancel.admit(event.toolCallId, signal) : undefined;
  try {
    const result = await decideToolCall(event, panel, signal, parentToolUseId, preToolUse, stopSignal, recordSessionId);
    if (stopSignal && result?.block) panel.shellCancel.releaseAdmitted(event.toolCallId);
    return result;
  } catch (err) {
    if (stopSignal) panel.shellCancel.releaseAdmitted(event.toolCallId);
    throw err;
  }
}

/** `stopSignal` aborts when the user stops this shell call; such a call is blocked, never run and never prompted for. */
async function decideToolCall(
  event: ToolCallEvent,
  panel: GatePermissionContext,
  signal: AbortSignal | undefined,
  parentToolUseId: string | null,
  preToolUse: PreToolUseHookGate | undefined,
  stopSignal: AbortSignal | undefined,
  recordSessionId: string | undefined,
): Promise<ToolCallEventResult | undefined> {
  const damoclesName = mapPiToolName(event.toolName);
  // pi keeps no `terminate` on the result it stores, so the run's outcome reads it from this record.
  const terminating = (reason: string, cause: TerminateCause): ToolCallEventResult => {
    if (recordSessionId !== undefined) recordTerminatedCall(recordSessionId, { toolCallId: event.toolCallId, toolName: damoclesName, cause });
    return { block: true, reason, terminate: true };
  };
  const category = toolCategory(damoclesName);
  // Read-only-annotated MCP tools auto-allow like reads; non-read MCP tools hit full approval (US-014.4).
  const isMcp = damoclesName.startsWith('mcp__');
  const mcpReadOnly = isMcp && (panel.isMcpReadOnly?.(damoclesName) ?? false);
  // A design chat's MCP call that is not read-only (PD-25): no hook, YOLO or allow rule approves it, and a deny rule denies it.
  const onlyUserApproves = isMcp && !mcpReadOnly && panel.designScope?.() !== undefined;

  // PreToolUse hooks run INSIDE the single gate handler, before the gate decides (Section 3.3). `allow`
  // skips the gate entirely (force-allow); `deny`/exit-2 blocks; `updatedInput` mutates `event.input` in
  // place (denormalized to pi's shape) so the gate + the tool both see the rewrite; `ask`/none falls
  // through. An infra failure (spawn/timeout) is fail-closed for write/shell only. All bounded to tools
  // the user wrote a hook for; both force-allow and block raise the transparency notice.
  // A PreToolUse hook's `additionalContext` (when the tool will proceed) is delivered on the matching
  // tool result — pi's `tool_call` return can't inject context. Stamped on any "tool proceeds" path.
  let pendingContext: string | undefined;
  // Ends the PreToolUse hooks, the approval prompt and the checkpoint wait on a Stop as well as on a run abort.
  const callSignal = stopSignal ? AbortSignal.any([signal ?? NEVER_ABORT, stopSignal]) : signal;
  // The user acted, so this is a user rejection: no policy wording, no `terminate` (the turn goes on),
  // and never the note, which already reached the agent as a user message.
  const stoppedByUser = (): ToolCallEventResult | undefined => {
    if (!stopSignal?.aborted) return undefined;
    const cancellation = panel.shellCancel.takeCancellation(event.toolCallId) ?? {};
    return { block: true, reason: formatDenyReason(describeStoppedBeforeRun(cancellation)) };
  };
  // A wait `callSignal` ended blocks as an aborted approval prompt does: the user's Stop, else an unasked deny.
  const abortedWhileWaiting = (): ToolCallEventResult =>
    stoppedByUser() ?? { block: true, reason: formatPolicyBlockReason(ABORTED_BEFORE_RUN) };
  // Read first where every hook has run, so each check judges the input as it runs.
  let facts: Promise<CallFacts> | undefined;
  const callFacts = (): Promise<CallFacts> => (facts ??= callFactsOf(
    damoclesName, normalizeToolInput(event.toolName, event.input as Record<string, unknown>), panel.machine ?? UNKNOWN_MACHINE, () => panel.permissionHandler.sessionCwd(), panel.browserFiles));
  // Every allow path funnels here, after approval, so the approval prompt's time counts toward the baseline.
  // A page outside the chat's folders is granted its folder here, whichever answer let it run: the user's, a rule's, YOLO's or a hook's.
  const proceed = async (): Promise<ToolCallEventResult | undefined> => {
    const page = BROWSER_URL_TOOLS.has(damoclesName) ? await callFacts() : undefined;
    if (page?.pageRefusal !== undefined) return { block: true, reason: formatPolicyBlockReason(page.pageRefusal) };
    const checkpoint = panel.checkpointBaseline;
    if (checkpoint && waitsForCheckpointBaseline(event.toolName, event.input as Record<string, unknown>, panel.isMcpReadOnly, checkpoint.folder, (await callFacts()).shellVerdict)) {
      await checkpoint.wait(callSignal ?? NEVER_ABORT, mapPiToolName(event.toolName));
      if (callSignal?.aborted) return abortedWhileWaiting();
    }
    const stopped = stoppedByUser();
    if (stopped) return stopped;
    if (pendingContext && preToolUse) preToolUse.stashContext(event.toolCallId, pendingContext);
    if (page?.outsidePage) {
      const root = page.reachesNetwork ? await networkRoot(page.outsidePage.root) : { root: page.outsidePage.root };
      if ('refused' in root) return { block: true, reason: formatPolicyBlockReason(root.refused) };
      panel.browserFiles?.grant(page.outsidePage.folder, root.root);
    }
    return undefined;
  };
  // A network folder is resolved only once the call may run, off the host thread, and judged again as the real path it serves from.
  const networkRoot = async (folder: string): Promise<{ readonly root: string } | { readonly refused: string }> => {
    let real: string;
    try {
      real = await realpath(folder);
    } catch (err) {
      return { refused: `${folder} could not be read (${(err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err))}), so it is not served.` };
    }
    const refused = panel.browserFiles?.grantRefusal(real, true);
    return refused === undefined ? { root: real } : { refused };
  };

  // D62, a design chat's posture and one writer per design file apply in every mode and before a hook's force-allow, to the
  // input as a hook rewrote it.
  // A write whose target reaches a network host is in no design folder, designs folder or worktree, which all lie on the chat's own
  // drives or hosts, so only the design rule judges it, and without touching it.
  const isolationBlock = async (): Promise<ToolCallEventResult | undefined> => {
    const design = panel.designScope?.();
    const isolation = panel.worktreeIsolation?.();
    if (!design && !isolation && category !== 'write') return undefined;
    const input = normalizeToolInput(event.toolName, event.input as Record<string, unknown>);
    const facts = await callFacts();
    const networkPath = facts.reachesNetwork;
    const blocked = (design ? designWriteBlock(damoclesName, input, design, { ...facts, mcpReadOnly }) : undefined)
      ?? (category === 'write' && !networkPath ? designFilesWriteBlock(input, panel.permissionHandler.sessionCwd()) : undefined)
      ?? (isolation && !networkPath ? worktreeIsolationBlock(damoclesName, input, isolation) : undefined);
    return blocked === undefined ? undefined : { block: true, reason: formatPolicyBlockReason(blocked) };
  };

  // a tool whose user-scope service this core cannot reach never runs, in any mode, before any hook
  if (userScopeToolNames(userScopeReach()).has(event.toolName)) {
    const relayedServer = relayedServerOfTool(event.toolName);
    const reason = relayedServer !== undefined ? relayedMcpUnreachableReason(relayedServer) : isForgeTool(event.toolName) ? forgeUnreachableReason() : browserClosedReason();
    return { block: true, reason: formatPolicyBlockReason(englishText(reason)) };
  }

  if (preToolUse) {
    const result = await preToolUse.run(event, callSignal);
    if (result?.systemMessages.length) preToolUse.notify(result.systemMessages);
    if (result && 'aborted' in result) return abortedWhileWaiting();
    const stopped = stoppedByUser();
    if (stopped) return stopped;
    if (result) {
      if (result.mutated && result.decision !== 'deny') {
        // `finalInput` is the COMPLETE rewritten input: dispatch chains each hook's `updated_input` onto a
        // copy of the original tool input, so it always carries every key. Merging it back is therefore a
        // full overwrite of the live keys — there is no "hook dropped a key but it survives" case. The
        // approval diff is built from this same rewritten input below, so the user sees exactly what runs.
        Object.assign(event.input, denormalizeToolInput(event.toolName, result.finalInput));
      }
      if (result.decision === 'deny') {
        preToolUse.onDecision(damoclesName, 'deny', result.reason, result.terminate === true);
        // A hook deny defaults to non-terminating; `terminate` is the hook author's explicit opt-in.
        const reason = formatPolicyBlockReason(result.reason ?? 'Blocked by a configured PreToolUse hook');
        return result.terminate ? terminating(reason, 'hook') : { block: true, reason };
      }
      // Fail closed BEFORE the force-allow: a hook that timed out or failed to spawn may be the one that
      // would have denied, and a force-allow skips the gate entirely (canUseTool, plan mode, the
      // read-only-shell classifier, settings deny rules). A surviving sibling's `allow` is not evidence
      // that the down hook would have agreed.
      if (result.anyFailed && (category === 'write' || category === 'shell')) {
        return gateErrorFallback();
      }
      if (result.additionalContext) pendingContext = result.additionalContext;
      if (result.decision === 'allow') {
        const isolated = await isolationBlock();
        if (isolated) return isolated;
        // A hook's allow in a design chat still leaves a non-read-only MCP call to `gateVerdict`, which asks the user (PD-4, PD-25).
        if (!onlyUserApproves) {
          preToolUse.onDecision(damoclesName, 'allow', result.reason, false);
          return proceed();
        }
        log('[PermissionGate] a PreToolUse hook allowed %s, which only the user can approve in a design chat', damoclesName);
      }
    }
  }

  const isolated = await isolationBlock();
  if (isolated) return isolated;

  const input = normalizeToolInput(event.toolName, event.input as Record<string, unknown>);
  // Read after the hooks, since a hook's `updatedInput` can change which server a resource call names.
  const mcpTool = isMcp ? panel.mcpToolIdentity?.(damoclesName) : mcpResourceIdentity(damoclesName, input);
  const decidedAs = permissionCallOf(damoclesName, input);
  if ('undecidable' in decidedAs) return { block: true, reason: formatPolicyBlockReason(decidedAs.undecidable) };

  // A GitHub or GitLab call: blocks no rule can lift come first, then its target, which project-scoped rules name.
  const forge = isForgeTool(damoclesName) ? panel.forgeTools : undefined;
  let forgeProject: string | undefined;
  if (isForgeTool(damoclesName)) {
    if (!forge) return { block: true, reason: formatPolicyBlockReason('The GitHub and GitLab tools are not available to this agent.') };
    const fixed = gateVerdict({ name: damoclesName, input, mcpReadOnly: false, rule: null }, panel);
    if (fixed.kind === 'block') return { block: true, reason: formatPolicyBlockReason(fixed.reason) };
    let target: Awaited<ReturnType<ForgeToolsPort['target']>>;
    try {
      target = await forge.target({ tool: damoclesName, input, toolCallId: event.toolCallId }, callSignal ?? NEVER_ABORT);
    } catch (err) {
      if (callSignal?.aborted) return abortedWhileWaiting();
      throw err;
    }
    if (callSignal?.aborted) return abortedWhileWaiting();
    if (!target.ok) return { block: true, reason: formatPolicyBlockReason(target.answer.text) };
    forgeProject = target.project;
  }

  // The full approval flow: the prompt for gating tools and unknown tools, and for any call an ask rule names.
  const askUser = async (call: GatedCall, requiresUser: boolean): Promise<ToolCallEventResult | undefined> => {
    const stopped = stoppedByUser();
    if (stopped) return stopped;
    // a forge write's card names server, project and account, resolved before the prompt shows; YOLO, allow and deny rules skip it
    let forgeCard: { readonly permissionDetail: PermissionDetail; readonly suggestions: PermissionUpdate[] } | undefined;
    if (forge && FORGE_WRITE_TOOLS.has(damoclesName)) {
      const decided = panel.permissionHandler.decide(call.name, call.input, call.rule, requiresUser, call.reachesNetwork === true);
      if (decided === 'deny') return { block: true, reason: formatPolicyBlockReason(SETTINGS_RULE_DENY) };
      if (decided !== 'allow') {
        let approval: ForgeApprovalAnswer;
        try {
          approval = await forge.approval({ tool: damoclesName, input, toolCallId: event.toolCallId }, callSignal ?? NEVER_ABORT);
        } catch (err) {
          if (callSignal?.aborted) return abortedWhileWaiting();
          throw err;
        }
        if (callSignal?.aborted) return abortedWhileWaiting();
        if (!approval.ok) return { block: true, reason: formatPolicyBlockReason(approval.answer.text) };
        forgeCard = { permissionDetail: approval.detail, suggestions: [approval.suggestion] };
      }
    }
    const facts = await callFacts();
    const networkCard = call.reachesNetwork ? networkPathDetail(damoclesName, facts) : undefined;
    const pathCard = facts.outsidePage ? outsideFolderDetail(damoclesName, facts.outsidePage, networkCard) : networkCard;
    const result = await panel.permissionHandler.canUseTool(
      damoclesName,
      input,
      {
        ...buildCanUseToolContext(event.toolCallId, callSignal, parentToolUseId, mcpTool),
        ...(forgeCard ?? {}),
        ...(pathCard ? { permissionDetail: pathCard } : {}),
        runsUnasked: () => runsUnasked(call, panel),
        ...(requiresUser ? { requiresUser: true as const, rule: call.rule } : { rule: call.rule }),
        ...(call.reachesNetwork ? { reachesNetwork: true as const } : {}),
        ...(call.outsideFolder ? { outsideFolder: true as const } : {}),
      },
    );
    // A Stop withdraws the prompt, which settles as an unasked deny, so this check must come first.
    const stoppedDuringPrompt = stoppedByUser();
    if (stoppedDuringPrompt) return stoppedDuringPrompt;
    // `interrupt` becomes pi's `terminate`, and only `buildUserDenyResult`/`buildUserFileEditDenyResult`
    // (permission-handler/utils.ts) ever set it: the user answered the prompt and left the feedback box
    // empty. An unexplained "no" means stop; "no, do X instead" is instruction the model must keep. Every
    // deny the user was NOT asked about goes through `buildUnaskedDenyResult`, which cannot set it and
    // marks it `policy`, so the model is never told the user rejected it.
    // See docs/invariants.md ("Permissions and plan mode") for pi's per-batch terminate semantics.
    if (result.behavior !== 'deny') {
      // Sent whether or not a prompt was raised, since `canUseTool` does not say; a running card ignores it.
      panel.postMessage?.({ type: 'toolPending', toolUseId: event.toolCallId, toolName: damoclesName, input, parentToolUseId });
      return proceed();
    }
    if (result.policy) return { block: true, reason: formatPolicyBlockReason(result.message) };
    const reason = formatDenyReason(result.message);
    return result.interrupt ? terminating(reason, 'user') : { block: true, reason };
  };

  if (GATE_ALLOW_ALWAYS.has(damoclesName)) return proceed();

  const { shellVerdict, reachesNetwork: networkPath, outsidePage, pageRefusal, grantedPage } = await callFacts();
  if (pageRefusal !== undefined) return { block: true, reason: formatPolicyBlockReason(pageRefusal) };
  const ruleOptions = { ...(networkPath ? { pathsAsWritten: true as const } : {}), ...(forgeProject !== undefined ? { forgeProject } : {}) };
  let rule = onlyUserApproves
    ? await panel.permissionHandler.matchRule(damoclesName, input, mcpTool, { ignoreBypass: true })
    : await panel.permissionHandler.matchRule(decidedAs.name, decidedAs.input, mcpTool, ruleOptions);
  // A call decided as another tool's keeps its own tool's rule too, and the stricter of the two decides (D101).
  if (decidedAs.name !== damoclesName) rule = stricterRule(rule, await panel.permissionHandler.matchRule(damoclesName, input, mcpTool, ruleOptions));
  // A page outside the project is a file the browser reads, so a Read deny or ask rule on it decides too; a Read allow grants no folder.
  const pageFile = outsidePage?.file ?? grantedPage;
  if (pageFile !== undefined) {
    const readRule = await panel.permissionHandler.matchRule(TOOL_READ, { file_path: pageFile }, undefined, ruleOptions);
    if (readRule === 'deny' || readRule === 'ask') rule = stricterRule(rule, readRule);
  }
  const call: GatedCall = { name: decidedAs.name, input: decidedAs.input, mcpReadOnly, rule, ...(shellVerdict ? { shellVerdict } : {}), ...(networkPath ? { reachesNetwork: true as const } : {}), ...(outsidePage ? { outsideFolder: true as const } : {}) };
  const verdict = gateVerdict(call, panel);
  if (verdict.kind === 'block') return { block: true, reason: formatPolicyBlockReason(verdict.reason) };
  return verdict.kind === 'run' ? proceed() : askUser(call, verdict.requiresUser === true);
}

/** The server an MCP resource tool call names, so `mcp__<server>` rules cover it as one of that server's tools. */
function mcpResourceIdentity(toolName: string, input: Record<string, unknown>): McpToolIdentity | undefined {
  const server = input['server'];
  return isMcpResourceToolName(toolName) && typeof server === 'string' && server !== '' ? { server, tool: toolName } : undefined;
}

const RULE_STRENGTH: Readonly<Record<PermissionBehavior, number>> = { allow: 1, ask: 2, deny: 3 };

/** The stricter of two matched settings rules, deny over ask over allow, as rules across settings files combine. */
function stricterRule(a: PermissionBehavior | null, b: PermissionBehavior | null): PermissionBehavior | null {
  if (a === null || b === null) return a ?? b;
  return RULE_STRENGTH[a] >= RULE_STRENGTH[b] ? a : b;
}

const IMPORT_ASSET_SOURCES = ['path', 'file', 'url'] as const;

/**
 * The call whose settings rules and defaults decide `name`'s permission (D101): an ImportAsset from `url` as the chat's WebFetch
 * of that URL, one from `file` or a project `path` as a Read of that path (`path` is cwd-relative, as Read resolves it), any other
 * call as itself; the gate adds the ImportAsset rule to a mapped call's. An ImportAsset that names no single source cannot be decided.
 */
function permissionCallOf(name: string, input: Record<string, unknown>): { name: string; input: Record<string, unknown> } | { undecidable: string } {
  if (name !== TOOL_IMPORT_ASSET) return { name, input };
  const named = IMPORT_ASSET_SOURCES.filter((source) => input[source] !== undefined);
  const source = named.length === 1 ? named[0]! : undefined;
  const value = source === undefined ? undefined : input[source];
  if (source === undefined || typeof value !== 'string' || value === '') {
    return { undecidable: 'ImportAsset takes exactly one of path, file and url, as a non-empty string, so this call could not be approved.' };
  }
  return source === 'url' ? { name: TOOL_WEB_FETCH, input: { url: value } } : { name: TOOL_READ, input: { file_path: value } };
}

/** A call the gate decides, as it reached the gate once its PreToolUse hooks ran. */
export interface GatedCall {
  /** The Damocles tool name, or for an ImportAsset the WebFetch or Read it is decided as (`permissionCallOf`). */
  name: string;
  /** The normalized input the approval flow sees. */
  input: Record<string, unknown>;
  /** Whether it is a read-only-annotated MCP tool. */
  mcpReadOnly: boolean;
  /** The settings rule it matched when it reached the gate, null when none did, or YOLO was on and the call is not one only the user approves. */
  rule: PermissionBehavior | null;
  /** A shell call's `provenReadOnlyShell` verdict, taken once when it reached the gate; a shell call without one is not proven. */
  shellVerdict?: ReadOnlyVerdict;
  /** Its file path may reach a network host the chat does not live on (`CallFacts.reachesNetwork`). */
  reachesNetwork?: true;
  /** It loads a file page outside the chat's folders, whose run grants the page's folder (`CallFacts.outsidePage`). */
  outsideFolder?: true;
}

/** Whether a call asks when no settings rule decides it, in every mode: its path may reach a network host, or it grants a folder. */
function asksUnlessRuled(call: GatedCall): boolean {
  return call.reachesNetwork === true || call.outsideFolder === true;
}

/**
 * Run the call, block it with a policy reason, or hand it to the approval flow (`canUseTool`). `requiresUser`: only the user's
 * answer approves it, which YOLO does not give (a design chat's MCP call that is not read-only, PD-25).
 */
export type GateVerdict = { kind: 'run' } | { kind: 'block'; reason: string } | { kind: 'approval'; requiresUser?: true };

const RUN: GateVerdict = { kind: 'run' };
const APPROVAL: GateVerdict = { kind: 'approval' };
const USER_APPROVAL: GateVerdict = { kind: 'approval', requiresUser: true };
const SETTINGS_RULE_DENY = 'Permission denied by a rule in your Damocles settings';

/**
 * The gate's decision on a call under the current permission state. Synchronous, so an open prompt is
 * decided again by this same function when the mode or YOLO changes (`runsUnasked`).
 */
export function gateVerdict(call: GatedCall, panel: GatePermissionContext): GateVerdict {
  const { name, input, rule } = call;
  // A path that may reach a network host, or a page outside the chat's folders, asks unless an allow rule names the call.
  const byRule = (): GateVerdict => (rule === 'deny' ? { kind: 'block', reason: SETTINGS_RULE_DENY }
    : rule === 'ask' || (asksUnlessRuled(call) && rule !== 'allow') ? APPROVAL : RUN);

  // In-process MCP module tools (memory/compass/browser, now PascalCase): auto-allow with exact SDK
  // parity — the SDK's `mcp__` rule never prompted, but a settings deny rule is still honored (FR-4)
  // and an ask rule prompts. Web tools are NOT here — they are in `READ_ONLY_TOOLS`, so they fall
  // through to the read branch.
  if (GATEABLE_MODULE_NAMES.has(name)) return byRule();

  // Design tools run by settings rule; they are not module tools, which never wait for the checkpoint baseline (PD-42).
  if (DESIGN_PI_TOOL_NAMES.has(name)) return byRule();

  // A design chat (PD-4, PD-25); `designWriteBlock` already refused writes outside its folder and unproven shell commands.
  if (panel.designScope?.()) {
    if (isForgeTool(name)) return { kind: 'block', reason: DESIGN_CHAT_FORGE_REFUSAL };
    if (SHELL_TOOLS.has(name)) {
      const verdict = call.shellVerdict ?? UNPROVEN;
      return verdict.readOnly ? byRule() : { kind: 'block', reason: designShellRefusal(verdict) };
    }
    if (name === TOOL_EDIT || name === TOOL_WRITE) return byRule();
    if (name === TOOL_GENERATE_IMAGE) return APPROVAL;
    if (name.startsWith('mcp__') && !call.mcpReadOnly) return rule === 'deny' ? { kind: 'block', reason: SETTINGS_RULE_DENY } : USER_APPROVAL;
  }

  // Plan mode blocks the write-category tools. A shell command `provenReadOnlyShell` proves read-only
  // auto-runs; any other goes through canUseTool like default mode (prompt, settings rules, YOLO), so
  // the model can gather what the plan needs (services, logs, endpoints) with the user's approval. The
  // plan-mode prompt forbids changing files through the shell. The ONE write carve-out is Edit/Write to
  // the plan file (US-002): it falls through to the normal flow where the EvaluatorManager auto-allows
  // the plans-dir write. MCP tools are NOT blocked here: they follow normal-mode rules, since the user
  // controls which servers are enabled.
  // Read-only SUBAGENTS (Explore/Plan, team reviewers, any agent whose toolset omits every write tool)
  // get the same shell rule in every permission mode: proven reads auto-run, anything else asks, and
  // YOLO approves it. Their prompts forbid writing through the shell. They have no plan file.
  //
  // MCP is exempt from the read-only-SUBAGENT branch too, on purpose and by the same reasoning. This
  // is load-bearing now that nested agents receive MCP tools: `toolCategory('mcp__…')` is `'other'`
  // (tool-normalization.ts:47-51), so the `write`/`shell` condition below never catches an MCP call,
  // and a read-only agent reaches MCP under normal-mode rules — annotated reads auto-allow, everything
  // else routes to `canUseTool` and prompts. That is a DECISION, not an oversight, and it is wrong to
  // "fix" in either direction without reading this:
  //   - Blocking MCP for read-only subagents would make them stricter than the panel AND stricter than
  //     plan mode, which the paragraph above already exempts. Most servers omit `readOnlyHint`
  //     entirely, so it would fail closed against the common case and grant Explore/Plan nothing.
  //   - Auto-allowing non-annotated MCP for them would be laxer than the panel. It is not.
  // `docs/invariants.md` scopes the read-only-agent rule to the SHELL: an unproven command needs the
  // user's approval, so `echo > file` cannot silently undo a denied `Edit`; it is not a general
  // capability ceiling. The trust boundary for MCP is the user's server-enablement list, which a
  // subagent cannot widen.
  const category = toolCategory(name);
  const planMode = panel.isPlanMode();
  const readOnlyAgent = panel.readOnlyShell === true;
  if (category === 'shell' && (planMode || readOnlyAgent)) {
    // A shell tool `provenReadOnlyShell` cannot read always asks; never default it to allow.
    if (call.shellVerdict?.readOnly !== true) return APPROVAL;
    // Auto-allow unless a settings rule names the command: never hand it to canUseTool for the
    // read-only verdict alone, since with no rule it would prompt for every shell command.
    return byRule();
  }
  if (category === 'write' && (planMode || readOnlyAgent)) {
    // The plan file is on this computer's drives, so a path reaching a network host is never it, and is not touched.
    const isPlanFileEdit =
      planMode &&
      call.reachesNetwork !== true &&
      (name === TOOL_EDIT || name === TOOL_WRITE) &&
      panel.permissionHandler.isPlanFile(typeof input['file_path'] === 'string' ? (input['file_path'] as string) : '');
    if (!isPlanFileEdit) {
      return { kind: 'block', reason: planMode
        ? 'Plan mode is active — only read-only tools are allowed until you exit the plan.'
        : 'You are a read-only agent — only read-only tools are allowed.' };
    }
  }

  // Read tools (incl. known extension read tools + read-only MCP tools) auto-allow, still honoring
  // settings deny rules. The evaluator answers ask for them only when an ask rule names the call, and
  // that prompts in every mode.
  // A read whose path may reach a network host the chat does not live on asks, unless a rule decides it (`decide`'s `reachesNetwork`),
  // since opening it sends the user's Windows credentials to that host.
  if (category === 'read' || call.mcpReadOnly) {
    const evaluation = panel.permissionHandler.decide(name, input, rule, false, asksUnlessRuled(call));
    if (evaluation === 'deny') return { kind: 'block', reason: SETTINGS_RULE_DENY };
    if (evaluation !== 'ask') return RUN;
  }

  // Gating tools (Edit/Write/Bash/PowerShell) + unknown tools: full approval flow.
  return APPROVAL;
}

const UNPROVEN: ReadOnlyVerdict = { readOnly: false, reason: 'no read-only verdict was taken for this command' };

/**
 * Whether the gate would run `call` with no prompt under the current permission state: its own verdict,
 * and for a call it hands to the approval flow, the evaluator's, which `canUseTool` applies the same way.
 */
export function runsUnasked(call: GatedCall, panel: GatePermissionContext): boolean {
  const verdict = gateVerdict(call, panel);
  return verdict.kind === 'run'
    || (verdict.kind === 'approval' && panel.permissionHandler.decide(call.name, call.input, call.rule, verdict.requiresUser === true, asksUnlessRuled(call)) === 'allow');
}
