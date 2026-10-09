import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import type { SessionOptions } from '../../session-types';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { MAX_IMAGE_BASE64_LENGTH } from '../../../shared/types/content';
import { formatUserSteerPrefix, type UserSteerNote } from '../../../shared/steer';
import type { ForkSpawnArgs } from '../../../shared/types/session';
import type { AccountInfo, AutoCompactConfig } from '../../../shared/types/settings';
import type { Agent, AgentTurnContext, AgentTurnDecision, FinishTurn } from '@earendil-works/pi-agent-core';

const H = vi.hoisted(() => {
  const CACHE_WARMING_MODES = ['off', 'streaming', 'idle'];
  const seq: string[] = [];
  const captured: { services: unknown[]; customTools: Array<{ name: string; execute: (...a: never[]) => Promise<unknown> }> } = { services: [], customTools: [] };
  // The bash delegate's body, swappable per test so a case can hold a command open across a Stop click.
  let bashExecute: (...a: never[]) => Promise<unknown> = async () => ({ content: [], details: undefined });
  let sessionCounter = 0;
  let customMessageCounter = 0;
  let lastSession: ReturnType<typeof makeSession> | null = null;
  // Opt-in: a test can swap the structural sessionManager fake for a REAL pi SessionManager on a
  // tmpdir, so the on-disk no-append-after-rm invariant is exercised rather than simulated.
  let sessionManagerFactory: (() => unknown) | null = null;
  // Opt-in: runs against each freshly built fake session before PiSession binds it.
  let sessionSetup: ((session: { agent: { finishTurn?: unknown } }) => void) | null = null;

  function makeSession() {
    const id = `sess-${++sessionCounter}`;
    const sessionManager = (sessionManagerFactory?.() ?? {
      getSessionName: vi.fn((): string | undefined => undefined),
      appendSessionInfo: vi.fn((_name: string) => 'info-1'),
      getLeafId: vi.fn(() => 'leaf-1'),
      getBranch: vi.fn(() => [
        { type: 'message', id: 'u1', message: { role: 'user', content: 'hello world' } },
        {
          type: 'message',
          id: 'a1',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'doing it' },
              { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.ts' } },
            ],
          },
        },
        { type: 'message', id: 'r1', message: { role: 'toolResult', toolCallId: 't1', content: 'file body' } },
      ]),
      getEntry: vi.fn((_id: string) => undefined as unknown),
      getEntries: vi.fn(() => [] as unknown[]),
      getHeader: vi.fn(() => null),
      getSessionFile: vi.fn(() => undefined as string | undefined),
      appendCustomEntry: vi.fn((_customType: string, _data?: unknown) => 'custom-1'),
    }) as {
      getSessionName: (() => string | undefined);
      appendSessionInfo: ((name: string) => unknown);
      getSessionFile: (() => string | undefined);
      [k: string]: unknown;
    };
    // Per-session tool registry the MCP-reload orphan check (`missingMcpRegistryNames`) reads via
    // getAllTools(). Tests mutate `registryToolNames` to simulate an orphaned vs current registry, and
    // a mocked reload() can repopulate it.
    const registryToolNames = new Set<string>(['read', 'bash', 'Edit', 'write']);
    // The live subscriptions (the adapter's and the image cache's), so a test can drive the real pi events a
    // call emits before it settles — the only way to exercise a path where the adapter and the caller both see one failure.
    const listeners = new Set<(event: unknown) => void>();
    const session = {
      listeners,
      sessionId: id,
      // pi's Agent. `readonly` upstream and NOT plumbed through the session factory, so `bindSession`
      // installs the graceful budget-stop decider onto it per bind — a replacement session brings a
      // new Agent, which is what the re-installation test pins.
      // `peekQueuedMessages` is pi's own steering/follow-up queue, which the plan-mode hold reads, so it
      // has to answer on every fake session rather than only in the tests that queue something.
      agent: { peekQueuedMessages: () => [] } as { finishTurn?: FinishTurn; peekQueuedMessages: () => unknown[] },
      isStreaming: false,
      isCompacting: false,
      get isIdle() { return !this.isStreaming; },
      registryToolNames,
      subscribe: vi.fn((listenerFn: unknown) => {
        seq.push('subscribe');
        const fn = listenerFn as (event: unknown) => void;
        listeners.add(fn);
        return () => { listeners.delete(fn); seq.push('unsub'); };
      }),
      setAutoCompactionEnabled: vi.fn((enabled: boolean) => { if (!enabled) seq.push('compaction-off'); }),
      compact: vi.fn(async () => ({ summary: 'summary', firstKeptEntryId: 'k1', tokensBefore: 100 })),
      abortCompaction: vi.fn(),
      setActiveToolsByName: vi.fn(),
      getActiveToolNames: vi.fn(() => ['read', 'bash', 'Edit', 'write']),
      getAllTools: vi.fn(() => [...registryToolNames].map((name) => ({ name }))),
      reload: vi.fn(async () => { seq.push(`reload:${id}`); }),
      bindExtensions: vi.fn(async () => undefined),
      setThinkingLevel: vi.fn(),
      prompt: vi.fn(async () => undefined),
      steer: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
      sendUserMessage: vi.fn(async () => undefined),
      sendCustomMessage: vi.fn(async () => undefined),
      clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
      getFollowUpMessages: vi.fn((): string[] => []),
      // pi's registered extension commands, which `prompt()` runs without committing a user entry.
      extensionRunner: { getCommand: vi.fn((_name: string): unknown => undefined), hasHandlers: vi.fn(() => false) },
      abort: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      getSessionStats: vi.fn(() => ({ sessionId: id, cost: 0, tokens: { input: 120, output: 40, cacheRead: 30, cacheWrite: 10, total: 200 } })),
      getLastAssistantText: vi.fn(() => 'hi'),
      getContextUsage: vi.fn(() => ({ tokens: 160, contextWindow: 1_000_000, percent: 0 })),
      get systemPrompt() { return 'You are a helpful coding assistant.'; },
      // Mirrors pi's AgentSession.setSessionName, which appends through the manager — so a real
      // manager really writes to disk here and the fake stays structurally honest.
      setSessionName: vi.fn((name: string) => { sessionManager.appendSessionInfo(name); }),
      sessionManager,
      messages: [],
    };
    // As pi does: a custom message that neither triggers nor joins a running turn is on the branch at once.
    session.sendCustomMessage.mockImplementation(async (...args: unknown[]) => {
      const [message, options] = args as [{ customType: string; content: unknown; display: boolean; details?: unknown }, { triggerTurn?: boolean; deliverAs?: string } | undefined];
      if (session.isStreaming || options?.triggerTurn || options?.deliverAs === 'nextTurn') return undefined;
      const appendReal = sessionManager['appendCustomMessageEntry'];
      if (typeof appendReal === 'function') {
        appendReal.call(sessionManager, message.customType, message.content, message.display, message.details);
        return undefined;
      }
      const getBranch = sessionManager['getBranch'] as { (): unknown[]; mockReturnValue?: (value: unknown[]) => void };
      getBranch.mockReturnValue?.([...getBranch(), { type: 'custom_message', id: `cm-${++customMessageCounter}`, ...message }]);
      return undefined;
    });
    lastSession = session;
    // pi installs its own `agent.finishTurn` during session construction, before Damocles binds, so a
    // test that needs a prior hook has to get it on here rather than after the bind.
    sessionSetup?.(session as { agent: { finishTurn?: unknown } });
    return session;
  }

  function makeServices() {
    // pi's settings manager has a field asymmetry this fake reproduces on purpose: `applyOverrides`
    // writes the effective `settings` object (dist/core/settings-manager.js:366 in pi 0.99.2) while
    // `setCacheWarmingMode`/`getCacheWarmingMode` write and read `globalSettings` (:679-687). A mode
    // routed through `applyOverrides` is therefore invisible to the getter pi's CacheWarmer calls.
    const globalSettings: { cacheWarming?: string } = {};
    let effectiveSettings: Record<string, unknown> = {};
    return {
      cwd: '/cwd',
      agentDir: '/fake/agent',
      settingsManager: {
        setCompactionEnabled: vi.fn((enabled: boolean) => { if (!enabled) seq.push('compaction-off'); }),
        applyOverrides: vi.fn((overrides: Record<string, unknown>) => { effectiveSettings = { ...effectiveSettings, ...overrides }; }),
        setCacheWarmingMode: vi.fn((mode: string) => { globalSettings.cacheWarming = mode; }),
        getCacheWarmingMode: vi.fn((): string => {
          const mode = globalSettings.cacheWarming;
          return mode !== undefined && CACHE_WARMING_MODES.includes(mode) ? mode : 'streaming';
        }),
        getCompactionSettings: vi.fn(() => ({ enabled: false, reserveTokens: 16384, keepRecentTokens: 20000 })),
        getGlobalSettings: vi.fn(() => ({})),
        getProjectSettings: vi.fn(() => ({})),
        getPackages: vi.fn(() => []),
        // The bash override builds its delegate during buildCustomTools, so session construction reads
        // both of these before any turn runs.
        getShellCommandPrefix: vi.fn(() => undefined),
        getShellPath: vi.fn(() => undefined),
        isProjectTrusted: vi.fn(() => true),
      },
      modelRuntime: {
        getAvailableSnapshot: () => [{ id: 'claude-opus-5-5', name: 'Opus', api: 'anthropic-messages', provider: 'anthropic', contextWindow: 1_000_000 }],
        getModel: (provider: string, id: string) => (provider === 'anthropic' && id === 'claude-opus-5-5'
          ? { id, name: 'Opus', api: 'anthropic-messages', provider, contextWindow: 1_000_000 }
          : undefined),
        hasConfiguredAuth: () => true,
        getModels: () => [{ id: 'claude-opus-5-5', name: 'Opus', api: 'anthropic-messages', provider: 'anthropic', contextWindow: 1_000_000 }],
        refresh: vi.fn(),
      },
      resourceLoader: {
        reload: vi.fn(async () => undefined),
        extendResources: vi.fn(),
        getExtensions: vi.fn(() => ({ extensions: [], errors: [], runtime: {} })),
        getPrompts: vi.fn(() => ({
          prompts: [
            { name: 'review', description: 'Review code', argumentHint: '[pr]', content: 'review prompt body', filePath: '/cwd/.claude/commands/review.md', sourceInfo: { path: '/cwd/.claude/commands/review.md', scope: 'project' } },
          ],
          diagnostics: [],
        })),
        getSkills: vi.fn(() => ({
          skills: [
            { name: 'simplify', description: 'Simplify code', filePath: '/home/.claude/skills/simplify/SKILL.md', baseDir: '/home/.claude/skills/simplify', sourceInfo: { path: '/home/.claude/skills/simplify', scope: 'user' }, disableModelInvocation: false },
          ],
          diagnostics: [],
        })),
        getAgentsFiles: vi.fn(() => ({ agentsFiles: [] })),
      },
      diagnostics: [],
    };
  }

  let services = makeServices();

  const fakePi = {
    createAgentSessionServices: vi.fn(async () => services),
    createAgentSessionFromServices: vi.fn(async (opts: { services: unknown; customTools?: Array<{ name: string; execute: (...a: never[]) => Promise<unknown> }> }) => {
      captured.services.push(opts.services);
      captured.customTools = opts.customTools ?? [];
      return { session: makeSession() };
    }),
    createAgentSessionRuntime: vi.fn(async (factory: (o: { sessionManager: unknown; cwd: string; agentDir: string }) => Promise<{ session: unknown }>, opts: { cwd: string; agentDir: string; sessionManager: unknown }) => {
      let current = (await factory({ ...opts })).session;
      let before: (() => void) | undefined;
      let rebind: ((s: unknown) => Promise<void>) | undefined;
      let disposed = false;
      return {
        get session() { return current; },
        get services() { return services; },
        setBeforeSessionInvalidate: (cb?: () => void) => { before = cb; },
        setRebindSession: (cb?: (s: unknown) => Promise<void>) => { rebind = cb; },
        newSession: async () => {
          before?.();
          current = (await factory({ ...opts })).session;
          await rebind?.(current);
          return { cancelled: false };
        },
        // The stored file's session: a test names its id and branch through `setSessionSetup`.
        switchSession: async (_sessionPath: string) => {
          await (current as { abort: () => Promise<void> }).abort();
          before?.();
          current = (await factory({ ...opts })).session;
          await rebind?.(current);
          return { cancelled: false };
        },
        dispose: async () => { disposed = true; },
        get disposed() { return disposed; },
      };
    }),
    SessionManager: { create: vi.fn(() => ({ kind: 'persistent', getBranch: () => [] })), inMemory: vi.fn(() => ({ kind: 'memory' })) },
    SettingsManager: { inMemory: vi.fn(() => ({ kind: 'settings' })), create: vi.fn(() => ({ kind: 'settings' })) },
    ModelRuntime: { create: vi.fn(async () => services.modelRuntime) },
    DefaultPackageManager: class { getInstalledPath(): string | undefined { return undefined; } },
    defineTool: vi.fn((tool: unknown) => tool),
    createEditToolDefinition: vi.fn(() => ({ execute: vi.fn(async () => ({ content: [], details: undefined })) })),
    // The bash override spreads its metadata from a delegate built at construction, so this must answer
    // with a whole definition, not just an `execute`.
    createBashToolDefinition: vi.fn(() => ({ name: 'bash', label: 'Bash', description: 'pi bash', parameters: {}, execute: (...a: never[]) => bashExecute(...a) })),
    createPowerShellToolDefinition: vi.fn(() => ({ name: 'powershell', label: 'powershell', description: 'pi powershell', parameters: {}, execute: vi.fn() })),
    createGrepToolDefinition: vi.fn(() => ({ name: 'grep', label: 'grep', description: 'pi grep', parameters: {}, execute: vi.fn() })),
    createFindToolDefinition: vi.fn(() => ({ name: 'find', label: 'find', description: 'pi find', parameters: {}, execute: vi.fn() })),
    createWriteToolDefinition: vi.fn(() => ({ name: 'write', label: 'write', description: 'pi write', parameters: {}, execute: vi.fn() })),
  };

  return {
    seq,
    captured,
    fakePi,
    resetServices: () => { services = makeServices(); },
    getServices: () => services,
    getLastSession: () => lastSession,
    fireEvent: (event: unknown) => { for (const fn of [...(lastSession?.listeners ?? [])]) fn(event); },
    setSessionManagerFactory: (f: (() => unknown) | null) => { sessionManagerFactory = f; },
    setSessionSetup: (f: ((session: { agent: { finishTurn?: unknown } }) => void) | null) => { sessionSetup = f; },
    setBashExecute: (fn: (...a: never[]) => Promise<unknown>) => { bashExecute = fn; },
  };
});

// The AI title sub-call, controllable per test. Defaults to "no title", so every other turn-driving
// test leaves the auto-title path inert; the title tests swap in their own resolution timing.
const TITLE = vi.hoisted(() => ({ impl: async (): Promise<string | null> => null }));
/** Sessions read MCP only through their folder runtime's view, so stubbing it there reaches every panel. */
function stubPanelMcp(source: McpToolSource | null): void {
  const folders = PiRuntime.get('/fake/agent').folders();
  if (folders.length === 0) throw new Error('stubPanelMcp: no folder runtime yet');
  const stub = source && withExposure(!('getAllToolDescriptors' in source) ? withDescriptors(source) : source);
  for (const folder of folders) vi.spyOn(folder, 'mcp', 'get').mockReturnValue(stub as McpToolSource);
}

/**
 * A descriptor a stub gives no exposure is deferred, the config default, and the exposure queries a
 * stub leaves out are answered from its descriptors the way `FolderMcpView` answers them.
 */
function withExposure(source: McpToolSource): McpToolSource {
  const descriptors = (): McpToolDescriptor[] =>
    source.getAllToolDescriptors().map((d): McpToolDescriptor => ({ ...d, exposure: d.exposure ?? 'deferred', exposureSource: d.exposureSource ?? 'config', configExposure: d.configExposure ?? 'deferred' }));
  const named = (exposure: McpToolDescriptor['exposure']) => () => descriptors().filter((d) => d.exposure === exposure).map((d) => d.piName);
  return Object.assign(Object.create(source) as McpToolSource, {
    getAllToolDescriptors: descriptors,
    offToolNames: 'offToolNames' in source ? () => source.offToolNames() : named('off'),
    deferrableToolNames: 'deferrableToolNames' in source ? () => source.deferrableToolNames() : named('deferred'),
    pendingDirectServers: 'pendingDirectServers' in source ? () => source.pendingDirectServers() : () => [],
  });
}

/** A name-only stub gets descriptors whose server is the fixture name's middle segment; tests that care set serverName themselves. */
function withDescriptors(source: McpToolSource): McpToolSource {
  const descriptors = () =>
    source.allToolNames().map((piName) => ({ piName, serverName: piName.split('__')[1] ?? piName, description: '' }));
  return Object.assign(Object.create(source) as McpToolSource, {
    allToolNames: () => source.allToolNames(),
    getAllToolDescriptors: descriptors,
  });
}

/** The finished folder runtime every session in this file starts on. */
function cwdFolder(): FolderRuntime | undefined {
  return PiRuntime.get('/fake/agent').folders().find((folder) => folder.cwd === '/cwd');
}

vi.mock('../session-title', () => ({ generateSessionTitle: () => TITLE.impl() }));

vi.mock('../pi-loader', () => ({
  initPiLoader: vi.fn(async () => H.fakePi),
  getPiCodingAgent: vi.fn(() => H.fakePi),
  PI_MIN_NODE_MAJOR: 22,
  nodeSupportsPi: () => true,
}));


// The real factory returns undefined off win32, which would make every assertion below vacuous, so the
// module is faked to hand out a distinct disposable per call.
const JOB = vi.hoisted(() => ({ created: [] as Array<{ id: number; disposed: number }>, next: 0 }));
vi.mock('../tools/process-tree', () => ({
  createShellSessionJob: () => {
    const handle = { id: JOB.next++, disposed: 0 };
    JOB.created.push(handle);
    return { dispose: () => { handle.disposed += 1; } };
  },
  createShellJob: () => undefined,
  killProcessTree: () => undefined,
}));

// A recording pass-through, not a stub: every other test in this file needs the real tool set, and the
// only thing this adds is the deps object each of the three build sites hands in.
vi.mock('../tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tools')>();
  return { ...actual, buildCustomTools: vi.fn(actual.buildCustomTools) };
});

// Only the fs-touching seed is stubbed; `cacheWarmingSetting` stays real so the mode a test configures
// travels the production path.
vi.mock('../agent-dir', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-dir')>()),
  ensurePiAgentDir: (dir: string) => dir,
  PI_AGENT_DIR: '/fake/agent',
}));

// `start()` calls ensurePiSessionDir, which does a real fs.mkdirSync under PI_AGENT_DIR. With the agent
// dir mocked to '/fake/agent', that mkdir lands at the filesystem root and throws EACCES on Linux CI —
// initializeEarly() swallows the throw, so the live session never starts and every lifecycle assertion
// fails. Stub the FS boundary (it succeeds on Windows but not Linux, which masked this locally).
vi.mock('../session-store/session-dir', () => ({
  piSessionDir: (cwd: string) => `/fake/agent/sessions/${cwd}`,
  ensurePiSessionDir: (cwd: string) => `/fake/agent/sessions/${cwd}`,
}));

// Recording pass-throughs, so a case can hold the interruption reconcile open or read the fork copy's input.
vi.mock('../interruption-notice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../interruption-notice')>();
  return { ...actual, reconcileInterruptions: vi.fn(actual.reconcileInterruptions) };
});
vi.mock('../undelivered-results', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../undelivered-results')>();
  return { ...actual, collectUndeliveredFromFiles: vi.fn(actual.collectUndeliveredFromFiles) };
});
vi.mock('../session-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session-store')>();
  return { ...actual, resolvePiSessionFile: vi.fn(actual.resolvePiSessionFile) };
});
vi.mock('../fork-agent-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../fork-agent-data')>();
  return { ...actual, copyForkAgentData: vi.fn(actual.copyForkAgentData) };
});

import { PiSession } from '../pi-session';
import type { CheckpointService } from '../checkpoint-service';
import { RepoManager, getGitDir, getRepoDir } from '../checkpoints';
import { PiRuntime } from '../pi-runtime';
import { FolderRuntime } from '../folder-runtime';
import { reconstructMessages } from '../session-store/history-loader';
import { formatTerminalAttachmentBlock } from '../../terminal-attachment';
import { getPiCodingAgent } from '../pi-loader';
import { resolveAgentToolset } from '../subagents/agent-toolset';
import { DEFAULT_AGENTS } from '../subagents/default-agents';
import { computePlanFilePath } from '../../paths';
import { PLAN_MODE_EXCLUDED_TOOLS, PI_EXCLUDED_TOOLS, PI_NATIVE_ACTIVE_TOOLS, WEB_TOOLS } from '../pi-models';
import { buildAccountInfo } from '../account-billing';
import { fullActiveToolNames, type ToolStatusDeps } from '../tool-status';
import { BROWSER_PI_TOOL_NAMES } from '../tools/browser-tools';
import { MEMORY_PI_TOOL_NAMES } from '../tools/memory-tools';
import { COMPASS_PI_TOOL_NAMES } from '../tools/compass-tools';
import { installTurnDecider, TEAM_TERMINAL_HOOK } from '../finish-turn';
import { TEAM_MAIN_PI_TOOL_NAMES, TEAM_AGENT_PI_TOOL_NAMES, teamAgentPiToolNamesForRole } from '../tools/team-tools';
import { deferredToolNames } from '../tools/deferred-tools';
import { mapPiToolName, toolCategory } from '../tool-normalization';
import { CUSTOM_TOOL_NAMES, OVERRIDE_TOOL_NAMES, buildCustomTools } from '../tools';
import { FULL_TOOL_CATALOG } from '../tools/tool-catalog';
import { PLAN_MODE_NUDGE_TEXT, PLAN_MODE_NUDGE_ESCALATED_TEXT } from '../plan-mode-hold';
import { teamPlanModeStatement } from '../../team/prompts';
import { TOOL_ENTER_PLAN_MODE, TOOL_BROWSER_REQUEST_INPUT, TOOL_TOOL_SEARCH, TOOL_EDIT, TOOL_GENERATE_IMAGE } from '../../../shared/tool-names';
import type { MemoryService } from '../../memory';
import type { CompassService } from '../../compass';
import type { McpToolSource } from '../mcp/tool-source';
import type { McpToolDescriptor } from '../mcp/types';
import type { NestedMcpToolset } from '../tools/mcp-tools';
import { FolderMcpView } from '../mcp/folder-mcp-view';
import { managerWithFake, specOf } from '../mcp/__tests__/fake-server-manager';
import { createToolSearchTool, type DeferrableSnapshot, type ToolSearchDetails } from '../tools/tool-search-tool';
import { reconcileInterruptions, type NoticeMessage } from '../interruption-notice';
import { copyForkAgentData } from '../fork-agent-data';
import { collectUndeliveredFromFiles, type UndeliveredFileResult } from '../undelivered-results';
import { resolvePiSessionFile } from '../session-store';
import { deliveredBackgroundResults, latestSubagentInvocations, subagentBranchIndex } from '../agent-records';
import type { AgentManager } from '../subagents/agent-manager';
import { SUBAGENT_RESULTS_CUSTOM_TYPE } from '../subagents/background-results';
import type { AgentRecord } from '../subagents/types';
import { emptyAgentUsage } from '../../../shared/usage-accounting';
import { buildAgentStartResult, type ProjectionReader } from '../agent-start';
import type { PanelGateContext } from '../permission-gate';
import { DAMOCLES_AGENT_INVOCATION_ENTRY, DAMOCLES_INTERRUPTION_NOTICE } from '../session-store/constants';
import { FORK_AT_SECOND_PROMPT, FORK_PROMPT_COUNT, STORED_CONVERSATION, STORED_PROMPT_COUNT, withPrompt } from '../session-store/__tests__/prompt-index-fixtures';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import * as fsSync from 'fs';
// The on-disk-invariant suite drives the REAL SessionManager. `pi-loader` is mocked, so nothing else
// pulls this package in, and loading it takes most of a second. Imported statically so that cost is
// paid once during collection instead of inside a test's 5s timeout budget.
import * as realPi from '@earendil-works/pi-coding-agent';
import { installFakePlatform, type FakePlatform } from '../../../__mocks__/fake-platform';
import { SESSION_LEASE_DIR, sessionLeaseBlocker, sessionLeasePath, sessionLeasesOf } from '../session-store/session-lease';
import elBundle from '../../../../l10n/bundle.l10n.el.json';

/** The platform every session here reads through, also served by the host accessor; fresh per test. */
let testPlatform: FakePlatform;
beforeEach(() => {
  testPlatform = installFakePlatform();
});

/** A settings `get` answering the full dotted keys `read` knows, else the caller's default. */
function settingsReader(read: (key: string) => unknown): FakePlatform['settings']['get'] {
  return ((key: string, def?: unknown) => read(key) ?? def) as FakePlatform['settings']['get'];
}

/** Announce a change to `key`, as a settings edit would; reads stay with the stub that serves them. */
function fireSettingChange(key: string): void {
  void testPlatform.settings.update(key, globalThis.crypto.randomUUID(), 'user');
}

function makeOptions(messages: ExtensionToWebviewMessage[], extra?: Partial<SessionOptions>): SessionOptions {
  return {
    cwd: '/cwd',
    settingsFolder: undefined,
    projectScope: true,
    platform: testPlatform,
    permissionHandler: { getPermissionMode: () => 'default', setPermissionRequiredNotifier: () => {}, setPlanContentResolver: () => {}, setPendingPromptsListener: () => {}, setPromptOwnerResolver: () => {}, pendingPrompts: () => [] } as unknown as SessionOptions['permissionHandler'],
    onMessage: (m) => messages.push(m),
    model: 'claude-opus-5-5',
    resolveThinking: () => ({ thinkingDisabled: false, effort: null, maxThinkingTokens: null }),
    ...extra,
  };
}

/**
 * What pi's `prompt()` does for a prompt it runs rather than queues, as far as the entries it commits:
 * reports acceptance, then emits each user message's message_end and appends that same object.
 */
function piRuns(opts: unknown, getBranchMock: unknown, committed: readonly unknown[]): void {
  const getBranch = getBranchMock as ReturnType<typeof vi.fn<() => unknown[]>>;
  (opts as { preflightResult?: (disposition: string) => void } | undefined)?.preflightResult?.('started');
  const branch = [...getBranch()];
  for (const entry of committed) {
    const message = (entry as { message?: { role?: string } }).message;
    if (message?.role === 'user') H.fireEvent({ type: 'message_end', message });
    branch.push(entry);
  }
  getBranch.mockReturnValue(branch);
}

/** A SecretStorage stand-in. Without it `start()` skips the provider sync entirely, which is why the
 *  whole custom-provider fallback path was unreachable from this suite. */
const FAKE_SECRETS = {
  get: async () => 'sk-test',
  store: async () => undefined,
  delete: async () => undefined,
  onDidChange: () => ({ dispose: () => undefined }),
} as unknown as NonNullable<SessionOptions['secrets']>;

describe('PiSession lifecycle (US-P1-4)', () => {
  beforeEach(() => {
    H.seq.length = 0;
    H.captured.services.length = 0;
    H.resetServices();
  });
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  it('factory reuses PiRuntime.services (B1)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    expect(H.captured.services.length).toBeGreaterThanOrEqual(1);
    expect(H.captured.services[0]).toBe(cwdFolder()!.services);
    expect(H.captured.services[0]).toBe(H.getServices());
  });

  it('session replacement re-subscribes once and re-disables compaction, old unsub first', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    // Each bind subscribes twice: the stream adapter and the unpersisted tool image cache.
    expect(H.seq).toEqual(['subscribe', 'subscribe', 'compaction-off']);

    session.reset(); // -> runtime.newSession() exercises the replacement seam
    await new Promise((r) => setTimeout(r, 0));

    expect(H.seq.filter((s) => s === 'subscribe')).toHaveLength(4);
    expect(H.seq.filter((s) => s === 'compaction-off')).toHaveLength(2);
    const oldUnsubs = H.seq.flatMap((s, i) => (s === 'unsub' ? [i] : []));
    const newSubscribes = H.seq.flatMap((s, i) => (s === 'subscribe' ? [i] : [])).slice(2);
    expect(oldUnsubs).toHaveLength(2);
    expect(Math.max(...oldUnsubs)).toBeLessThan(Math.min(...newSubscribes));
  });

  it('reloads the shared extension runtime on replacement, not the first session (stale-ctx fix)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const reload = H.getServices().resourceLoader.reload as ReturnType<typeof vi.fn>;
    // First session binds the pristine init runtime — no reload, so startup stays cheap.
    expect(reload).not.toHaveBeenCalled();

    session.reset(); // replacement disposes the old session → its shared runtime is marked stale
    await new Promise((r) => setTimeout(r, 0));

    // The replacement must rebind to a FRESH runtime, else extension-registered MCP tools throw "ctx is stale".
    expect(reload).toHaveBeenCalledTimes(1);
    await session.dispose();
  });

  it('plan mode restricts the active tool set; default restores it (US-017)', async () => {
    const opts = makeOptions([]);
    opts.memoryService = { isEnabled: true } as never; // memory tools enter `full` only when the service is enabled
    const session = new PiSession(opts);
    await session.initializeEarly();
    const live = H.getLastSession();
    expect(live).not.toBeNull();
    const setActive = live!.setActiveToolsByName as ReturnType<typeof vi.fn>;

    setActive.mockClear();
    await session.setPermissionMode('plan');
    const planNames = setActive.mock.calls.at(-1)?.[0] as string[];
    expect(planNames).toContain('read');
    expect(planNames).toContain('ExitPlanMode');
    // Edit/Write stay active so the model can maintain its plan file; the gate restricts them to the
    // plan file (US-002). Active-set names: custom 'Edit' + pi-native 'write'. Shell stays out.
    expect(planNames).toContain('Edit');
    expect(planNames).toContain('write');
    // bash stays ACTIVE (callable) in plan mode; the gate classifies each command and blocks any
    // non-read-only one. The active set makes the tool reachable — the classifier is the boundary.
    expect(planNames).toContain('bash');
    // Memory module tools stay active in plan mode — extension-internal SQLite writes, never the workspace.
    expect(planNames).toContain('SearchMemories');
    expect(planNames).toContain('SaveMemory');

    await session.setPermissionMode('default');
    const fullNames = setActive.mock.calls.at(-1)?.[0] as string[];
    expect(fullNames).toContain('Edit');
    expect(fullNames).toContain('bash');
    await session.dispose();
  });

  it('the authoritative active set never carries pi\'s lowercase `powershell`', async () => {
    // pi 0.85.0 has its own `powershell` built-in (`tools/index.ts:95-104`, in `ToolName` and
    // `allToolNames`), so it is eligible to be registered. Damocles' shell tool is `PowerShell`, and
    // the two must not converge: `mapPiToolName`, the permission gate and the read-only-shell
    // classifier all key off the exact spelling.
    //
    // What this pins is the set Damocles COMPUTES and writes through `setActiveToolsByName`, which is
    // the last write and therefore authoritative. It goes red if someone adds `powershell` to
    // `PI_NATIVE_ACTIVE_TOOLS`, or renames the custom `PowerShell` to pi's spelling. It does NOT
    // observe pi's construction-time default set, which this write overrides regardless.
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const setActive = H.getLastSession()!.setActiveToolsByName as ReturnType<typeof vi.fn>;

    for (const mode of ['default', 'plan'] as const) {
      setActive.mockClear();
      await session.setPermissionMode(mode);
      const names = setActive.mock.calls.at(-1)?.[0] as string[];
      expect(names, `${mode} mode`).not.toContain('powershell');
      // The other half of the same guarantee: the Damocles tool is present under its own spelling, so
      // a rename to pi's name fails here rather than silently colliding with the built-in.
      expect(names, `${mode} mode`).toContain('PowerShell');
    }
    await session.dispose();
  });

  it('plan mode keeps every LOADED MCP tool in the active set, read-only or not (US-014.4)', async () => {
    // Subject unchanged and still the security-relevant one: plan mode does NOT filter MCP tools by
    // their read-only annotation. Slice 2 defers MCP tools until ToolSearch loads them, so the test now
    // loads both first — but the assertion that matters is untouched: once loaded, the NON-read-only
    // `mcp__git__commit` survives plan mode exactly as the read-only one does. A source change that
    // reintroduced read-only filtering in plan mode still fails here.
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    // Seed the live full set with one read-only-ish and one non-read MCP name via the real runtime
    // folder view — `fullActiveToolNames()` reads its `allToolNames()` live each call.
    stubPanelMcp({
      allToolNames: () => ['mcp__ctx7__query_docs', 'mcp__git__commit'],
    } as unknown as McpToolSource);

    const live = H.getLastSession()!;
    const setActive = live.setActiveToolsByName as ReturnType<typeof vi.fn>;

    // Deferred baseline first: neither is active until ToolSearch loads it.
    setActive.mockClear();
    session.refreshActiveTools();
    const beforeLoad = setActive.mock.calls.at(-1)?.[0] as string[];
    expect(beforeLoad).not.toContain('mcp__ctx7__query_docs');
    expect(beforeLoad).not.toContain('mcp__git__commit');

    session.activateDeferredTools(['mcp__ctx7__query_docs', 'mcp__git__commit']);
    setActive.mockClear();
    await session.setPermissionMode('plan');

    const planNames = setActive.mock.calls.at(-1)?.[0] as string[];
    expect(planNames).toContain('mcp__ctx7__query_docs');
    expect(planNames).toContain('mcp__git__commit');
    await session.dispose();
  });

  it('plan mode carries the browser tools when the browser is enabled, and none when it is off', async () => {
    const cfg = vi.spyOn(testPlatform.settings, 'get');
    const withBrowser = (enabled: boolean) => {
      cfg.mockImplementation(settingsReader((key: string) => (key === 'damocles.browser.enabled' ? enabled : undefined)));
    };

    withBrowser(true);
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const setActive = live.setActiveToolsByName as ReturnType<typeof vi.fn>;

    // Slice 2: browser tools are deferred, so the test loads them before asserting plan mode carries
    // them. Subject unchanged — the BROWSER MASTER FLAG governs plan-mode membership, not plan mode.
    session.activateDeferredTools([...BROWSER_PI_TOOL_NAMES]);
    setActive.mockClear();
    await session.setPermissionMode('plan');
    const withOn = setActive.mock.calls.at(-1)?.[0] as string[];
    for (const name of BROWSER_PI_TOOL_NAMES) expect(withOn, name).toContain(name);
    expect(withOn).toContain(TOOL_BROWSER_REQUEST_INPUT);

    // …and the off case is now STRICTLY STRONGER than before Slice 2: the tools are absent even though
    // ToolSearch activated them. That is the eligibility-beats-activated-preference invariant (§2.2) —
    // the activated set is a preference, never an override, so turning the subsystem off wins.
    withBrowser(false);
    setActive.mockClear();
    await session.setPermissionMode('plan');
    const withOff = setActive.mock.calls.at(-1)?.[0] as string[];
    for (const name of BROWSER_PI_TOOL_NAMES) expect(withOff, name).not.toContain(name);

    cfg.mockRestore();
    await session.dispose();
  });

  // --- MCP first-connect: reloadForMcpToolChange (frozen-allowlist fix) ------------------------------
  function seedMcpNames(names: string[]): void {
    stubPanelMcp({
      allToolNames: () => names,
    } as unknown as McpToolSource);
  }

  it('MCP tools-changed: registry already current → re-applies active set, NO reload (single-panel fix)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    seedMcpNames(['mcp__ctx7__query_docs']);
    const live = H.getLastSession()!;
    // With the frozen allowlist dropped, the single-slot refreshTools already put the mcp tool in this
    // session's registry — simulate that so the orphan check passes.
    (live.registryToolNames as Set<string>).add('mcp__ctx7__query_docs');
    const reload = live.reload as ReturnType<typeof vi.fn>;
    const setActive = live.setActiveToolsByName as ReturnType<typeof vi.fn>;
    // Slice 2: the MCP tool is deferred, so it only reaches the active set once loaded. Loading it here
    // keeps the final assertion end-to-end; the RELOAD DECISION under test is untouched.
    session.activateDeferredTools(['mcp__ctx7__query_docs']);
    setActive.mockClear();

    session.reloadForMcpToolChange();

    expect(reload).not.toHaveBeenCalled();
    expect(setActive).toHaveBeenCalledTimes(1);
    expect(setActive.mock.calls.at(-1)?.[0] as string[]).toContain('mcp__ctx7__query_docs');
    await session.dispose();
  });

  it('MCP tools-changed: orphaned registry → reloads, then re-applies the active set with the mcp name', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    seedMcpNames(['mcp__ctx7__query_docs']);
    const live = H.getLastSession()!;
    // Orphaned runtime: the mcp tool is requested but absent from this session's registry. reload()
    // repopulates it (the mock adds the name so the post-reload active-set apply includes it).
    const reload = live.reload as ReturnType<typeof vi.fn>;
    reload.mockImplementation(async () => { (live.registryToolNames as Set<string>).add('mcp__ctx7__query_docs'); });
    const setActive = live.setActiveToolsByName as ReturnType<typeof vi.fn>;
    // Slice 2: deferred until loaded (see the sibling test above). The ORPHAN DETECTION under test is
    // unaffected — `missingMcpRegistryNames` reads the ELIGIBLE set, not the active one, so a deferred
    // MCP tool still triggers the rebuild. That is exactly what this assertion pair proves.
    session.activateDeferredTools(['mcp__ctx7__query_docs']);
    setActive.mockClear();

    session.reloadForMcpToolChange();
    await new Promise((r) => setTimeout(r, 0));

    expect(reload).toHaveBeenCalledTimes(1);
    expect(setActive.mock.calls.at(-1)?.[0] as string[]).toContain('mcp__ctx7__query_docs');
    await session.dispose();
  });

  it('MCP tools-changed reloads EVERY orphaned panel, not just one (guards the root cause)', async () => {
    const a = new PiSession(makeOptions([]));
    const b = new PiSession(makeOptions([]));
    await a.initializeEarly();
    const liveA = H.getLastSession()!;
    await b.initializeEarly();
    const liveB = H.getLastSession()!;
    expect(liveA).not.toBe(liveB);
    seedMcpNames(['mcp__ctx7__query_docs']); // both registries lack it → both orphaned

    a.reloadForMcpToolChange();
    b.reloadForMcpToolChange();
    await new Promise((r) => setTimeout(r, 0));

    expect(liveA.reload as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(liveB.reload as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    await a.dispose();
    await b.dispose();
  });

  it('MCP tools-changed mid-stream defers the reload until the next turn (no mid-stream rebuild)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    seedMcpNames(['mcp__ctx7__query_docs']);
    const live = H.getLastSession()!;
    (live as { isStreaming: boolean }).isStreaming = true;
    const reload = live.reload as ReturnType<typeof vi.fn>;
    reload.mockImplementation(async () => { (live.registryToolNames as Set<string>).add('mcp__ctx7__query_docs'); });

    session.reloadForMcpToolChange();
    await new Promise((r) => setTimeout(r, 0));
    // Streaming → reload deferred, not run mid-turn.
    expect(reload).not.toHaveBeenCalled();

    // The turn settles; the next sendMessage flushes the deferred reload before prompting.
    (live as { isStreaming: boolean }).isStreaming = false;
    await session.sendMessage('go', undefined, 'c1', { content: 'go' });
    expect(reload).toHaveBeenCalledTimes(1);
    await session.dispose();
  });

  it('MCP tools-changed during compaction defers the reload (isCompacting guard, M1)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    seedMcpNames(['mcp__ctx7__query_docs']);
    const live = H.getLastSession()!;
    // compact() aborts first, so isStreaming is FALSE while isCompacting is true — the streaming guard
    // alone would let the reload rebuild the runtime underneath the live compaction.
    (live as { isStreaming: boolean }).isStreaming = false;
    (live as { isCompacting: boolean }).isCompacting = true;
    const reload = live.reload as ReturnType<typeof vi.fn>;

    session.reloadForMcpToolChange();
    await new Promise((r) => setTimeout(r, 0));
    expect(reload).not.toHaveBeenCalled();

    // Compaction finishes; the next turn flushes the deferred reload.
    (live as { isCompacting: boolean }).isCompacting = false;
    reload.mockImplementation(async () => { (live.registryToolNames as Set<string>).add('mcp__ctx7__query_docs'); });
    await session.sendMessage('go', undefined, 'c1', { content: 'go' });
    expect(reload).toHaveBeenCalledTimes(1);
    await session.dispose();
  });

  it('a failing session.reload() is fail-soft: contained, panel stays usable (L2)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    seedMcpNames(['mcp__ctx7__query_docs']);
    const live = H.getLastSession()!;
    const reload = live.reload as ReturnType<typeof vi.fn>;
    reload.mockRejectedValue(new Error('reload boom'));

    // Idle + orphaned → runs the reload now; the rejection must be swallowed (not thrown to the caller).
    expect(() => session.reloadForMcpToolChange()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    // Single-flight: even if the MCP backend races a second tools-changed, it coalesces onto the
    // in-flight reload rather than stacking a second rebuild — so the failed reload fired exactly once.
    expect(reload).toHaveBeenCalledTimes(1);
    // The panel still serves a turn afterwards (the rejection didn't poison the session).
    await session.sendMessage('go', undefined, 'c1', { content: 'go' });
    expect(live.prompt as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    await session.dispose();
  });

  it('a deferred reload is dropped when the session is reset before the next turn (no stale reload, L2)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    seedMcpNames(['mcp__ctx7__query_docs']);
    const first = H.getLastSession()!;
    (first as { isStreaming: boolean }).isStreaming = true;
    session.reloadForMcpToolChange(); // orphaned + streaming → deferred

    // A reset replaces the session; the fresh one reads the current tool set, so the deferral is moot.
    // `reset()` chains `runtime.newSession()` onto `resetPromise`; a bare macrotask tick does not drain
    // that chain, so the fresh session's first apply would not have happened yet. `whenReplaced()` is
    // the public seam for exactly this wait (credit: extension-host's harness finding).
    session.reset();
    await session.whenReplaced();
    const second = H.getLastSession()!;
    expect(second).not.toBe(first);
    // Give the fresh session the mcp tool (simulating its rebuilt registry) so no reload is warranted.
    (second.registryToolNames as Set<string>).add('mcp__ctx7__query_docs');
    const reloadSecond = second.reload as ReturnType<typeof vi.fn>;

    await session.sendMessage('go', undefined, 'c1', { content: 'go' });
    // reset() cleared the stale deferral, so the next turn does NOT reload the fresh session.
    expect(reloadSecond).not.toHaveBeenCalled();
    await session.dispose();
  });

  it('an MCP reload requested mid-reset serializes behind newSession, then runs on the fresh session (L2)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    seedMcpNames(['mcp__ctx7__query_docs']);
    H.seq.length = 0;

    // Make newSession observably slow so a reload requested during it must wait for it to finish. The
    // wrapper records ordering into the shared seq alongside each session's own `reload:<id>` marker.
    const runtime = (session as unknown as { runtime: { newSession: () => Promise<unknown> } }).runtime;
    const realNewSession = runtime.newSession.bind(runtime);
    runtime.newSession = async () => {
      H.seq.push('newSession:start');
      await new Promise((r) => setTimeout(r, 5));
      const res = await realNewSession();
      H.seq.push('newSession:end');
      return res;
    };

    session.reset(); // begins the slow newSession()
    // Request a reload while the reset is in flight. runMcpReload awaits the in-flight reset, then
    // re-reads the now-current (fresh) session and reloads IT — never concurrently with newSession.
    void session.reloadForMcpToolChange();

    await new Promise((r) => setTimeout(r, 30));
    const reloadIdx = H.seq.findIndex((s) => s.startsWith('reload:'));
    const endIdx = H.seq.indexOf('newSession:end');
    expect(endIdx).toBeGreaterThan(-1);
    // The reload ran strictly after newSession completed (serialized, not concurrent).
    expect(reloadIdx).toBeGreaterThan(endIdx);
    await session.dispose();
  });

  it('a burst of MCP tools-changed events coalesces into a single reload (single-flight, L2)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    seedMcpNames(['mcp__ctx7__query_docs']);
    const live = H.getLastSession()!;
    let resolveReload!: () => void;
    const reload = live.reload as ReturnType<typeof vi.fn>;
    // Hold the first reload open so the burst's later events arrive while it is still in flight.
    reload.mockImplementation(() => new Promise<void>((res) => { resolveReload = () => { (live.registryToolNames as Set<string>).add('mcp__ctx7__query_docs'); res(); }; }));

    // Three tools-changed in the same tick (orphaned, idle): the first starts the reload, the next two
    // must coalesce onto it rather than stack three rebuilds.
    session.reloadForMcpToolChange();
    session.reloadForMcpToolChange();
    session.reloadForMcpToolChange();
    await new Promise((r) => setTimeout(r, 0));
    expect(reload).toHaveBeenCalledTimes(1);

    // When the in-flight reload settles it has made the registry current, so the coalesced re-run sees
    // nothing missing and does NOT reload again.
    resolveReload();
    await new Promise((r) => setTimeout(r, 0));
    expect(reload).toHaveBeenCalledTimes(1);
    await session.dispose();
  });

  it('getPlanFilePath slugs the committed first user message from the branch (FR-4)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    // The mock branch's first user message is 'hello world'.
    expect(path.basename(session.getPlanFilePath())).toMatch(/^hello-world-/);
    await session.dispose();
  });

  it('getPlanFilePath falls back to the first sent message before it is committed to the branch (FR-4)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    // Simulate the first-turn before_agent_start window: the prompt isn't in the branch yet.
    (live.sessionManager.getBranch as ReturnType<typeof vi.fn>).mockReturnValue([]);
    expect(path.basename(session.getPlanFilePath())).toMatch(/^plan-/);

    // Synthetic <…> messages are ignored; the first real prompt sets the slug from the cache.
    await session.sendMessage('<reminder> synthetic');
    expect(path.basename(session.getPlanFilePath())).toMatch(/^plan-/);
    await session.sendMessage('Create a hello world file at root');
    expect(path.basename(session.getPlanFilePath())).toMatch(/^create-a-hello-world-file-at-root-/);
    await session.dispose();
  });

  it('getPlanContent returns null when no plan file exists for the session', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const planPath = session.getPlanFilePath();
    fsSync.rmSync(planPath, { force: true });
    expect(await session.getPlanContent()).toBeNull();
    await session.dispose();
  });

  it('getPlanContent returns the on-disk plan file content (located by the stable suffix)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const sessionId = session.currentSessionId!;
    const planPath = computePlanFilePath(sessionId, 'hello world');
    fsSync.mkdirSync(path.dirname(planPath), { recursive: true });
    fsSync.writeFileSync(planPath, '# Plan: the real one', 'utf-8');
    try {
      expect(await session.getPlanContent()).toBe('# Plan: the real one');
    } finally {
      fsSync.rmSync(planPath, { force: true });
      await session.dispose();
    }
  });

  it('getPlanContent propagates a read error for a located-but-unreadable plan (does NOT mask as null)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const sessionId = session.currentSessionId!;
    // A path that findSessionPlanFiles locates (right `-<id8>.md` suffix) but readFile cannot read as a
    // file — here a directory, which throws EISDIR. A present-but-unreadable plan must surface, not
    // silently degrade into the "no plan, re-run it" path.
    const planPath = computePlanFilePath(sessionId, 'hello world');
    fsSync.mkdirSync(planPath, { recursive: true });
    try {
      await expect(session.getPlanContent()).rejects.toThrow();
    } finally {
      fsSync.rmSync(planPath, { recursive: true, force: true });
      await session.dispose();
    }
  });

  it('getToolStatus reports group masters + per-tool enabled (layered)', () => {
    const opts = makeOptions([]);
    opts.memoryService = { isEnabled: true } as never;
    opts.compassService = { isEnabled: false } as never;
    opts.browserService = {} as never;
    const session = new PiSession(opts);
    const snap = session.getToolStatus();
    const group = (g: string) => snap.groups.find((x) => x.group === g);

    expect(group('memory')?.enabled).toBe(true);
    expect(group('memory')?.available).toBe(true);
    expect(group('compass')?.enabled).toBe(false);
    expect(group('compass')?.available).toBe(true);
    expect(group('core')?.enabled).toBe(true);

    const mem = snap.tools.find((t) => t.group === 'memory')!;
    expect(mem.toggleable).toBe(true);
    expect(mem.enabled).toBe(true); // group master on, not per-tool-disabled

    const compass = snap.tools.find((t) => t.group === 'compass')!;
    expect(compass.enabled).toBe(false); // group master off → all its tools off

    const core = snap.tools.find((t) => t.group === 'core')!;
    expect(core.toggleable).toBe(false);
    expect(core.enabled).toBe(true); // core is always on
  });

  it('refreshActiveTools re-applies the active set live for the current mode', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession();
    const setActive = live!.setActiveToolsByName as ReturnType<typeof vi.fn>;
    setActive.mockClear();
    session.refreshActiveTools();
    expect(setActive).toHaveBeenCalledTimes(1);
    await session.dispose();
  });

  it('clear() then sendMessage() prompts the fresh session, not the old one (plan clear-context)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const first = H.getLastSession();
    expect(first).not.toBeNull();

    session.clear(); // fires newSession() async — the old session is mid-teardown
    await session.sendMessage('go', undefined, 'c1', { content: 'go' });

    const second = H.getLastSession();
    expect(second).not.toBe(first);
    expect((second!.prompt as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect((first!.prompt as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    await session.dispose();
  });

  it('queueInput holds messages and steers them as ONE combined prompt while streaming', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    (live as { isStreaming: boolean }).isStreaming = true;
    const prompt = live.prompt as ReturnType<typeof vi.fn>;

    expect(session.queueInput('first', 'q1')).toBe('queued');
    expect(session.queueInput('second', 'q2')).toBe('queued');

    // Each queue re-steers the FULL combined buffer (clearing the prior steer), one pass at a time: the
    // second waits until the first has handed its batch to pi.
    expect(prompt).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
    expect((live.clearQueue as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
    const last = prompt.mock.calls.at(-1);
    expect(last?.[0]).toBe('first\n\nsecond');
    expect(last?.[1]).toMatchObject({ streamingBehavior: 'steer' });
    await session.dispose();
  });

  it('collapses queued chips into the combined message when pi delivers the steer', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    (live as { isStreaming: boolean }).isStreaming = true;
    session.queueInput('a', 'q1');
    session.queueInput('b', 'q2');

    session.onQueuedInputsDelivered('a\n\nb'); // adapter calls this with the delivered user message_end text

    const batch = messages.find((m) => m.type === 'queueBatchProcessed');
    expect(batch).toMatchObject({ messageIds: ['q1', 'q2'], combinedContent: 'a\n\nb' });
    // Buffer cleared — a second delivery emits nothing.
    messages.length = 0;
    session.onQueuedInputsDelivered('a\n\nb');
    expect(messages.some((m) => m.type === 'queueBatchProcessed')).toBe(false);
    await session.dispose();
  });

  it('reports a delivered batch is owed a mid-stream marker, then writes it keyed to the committed entry', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    (live as { isStreaming: boolean }).isStreaming = true;
    const append = live.sessionManager.appendCustomEntry as ReturnType<typeof vi.fn>;
    session.queueInput('a', 'q1');
    session.queueInput('b', 'q2');

    // Delivery (user message_end) flushes the buffer but does NOT write yet — pi hasn't committed the
    // steered entry to the tree at this point, so keying it here would mis-key to the prior turn.
    expect(session.onQueuedInputsDelivered('a\n\nb')).toBe(true);
    expect(append.mock.calls.some((c) => c[0] === 'damocles-mid-stream')).toBe(false);

    // The adapter resolves the committed entry id at the next assistant message_start and calls back.
    session.recordMidStreamMarker('u-combined');
    const calls = append.mock.calls.filter((c) => c[0] === 'damocles-mid-stream');
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toEqual({ userEntryId: 'u-combined' });
    await session.dispose();
  });

  it('onQueuedInputsDelivered returns false (no marker owed) when no batch was queued', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const append = live.sessionManager.appendCustomEntry as ReturnType<typeof vi.fn>;

    expect(session.onQueuedInputsDelivered('anything')).toBe(false);
    expect(append.mock.calls.some((c) => c[0] === 'damocles-mid-stream')).toBe(false);
    await session.dispose();
  });

  it('queueInput refuses (returns false) when the session is not streaming', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    (live as { isStreaming: boolean }).isStreaming = false;
    expect(session.queueInput('nope')).toBe(false);
    expect((live.prompt as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    await session.dispose();
  });

  it('cancel() returns queued-but-undelivered messages to the input and empties pi\'s queue', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    (live as { isStreaming: boolean }).isStreaming = true;
    session.queueInput('pending', 'q1');
    messages.length = 0;
    (live.clearQueue as ReturnType<typeof vi.fn>).mockClear();

    session.cancel();
    expect(messages).toContainEqual({ type: 'queueCancelled', messageId: 'q1', returnToInput: true });
    // pi's next run would otherwise start by draining the stopped run's steer.
    expect(live.clearQueue).toHaveBeenCalled();
    // The dropped message is not re-delivered.
    session.onQueuedInputsDelivered('pending');
    expect(messages.some((m) => m.type === 'queueBatchProcessed')).toBe(false);
    await session.dispose();
  });

  it("a new chat returns every queued message to the input, one still being screened included, and empties pi's queue", async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    (live as { isStreaming: boolean }).isStreaming = true;
    session.queueInput('pending', 'q1');
    // An input handler that has not answered yet holds the next one in screening.
    const runner = live.extensionRunner as unknown as { hasHandlers: ReturnType<typeof vi.fn>; emitInput?: () => Promise<unknown> };
    runner.hasHandlers.mockReturnValue(true);
    runner.emitInput = () => new Promise(() => {});
    session.queueInput('screening', 'q2');
    messages.length = 0;
    (live.clearQueue as ReturnType<typeof vi.fn>).mockClear();

    session.clear();

    expect(messages.filter((m) => m.type === 'queueCancelled')).toEqual([
      { type: 'queueCancelled', messageId: 'q1', returnToInput: true },
      { type: 'queueCancelled', messageId: 'q2', returnToInput: true },
    ]);
    // The old run streams until the replacement aborts it, and must not deliver the batch meanwhile.
    expect(live.clearQueue).toHaveBeenCalled();
    await session.whenReplaced();
    await session.dispose();
  });

  it("a folder switch, which disposes the session, first returns every queued message and every prompt pi queued to the input", async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const followUps: string[] = [];
    Object.assign(live, { isStreaming: true, getFollowUpMessages: () => followUps });
    (live.clearQueue as ReturnType<typeof vi.fn>).mockImplementation(() => ({ steering: [], followUp: followUps.splice(0) }));
    (live.prompt as ReturnType<typeof vi.fn>).mockImplementationOnce(async (text: string, opts: { preflightResult: (d: string) => void }) => {
      followUps.push(text);
      opts.preflightResult('queued');
    });
    const withdrawn = vi.fn();
    expect(await session.sendMessage('also look at this', undefined, 'c1', { content: 'also look at this' }, withdrawn)).toBe('sent');
    session.queueInput('pending', 'q1');
    const runner = live.extensionRunner as unknown as { hasHandlers: ReturnType<typeof vi.fn>; emitInput?: () => Promise<unknown> };
    runner.hasHandlers.mockReturnValue(true);
    runner.emitInput = () => new Promise(() => {});
    session.queueInput('screening', 'q2');
    messages.length = 0;

    const disposed = session.dispose();

    expect(messages.filter((m) => m.type === 'queueCancelled')).toEqual([
      { type: 'queueCancelled', messageId: 'q1', returnToInput: true },
      { type: 'queueCancelled', messageId: 'q2', returnToInput: true },
      { type: 'queueCancelled', messageId: 'c1', returnToInput: true },
    ]);
    expect(withdrawn).toHaveBeenCalledOnce();
    expect(followUps).toEqual([]);
    await disposed;
  });

  describe("a folder switch, which disposes the session, returns a prompt pi's input handlers still hold to the input once", () => {
    const IMAGE = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'iVBORw0KGgo=' } };
    const TYPED = [{ type: 'text' as const, text: 'what is this?' }, IMAGE];
    const returned = (messages: ExtensionToWebviewMessage[]) => messages.filter((m) => m.type === 'interruptRecovery' || m.type === 'queueCancelled');

    it.each([
      ['to open a run, after the disposal settled', 'started', false],
      ['to open a run, while the disposal still aborts the turn', 'started', true],
      ['into the running run, after the disposal settled', 'queued', false],
      ['into the running run, while the disposal still aborts the turn', 'queued', true],
    ])('with its text, image and chips, and pi releasing it %s delivers nothing', async (_when, disposition, duringAbort) => {
      const messages: ExtensionToWebviewMessage[] = [];
      const session = new PiSession(makeOptions(messages));
      await session.initializeEarly();
      const live = H.getLastSession()!;
      const followUps: string[] = [];
      Object.assign(live, { isStreaming: disposition === 'queued', getFollowUpMessages: () => followUps });
      (live.clearQueue as ReturnType<typeof vi.fn>).mockImplementation(() => ({ steering: [], followUp: followUps.splice(0) }));
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const runs: string[] = [];
      (live.prompt as ReturnType<typeof vi.fn>).mockImplementationOnce(async (text: string, opts: { preflightResult: (d: string) => void }) => {
        await held;
        if (disposition === 'queued') followUps.push(text);
        opts.preflightResult(disposition);
        if (disposition === 'started') runs.push(text);
      });
      if (duringAbort) {
        (live.abort as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
          release();
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      const withdrawn = vi.fn();
      const sending = session.sendMessage(TYPED, undefined, 'c1', { content: 'what is this?', contentBlocks: TYPED }, withdrawn);
      await vi.waitFor(() => expect(live.prompt).toHaveBeenCalledOnce());

      const disposed = session.dispose();

      // Back before the panel moves, which a folder switch does once the disposal settles.
      expect(returned(messages)).toEqual([{ type: 'interruptRecovery', correlationId: 'c1', promptContent: 'what is this?', contentBlocks: TYPED }]);
      expect(withdrawn).toHaveBeenCalledOnce();
      await disposed;
      release();

      expect(await sending).toBe('withdrawn');
      expect(withdrawn).toHaveBeenCalledOnce();
      expect(returned(messages)).toHaveLength(1);
      expect(runs).toEqual([]);
      expect(followUps).toEqual([]);
    });

    it('before pi has it, with no echo shown', async () => {
      const messages: ExtensionToWebviewMessage[] = [];
      const session = new PiSession(makeOptions(messages));
      await session.initializeEarly();
      const live = H.getLastSession()!;
      session.requestInterruptionCheck();
      let disposed!: Promise<void>;
      vi.mocked(reconcileInterruptions).mockImplementationOnce(async () => {
        disposed = session.dispose();
        return [];
      });
      const withdrawn = vi.fn();

      const outcome = await session.sendMessage(TYPED, undefined, 'c1', { content: 'what is this?', contentBlocks: TYPED }, withdrawn);
      await disposed;

      expect(outcome).toBe('withdrawn');
      expect(withdrawn).toHaveBeenCalledOnce();
      expect(returned(messages)).toEqual([{ type: 'interruptRecovery', correlationId: 'c1', promptContent: 'what is this?', contentBlocks: TYPED }]);
      expect(messages.some((m) => m.type === 'userMessage')).toBe(false);
      expect(live.prompt).not.toHaveBeenCalled();
    });

    it('but not one whose run started, which reached the model', async () => {
      const messages: ExtensionToWebviewMessage[] = [];
      const session = new PiSession(makeOptions(messages));
      await session.initializeEarly();
      const live = H.getLastSession()!;
      let finish!: () => void;
      const running = new Promise<void>((resolve) => { finish = resolve; });
      (live.prompt as ReturnType<typeof vi.fn>).mockImplementationOnce(async (_text: string, opts: { preflightResult: (d: string) => void }) => {
        opts.preflightResult('started');
        await running;
      });
      const withdrawn = vi.fn();
      const sending = session.sendMessage(TYPED, undefined, 'c1', { content: 'what is this?', contentBlocks: TYPED }, withdrawn);
      await vi.waitFor(() => expect(live.prompt).toHaveBeenCalledOnce());

      const disposed = session.dispose();
      finish();
      await disposed;

      expect(await sending).not.toBe('withdrawn');
      expect(withdrawn).not.toHaveBeenCalled();
      expect(returned(messages)).toEqual([]);
    });

    it('nor one a Stop already handed back', async () => {
      const messages: ExtensionToWebviewMessage[] = [];
      const session = new PiSession(makeOptions(messages));
      await session.initializeEarly();
      const live = H.getLastSession()!;
      (live.prompt as ReturnType<typeof vi.fn>).mockImplementationOnce(async (_text: string, opts: { preflightResult: (d: string) => void }) => {
        session.cancel();
        opts.preflightResult('started');
      });
      const withdrawn = vi.fn();
      expect(await session.sendMessage(TYPED, undefined, 'c1', { content: 'what is this?', contentBlocks: TYPED }, withdrawn)).toBe('unsent');

      await session.dispose();

      expect(withdrawn).not.toHaveBeenCalled();
      expect(returned(messages)).toHaveLength(1);
    });
  });

  it('sendMessage after cancel() waits for the abort to settle before prompting', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    let abortResolved = false;
    (live.abort as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      abortResolved = true;
    });

    session.cancel(); // fires abort async; pi is mid-teardown
    await session.sendMessage('again', undefined, 'c2', { content: 'again' });

    // The new turn must not start until the in-flight abort fully wound down.
    expect(abortResolved).toBe(true);
    expect((live.prompt as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    await session.dispose();
  });

  it('sendMessage routes via follow-up when pi is unexpectedly still streaming (no crash)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    (live as { isStreaming: boolean }).isStreaming = true;

    await session.sendMessage('hi', undefined, 'c3', { content: 'hi' });
    const promptCall = (live.prompt as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(promptCall?.[1]).toMatchObject({ streamingBehavior: 'followUp' });
    await session.dispose();
  });

  it('emitCustomAgents badges a .damocles project agent as project scope', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();

    // The registry the session bound at start scans the developer's real home dir, so swap in a
    // fixed one before re-emitting; the mapping under test is the source -> scope badge.
    const internals = session as unknown as { agentRegistry: unknown; emitCustomAgents: () => void };
    internals.agentRegistry = {
      getAvailableConfigs: () => [
        { name: 'Reviewer', description: 'Reviews code', isDefault: false, source: 'project-damocles' },
      ],
    };
    internals.emitCustomAgents();

    const emitted = messages.filter((m) => m.type === 'customAgents').at(-1) as { agents: unknown[] };
    expect(emitted.agents).toEqual([{ name: 'Reviewer', description: 'Reviews code', source: 'project' }]);
    await session.dispose();
  });

  it('dispose tears down the runtime but leaves the PiRuntime singleton alive', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    await session.dispose();
    expect(PiRuntime.exists).toBe(true);
    expect(session.currentSessionId).toBeNull();
  });

  it('no ChatSession method throws when called on a started session (FR-10)', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const s = new PiSession(makeOptions(messages));
    await s.initializeEarly();

    // getters
    void s.currentSessionId; void s.persistenceSessionId; void s.memorySessionId;
    void s.teamService; void s.processing; void s.currentPromptIndex;
    void s.conversationHead; void s.currentModel;

    // synchronous methods
    s.getPlanFilePath();
    s.getModelInfo(); s.setResumeSession(null); s.queueInput('hi'); s.cancel(); s.reset(); s.clear();
    s.setModel('claude-opus-5-5'); s.setMcpServers({ userUnion: {}, userVisible: [], folder: {} });
    s.setMcpStatusListener(() => {}); s.refreshActiveTools(); s.getToolStatus();
    s.seedCheckpoints([]); s.getAccumulatedCost();
    s.disableThinkingForNextQuery(); s.restoreThinkingConfig(); s.cancelBtw('b');
    s.cancelToolCall('x'); s.stopSubagent('t');

    // async methods
    await Promise.all([
      s.setPermissionMode('default'), s.getSupportedModels(), s.getSupportedCommands(),
      s.getMcpServerStatus(), s.reconnectMcpServerLive('m'),
      s.getMemoryInjection(0),
      s.requestContextUsage(), s.cancelAutoCompact(), s.interrupt(),
      s.rewindFiles('u'), s.sendBtw('b', 'q'),
      s.sendMessage('hello', undefined, 'corr-1', { content: 'hello' }),
    ]);

    expect(messages.some((m) => m.type === 'rewindError')).toBe(true);
    // btw now runs as a real ephemeral aside (US-025) — it answers rather than emitting the old
    // "not available" error.
    expect(messages.some((m) => m.type === 'btwComplete')).toBe(true);
    await s.dispose();
  });

  it('getSupportedCommands surfaces prompt templates and skills (US-015/016)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();

    const commands = await session.getSupportedCommands();
    const names = commands.map((c) => c.name);
    expect(names).toContain('review');
    expect(names).toContain('skill:simplify');

    const review = commands.find((c) => c.name === 'review');
    expect(review?.description).toBe('Review code');
    expect(review?.argumentHint).toBe('[pr]');
    await session.dispose();
  });

  it('requestContextUsage emits a populated ContextUsageData with clickable file paths (US-CMD)', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();

    await session.requestContextUsage();
    const msg = messages.find((m) => m.type === 'contextUsage');
    expect(msg).toBeDefined();
    const data = (msg as { data: import('../../../shared/types/session').ContextUsageData | null }).data;
    expect(data).not.toBeNull();
    expect(data!.totalTokens).toBe(160);
    expect(data!.maxTokens).toBe(1_000_000);
    expect(data!.messageBreakdown).toBeDefined();
    expect(data!.messageBreakdown!.userMessageTokens).toBeGreaterThan(0);
    expect(data!.messageBreakdown!.toolCallsByType.some((t) => t.name === 'read')).toBe(true);
    expect(data!.systemPromptSections?.length).toBeGreaterThan(0);
    expect(data!.skills?.skillFrontmatter[0]?.filePath).toBe('/home/.claude/skills/simplify/SKILL.md');
    expect(data!.slashCommands?.commands?.some((c) => c.filePath === '/cwd/.claude/commands/review.md')).toBe(true);
    await session.dispose();
  });

  it('getSystemPromptText shows the Damocles prompt with NO turn run (regression: pi boilerplate)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    // No prompt() turn has run, so pi's mutable agent.state.systemPrompt would hold pi's boilerplate.
    const prompt = await session.getSystemPromptText();
    expect(prompt).toBeDefined();
    expect(prompt).toContain('AI coding agent');
    expect(prompt).not.toContain('operating inside pi');
    await session.dispose();
  });

  it('/context system-prompt token count is non-zero with NO turn run (US-021)', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();

    await session.requestContextUsage();
    const msg = messages.find((m) => m.type === 'contextUsage');
    const data = (msg as { data: import('../../../shared/types/session').ContextUsageData | null }).data;
    expect(data).not.toBeNull();
    // One row per prompt piece, named by the section key, preamble first. Memory is off and no plan
    // file exists in this panel, so only the always-on pieces are present.
    expect(data!.systemPromptSections!.map((s) => s.name)).toEqual(['preamble', 'damocles_tone']);
    expect(data!.systemPromptSections!.every((s) => s.tokens > 0)).toBe(true);
    await session.dispose();
  });

  it('/context gains a damocles_memory row when memory is on, and keeps map order', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const opts = makeOptions(messages);
    opts.memoryService = { isEnabled: true } as never;
    const session = new PiSession(opts);
    await session.initializeEarly();

    await session.requestContextUsage();
    const msg = messages.find((m) => m.type === 'contextUsage');
    const data = (msg as { data: import('../../../shared/types/session').ContextUsageData | null }).data;
    expect(data!.systemPromptSections!.map((s) => s.name)).toEqual(['preamble', 'damocles_memory', 'damocles_tone']);
    await session.dispose();
  });

  it('records an original-input sidecar when pi expanded a slash command (typed != stored)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const append = live.sessionManager.appendCustomEntry as ReturnType<typeof vi.fn>;
    const getBranch = live.sessionManager.getBranch as ReturnType<typeof vi.fn>;
    // Before the turn the branch holds a prior user entry; prompt() commits a NEW user entry holding
    // the EXPANDED body of the slash command.
    getBranch.mockReturnValue([{ type: 'message', id: 'u-prior', message: { role: 'user', content: [{ type: 'text', text: 'prior' }] } }]);
    (live.prompt as ReturnType<typeof vi.fn>).mockImplementation(async (_text: string, opts: unknown) => {
      piRuns(opts, getBranch, [
        { type: 'message', id: 'u-new', message: { role: 'user', content: [{ type: 'text', text: 'Hello day is Tuesday' }] } },
      ]);
    });

    await session.sendMessage('Hello day is Tuesday', undefined, 'c1', { content: '/example what is the day' });

    const call = append.mock.calls.find((c) => c[0] === 'damocles-original-input');
    expect(call).toBeDefined();
    expect(call![1]).toEqual({ userEntryId: 'u-new', original: '/example what is the day' });
    await session.dispose();
  });

  it('keys the sidecar to the entry the prompt committed when a note or queued batch committed after it', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const append = live.sessionManager.appendCustomEntry as ReturnType<typeof vi.fn>;
    const getBranch = live.sessionManager.getBranch as ReturnType<typeof vi.fn>;
    getBranch.mockReturnValue([]);
    // The run commits the expanded prompt, then a cancel note and a queued batch steered in at later boundaries.
    (live.prompt as ReturnType<typeof vi.fn>).mockImplementation(async (_text: string, opts: unknown) => {
      piRuns(opts, getBranch, [
        { type: 'message', id: 'u-new', message: { role: 'user', content: [{ type: 'text', text: 'Hello day is Tuesday' }] } },
        { type: 'message', id: 'a-1', message: { role: 'assistant', content: [{ type: 'text', text: 'running it' }] } },
        { type: 'message', id: 'u-note', message: { role: 'user', content: [{ type: 'text', text: 'skip it' }] } },
        { type: 'message', id: 'u-batch', message: { role: 'user', content: [{ type: 'text', text: 'and check the logs' }] } },
      ]);
    });

    await session.sendMessage('Hello day is Tuesday', undefined, 'c1', { content: '/example what is the day' });

    const sidecars = append.mock.calls.filter((c) => c[0] === 'damocles-original-input').map((c) => c[1]);
    expect(sidecars).toEqual([{ userEntryId: 'u-new', original: '/example what is the day' }]);
    await session.dispose();
  });

  it('records no sidecar for a plain prompt whose run a note joined after it', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const append = live.sessionManager.appendCustomEntry as ReturnType<typeof vi.fn>;
    const getBranch = live.sessionManager.getBranch as ReturnType<typeof vi.fn>;
    getBranch.mockReturnValue([]);
    const typed = 'Run Start-Sleep -Seconds 60; echo done in PowerShell.';
    (live.prompt as ReturnType<typeof vi.fn>).mockImplementation(async (_text: string, opts: unknown) => {
      piRuns(opts, getBranch, [
        { type: 'message', id: 'u-prompt', message: { role: 'user', content: [{ type: 'text', text: typed }] } },
        { type: 'message', id: 'u-note', message: { role: 'user', content: [{ type: 'text', text: 'skip it' }] } },
      ]);
    });

    await session.sendMessage(typed, undefined, 'c1', { content: typed });

    expect(append.mock.calls.some((c) => c[0] === 'damocles-original-input')).toBe(false);
    await session.dispose();
  });

  it('does NOT record a sidecar for a plain message (typed == stored)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const append = live.sessionManager.appendCustomEntry as ReturnType<typeof vi.fn>;
    const getBranch = live.sessionManager.getBranch as ReturnType<typeof vi.fn>;
    getBranch.mockReturnValue([]);
    (live.prompt as ReturnType<typeof vi.fn>).mockImplementation(async (_text: string, opts: unknown) => {
      piRuns(opts, getBranch, [
        { type: 'message', id: 'u-new', message: { role: 'user', content: [{ type: 'text', text: 'just a normal message' }] } },
      ]);
    });

    await session.sendMessage('just a normal message', undefined, 'c1', { content: 'just a normal message' });

    expect(append.mock.calls.some((c) => c[0] === 'damocles-original-input')).toBe(false);
    await session.dispose();
  });

  it('does NOT record a sidecar when no new user entry was committed (pi extension command)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const append = live.sessionManager.appendCustomEntry as ReturnType<typeof vi.fn>;
    // The branch's last user entry id is unchanged across the turn (a /todos-style command commits none).
    (live.sessionManager.getBranch as ReturnType<typeof vi.fn>).mockReturnValue([
      { type: 'message', id: 'u-stable', message: { role: 'user', content: [{ type: 'text', text: 'prior turn' }] } },
    ]);
    (live.prompt as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await session.sendMessage('expanded body', undefined, 'c1', { content: '/todos' });

    expect(append.mock.calls.some((c) => c[0] === 'damocles-original-input')).toBe(false);
    await session.dispose();
  });

  it('does NOT record a sidecar for a plain message stored with an IDE-context prefix (asymmetric strip)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const append = live.sessionManager.appendCustomEntry as ReturnType<typeof vi.fn>;
    const getBranch = live.sessionManager.getBranch as ReturnType<typeof vi.fn>;
    getBranch.mockReturnValue([]);
    // pi merges the IDE-context block into the stored user message; the typed text carries no prefix.
    // Stripping the stored side before comparing must collapse them to equal → no sidecar.
    (live.prompt as ReturnType<typeof vi.fn>).mockImplementation(async (_text: string, opts: unknown) => {
      piRuns(opts, getBranch, [
        {
          type: 'message',
          id: 'u-new',
          message: {
            role: 'user',
            content: [{ type: 'text', text: '<ide_opened_file>The user opened the file c:\\x.ts in the IDE. This may or may not be related to the current task.</ide_opened_file>\nwhat day is it' }],
          },
        },
      ]);
    });

    await session.sendMessage('augmented-by-ide-context', undefined, 'c1', { content: 'what day is it' });

    expect(append.mock.calls.some((c) => c[0] === 'damocles-original-input')).toBe(false);
    await session.dispose();
  });

  // --- terminal attachment sidecar and send outcome -------------------------------------------------
  const attachmentInfo = (id: string) => ({ id, source: 'command' as const, commandLine: 'npm test', exitCode: 1, terminalTitle: 'pwsh', lineCount: 1, omittedLines: 0, preview: 'FAIL' });
  const ATTACHED = { content: 'what failed?', terminalAttachments: [attachmentInfo('t1'), attachmentInfo('t2')] };
  const attachmentSidecars = (append: ReturnType<typeof vi.fn>) => append.mock.calls.filter((c) => c[0] === 'damocles-terminal-attachments').map((c) => c[1]);

  it('records the attachment count for the entry the prompt committed, at its commit, and reports it sent', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const append = live.sessionManager.appendCustomEntry as ReturnType<typeof vi.fn>;
    const getBranch = live.sessionManager.getBranch as ReturnType<typeof vi.fn>;
    getBranch.mockReturnValue([]);
    let atCommit: unknown[] = [];
    (live.prompt as ReturnType<typeof vi.fn>).mockImplementation(async (_text: string, opts: unknown) => {
      piRuns(opts, getBranch, [
        { type: 'message', id: 'u-new', message: { role: 'user', content: [{ type: 'text', text: 'blocks then what failed?' }] } },
        { type: 'message', id: 'u-note', message: { role: 'user', content: [{ type: 'text', text: 'skip it' }] } },
      ]);
      await Promise.resolve();
      atCommit = attachmentSidecars(append);
    });

    const outcome = await session.sendMessage('blocks then what failed?', undefined, 'c1', ATTACHED);

    expect(atCommit).toEqual([{ userEntryId: 'u-new', count: 2 }]);
    expect(attachmentSidecars(append)).toEqual([{ userEntryId: 'u-new', count: 2 }]);
    expect(outcome).toBe('sent');
    await session.dispose();
  });

  it('records no attachment count for a prompt stopped before its run, which goes back unsent', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const append = live.sessionManager.appendCustomEntry as ReturnType<typeof vi.fn>;
    (live.sessionManager.getBranch as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (live.prompt as ReturnType<typeof vi.fn>).mockImplementation(async (_text: string, opts: unknown) => {
      session.cancel();
      (opts as { preflightResult: (disposition: string) => void }).preflightResult('started');
    });

    const outcome = await session.sendMessage('blocks then what failed?', undefined, 'c1', ATTACHED);

    expect(attachmentSidecars(append)).toEqual([]);
    expect(outcome).toBe('unsent');
    expect(messages).toContainEqual({ type: 'interruptRecovery', correlationId: 'c1', promptContent: 'what failed?' });
    await session.dispose();
  });

  it.each([
    ['after its echo', true],
    ['before its echo', false],
  ])('returns a prompt stopped before its run %s with its typed text and images', async (_when, echoed) => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const image = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'iVBORw0KGgo=' } };
    const typed = [{ type: 'text' as const, text: 'what is this?' }, image];
    (live.prompt as ReturnType<typeof vi.fn>).mockImplementation(async (_text: string, opts: unknown) => {
      session.cancel();
      (opts as { preflightResult: (disposition: string) => void }).preflightResult('started');
    });
    if (!echoed) {
      session.requestInterruptionCheck();
      vi.mocked(reconcileInterruptions).mockImplementationOnce(async () => {
        session.cancel();
        return [];
      });
    }

    const outcome = await session.sendMessage(typed, undefined, 'c1', { content: 'what is this?', contentBlocks: typed });

    expect(outcome).toBe('unsent');
    expect(messages.some((m) => m.type === 'userMessage')).toBe(echoed);
    expect(messages).toContainEqual({ type: 'interruptRecovery', correlationId: 'c1', promptContent: 'what is this?', contentBlocks: typed });
    await session.dispose();
  });

  it('records no attachment count when the session was replaced before the prompt committed', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const append = live.sessionManager.appendCustomEntry as ReturnType<typeof vi.fn>;
    const getBranch = live.sessionManager.getBranch as ReturnType<typeof vi.fn>;
    getBranch.mockReturnValue([]);
    (live.prompt as ReturnType<typeof vi.fn>).mockImplementation(async (_text: string, opts: unknown) => {
      (opts as { preflightResult: (disposition: string) => void }).preflightResult('started');
      session.reset();
      await session.whenReplaced();
      const message = { role: 'user', content: [{ type: 'text', text: 'blocks then what failed?' }] };
      // The replaced session's own listeners, which still include the prompt's entry watch.
      for (const listener of [...live.listeners]) listener({ type: 'message_end', message });
      getBranch.mockReturnValue([{ type: 'message', id: 'u-new', message }]);
      await Promise.resolve();
    });

    await session.sendMessage('blocks then what failed?', undefined, 'c1', ATTACHED);

    expect(H.getLastSession()).not.toBe(live);
    expect(attachmentSidecars(append)).toEqual([]);
    expect(append.mock.calls.some((c) => c[0] === 'damocles-original-input')).toBe(false);
    await session.dispose();
  });

  it('names the typed text as the prompt a UserPromptSubmit hook sees, sent alone or behind blocks, and queued', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    (live.sessionManager.getBranch as ReturnType<typeof vi.fn>).mockReturnValue([]);
    const gate = (cwdFolder() as unknown as { _panelRegistry: Map<string, PanelGateContext> })._panelRegistry.get(live.sessionId as string)!;
    const seen: Array<string | undefined> = [];
    // pi runs no hook on the re-steered batch, which it gets as `source: 'extension'`.
    (live.prompt as ReturnType<typeof vi.fn>).mockImplementation(async (text: string, opts?: { source?: string }) => {
      if (opts?.source !== 'extension') seen.push(gate.typedPromptOf?.(text));
    });

    await session.sendMessage('/review src', undefined, 'c1', { content: '/review src' });
    await session.sendMessage('blocks\nreview prompt body src', undefined, 'c2', { content: '/review src', terminalAttachments: [attachmentInfo('t1')] });

    Object.assign(live, { isStreaming: true });
    const runner = live.extensionRunner as unknown as { hasHandlers: ReturnType<typeof vi.fn>; emitInput?: (text: string) => Promise<unknown> };
    runner.hasHandlers.mockReturnValue(true);
    runner.emitInput = async (text) => { seen.push(gate.typedPromptOf?.(text)); return { action: 'continue' }; };
    session.queueInput('Execute skill simplify', 'q1', '/simplify');
    await vi.waitFor(() => expect(seen).toHaveLength(3));

    expect(seen).toEqual(['/review src', '/review src', '/simplify']);
    expect(gate.typedPromptOf?.('/review src')).toBeUndefined();
    await session.dispose();
  });

  it('reports a prompt unsent when it is refused, and sent when pi queued it into the running run', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    (live.sessionManager.getBranch as ReturnType<typeof vi.fn>).mockReturnValue([]);
    let release!: () => void;
    (live.prompt as ReturnType<typeof vi.fn>).mockImplementationOnce(async (_text: string, opts: unknown) => {
      (opts as { preflightResult: (disposition: string) => void }).preflightResult('queued');
      await new Promise<void>((resolve) => { release = resolve; });
    });

    const queued = session.sendMessage('first', undefined, 'c1', { content: 'first' });
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(await session.sendMessage('second', undefined, 'c2', { content: 'second' })).toBe('unsent');
    release();
    expect(await queued).toBe('sent');

    (live.prompt as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { throw new Error('No API key found for anthropic'); });
    expect(await session.sendMessage('third', undefined, 'c3', { content: 'third' })).toBe('unsent');
    await session.dispose();
  });

  // --- memory candidate enqueue (consolidation wiring) ---------------------------------------------
  function memorySpy() {
    return {
      isEnabled: true,
      ensureInitialized: vi.fn(async () => {}),
      enqueueTurnCandidate: vi.fn(),
      getPersistedMemoryInjection: vi.fn(),
    };
  }
  /** Force the adapter's observedAgentRun gate true (real LLM turn) — the no-op harness prompt fires
   *  no events, so the gate stays false by default. */
  function forceAgentRun(session: PiSession): void {
    (session as unknown as { adapter: { observedAgentRun: () => boolean } }).adapter.observedAgentRun = () => true;
  }

  it('session-start modelUpdate carries the workspace default from getDefaultModel, distinct from the active model', async () => {
    // defaultModel must come from getDefaultModel(), not the active panel model. Use a distinct sentinel
    // default so the assertion holds even though resolveInitialModel keeps activeModel on the authed model.
    const messages: ExtensionToWebviewMessage[] = [];
    const opts = makeOptions(messages);
    opts.getDefaultModel = () => 'workspace-default-model';
    const session = new PiSession(opts);
    await session.initializeEarly();
    forceAgentRun(session);

    await session.sendMessage('hi', undefined, 'corr', { content: 'hi' });

    const modelUpdate = messages.find((m) => m.type === 'modelUpdate');
    expect(modelUpdate).toMatchObject({ type: 'modelUpdate', defaultModel: 'workspace-default-model' });
    expect((modelUpdate as { activeModel: string }).activeModel).not.toBe('workspace-default-model');
    await session.dispose();
  });

  it('enqueues one memory candidate per real turn with the right shape', async () => {
    const opts = makeOptions([]);
    const memory = memorySpy();
    opts.memoryService = memory as never;
    const session = new PiSession(opts);
    await session.initializeEarly();
    forceAgentRun(session);
    const live = H.getLastSession()!;
    const getBranch = live.sessionManager.getBranch as ReturnType<typeof vi.fn>;
    // The previous turn ends on its answer a1; prompt() commits a new user (u2) + assistant (a2), and
    // the candidate starts at u2, so a1 belongs to the previous turn's candidate only.
    getBranch.mockReturnValue([
      { type: 'message', id: 'u1', message: { role: 'user', content: 'old' } },
      { type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] } },
    ]);
    (live.prompt as ReturnType<typeof vi.fn>).mockImplementation(async (_text: string, promptOpts: unknown) => {
      piRuns(promptOpts, getBranch, [
        { type: 'message', id: 'u2', message: { role: 'user', content: 'hi' } },
        { type: 'message', id: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
      ]);
    });

    await session.sendMessage('hi', undefined, 'corr', { content: 'hi' });

    expect(memory.enqueueTurnCandidate).toHaveBeenCalledTimes(1);
    expect(memory.enqueueTurnCandidate).toHaveBeenCalledWith({
      sessionId: session.memorySessionId,
      // u1 is prompt 0, so the prompt this turn committed is prompt 1.
      promptIndex: 1,
      userText: 'hi',
      assistantText: 'done',
      files: [],
      // The session's own folder, so another window's consolidation files it there.
      workspace: '/cwd',
    });
    await session.dispose();
  });

  it('does NOT enqueue a memory candidate when the turn ran no LLM agent (extension command)', async () => {
    const opts = makeOptions([]);
    const memory = memorySpy();
    opts.memoryService = memory as never;
    const session = new PiSession(opts);
    await session.initializeEarly();
    // Leave observedAgentRun false (harness default) — a fresh user entry on the branch still must not enqueue.
    const live = H.getLastSession()!;
    (live.sessionManager.getBranch as ReturnType<typeof vi.fn>).mockReturnValue([
      { type: 'message', id: 'u2', message: { role: 'user', content: 'hi' } },
    ]);

    await session.sendMessage('hi', undefined, 'corr', { content: 'hi' });

    expect(memory.enqueueTurnCandidate).not.toHaveBeenCalled();
    await session.dispose();
  });

  it('does NOT enqueue a memory candidate when no new user entry was committed', async () => {
    const opts = makeOptions([]);
    const memory = memorySpy();
    opts.memoryService = memory as never;
    const session = new PiSession(opts);
    await session.initializeEarly();
    forceAgentRun(session);
    const live = H.getLastSession()!;
    // prompt() commits nothing, so there is no entry to start the exchange from.
    (live.sessionManager.getBranch as ReturnType<typeof vi.fn>).mockReturnValue([
      { type: 'message', id: 'u-stable', message: { role: 'user', content: 'prior turn' } },
    ]);

    await session.sendMessage('hi', undefined, 'corr', { content: 'hi' });

    expect(memory.enqueueTurnCandidate).not.toHaveBeenCalled();
    await session.dispose();
  });

  it('joins multiple post-boundary user entries (steered turn) into one candidate', async () => {
    const opts = makeOptions([]);
    const memory = memorySpy();
    opts.memoryService = memory as never;
    const session = new PiSession(opts);
    await session.initializeEarly();
    forceAgentRun(session);
    const live = H.getLastSession()!;
    const getBranch = live.sessionManager.getBranch as ReturnType<typeof vi.fn>;
    getBranch.mockReturnValue([{ type: 'message', id: 'u1', message: { role: 'user', content: 'old' } }]);
    (live.prompt as ReturnType<typeof vi.fn>).mockImplementation(async (_text: string, promptOpts: unknown) => {
      piRuns(promptOpts, getBranch, [
        { type: 'message', id: 'u2', message: { role: 'user', content: 'first' } },
        { type: 'message', id: 'u3', message: { role: 'user', content: 'second' } },
        { type: 'message', id: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } },
      ]);
    });

    await session.sendMessage('first', undefined, 'corr', { content: 'first' });

    expect(memory.enqueueTurnCandidate).toHaveBeenCalledTimes(1);
    expect(memory.enqueueTurnCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ userText: 'first\n\nsecond', assistantText: 'reply' }),
    );
    await session.dispose();
  });

  describe('prompt index', () => {
    /** Send one prompt on a session whose branch is `branch`, committing it as `id` the way pi does. */
    async function sendOn(branch: readonly SessionEntry[], id: string) {
      const messages: ExtensionToWebviewMessage[] = [];
      const opts = makeOptions(messages);
      const memory = memorySpy();
      opts.memoryService = memory as never;
      const session = new PiSession(opts);
      await session.initializeEarly();
      forceAgentRun(session);
      const live = H.getLastSession()!;
      const getBranch = live.sessionManager.getBranch as ReturnType<typeof vi.fn<() => SessionEntry[]>>;
      getBranch.mockReturnValue([...branch]);
      let duringTurn: number | undefined;
      (live.prompt as ReturnType<typeof vi.fn>).mockImplementation(async (text: string, promptOpts: unknown) => {
        // What the gate hands `before_agent_start`, the permission turn key and the overlay record.
        duringTurn = session.currentPromptIndex;
        piRuns(promptOpts, getBranch, withPrompt([], id, text));
      });
      await session.sendMessage('next prompt', undefined, `corr-${id}`, { content: 'next prompt' });
      const stamped = messages.find((m): m is Extract<ExtensionToWebviewMessage, { type: 'userMessage' }> => m.type === 'userMessage');
      return { session, live, messages, memory, duringTurn, stamped: stamped?.promptIndex };
    }

    it('stamps a resumed conversation\'s next prompt with the index a reload gives it', async () => {
      const { session, memory, duringTurn, stamped } = await sendOn(STORED_CONVERSATION, 'u-new');
      expect(stamped).toBe(STORED_PROMPT_COUNT);
      expect(duringTurn).toBe(STORED_PROMPT_COUNT);
      expect(memory.enqueueTurnCandidate).toHaveBeenCalledWith(expect.objectContaining({ promptIndex: STORED_PROMPT_COUNT }));
      await session.dispose();
    });

    it('stamps a fork\'s resent prompt after the prompts the fork inherited', async () => {
      const { session, duringTurn, stamped } = await sendOn(FORK_AT_SECOND_PROMPT, 'u-fork');
      expect(stamped).toBe(FORK_PROMPT_COUNT);
      expect(duringTurn).toBe(FORK_PROMPT_COUNT);
      await session.dispose();
    });

    it('advances from the branch on the next send, and echoes a command that commits no prompt as injected', async () => {
      const { session, live, messages } = await sendOn(STORED_CONVERSATION, 'u-new');
      // A pi extension command (`/todos`) runs inside prompt() and commits no user entry.
      live.extensionRunner.getCommand.mockImplementation((name: string) => (name === 'todos' ? { invocationName: 'todos' } : undefined));
      const getBranch = live.sessionManager.getBranch as ReturnType<typeof vi.fn<() => SessionEntry[]>>;
      (live.prompt as ReturnType<typeof vi.fn>).mockImplementation(async (text: string) => {
        if (text !== '/todos') getBranch.mockReturnValue(withPrompt(getBranch(), 'u-after', text));
      });
      await session.sendMessage('/todos', undefined, 'corr-cmd', { content: '/todos' });
      await session.sendMessage('after the command', undefined, 'corr-after', { content: 'after the command' });
      const echoes = messages.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'userMessage' }> => m.type === 'userMessage');
      // The prompt rows carry distinct indices, and the command row is not a prompt, so none is shared.
      expect(echoes.map((m) => [m.promptIndex, m.isInjected === true, m.isCommandEcho === true])).toEqual([
        [STORED_PROMPT_COUNT, false, false],
        [STORED_PROMPT_COUNT, true, true],
        [STORED_PROMPT_COUNT + 1, false, false],
      ]);
      await session.dispose();
    });

    it('keys an injection that starts after the in-flight index was cleared to the prompt it precedes', async () => {
      // A steer resent by `resteerQueuedInputs` can find the run settled and start one of its own, so
      // `before_agent_start` fires with no `sendMessage` in flight.
      const { session, live } = await sendOn(STORED_CONVERSATION, 'u-new');
      const memory = {
        isEnabled: true,
        ensureInitialized: vi.fn(async () => {}),
        buildInjectionContext: vi.fn(async () => null),
        persistMemoryInjection: vi.fn(async () => {}),
      };
      const gate = (cwdFolder() as unknown as { _panelRegistry: Map<string, PanelGateContext> })._panelRegistry.get(live.sessionId as string)!;
      const emitted: ExtensionToWebviewMessage[] = [];
      const panel: PanelGateContext = { ...gate, memoryService: memory as never, postMessage: (m) => emitted.push(m) };
      const branch = (live.sessionManager.getBranch as () => SessionEntry[])();
      await buildAgentStartResult(
        { type: 'before_agent_start', prompt: 'steered', systemPrompt: '', systemPromptOptions: { selectedTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [], appendSystemPrompt: '', sections: {}, cwd: '/cwd', contextFiles: [], skills: [] } },
        panel,
        live.sessionId as string,
        { getBranch: () => branch, buildSessionProjection: () => ({ messages: [] }) } as unknown as ProjectionReader,
        () => true,
      );
      expect(session.currentPromptIndex).toBe(STORED_PROMPT_COUNT);
      expect(emitted).toContainEqual({ type: 'contextInjectionStarted', promptIndex: STORED_PROMPT_COUNT + 1 });
      expect(memory.buildInjectionContext).toHaveBeenCalledWith(expect.objectContaining({ promptIndex: STORED_PROMPT_COUNT + 1 }));
      await session.dispose();
    });

    it('reports the latest prompt on the branch between turns', async () => {
      const session = new PiSession(makeOptions([]));
      await session.initializeEarly();
      (H.getLastSession()!.sessionManager.getBranch as ReturnType<typeof vi.fn>).mockReturnValue([...STORED_CONVERSATION]);
      expect(session.currentPromptIndex).toBe(STORED_PROMPT_COUNT - 1);
      await session.dispose();
    });
  });

  it('requestContextUsage reports busy while a turn is processing (US-CMD)', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    let resolvePrompt: () => void = () => {};
    (live.prompt as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise<void>((r) => { resolvePrompt = () => r(); }));

    const turn = session.sendMessage('go', undefined, 'c1', { content: 'go' });
    while (!session.processing) await new Promise((r) => setTimeout(r, 0));
    await session.requestContextUsage();
    const busy = messages.find((m) => m.type === 'contextUsage' && m.reason === 'busy');
    expect(busy).toBeDefined();

    resolvePrompt();
    await turn;
    await session.dispose();
  });

  it('clear() emits sessionCleared on the fresh session and resets the turn (/clear)', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const first = H.getLastSession();

    session.clear();
    await session.whenReplaced();

    expect(H.getLastSession()).not.toBe(first);
    expect(session.processing).toBe(false);
    await session.dispose();
  });

  /**
   * pi's manual `compact()` reports every outcome twice: once on its own `compaction_end` event, which
   * the adapter translates, and once by rethrowing to the caller. These cases drive BOTH halves, so a
   * de-duplication that only looks at the rethrow cannot pass them. The old fakes rejected without
   * emitting `compaction_end`, which is a sequence pi never produces.
   */
  const compactFailing = (live: ReturnType<typeof H.getLastSession>, end: Record<string, unknown>, rethrow: Error): void => {
    (live!.compact as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      H.fireEvent({ type: 'compaction_start', reason: 'manual' });
      H.fireEvent({ type: 'compaction_end', reason: 'manual', result: undefined, willRetry: false, ...end });
      throw rethrow;
    });
  };

  const errorsOf = (messages: ExtensionToWebviewMessage[]): string[] =>
    messages.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'error' }> => m.type === 'error').map((m) => m.message);

  it('compact() surfaces a "nothing to compact" refusal as a friendly info notice in the UI language, not an error', async () => {
    const greek = elBundle as Record<string, string>;
    const t = vi.spyOn(testPlatform.localization, 't').mockImplementation((message) => greek[message] ?? message);
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    compactFailing(
      H.getLastSession(),
      { aborted: false, errorMessage: 'Compaction failed: Nothing to compact (session too small)' },
      new Error('Nothing to compact (session too small)'),
    );

    try {
      await session.compact();
    } finally {
      t.mockRestore();
    }

    // The adapter deliberately reports nothing for this one, so `compact()` is still its only owner.
    expect(errorsOf(messages)).toEqual([]);
    const notice = messages.find((m): m is Extract<ExtensionToWebviewMessage, { type: 'notification' }> => m.type === 'notification');
    expect(notice?.notificationType).toBe('info');
    expect(greek['The conversation is too short to compact yet.']).toBeDefined();
    expect(notice?.message).toBe(greek['The conversation is too short to compact yet.']);
    expect(notice?.message).not.toMatch(/[—:]/);
    await session.dispose();
  });

  it('compact() while a compaction runs refuses with a warning in the UI language', async () => {
    const greek = elBundle as Record<string, string>;
    const t = vi.spyOn(testPlatform.localization, 't').mockImplementation((message) => greek[message] ?? message);
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    let finish!: () => void;
    (H.getLastSession()!.compact as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));

    let running: Promise<void> | undefined;
    try {
      running = session.compact();
      await session.compact();
    } finally {
      t.mockRestore();
    }

    const notice = messages.find((m): m is Extract<ExtensionToWebviewMessage, { type: 'notification' }> => m.type === 'notification');
    expect(notice?.notificationType).toBe('warning');
    expect(greek['Finish or stop the current turn before compacting.']).toBeDefined();
    expect(notice?.message).toBe(greek['Finish or stop the current turn before compacting.']);
    await vi.waitFor(() => expect(finish).toBeDefined());
    finish();
    await running;
    await session.dispose();
  });

  it('compact() leaves a user-stopped compaction to the single compactionAborted card', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    compactFailing(H.getLastSession(), { aborted: true }, new Error('Compaction cancelled'));

    await session.compact();

    expect(messages.filter((m) => m.type === 'compactionAborted')).toHaveLength(1);
    expect(errorsOf(messages)).toEqual([]);
    expect(messages.some((m) => m.type === 'notification')).toBe(false);
    await session.dispose();
  });

  it('compact() reads pi\'s own event, not the rethrown error shape, to know the abort was reported', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    // pi rethrows the original error, whose name and text vary with what raised it. Nothing here
    // matches either, so a de-duplication built on the error shape would print a second card.
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    compactFailing(H.getLastSession(), { aborted: true }, abortError);

    await session.compact();

    expect(messages.filter((m) => m.type === 'compactionAborted')).toHaveLength(1);
    expect(errorsOf(messages)).toEqual([]);
    await session.dispose();
  });

  it('compact() surfaces a genuine compaction failure as exactly one red error', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    // pi prefixes its event message and rethrows the bare one, so the two cards never look alike.
    compactFailing(
      H.getLastSession(),
      { aborted: false, errorMessage: 'Compaction failed: Request failed: 500' },
      new Error('Request failed: 500'),
    );

    await session.compact();

    expect(errorsOf(messages)).toEqual(['Compaction failed: Request failed: 500']);
    expect(messages.some((m) => m.type === 'notification' && m.notificationType === 'info')).toBe(false);
    await session.dispose();
  });

  it('rewindFiles(compactionId, fork-conversation) branches at the compaction parent with no prompt (US-002)', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const onSpawnFork = vi.fn<(args: ForkSpawnArgs) => Promise<void>>(async () => undefined);
    const session = new PiSession({ ...makeOptions(messages), onSpawnFork });
    await session.initializeEarly();
    const live = H.getLastSession()!;
    // The compaction entry is an ordinary tree node; its parent is the last pre-compaction message.
    (live.sessionManager.getEntry as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === 'comp1' ? { id: 'comp1', parentId: 'a1', type: 'compaction' } : undefined,
    );

    await session.rewindFiles('comp1', 'fork-conversation');

    expect(messages.some((m) => m.type === 'rewindError')).toBe(false);
    expect(onSpawnFork).toHaveBeenCalledTimes(1);
    const args = onSpawnFork.mock.calls[0]![0];
    expect(args.forkAtUuid).toBe('a1');
    expect(args.promptContent).toBeUndefined();
    await session.dispose();
  });

  it('rewindFiles fails soft when the anchor cannot be resolved (US-002 FR-7)', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const onSpawnFork = vi.fn<(args: ForkSpawnArgs) => Promise<void>>(async () => undefined);
    const session = new PiSession({ ...makeOptions(messages), onSpawnFork });
    await session.initializeEarly();
    const live = H.getLastSession()!;
    (live.sessionManager.getEntry as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    await session.rewindFiles('does-not-exist', 'fork-conversation');

    expect(onSpawnFork).not.toHaveBeenCalled();
    expect(messages.some((m) => m.type === 'rewindError')).toBe(true);
    await session.dispose();
  });

  it('rewindFiles forks the very first message (parentId null) through to spawnPiFork (US-002 H1)', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const onSpawnFork = vi.fn<(args: ForkSpawnArgs) => Promise<void>>(async () => undefined);
    const session = new PiSession({ ...makeOptions(messages), onSpawnFork });
    await session.initializeEarly();
    const live = H.getLastSession()!;
    // The first entry in a session has parentId: null — forking it means "fork from before the first
    // message". This must NOT be rejected; it flows through as forkAtUuid: null (fresh panel).
    (live.sessionManager.getEntry as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === 'u1' ? { id: 'u1', parentId: null, type: 'message' } : undefined,
    );

    await session.rewindFiles('u1', 'fork-conversation');

    expect(messages.some((m) => m.type === 'rewindError')).toBe(false);
    expect(onSpawnFork).toHaveBeenCalledTimes(1);
    const args = onSpawnFork.mock.calls[0]![0];
    expect(args.forkAtUuid).toBeNull();
    await session.dispose();
  });

  it('forks a first message whose parent is metadata WITHOUT a branched session id (no replay of an unwritten file)', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const onSpawnFork = vi.fn<(args: ForkSpawnArgs) => Promise<void>>(async () => undefined);
    const session = new PiSession({ ...makeOptions(messages), onSpawnFork });
    await session.initializeEarly();
    const live = H.getLastSession()!;
    // The first USER message's parent is a metadata entry (thinking_level_change), so parentId is
    // non-null — but the root→parent branch has NO assistant message. pi defers writing such a branched
    // file to disk, so we must NOT resume it (that would 404). The fork must proceed as a fresh panel.
    (live.sessionManager.getEntry as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === 'u1' ? { id: 'u1', parentId: 'meta1', type: 'message' } : undefined,
    );
    (live.sessionManager.getSessionFile as ReturnType<typeof vi.fn>).mockReturnValue('/fake/agent/sessions/cwd/src.jsonl');
    (live.sessionManager.getBranch as ReturnType<typeof vi.fn>).mockImplementation((fromId?: string) =>
      fromId === 'meta1'
        ? [
            { type: 'session', id: 'sess' },
            { type: 'model_change', id: 'mc1', parentId: 'sess' },
            { type: 'thinking_level_change', id: 'meta1', parentId: 'mc1' },
          ]
        : [],
    );

    await session.rewindFiles('u1', 'fork-conversation', 'what is the day');

    expect(messages.some((m) => m.type === 'rewindError')).toBe(false);
    expect(onSpawnFork).toHaveBeenCalledTimes(1);
    const args = onSpawnFork.mock.calls[0]![0];
    expect(args.forkAtUuid).toBe('meta1');
    // No branched session id → showForked won't try to replay a never-written file; the prompt prefills.
    expect(args.piBranchedSessionId).toBeUndefined();
    expect(args.promptContent).toBe('what is the day');
    await session.dispose();
  });

  it('rewindFiles(compactionId, code-only) restores the snapshot via a compaction-keyed checkpoint (Slice 2)', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    // A damocles-checkpoint whose userEntryId IS a compaction entry id — structurally identical to a
    // prompt-keyed checkpoint; only the userEntryId happens to reference a compaction entry.
    (live.sessionManager.getBranch as ReturnType<typeof vi.fn>).mockReturnValue([
      { type: 'custom', customType: 'damocles-checkpoint', data: {
        v: 2, kind: 'checkpoint', turnId: 'turn-comp', userEntryId: 'comp1',
        beforeCommit: 'snap-commit', afterCommit: 'snap-commit', prompt: '', fileCount: 1,
        fileChanges: [{ path: 'a.ts', added: 1, removed: 0 }], createdAt: new Date().toISOString(),
      } },
    ]);
    const restore = vi.fn(async (_entry: unknown, _sm: unknown, _signal: AbortSignal) => ({ ok: true as const }));
    const cpSvc = (session as unknown as { checkpointService: { restore: typeof restore } }).checkpointService;
    vi.spyOn(cpSvc, 'restore').mockImplementation(restore);

    await session.rewindFiles('comp1', 'code-only');

    expect(restore).toHaveBeenCalledWith(expect.objectContaining({ userEntryId: 'comp1', beforeCommit: 'snap-commit' }), expect.anything(), expect.any(AbortSignal));
    expect(messages.some((m) => m.type === 'rewindComplete')).toBe(true);
    expect(messages.some((m) => m.type === 'rewindError')).toBe(false);
    await session.dispose();
  });

  it('rewindFiles(compactionId, fork-and-rewind-code) restores the snapshot AND spawns the fork (Slice 2)', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const onSpawnFork = vi.fn<(args: ForkSpawnArgs) => Promise<void>>(async () => undefined);
    const session = new PiSession({ ...makeOptions(messages), onSpawnFork });
    await session.initializeEarly();
    const live = H.getLastSession()!;
    (live.sessionManager.getBranch as ReturnType<typeof vi.fn>).mockReturnValue([
      { type: 'custom', customType: 'damocles-checkpoint', data: {
        v: 2, kind: 'checkpoint', turnId: 'turn-comp', userEntryId: 'comp1',
        beforeCommit: 'snap-commit', afterCommit: 'snap-commit', prompt: '', fileCount: 1,
        fileChanges: [{ path: 'a.ts', added: 1, removed: 0 }], createdAt: new Date().toISOString(),
      } },
    ]);
    // The compaction entry is an ordinary tree node; its parent is the last pre-compaction message.
    (live.sessionManager.getEntry as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === 'comp1' ? { id: 'comp1', parentId: 'a1', type: 'compaction' } : undefined,
    );
    const restore = vi.fn(async (_entry: unknown, _sm: unknown, _signal: AbortSignal) => ({ ok: true as const }));
    const cpSvc = (session as unknown as { checkpointService: { restore: typeof restore } }).checkpointService;
    vi.spyOn(cpSvc, 'restore').mockImplementation(restore);

    await session.rewindFiles('comp1', 'fork-and-rewind-code');

    expect(restore).toHaveBeenCalledWith(expect.objectContaining({ userEntryId: 'comp1', beforeCommit: 'snap-commit' }), expect.anything(), expect.any(AbortSignal));
    expect(messages.some((m) => m.type === 'rewindError')).toBe(false);
    expect(onSpawnFork).toHaveBeenCalledTimes(1);
    const args = onSpawnFork.mock.calls[0]![0];
    expect(args.forkAtUuid).toBe('a1');
    await session.dispose();
  });

  it('rewindFiles(compactionId, code-only) with NO checkpoint fails soft (guards a webview gating bug)', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    // The branch holds no damocles-checkpoint for this compaction id (legacy session, or the picker
    // gating let a checkpoint-less anchor through). File rewind must refuse rather than run git.
    (live.sessionManager.getBranch as ReturnType<typeof vi.fn>).mockReturnValue([]);

    await session.rewindFiles('comp1', 'code-only');

    expect(messages.some((m) => m.type === 'rewindError' && m.message === 'No checkpoint exists for this message')).toBe(true);
    expect(messages.some((m) => m.type === 'rewindComplete')).toBe(false);
    await session.dispose();
  });

  /** A live session whose branch holds one v3 checkpoint for u1, and whose file holds `records`. */
  async function sessionWithCheckpoint(messages: ExtensionToWebviewMessage[], records: unknown[] = []) {
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const checkpoint = { type: 'custom', customType: 'damocles-checkpoint', data: {
      v: 2, kind: 'checkpoint', turnId: 't1', userEntryId: 'u1', beforeCommit: 'b'.repeat(40), afterCommit: 'b'.repeat(40),
      prompt: 'p', fileCount: 0, fileChanges: [], createdAt: new Date().toISOString(),
    } };
    const entries = [checkpoint, ...records.map((data) => ({ type: 'custom', customType: 'damocles-checkpoint', data }))];
    (live.sessionManager.getBranch as ReturnType<typeof vi.fn>).mockReturnValue(entries);
    (live.sessionManager.getEntries as ReturnType<typeof vi.fn>).mockReturnValue(entries);
    const service = (session as unknown as { checkpointService: CheckpointService | null }).checkpointService!;
    return { session, service };
  }

  const rewindErrors = (messages: ExtensionToWebviewMessage[]) =>
    messages.flatMap((m) => (m.type === 'rewindError' ? [m.message] : []));

  it('tells a missing checkpoint service apart from missing git', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const { session, service } = await sessionWithCheckpoint(messages);
    vi.spyOn(service, 'restore').mockResolvedValueOnce({ ok: false, reason: 'git-unavailable', error: 'spawn git ENOENT', preRewind: null });
    await session.rewindFiles('u1', 'code-only');
    (session as unknown as { checkpointService: CheckpointService | null }).checkpointService = null;
    await session.rewindFiles('u1', 'code-only');
    expect(rewindErrors(messages)).toEqual([
      'File rewind is unavailable because git was not found.',
      'File rewind is unavailable because checkpoints are not active for this conversation in this panel.',
    ]);
    await session.dispose();
  });

  it('says the folder may be partly restored and the pre-rewind state is kept when the rollback fails too', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const { session, service } = await sessionWithCheckpoint(messages);
    vi.spyOn(service, 'restore').mockResolvedValueOnce({
      ok: false, reason: 'checkout-failed', error: 'read-tree failed', rollbackError: 'clean failed',
      preRewind: { v: 3, kind: 'pre-rewind', id: 'rw1', folderId: '0123456789abcdef', commit: 'c'.repeat(40),
        skipped: { totalCount: 0, totalBytes: 0, byReason: {}, patterns: [], manifest: null }, target: { kind: 'turn', userEntryId: 'u1' }, createdAt: '' },
    });
    await session.rewindFiles('u1', 'code-only');
    const [message] = rewindErrors(messages);
    expect(message).toContain('the folder may be partly restored');
    expect(message).toContain('Your files from before the rewind are kept');
    expect(message).toContain('Restore error: read-tree failed. Rollback error: clean failed');
    expect(messages.some((m) => m.type === 'rewindComplete')).toBe(false);
    await session.dispose();
  });

  it('reports each restore that changed nothing in its own words, and a not-rewindable turn by its reason', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const { session, service } = await sessionWithCheckpoint(messages, [
      { v: 3, kind: 'not-rewindable', userEntryId: 'u9', reason: 'baseline-timeout', params: { tool: 'Edit', waitSeconds: 30 }, createdAt: '' },
    ]);
    const restore = vi.spyOn(service, 'restore');
    restore.mockResolvedValueOnce({ ok: false, reason: 'aborted', preRewind: null });
    restore.mockResolvedValueOnce({ ok: false, reason: 'snapshot-failed', error: 'disk full', preRewind: null });
    await session.rewindFiles('u1', 'code-only');
    await session.rewindFiles('u1', 'code-only');
    await session.rewindFiles('u9', 'code-only');
    expect(rewindErrors(messages)).toEqual([
      'Checkpoint work in this folder is still running, so no files were changed. Try again in a moment.',
      'No files were changed: the current files could not be saved before the restore (disk full).',
      'This turn cannot be rewound: a file-changing tool ran before its checkpoint was ready.',
    ]);
    await session.dispose();
  });

  it('undoes a rewind from its restore point, files only, and refuses an unknown one', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const record = { v: 3, kind: 'pre-rewind', id: 'rw1', folderId: '0123456789abcdef', commit: 'c'.repeat(40),
      skipped: { totalCount: 0, totalBytes: 0, byReason: {}, patterns: [], manifest: null }, target: { kind: 'turn', userEntryId: 'u1' },
      createdAt: '2026-01-01T00:00:00.000Z' };
    const { session, service } = await sessionWithCheckpoint(messages, [record]);
    const undo = vi.spyOn(service, 'restorePreRewind').mockResolvedValue({ ok: true, preRewind: { ...record, id: 'rw2', target: { kind: 'undo', preRewindId: 'rw1' } } as never });
    await session.undoRewind('rw1');
    expect(undo).toHaveBeenCalledWith(expect.objectContaining({ id: 'rw1', commit: 'c'.repeat(40) }), expect.anything(), expect.any(AbortSignal));
    expect(messages.filter((m) => m.type === 'rewindUndone')).toHaveLength(1);

    await session.undoRewind('rw-gone');
    expect(undo).toHaveBeenCalledTimes(1);
    expect(rewindErrors(messages)).toEqual(['This restore point no longer exists.']);
    await session.dispose();
  });
});

describe('PiSession MCP scope feed', () => {
  const SCOPE_X = { userUnion: { ux: specOf({ command: 'ux' }) }, userVisible: ['ux'], folder: { fx: specOf({ command: 'fx' }) } };
  const SCOPE_Y = { userUnion: { uy: specOf({ command: 'uy' }) }, userVisible: [], folder: { fy: specOf({ command: 'fy' }) } };
  const spies: Array<{ mockRestore(): void }> = [];

  beforeEach(() => {
    H.seq.length = 0;
    H.captured.services.length = 0;
    H.resetServices();
  });
  afterEach(async () => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    await PiRuntime.disposeInstance();
  });

  /** Record both reconciles without connecting anything. */
  async function spyManagers() {
    const runtime = PiRuntime.get('/fake/agent');
    await runtime.init();
    const user = vi.spyOn(runtime.getUserMcp()!, 'reconcile').mockResolvedValue();
    const folder = vi.spyOn(FolderRuntime.prototype, 'reconcileFolder').mockResolvedValue();
    spies.push(user, folder);
    return { runtime, user, folder };
  }

  it('a scope set while start() waits on its folder runtime reaches both managers once the session binds', async () => {
    const { runtime, user, folder } = await spyManagers();
    let open!: () => void;
    const held = new Promise<void>((resolve) => { open = resolve; });
    const folderOf = runtime.folder.bind(runtime);
    spies.push(vi.spyOn(runtime, 'folder').mockImplementationOnce(async (cwd) => {
      await held;
      return folderOf(cwd);
    }));
    const session = new PiSession(makeOptions([]));

    const starting = session.initializeEarly();
    session.setMcpServers(SCOPE_X);
    expect(user).not.toHaveBeenCalled();
    expect(folder).not.toHaveBeenCalled();
    open();
    await starting;

    expect(user).toHaveBeenLastCalledWith(SCOPE_X.userUnion);
    expect(folder).toHaveBeenLastCalledWith(SCOPE_X.folder, SCOPE_X.userVisible);
  });

  // Both reconciles are stubbed, so no tools-changed event fires, as for servers already connected under an unchanged scope.
  it('publishes the MCP status once the session binds to its folder, after applying its scope', async () => {
    const { folder } = await spyManagers();
    const session = new PiSession(makeOptions([], { mcpScope: SCOPE_X }));
    const status = vi.fn();
    session.setMcpStatusListener(status);

    await session.initializeEarly();

    expect(status).toHaveBeenCalledTimes(1);
    expect(folder.mock.invocationCallOrder[0]).toBeLessThan(status.mock.invocationCallOrder[0]!);
  });

  it.each(['reset', 'clear'] as const)('a replacement session after %s re-applies the latest scope, not the creation-time one', async (replace) => {
    const { user, folder } = await spyManagers();
    const session = new PiSession(makeOptions([], { mcpScope: SCOPE_X }));
    await session.initializeEarly();
    session.setMcpServers(SCOPE_Y);
    const firstSession = H.getLastSession();
    user.mockClear();
    folder.mockClear();

    session[replace]();
    await vi.waitFor(() => expect(H.getLastSession()).not.toBe(firstSession));
    await vi.waitFor(() => expect(user).toHaveBeenCalled());

    expect(user).toHaveBeenLastCalledWith(SCOPE_Y.userUnion);
    expect(folder).toHaveBeenLastCalledWith(SCOPE_Y.folder, SCOPE_Y.userVisible);
  });

  it("sends the user part to the process-wide manager and the folder part to the session's folder", async () => {
    const { user, folder } = await spyManagers();
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();

    session.setMcpServers(SCOPE_X);

    expect(user.mock.calls).toEqual([[SCOPE_X.userUnion]]);
    expect(folder.mock.calls).toEqual([[SCOPE_X.folder, SCOPE_X.userVisible]]);
    expect(folder.mock.contexts[0]).toBe(cwdFolder());
  });
});

describe("PiSession's ToolSearch snapshot reads its own folder's MCP", () => {
  beforeEach(() => {
    H.seq.length = 0;
    H.captured.services.length = 0;
    H.resetServices();
  });
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  it("folder B's panel offers and resolves beta and the shared user server, never folder A's alpha", async () => {
    const tools = { alpha: [{ name: 'a_run' }], beta: [{ name: 'b_run' }], shared: [{ name: 'ping' }] };
    const user = managerWithFake(tools);
    const folderA = managerWithFake(tools);
    const folderB = managerWithFake(tools);
    const viewA = new FolderMcpView(user.manager, folderA.manager);
    const viewB = new FolderMcpView(user.manager, folderB.manager);
    try {
      await user.manager.reconcile({ shared: specOf({ command: 'shared' }) });
      viewA.setUserVisible(['shared']);
      viewB.setUserVisible(['shared']);
      await folderA.manager.reconcile({ alpha: specOf({ command: 'alpha' }) });
      await folderB.manager.reconcile({ beta: specOf({ command: 'beta' }) });
      const a = new PiSession(makeOptions([]));
      const b = new PiSession(makeOptions([], { cwd: '/b' }));
      await a.initializeEarly();
      await b.initializeEarly();
      const folderOf = (cwd: string) => PiRuntime.get('/fake/agent').folders().find((folder) => folder.cwd === cwd)!;
      vi.spyOn(folderOf('/cwd'), 'mcp', 'get').mockReturnValue(viewA);
      vi.spyOn(folderOf('/b'), 'mcp', 'get').mockReturnValue(viewB);
      type Gate = { deferrableTools(): DeferrableSnapshot; activateDeferredTools(names: string[]): void };
      const gateOf = (cwd: string, session: PiSession): Gate =>
        (folderOf(cwd) as unknown as { _panelRegistryReader(): { get(id: string): Gate | undefined } })
          ._panelRegistryReader().get(session.currentSessionId!)!;

      const gateB = gateOf('/b', b);
      const snapB = gateB.deferrableTools();
      expect(snapB.names).toEqual(expect.arrayContaining(['mcp__beta__b_run', 'mcp__shared__ping']));
      expect(snapB.names.filter((name) => name.includes('alpha'))).toEqual([]);
      expect([...snapB.mcpGroups.keys()].sort()).toEqual(['beta', 'shared']);
      expect([...(snapB.mcpDescriptions?.keys() ?? [])].sort()).toEqual(['mcp__beta__b_run', 'mcp__shared__ping']);
      expect([...gateOf('/cwd', a).deferrableTools().mcpGroups.keys()].sort()).toEqual(['alpha', 'shared']);

      // Wired the way the folder's Damocles extension wires ToolSearch to a registered panel.
      const tool = createToolSearchTool({
        deferrable: () => gateB.deferrableTools(),
        activate: (_id, names) => gateB.activateDeferredTools(names),
        inventory: () => ({ names: snapB.names, ...(snapB.mcpDescriptions ? { mcpDescriptions: snapB.mcpDescriptions } : {}) }),
      });
      expect(tool.description).toContain('mcp__beta__b_run');
      expect(tool.description).not.toContain('alpha');
      const ctx = { sessionManager: { getSessionId: () => b.currentSessionId } } as never;
      const result = (await tool.execute('tc-1', { tools: ['mcp__alpha__a_run', 'alpha'] }, undefined, undefined, ctx)) as unknown as { details?: ToolSearchDetails };
      expect(result.details?.matches ?? []).toEqual([]);
    } finally {
      viewA.dispose();
      viewB.dispose();
      await Promise.all([user.manager.dispose(), folderA.manager.dispose(), folderB.manager.dispose()]);
    }
  });

  it("a session writes under its panel's raw folder path, not the folder key", async () => {
    const raw = 'C:\\Work\\MyRepo';
    const session = new PiSession(makeOptions([], { cwd: raw }));
    await session.initializeEarly();

    const [folder] = PiRuntime.get('/fake/agent').folders();
    expect(folder!.key).not.toBe(raw);
    expect(H.fakePi.SessionManager.create).toHaveBeenLastCalledWith(raw, `/fake/agent/sessions/${raw}`);
    expect(H.fakePi.createAgentSessionRuntime.mock.lastCall![1]).toMatchObject({ cwd: raw });
  });
});

describe('PiSession runtime registration with two panels on one session id', () => {
  beforeEach(() => {
    H.seq.length = 0;
    H.captured.services.length = 0;
    H.resetServices();
  });
  afterEach(async () => {
    H.setSessionSetup(null);
    await PiRuntime.disposeInstance();
  });

  it("the older panel disposing after the newer one registered leaves the newer panel's gate, checkpoints, mutator and refresher", async () => {
    // Both panels resume one file, so pi hands both the header's session id.
    H.setSessionSetup((s) => { (s as unknown as { sessionId: string }).sessionId = 'sess-shared'; });
    const older = new PiSession(makeOptions([]));
    await older.initializeEarly();
    const newerOptions = makeOptions([]);
    const newer = new PiSession(newerOptions);
    await newer.initializeEarly();

    await older.dispose();

    const runtime = PiRuntime.get('/fake/agent');
    const folder = cwdFolder() as unknown as {
      _panelRegistryReader(): { get(id: string): { permissionHandler: unknown } | undefined };
      _checkpointRegistryReader(): { get(id: string): unknown };
      _activeToolRefreshers: Map<string, () => void>;
    };
    // The reader is the one the folder extension's tool_call handler routes through.
    expect(folder._panelRegistryReader().get('sess-shared')?.permissionHandler).toBe(newerOptions.permissionHandler);
    expect(folder._checkpointRegistryReader().get('sess-shared')).toBe((newer as unknown as { checkpointService: unknown }).checkpointService);
    expect(runtime.getSessionMutator('sess-shared')).toBe(newer);
    expect(folder._activeToolRefreshers.has('sess-shared')).toBe(true);

    await newer.dispose();
    expect(folder._panelRegistryReader().get('sess-shared')).toBeUndefined();
    expect(runtime.getSessionMutator('sess-shared')).toBeUndefined();
  });

  describe('dispose while start() is still running', () => {
    function gate(): { wait: Promise<void>; open: () => void } {
      let open!: () => void;
      const wait = new Promise<void>((resolve) => { open = resolve; });
      return { wait, open };
    }

    /** What a late start would leave behind: a bound runtime, a registration, an announced session id. */
    function leftovers(session: PiSession, sessionIds: string[]) {
      const folder = cwdFolder() as unknown as { _panelRegistry: Map<string, unknown> } | undefined;
      return {
        runtime: (session as unknown as { runtime: unknown }).runtime,
        panels: folder?._panelRegistry.size ?? 0,
        announced: sessionIds,
        currentSessionId: session.currentSessionId,
      };
    }

    it('a start held on its folder runtime binds nothing once the session is disposed', async () => {
      const held = gate();
      const runtime = PiRuntime.get('/fake/agent');
      const folderOf = runtime.folder.bind(runtime);
      vi.spyOn(runtime, 'folder').mockImplementationOnce(async (cwd) => {
        await held.wait;
        return folderOf(cwd);
      });
      const sessionIds: string[] = [];
      const session = new PiSession(makeOptions([], { onSessionIdChange: (id) => void sessionIds.push(id ?? "") }));
      const runtimesBefore = H.fakePi.createAgentSessionRuntime.mock.calls.length;

      const starting = session.initializeEarly();
      await session.dispose();
      held.open();
      await starting;

      expect(H.fakePi.createAgentSessionRuntime.mock.calls.length).toBe(runtimesBefore);
      expect(leftovers(session, sessionIds)).toEqual({ runtime: null, panels: 0, announced: [], currentSessionId: null });
    });

    it('a runtime created after dispose is released and never bound, registered or announced', async () => {
      const held = gate();
      const create = H.fakePi.createAgentSessionRuntime;
      const createRuntime = create.getMockImplementation()!;
      let created: { disposed: boolean } | undefined;
      create.mockImplementationOnce(async (factory, opts) => {
        await held.wait;
        const made = await createRuntime(factory, opts);
        created = made as unknown as { disposed: boolean };
        return made;
      });
      const sessionIds: string[] = [];
      const session = new PiSession(makeOptions([], { onSessionIdChange: (id) => void sessionIds.push(id ?? "") }));

      const runtimesBefore = create.mock.calls.length;
      const starting = session.initializeEarly();
      await vi.waitFor(() => expect(create.mock.calls.length).toBe(runtimesBefore + 1));
      await session.dispose();
      held.open();
      await starting;

      expect(created?.disposed).toBe(true);
      expect(H.seq).not.toContain('subscribe');
      expect((PiRuntime.get('/fake/agent') as unknown as { _sessionMutators: Map<string, unknown> })._sessionMutators.size).toBe(0);
      expect(leftovers(session, sessionIds)).toEqual({ runtime: null, panels: 0, announced: [], currentSessionId: null });
    });

    it('a stale caller cannot restart a disposed session', async () => {
      const session = new PiSession(makeOptions([]));
      const runtimesBefore = H.fakePi.createAgentSessionRuntime.mock.calls.length;
      await session.dispose();

      await expect((session as unknown as { ensureStarted(): Promise<void> }).ensureStarted()).rejects.toThrow('PiSession: session was disposed');
      expect(H.fakePi.createAgentSessionRuntime.mock.calls.length).toBe(runtimesBefore);
    });
  });

  // The webview persists a conversation for restore only when told it is stored, and pi writes the file with the first prompt.
  it('announces a new conversation unstored, then stored once, at the end of a turn that wrote its file', async () => {
    const fs = await import('fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-stored-'));
    const file = path.join(dir, 'new.jsonl');
    const messages: ExtensionToWebviewMessage[] = [];
    const announced: Array<[string | null, boolean]> = [];
    const session = new PiSession(makeOptions(messages, { onSessionIdChange: (id, stored) => void announced.push([id, stored]) }));
    try {
      await session.initializeEarly();
      const live = H.getLastSession()!;
      (live.sessionManager.getSessionFile as ReturnType<typeof vi.fn>).mockReturnValue(file);
      expect(announced).toEqual([[live.sessionId, false]]);
      expect(session.hasSessionFile()).toBe(false);
      const storedPosts = () => messages.filter((m) => m.type === 'sessionStarted');

      await session.sendMessage('no reply', undefined, 'c1', { content: 'no reply' });
      expect(storedPosts()).toEqual([]);

      (live.prompt as ReturnType<typeof vi.fn>).mockImplementation(async () => { fs.writeFileSync(file, '{}\n'); });
      await session.sendMessage('first reply', undefined, 'c2', { content: 'first reply' });
      await session.sendMessage('second reply', undefined, 'c3', { content: 'second reply' });

      expect(session.hasSessionFile()).toBe(true);
      expect(storedPosts()).toEqual([{ type: 'sessionStarted', sessionId: live.sessionId, stored: true }]);
    } finally {
      await session.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('announces a new conversation stored once pi commits its first prompt, before the turn ends', async () => {
    const fs = await import('fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-stored-'));
    const file = path.join(dir, 'new.jsonl');
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    try {
      await session.initializeEarly();
      const live = H.getLastSession()!;
      (live.sessionManager.getSessionFile as ReturnType<typeof vi.fn>).mockReturnValue(file);
      const getBranch = live.sessionManager.getBranch as ReturnType<typeof vi.fn>;
      getBranch.mockReturnValue([]);
      let duringTurn: ExtensionToWebviewMessage[] = [];
      (live.prompt as ReturnType<typeof vi.fn>).mockImplementation(async (_text: string, opts: unknown) => {
        fs.writeFileSync(file, '{}\n');
        piRuns(opts, getBranch, [{ type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'first prompt' }] } }]);
        await new Promise((r) => setTimeout(r, 0));
        duringTurn = messages.filter((m) => m.type === 'sessionStarted');
      });

      await session.sendMessage('first prompt', undefined, 'c1', { content: 'first prompt' });

      expect(duringTurn).toEqual([{ type: 'sessionStarted', sessionId: live.sessionId, stored: true }]);
      expect(messages.filter((m) => m.type === 'sessionStarted')).toHaveLength(1);
    } finally {
      await session.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hasConversation is true only for a pending resume or fork, a running turn, or a session with messages', async () => {
    // The panel asks before replacing the session on a folder switch, so a false positive nags and a
    // false negative discards a conversation without asking.
    const fresh = new PiSession(makeOptions([]));
    expect(fresh.hasConversation()).toBe(false);
    await fresh.initializeEarly();
    expect(fresh.hasConversation()).toBe(false);
    (H.getLastSession() as unknown as { messages: unknown[] }).messages.push({ role: 'user', content: 'hi' });
    expect(fresh.hasConversation()).toBe(true);
    await fresh.dispose();

    const resuming = new PiSession(makeOptions([]));
    resuming.setResumeSession('sess-stored');
    expect(resuming.hasConversation()).toBe(true);
    await resuming.dispose();

    const forked = new PiSession(makeOptions([], { forkContext: { piBranchedSessionId: 'sess-branch' } as NonNullable<SessionOptions['forkContext']> }));
    expect(forked.hasConversation()).toBe(true);
    await forked.dispose();

    const running = new PiSession(makeOptions([]));
    (running as unknown as { processingFlag: boolean }).processingFlag = true;
    expect(running.hasConversation()).toBe(true);
    await running.dispose();
  });

  it('holdsSession names the target of a resume switch before the switch lands', async () => {
    // Another panel's claim check runs in this window, while currentSessionId still reports the old session.
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const before = session.currentSessionId!;

    session.setResumeSession('sess-target');

    expect(session.currentSessionId).toBe(before);
    expect(session.holdsSession('sess-target')).toBe(true);
    expect(session.holdsSession(before)).toBe(true);
    expect(session.holdsSession('sess-unrelated')).toBe(false);
    await session.whenReplaced();
    await session.dispose();
  });
});

describe('PiSession plan-mode force-continue (WI-3)', () => {
  beforeEach(() => {
    H.seq.length = 0;
    H.captured.services.length = 0;
    H.resetServices();
  });
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  type SettleEvt = { type: 'agent_before_settle'; entries: unknown[]; continue: boolean; context: { contextMessages: unknown[] } };
  const userMsg = (): unknown => ({ role: 'user', content: [{ type: 'text', text: 'plan it' }] });
  /** The system prompt's plan-mode section, so the model under test already knows it is in plan mode. */
  const planSection = (): unknown => ({ role: 'system', content: '', sections: { damocles_plan_mode: 'Plan mode is active.' } });
  const assistant = (stopReason: string): unknown => ({ role: 'assistant', stopReason, content: [{ type: 'text', text: 'here is the plan' }] });
  const exitResult = (isError: boolean): unknown => ({ role: 'toolResult', toolName: 'ExitPlanMode', isError, toolCallId: 'tc1', content: [] });
  /** An already-injected nudge as the projection holds it: role 'custom', never role 'user'. */
  const nudgeMsg = (): unknown => ({ role: 'custom', customType: 'damocles-plan-mode-nudge', content: 'x', display: false });
  /** The boundary carries the session projection, so every turn under test opens with a user message. */
  const evt = (messages: unknown[]): SettleEvt =>
    ({ type: 'agent_before_settle', entries: [], continue: false, context: { contextMessages: [planSection(), userMsg(), ...messages] } });

  /** Drive the pre-settlement coordinator through the registered panel context (the real dispatch path). */
  async function fireBeforeSettle(event: SettleEvt): Promise<unknown> {
    const live = H.getLastSession()!;
    const panel = (cwdFolder() as unknown as {
      _panelRegistry: Map<string, { onBeforeSettle?: (e: SettleEvt) => Promise<unknown> }>;
    })._panelRegistry.get(live.sessionId as string)!;
    return panel.onBeforeSettle!(event);
  }

  const NUDGE = { type: 'custom_message', customType: 'damocles-plan-mode-nudge', display: false };

  it('plan mode + clean stop + no ExitPlanMode result ⇒ returns the hidden nudge draft', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    await session.setPermissionMode('plan');

    const draft = await fireBeforeSettle(evt([assistant('stop')]));

    expect(draft).toMatchObject(NUDGE);
    // The draft is committed by the boundary, so no follow-up is queued and nothing re-prompts.
    expect(H.getLastSession()!.sendCustomMessage).not.toHaveBeenCalled();
    await session.dispose();
  });

  it('plan mode + an APPROVED (non-error) ExitPlanMode result ⇒ no draft', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    await session.setPermissionMode('plan');

    expect(await fireBeforeSettle(evt([assistant('stop'), exitResult(false)]))).toBeUndefined();
    await session.dispose();
  });

  it('an approved ExitPlanMode in an EARLIER turn does not silence the nudge in this one', async () => {
    // The boundary event carries the whole session projection, not one turn's messages. Scanning all of
    // it would let a single approved exit disable the funnel for the rest of the session.
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    await session.setPermissionMode('plan');

    const priorTurn = [assistant('stop'), exitResult(false)];
    // The prompt after the approved exit re-entered plan mode, so pi patched the plan-mode section back in.
    const thisTurn = [planSection(), userMsg(), assistant('stop')];
    const draft = await fireBeforeSettle({
      type: 'agent_before_settle',
      entries: [],
      continue: false,
      context: { contextMessages: [planSection(), userMsg(), ...priorTurn, ...thisTurn] },
    });

    expect(draft).toMatchObject(NUDGE);
    await session.dispose();
  });

  it('plan mode + a REJECTED (isError) ExitPlanMode result + clean stop ⇒ nudge fires', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    await session.setPermissionMode('plan');

    expect(await fireBeforeSettle(evt([exitResult(true), assistant('stop')]))).toMatchObject(NUDGE);
    await session.dispose();
  });

  it('plan mode + clean stop + a queued user message ⇒ no draft', async () => {
    // The nudge would be appended immediately ahead of the user's own message, so the model would read
    // "call ExitPlanMode now" just before a human instruction that may want something else.
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    await session.setPermissionMode('plan');
    H.getLastSession()!.agent.peekQueuedMessages = () => [{ role: 'user', content: 'actually, do X first' }];

    expect(await fireBeforeSettle(evt([assistant('stop')]))).toBeUndefined();
    await session.dispose();
  });

  it('not in plan mode ⇒ no draft', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    // default mode (never entered plan)

    expect(await fireBeforeSettle(evt([assistant('stop')]))).toBeUndefined();
    await session.dispose();
  });

  // `'pending'` is pi's initial value for a streaming assistant message, resolved before the settle.
  // The hold gates on an allowlist (`=== 'stop'`), so an unresolved reason cannot nudge — pinned here so
  // the allowlist is stated rather than assumed by whoever reads the guard next.
  it.each(['error', 'aborted', 'length', 'pending'])('plan mode + last-assistant stopReason %s ⇒ no draft', async (reason) => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    await session.setPermissionMode('plan');

    expect(await fireBeforeSettle(evt([assistant(reason)]))).toBeUndefined();
    await session.dispose();
  });

  it('_aborting === true ⇒ no draft', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    await session.setPermissionMode('plan');
    (session as unknown as { _aborting: boolean })._aborting = true;

    expect(await fireBeforeSettle(evt([assistant('stop')]))).toBeUndefined();
    await session.dispose();
  });

  it('the first nudge of a turn carries the BASE text', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    await session.setPermissionMode('plan');

    const draft = (await fireBeforeSettle(evt([assistant('stop')]))) as { content: string };

    expect(draft.content).toBe(PLAN_MODE_NUDGE_TEXT);
    await session.dispose();
  });

  it('a turn that already nudged gets the ESCALATED text on the next one', async () => {
    // The "Holding." loop: the model answers in prose, the funnel re-fires, and repeating the base text
    // never changes the answer. The escalation is the only convergence pressure, since the funnel is
    // deliberately uncapped and pi 0.87.0 offers no way to force a tool call at the provider.
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    await session.setPermissionMode('plan');

    const draft = (await fireBeforeSettle(evt([assistant('stop'), nudgeMsg(), assistant('stop')]))) as { content: string };

    expect(draft.content).toBe(PLAN_MODE_NUDGE_ESCALATED_TEXT);
    await session.dispose();
  });

  it('a turn that already nudged several times still gets a draft', async () => {
    // The funnel has no retry cap by design: leaving plan mode is the user's decision, so the nudge
    // count picks the text and never decides whether a nudge goes out.
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    await session.setPermissionMode('plan');

    const looped = [assistant('stop'), nudgeMsg(), assistant('stop'), nudgeMsg(), assistant('stop'), nudgeMsg(), assistant('stop')];
    const draft = (await fireBeforeSettle(evt(looped))) as { content: string };

    expect(draft).toMatchObject(NUDGE);
    expect(draft.content).toBe(PLAN_MODE_NUDGE_ESCALATED_TEXT);
    await session.dispose();
  });

  it('a new turn after a nudged turn starts again at the BASE text', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    await session.setPermissionMode('plan');

    const priorTurn = [assistant('stop'), nudgeMsg(), assistant('stop')];
    const draft = (await fireBeforeSettle({
      type: 'agent_before_settle',
      entries: [],
      continue: false,
      context: { contextMessages: [planSection(), userMsg(), ...priorTurn, userMsg(), assistant('stop')] },
    })) as { content: string };

    expect(draft.content).toBe(PLAN_MODE_NUDGE_TEXT);
    await session.dispose();
  });

  it('plan mode + clean stop where the last assistant is a prose question (no ExitPlanMode) ⇒ nudge fires', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    await session.setPermissionMode('plan');

    // A prose "what should I do?" stop is still a clean stop with no ExitPlanMode — intended: redirect
    // the model to AskUserQuestion via the nudge rather than letting it stall on an unanswerable prose Q.
    const proseQuestion = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Which database should I use?' }] };

    expect(await fireBeforeSettle(evt([proseQuestion]))).toMatchObject(NUDGE);
    await session.dispose();
  });

  it('a model never told that plan mode started gets the plan-mode change notice instead of the nudge', async () => {
    // The user switched into plan mode during the run's last step, so no later step carried the notice.
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    await session.setPermissionMode('plan');

    const draft = await fireBeforeSettle({
      type: 'agent_before_settle',
      entries: [],
      continue: false,
      context: { contextMessages: [userMsg(), assistant('stop')] },
    });

    expect(draft).toMatchObject({ type: 'custom_message', customType: 'damocles-plan-mode-change', display: false, details: { planMode: true } });
    expect((draft as { content: string }).content).toMatch(/^The user switched this chat to plan mode. /);
    await session.dispose();
  });

  it('background injected+held this cycle ⇒ plan-mode hold not also invoked (coordinator early-return)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    await session.setPermissionMode('plan');

    // Stub the subagent manager to report background work to deliver, so the keep-alive injects+holds
    // and the coordinator returns before reaching the plan-mode hold.
    const mgr = (session as unknown as { subagentManager: unknown }).subagentManager as Record<string, unknown>;
    mgr.hasPendingBackground = vi.fn(() => true);
    mgr.waitForBackground = vi.fn(async () => undefined);
    mgr.deliverableLive = vi.fn(() => [{ type: 'Explore', description: 'd', result: 'r' }]);

    const draft = await fireBeforeSettle(evt([assistant('stop')]));

    // Exactly one draft, carrying the background results — NOT the plan nudge.
    expect(draft).toMatchObject({ type: 'custom_message', customType: 'damocles-subagent-results', display: false });
    await session.dispose();
  });

  it('the background injection carries per-agent status in details, which never reach the model-visible content', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();

    const mgr = (session as unknown as { subagentManager: unknown }).subagentManager as Record<string, unknown>;
    mgr.hasPendingBackground = vi.fn(() => true);
    mgr.waitForBackground = vi.fn(async () => undefined);
    mgr.deliverableLive = vi.fn(() => [
      { id: 'agent-1', toolCallId: 'tc-1', type: 'Explore', description: 'd', status: 'error', error: 'model unavailable' },
    ]);

    const draft = (await fireBeforeSettle(evt([assistant('stop')]))) as { content: string; details: unknown };

    expect(draft.details).toEqual({ agents: [{ agentId: 'agent-1', toolCallId: 'tc-1', status: 'error', result: 'model unavailable' }] });
    expect(draft.content).not.toContain('agent-1');
    expect(draft.content).not.toContain('tc-1');
    await session.dispose();
  });

  it('the settle after the continuation drains the background and lets the plan-mode hold through', async () => {
    // pi re-enters the boundary after each continuation, so precedence needs no state of its own.
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    await session.setPermissionMode('plan');

    const mgr = (session as unknown as { subagentManager: unknown }).subagentManager as Record<string, unknown>;
    mgr.hasPendingBackground = vi.fn(() => false);
    // The first draft is committed to the branch, so the next settle finds nothing left to deliver.
    mgr.deliverableLive = vi.fn().mockReturnValueOnce([{ type: 'Explore', description: 'd', result: 'r' }]).mockReturnValue([]);

    const first = await fireBeforeSettle(evt([assistant('stop')]));
    expect(first).toMatchObject({ customType: 'damocles-subagent-results' });

    const second = await fireBeforeSettle(evt([assistant('stop')]));
    expect(second).toMatchObject({ customType: 'damocles-plan-mode-nudge' });
    await session.dispose();
  });
});

describe('PiSession — subagent model resolution', () => {
  // These tests mutate the shared fake services (auth state), so each starts from a fresh set.
  beforeEach(() => {
    H.resetServices();
  });
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  /** Run `fn` with every provider unauthed, restoring the stub afterwards. Restoring locally (rather
   *  than relying on this block's beforeEach) keeps the mutation from reaching a later describe — the
   *  services object is shared file-wide and the next block does not reset it. */
  async function withoutAuth<T>(fn: () => T): Promise<T> {
    const runtime = H.getServices().modelRuntime;
    const original = runtime.hasConfiguredAuth;
    runtime.hasConfiguredAuth = () => false;
    try {
      return fn();
    } finally {
      runtime.hasConfiguredAuth = original;
    }
  }

  /** The private resolver, as the AgentManager engine calls it. Note it takes ONLY an agent config —
   *  there is no spawn-time model argument, which is the point of the precedence. */
  // "Game Designer" deliberately, never "Explore" — that name takes the Explore-settings branch and
  // would silently bypass the precedence these tests pin.
  type Cfg = { name: string; description: string; model?: string; filePath?: string; thinking?: string };
  function resolve(session: PiSession, cfg: Cfg) {
    return (session as unknown as { resolveSubagentModel: (c: Cfg) => { model?: unknown; modelLabel?: string; thinkingLevel?: string; error?: string } })
      .resolveSubagentModel(cfg);
  }

  it('inherits the session model when the template declares none', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const res = resolve(session, { name: 'Game Designer', description: 'd' });
    expect(res.error).toBeUndefined();
    expect(res.model).toMatchObject({ id: 'claude-opus-5-5', provider: 'anthropic' });
    await session.dispose();
  });

  // Without an explicit level pi uses the default it last persisted, which differs between machines.
  it("carries the panel's resolved effort along with the inherited model", async () => {
    const session = new PiSession(makeOptions([], {
      resolveThinking: () => ({ thinkingDisabled: false, effort: 'xhigh', maxThinkingTokens: null }),
    }));
    await session.initializeEarly();
    expect(resolve(session, { name: 'Game Designer', description: 'd' }).thinkingLevel).toBe('xhigh');
    await session.dispose();
  });

  it("lets a template's own thinking field beat the panel effort", async () => {
    const session = new PiSession(makeOptions([], {
      resolveThinking: () => ({ thinkingDisabled: false, effort: 'xhigh', maxThinkingTokens: null }),
    }));
    await session.initializeEarly();
    expect(resolve(session, { name: 'Game Designer', description: 'd', thinking: 'low' }).thinkingLevel).toBe('low');
    await session.dispose();
  });

  it('honors the template `model:` over the session model', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const res = resolve(session, { name: 'Game Designer', description: 'd', model: 'claude-opus-5-5' });
    expect(res.error).toBeUndefined();
    expect(res.model).toMatchObject({ id: 'claude-opus-5-5', provider: 'anthropic' });
    await session.dispose();
  });

  it('surfaces a template model that does not exist instead of silently using the session model', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const res = resolve(session, { name: 'Game Designer', description: 'd', model: 'claude-sonnet-4.5', filePath: '/agents/gd.md' });
    expect(res.model).toBeUndefined();
    // A broken pin must be visible and point at the file to fix — hiding it behind a fallback would
    // leave the template silently wrong forever.
    expect(res.error).toContain('claude-sonnet-4.5');
    expect(res.error).toContain('/agents/gd.md');
    await session.dispose();
  });

  it('rejects a resolvable-but-unauthed template model rather than spawning a session that fails at first request', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const res = await withoutAuth(() => resolve(session, { name: 'Game Designer', description: 'd', model: 'claude-opus-5-5' }));
    expect(res.model).toBeUndefined();
    // Branched cause: the model exists, so the fix is signing in — not editing the template.
    expect(res.error).toContain('not signed in');
    await session.dispose();
  });

  it('requires auth on the `provider/modelId` form too, not just curated values', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    // The direct-lookup fallback skips resolvePiModel entirely, so without its own auth check this
    // form silently re-admits a model auth just rejected.
    const res = await withoutAuth(() => resolve(session, { name: 'Game Designer', description: 'd', model: 'anthropic/claude-opus-5-5' }));
    expect(res.model).toBeUndefined();
    expect(res.error).toContain('not available');
    await session.dispose();
  });

  it('accepts the `provider/modelId` form when its provider IS authed', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const res = resolve(session, { name: 'Game Designer', description: 'd', model: 'anthropic/claude-opus-5-5' });
    expect(res.error).toBeUndefined();
    expect(res.model).toMatchObject({ id: 'claude-opus-5-5', provider: 'anthropic' });
    await session.dispose();
  });

  it.each([
    { mode: 'apikey', billed: true },
    { mode: 'allowance', billed: false },
  ])('labels the resolved model billed by the credential it runs on ($mode)', async ({ mode, billed }) => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    vi.spyOn(PiRuntime.get('/fake/agent'), 'getClaudeAuthStatus').mockReturnValue({ mode } as never);
    const billing = (cfg: Cfg) => (resolve(session, cfg) as { dollarBilled?: boolean }).dollarBilled;
    expect(billing({ name: 'Game Designer', description: 'd' })).toBe(billed);
    expect(billing({ name: 'Game Designer', description: 'd', model: 'anthropic/claude-opus-5-5' })).toBe(billed);
    await session.dispose();
  });
});

describe('PiSession subagent records', () => {
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  type RecordsEngine = { recordInvocation: (d: unknown) => void; subagentStoreDir: () => string };
  const engineOf = (session: PiSession): RecordsEngine =>
    (session as unknown as { buildSubagentEngine: (pi: unknown) => RecordsEngine }).buildSubagentEngine(getPiCodingAgent());

  it('appends the invocation entry to the live parent session', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const append = live.sessionManager.appendCustomEntry as ReturnType<typeof vi.fn>;
    append.mockClear();

    const data = { kind: 'subagent', id: 'agent-1', toolCallId: 'tc-1', resume: false };
    engineOf(session).recordInvocation(data);

    expect(append).toHaveBeenCalledWith('damocles-agent-invocation', data);
    await session.dispose();
  });

  it('warns the user when the invocation entry cannot be written', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const append = H.getLastSession()!.sessionManager.appendCustomEntry as ReturnType<typeof vi.fn>;
    append.mockImplementationOnce(() => { throw new Error('disk full'); });

    engineOf(session).recordInvocation({ kind: 'subagent', id: 'agent-1', toolCallId: 'tc-1', resume: false });

    expect(messages.some((m) => m.type === 'notification' && m.notificationType === 'warning')).toBe(true);
    await session.dispose();
  });

  it('files subagent sessions under the live parent session’s subagents folder', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const dir = engineOf(session).subagentStoreDir();
    expect(path.basename(dir)).toBe('subagents');
    expect(path.basename(path.dirname(dir))).toBe(H.getLastSession()!.sessionId);
    await session.dispose();
  });
});

describe('PiSession unpersisted tool result images', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await PiRuntime.disposeInstance();
  });

  const png = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
  const pngBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const toolEnd = (toolCallId: string) =>
    ({ type: 'tool_execution_end', toolCallId, toolName: 'browser_screenshot', result: { content: [png] }, isError: false });
  const resultEnd = (toolCallId: string) =>
    ({ type: 'message_end', message: { role: 'toolResult', toolCallId, toolName: 'browser_screenshot', content: [png], isError: false, timestamp: 0 } });

  it('serves a bound session\'s result images until its toolResult message ends', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();

    H.fireEvent(toolEnd('t1'));
    expect(session.unpersistedToolResultImages('t1')).toEqual([pngBlock]);

    H.fireEvent(resultEnd('t1'));
    expect(session.unpersistedToolResultImages('t1')).toBeUndefined();
    await session.dispose();
  });

  type NestedEngine = { createSession: (opts: unknown) => Promise<unknown>; forgetSession: (s: unknown) => void };
  it.each<[string, (session: PiSession) => NestedEngine]>([
    ['subagent', (session) =>
      (session as unknown as { buildSubagentEngine: (pi: unknown, folder: unknown) => NestedEngine }).buildSubagentEngine(getPiCodingAgent(), cwdFolder())],
    ['team', (session) => session.buildTeamEngine() as unknown as NestedEngine],
  ])('the %s engine tracks a nested session from createSession until forgetSession', async (_label, engineOf) => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const folder = cwdFolder()!;
    const listeners = new Set<(event: unknown) => void>();
    const nested = { agent: {}, subscribe: (fn: (event: unknown) => void) => { listeners.add(fn); return () => listeners.delete(fn); } };
    vi.spyOn(folder, 'createSubagentSession').mockResolvedValue(nested as never);
    const forget = vi.spyOn(folder, 'forgetSubagentSession').mockImplementation(() => {});
    const engine = engineOf(session);

    const created = await engine.createSession({ role: 'specialist', extensionFactory: () => undefined });
    for (const fn of listeners) fn(toolEnd('nested-1'));
    expect(session.unpersistedToolResultImages('nested-1')).toEqual([pngBlock]);

    engine.forgetSession(created);
    expect(session.unpersistedToolResultImages('nested-1')).toBeUndefined();
    expect(listeners.size).toBe(0);
    expect(forget).toHaveBeenCalledWith(nested);
    await session.dispose();
  });

  it('the team engine tells a team agent about a plan-mode change at its next step and at a prompt start', async () => {
    let mode = 'default';
    const options = makeOptions([]);
    (options.permissionHandler as unknown as { getPermissionMode: () => string }).getPermissionMode = () => mode;
    const session = new PiSession(options);
    await session.initializeEarly();
    const folder = cwdFolder()!;
    const agent: { prepareNextTurnWithContext?: (turn: unknown) => Promise<{ messages?: unknown[] } | undefined> } = {};
    const create = vi.spyOn(folder, 'createSubagentSession').mockResolvedValue({ agent, subscribe: () => () => undefined } as never);
    const gate = vi.fn();
    await session.buildTeamEngine().createSession({ role: 'lead', extensionFactory: gate } as never);
    const directive = teamPlanModeStatement('lead').guidance();
    const preamble = { role: 'system', content: '', sections: { preamble: 'You lead the team.' } };

    mode = 'plan';
    const step = await agent.prepareNextTurnWithContext!({ newMessages: [], context: { messages: [preamble, { role: 'user', content: [] }] } });
    expect(step?.messages).toEqual([expect.objectContaining({ customType: 'damocles-plan-mode-change', content: `The user switched this chat to plan mode. ${directive}` })]);

    // A lead spawned while the team was in plan mode, whose user has since left it.
    mode = 'default';
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const pi = { on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler) };
    const factory = (create.mock.calls[0]![0] as { extensionFactory: (pi: unknown) => Promise<void> }).extensionFactory;
    await factory(pi);
    expect(gate).toHaveBeenCalledWith(pi);
    const start = handlers.get('before_agent_start')!(
      { systemPromptOptions: { sections: {}, customPrompt: `You lead the team.\n\n${directive}` } },
      { sessionManager: { buildSessionProjection: () => ({ messages: [] }) } },
    );
    expect(start).toMatchObject({ message: { customType: 'damocles-plan-mode-change', details: { planMode: false } } });
    await session.dispose();
  });
});

describe('PiSession.steerSubagent (Slice 2 — /steer live flow)', () => {
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  it('emits subagentSteered with the record toolCallId as toolUseId and the manager status', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();

    const record: Record<string, unknown> = { type: 'Explore', description: 'find things', toolCallId: 'tool-42' };
    const steer = vi.fn(async () => 'steered' as const);
    (session as unknown as { subagentManager: unknown }).subagentManager = {
      steer,
      getRecord: vi.fn(() => record),
      dispose: vi.fn(),
    };

    await session.steerSubagent('agent-1', 'focus on tests');

    expect(steer).toHaveBeenCalledWith('agent-1', 'focus on tests', undefined);
    const emitted = messages.find((m) => m.type === 'subagentSteered');
    expect(emitted).toMatchObject({
      type: 'subagentSteered',
      agentId: 'agent-1',
      toolUseId: 'tool-42',
      agentType: 'Explore',
      description: 'find things',
      message: 'focus on tests',
      status: 'steered',
    });
    // A delivered steer is recorded on the record so the parent sees it when it consumes the result.
    expect(record.userSteers).toEqual([{ message: 'focus on tests' }]);
    await session.dispose();
  });

  it('persists a damocles-steer sidecar entry (raw message, no marker) so reload replays the chip', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const record: Record<string, unknown> = { type: 'Explore', description: 'find things', toolCallId: 'tool-42' };
    (session as unknown as { subagentManager: unknown }).subagentManager = {
      steer: vi.fn(async () => 'steered' as const),
      getRecord: vi.fn(() => record),
      dispose: vi.fn(),
    };
    const appendCustomEntry = vi.fn();
    (session as unknown as { runtime: unknown }).runtime = { session: { sessionManager: { appendCustomEntry }, clearQueue: vi.fn(() => ({ steering: [], followUp: [] })) }, dispose: vi.fn() };

    await session.steerSubagent('agent-1', 'focus on tests');

    expect(appendCustomEntry).toHaveBeenCalledWith('damocles-steer', {
      agentId: 'agent-1',
      agentType: 'Explore',
      description: 'find things',
      message: 'focus on tests',
    });
    await session.dispose();
  });

  it('does NOT persist a sidecar entry for a non-deliverable steer (finished)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const record: Record<string, unknown> = { type: 'Explore', description: 'd', toolCallId: 't1' };
    (session as unknown as { subagentManager: unknown }).subagentManager = {
      steer: vi.fn(async () => 'finished' as const),
      getRecord: vi.fn(() => record),
      dispose: vi.fn(),
    };
    const appendCustomEntry = vi.fn();
    (session as unknown as { runtime: unknown }).runtime = { session: { sessionManager: { appendCustomEntry }, clearQueue: vi.fn(() => ({ steering: [], followUp: [] })) }, dispose: vi.fn() };

    await session.steerSubagent('agent-1', 'too late');

    expect(appendCustomEntry).not.toHaveBeenCalled();
    await session.dispose();
  });

  it('ignores an empty steer message (no emit, no persistence)', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const steer = vi.fn(async () => 'steered' as const);
    (session as unknown as { subagentManager: unknown }).subagentManager = { steer, getRecord: vi.fn(), dispose: vi.fn() };

    await session.steerSubagent('agent-1', '   ');

    expect(steer).not.toHaveBeenCalled();
    expect(messages.find((m) => m.type === 'subagentSteered')).toBeUndefined();
    await session.dispose();
  });

  it('records the user steer on a queued agent so the parent still becomes aware of it', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const record: Record<string, unknown> = { type: 'Explore', description: 'd', toolCallId: 't1' };
    (session as unknown as { subagentManager: unknown }).subagentManager = {
      steer: vi.fn(async () => 'queued' as const),
      getRecord: vi.fn(() => record),
      dispose: vi.fn(),
    };

    await session.steerSubagent('agent-1', 'skip the UI');

    expect(record.userSteers).toEqual([{ message: 'skip the UI' }]);
    await session.dispose();
  });

  it('no manager / unknown id → status not-found, toolUseId null, and no userSteers write', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    // subagentManager stays null (no subagent engine ever built) → treated as 'not-found'.

    await session.steerSubagent('ghost', 'hello');

    const emitted = messages.find((m) => m.type === 'subagentSteered');
    expect(emitted).toMatchObject({
      type: 'subagentSteered',
      agentId: 'ghost',
      toolUseId: null,
      message: 'hello',
      status: 'not-found',
    });
    expect((emitted as { agentType?: string }).agentType).toBeUndefined();
    await session.dispose();
  });

  it('does NOT write userSteers when the manager reports a non-deliverable status (finished)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const record: Record<string, unknown> = { type: 'Explore', description: 'd', toolCallId: 't1' };
    (session as unknown as { subagentManager: unknown }).subagentManager = {
      steer: vi.fn(async () => 'finished' as const),
      getRecord: vi.fn(() => record),
      dispose: vi.fn(),
    };

    await session.steerSubagent('agent-1', 'too late');

    expect(record.userSteers).toBeUndefined();
    await session.dispose();
  });

  const PNG = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'AAAA' } };

  function withSubagent(session: PiSession, status: 'steered' | 'queued' = 'steered') {
    const record: Record<string, unknown> = { type: 'Explore', description: 'find things', toolCallId: 'tool-42' };
    const steer = vi.fn(async () => status);
    (session as unknown as { subagentManager: unknown }).subagentManager = { steer, getRecord: vi.fn(() => record), dispose: vi.fn() };
    const appendCustomEntry = vi.fn();
    (session as unknown as { runtime: unknown }).runtime = { session: { sessionManager: { appendCustomEntry }, clearQueue: vi.fn(() => ({ steering: [], followUp: [] })) }, dispose: vi.fn() };
    return { record, steer, appendCustomEntry };
  }

  it('forwards, emits and persists the images, and records their count for the parent', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const { record, steer, appendCustomEntry } = withSubagent(session);

    await session.steerTarget('agent-1', 'look at this', [PNG, PNG], 'req-1');

    expect(steer).toHaveBeenCalledWith('agent-1', 'look at this', [PNG, PNG]);
    expect(messages.find((m) => m.type === 'subagentSteered')).toMatchObject({ message: 'look at this', images: [PNG, PNG], requestId: 'req-1', status: 'steered' });
    expect(appendCustomEntry).toHaveBeenCalledWith('damocles-steer', {
      agentId: 'agent-1',
      agentType: 'Explore',
      description: 'find things',
      message: 'look at this',
      images: [PNG, PNG],
    });
    expect(record.userSteers).toEqual([{ message: 'look at this', imageCount: 2 }]);
    await session.dispose();
  });

  it('accepts an image-only steer', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const { record, steer } = withSubagent(session, 'queued');

    await session.steerTarget('agent-1', '', [PNG], 'req-1');

    expect(steer).toHaveBeenCalledWith('agent-1', '', [PNG]);
    expect(messages.find((m) => m.type === 'subagentSteered')).toMatchObject({ message: '', images: [PNG], status: 'queued' });
    expect(record.userSteers).toEqual([{ message: '', imageCount: 1 }]);
    await session.dispose();
  });

  it('still drops a steer with no text and an empty image list', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const { steer } = withSubagent(session);

    await session.steerTarget('agent-1', '  ', [], 'req-1');

    expect(steer).not.toHaveBeenCalled();
    expect(messages.find((m) => m.type === 'subagentSteered')).toBeUndefined();
    await session.dispose();
  });

  it('trims the message, so a whitespace-only steer with an image records (no text)', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const { record, steer, appendCustomEntry } = withSubagent(session);

    await session.steerTarget('agent-1', ' \n ', [PNG], 'req-1');

    expect(steer).toHaveBeenCalledWith('agent-1', '', [PNG]);
    expect(messages.find((m) => m.type === 'subagentSteered')).toMatchObject({ message: '', images: [PNG] });
    expect(appendCustomEntry).toHaveBeenCalledWith('damocles-steer', expect.objectContaining({ message: '' }));
    expect(formatUserSteerPrefix(record.userSteers as UserSteerNote[])).toBe('[User steered this agent mid-task: (no text) (+1 image)]\n');
    await session.dispose();
  });

  it('rebuilds each image, so an extra property reaches neither the agent, the chip nor the session file', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const { steer, appendCustomEntry } = withSubagent(session);
    const padded = { ...PNG, extra: 'x', source: { ...PNG.source, url: 'https://x' } };

    await session.steerTarget('agent-1', 'look', [padded], 'req-1');

    expect(steer).toHaveBeenCalledWith('agent-1', 'look', [PNG]);
    expect((messages.find((m) => m.type === 'subagentSteered') as { images: unknown[] }).images).toStrictEqual([PNG]);
    expect(appendCustomEntry.mock.calls[0]![1].images).toStrictEqual([PNG]);
    await session.dispose();
  });

  it('echoes no images when the steer was not delivered', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    (session as unknown as { subagentManager: unknown }).subagentManager = {
      steer: vi.fn(async () => 'finished' as const),
      getRecord: vi.fn(() => ({ toolCallId: 't1' })),
      dispose: vi.fn(),
    };

    await session.steerTarget('agent-1', 'too late', [PNG], 'req-1');

    const emitted = messages.find((m) => m.type === 'subagentSteered');
    expect(emitted).toMatchObject({ status: 'finished' });
    expect(emitted).not.toHaveProperty('images');
    await session.dispose();
  });

  it.each([
    ['a malformed image', [{ type: 'image', source: { type: 'url', url: 'https://x' } }]],
    ['an unsupported media type', [{ type: 'image', source: { type: 'base64', media_type: 'image/bmp', data: 'AAAA' } }]],
    ['a non-array', 'not-an-array'],
    ['more than ten images', Array.from({ length: 11 }, () => PNG)],
    ['an image over the base64 cap', [PNG, { ...PNG, source: { ...PNG.source, data: 'A'.repeat(MAX_IMAGE_BASE64_LENGTH + 1) } }]],
  ])('reports failed and delivers nothing for %s', async (_label, images) => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const { steer, appendCustomEntry } = withSubagent(session);

    await session.steerTarget('agent-1', 'look', images as never, 'req-1');

    expect(steer).not.toHaveBeenCalled();
    expect(appendCustomEntry).not.toHaveBeenCalled();
    expect(messages.filter((m) => m.type === 'subagentSteered')).toEqual([
      { type: 'subagentSteered', agentId: 'agent-1', toolUseId: null, message: 'look', requestId: 'req-1', status: 'failed' },
    ]);
    await session.dispose();
  });
});

describe('PiSession team stop causes', () => {
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  it('stops a running team as the user on ESC and as a reset on a clear', async () => {
    const teamService = { dispose: vi.fn(), cancelActiveTeam: vi.fn(() => true), setRunListener: vi.fn(), running: false };
    const session = new PiSession(makeOptions([], { teamService: teamService as unknown as NonNullable<SessionOptions['teamService']> }));
    await session.initializeEarly();

    session.cancel();
    expect(teamService.cancelActiveTeam).toHaveBeenLastCalledWith('user');
    session.reset();
    expect(teamService.cancelActiveTeam).toHaveBeenLastCalledWith('reset');

    await session.whenReplaced();
    await session.dispose();
  });
});

describe('PiSession.steerTarget (/steer routing to team members)', () => {
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  function teamServiceStub(outcome: unknown) {
    return { steerMember: vi.fn(() => outcome), listSteerTargets: vi.fn(() => []), dispose: vi.fn(), cancelActiveTeam: vi.fn(), setRunListener: vi.fn(), running: false };
  }

  it('routes an id no subagent owns to the team member, emits the team chip and persists it', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const teamService = teamServiceStub({ status: 'steered', teamId: 'team-1', teamTitle: 'Rewrite', memberName: 'backend', role: 'specialist' });
    const session = new PiSession(makeOptions(messages, { teamService: teamService as unknown as NonNullable<SessionOptions['teamService']> }));
    await session.initializeEarly();
    const subagentSteer = vi.fn();
    (session as unknown as { subagentManager: unknown }).subagentManager = { steer: subagentSteer, getRecord: vi.fn(() => undefined), dispose: vi.fn() };
    const appendCustomEntry = vi.fn();
    (session as unknown as { runtime: unknown }).runtime = { session: { sessionManager: { appendCustomEntry }, clearQueue: vi.fn(() => ({ steering: [], followUp: [] })) }, dispose: vi.fn() };

    await session.steerTarget('member-1', 'use the new schema', undefined, 'req-1');

    expect(subagentSteer).not.toHaveBeenCalled();
    expect(teamService.steerMember).toHaveBeenCalledWith('member-1', 'use the new schema', undefined);
    expect(messages.find((m) => m.type === 'subagentSteered')).not.toHaveProperty('images');
    expect(messages.find((m) => m.type === 'subagentSteered')).toMatchObject({
      agentId: 'member-1',
      toolUseId: null,
      description: 'Rewrite · backend',
      message: 'use the new schema',
      requestId: 'req-1',
      status: 'steered',
      team: { teamId: 'team-1', teamTitle: 'Rewrite', memberName: 'backend', role: 'specialist' },
    });
    expect(appendCustomEntry).toHaveBeenCalledWith('damocles-steer', { agentId: 'member-1', description: 'Rewrite · backend', message: 'use the new schema' });
    await session.dispose();
  });

  it('forwards, emits and persists the images of a team member steer, image-only included', async () => {
    const png = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'AAAA' } };
    const messages: ExtensionToWebviewMessage[] = [];
    const teamService = teamServiceStub({ status: 'steered', teamId: 'team-1', teamTitle: 'Rewrite', memberName: 'backend', role: 'specialist' });
    const session = new PiSession(makeOptions(messages, { teamService: teamService as unknown as NonNullable<SessionOptions['teamService']> }));
    await session.initializeEarly();
    const appendCustomEntry = vi.fn();
    (session as unknown as { runtime: unknown }).runtime = { session: { sessionManager: { appendCustomEntry }, clearQueue: vi.fn(() => ({ steering: [], followUp: [] })) }, dispose: vi.fn() };

    await session.steerTarget('member-1', '', [png], 'req-1');

    expect(teamService.steerMember).toHaveBeenCalledWith('member-1', '', [png]);
    expect(messages.find((m) => m.type === 'subagentSteered')).toMatchObject({ message: '', images: [png], status: 'steered' });
    expect(appendCustomEntry).toHaveBeenCalledWith('damocles-steer', { agentId: 'member-1', description: 'Rewrite · backend', message: '', images: [png] });
    await session.dispose();
  });

  it('reports a finished member without persisting a chip', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const teamService = teamServiceStub({ status: 'finished', teamId: 'team-1', teamTitle: 'Rewrite', memberName: 'backend', role: 'specialist' });
    const session = new PiSession(makeOptions(messages, { teamService: teamService as unknown as NonNullable<SessionOptions['teamService']> }));
    await session.initializeEarly();
    const appendCustomEntry = vi.fn();
    (session as unknown as { runtime: unknown }).runtime = { session: { sessionManager: { appendCustomEntry }, clearQueue: vi.fn(() => ({ steering: [], followUp: [] })) }, dispose: vi.fn() };

    await session.steerTarget('member-1', 'too late', undefined, 'req-1');

    expect(messages.find((m) => m.type === 'subagentSteered')).toMatchObject({ status: 'finished' });
    expect(appendCustomEntry).not.toHaveBeenCalled();
    await session.dispose();
  });

  const png = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'AAAA' } };

  it('echoes no images for a member the steer did not reach', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const teamService = teamServiceStub({ status: 'finished', teamId: 'team-1', teamTitle: 'Rewrite', memberName: 'backend', role: 'specialist' });
    const session = new PiSession(makeOptions(messages, { teamService: teamService as unknown as NonNullable<SessionOptions['teamService']> }));
    await session.initializeEarly();

    await session.steerTarget('member-1', 'too late', [png], 'req-1');

    const emitted = messages.find((m) => m.type === 'subagentSteered');
    expect(emitted).toMatchObject({ status: 'finished' });
    expect(emitted).not.toHaveProperty('images');
    await session.dispose();
  });

  it('hands the member, the chip and the session file the trimmed message', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const teamService = teamServiceStub({ status: 'steered', teamId: 'team-1', teamTitle: 'Rewrite', memberName: 'backend', role: 'specialist' });
    const session = new PiSession(makeOptions(messages, { teamService: teamService as unknown as NonNullable<SessionOptions['teamService']> }));
    await session.initializeEarly();
    const appendCustomEntry = vi.fn();
    (session as unknown as { runtime: unknown }).runtime = { session: { sessionManager: { appendCustomEntry }, clearQueue: vi.fn(() => ({ steering: [], followUp: [] })) }, dispose: vi.fn() };

    await session.steerTarget('member-1', '  ', [png], 'req-1');

    expect(teamService.steerMember).toHaveBeenCalledWith('member-1', '', [png]);
    expect(messages.find((m) => m.type === 'subagentSteered')).toMatchObject({ message: '', images: [png] });
    expect(appendCustomEntry).toHaveBeenCalledWith('damocles-steer', { agentId: 'member-1', description: 'Rewrite · backend', message: '', images: [png] });
    await session.dispose();
  });

  it('prefers a subagent that owns the id and never asks the team', async () => {
    const teamService = teamServiceStub(null);
    const session = new PiSession(makeOptions([], { teamService: teamService as unknown as NonNullable<SessionOptions['teamService']> }));
    await session.initializeEarly();
    const steer = vi.fn(async () => 'steered' as const);
    (session as unknown as { subagentManager: unknown }).subagentManager = { steer, getRecord: vi.fn(() => ({ toolCallId: 't1' })), dispose: vi.fn() };

    await session.steerTarget('agent-1', 'focus', undefined, 'req-1');

    expect(steer).toHaveBeenCalledWith('agent-1', 'focus', undefined);
    expect(teamService.steerMember).not.toHaveBeenCalled();
    await session.dispose();
  });

  it('falls back to the subagent not-found report when no team member matches', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const teamService = teamServiceStub(null);
    const session = new PiSession(makeOptions(messages, { teamService: teamService as unknown as NonNullable<SessionOptions['teamService']> }));
    await session.initializeEarly();

    await session.steerTarget('ghost', 'hello', undefined, 'req-1');

    expect(messages.find((m) => m.type === 'subagentSteered')).toMatchObject({ agentId: 'ghost', status: 'not-found' });
    await session.dispose();
  });

  it('steerSubagent stays subagent-only and never consults the team', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const teamService = teamServiceStub({ status: 'steered', teamId: 't', teamTitle: 'T', memberName: 'm', role: 'lead' });
    const session = new PiSession(makeOptions(messages, { teamService: teamService as unknown as NonNullable<SessionOptions['teamService']> }));
    await session.initializeEarly();

    await session.steerSubagent('member-1', 'hello');

    expect(teamService.steerMember).not.toHaveBeenCalled();
    expect(messages.find((m) => m.type === 'subagentSteered')).toMatchObject({ status: 'not-found' });
    // Only a user's steerAgent carries an id, so this result settles no held draft in the webview.
    expect(messages.find((m) => m.type === 'subagentSteered')).not.toHaveProperty('requestId');
    await session.dispose();
  });
});

/**
 * Slice 1 guards for the plan-mode active-set INVERSION (inclusion allowlist → exclusion list). These
 * operate on the pure `fullActiveToolNames` + `PLAN_MODE_EXCLUDED_TOOLS` pair rather than a live session,
 * so they state the set algebra directly.
 */
describe('plan-mode active set — exclusion model', () => {
  const fullyEnabled: ToolStatusDeps = {
    webEnabled: true,
    teamEnabled: true,
    teamAvailable: true,
    memoryService: { isEnabled: true } as unknown as MemoryService,
    compassService: { isEnabled: true } as unknown as CompassService,
    browserAvailable: true,
    browserEnabled: true,
    imageEnabled: true,
    imageAvailability: { available: true },
    mcpEnabled: true,
    mcpToolNames: ['mcp__git__status', 'mcp__git__commit'],
    mcpDeferrableToolNames: ['mcp__git__status', 'mcp__git__commit'],
    disabled: new Set<string>(),
  };

  const planSet = (): string[] => {
    const excluded = new Set(PLAN_MODE_EXCLUDED_TOOLS);
    return fullActiveToolNames(fullyEnabled).filter((n) => !excluded.has(n));
  };

  /**
   * The plan-mode tool set, PINNED. This is the decision point: because the gateable module tools
   * (memory/compass/browser/team) are auto-allowed by `runPermissionGate` BEFORE its plan-mode branch,
   * `PLAN_MODE_EXCLUDED_TOOLS` is their only plan-mode control — so a tool silently reaching plan mode is
   * a security change, not a UX one.
   *
   * A live-constant expectation cannot catch that: a 26th entry in `BROWSER_SPECS` would satisfy
   * `toContain(...BROWSER_PI_TOOL_NAMES)` while granting the planner a tool nobody reviewed. Pinning the
   * names means ANY new tool anywhere fails here until someone decides whether it belongs in plan mode.
   *
   * When this test fails, do not just paste the new name in. Decide first: should a PLANNING agent be
   * able to call it? If no, add it to `PLAN_MODE_EXCLUDED_TOOLS`. If yes, add it here with that reasoning
   * in the commit message.
   *
   * Do NOT "fix" this list when a deferred group is missing from a live plan-mode request: `planSet()`
   * filters `fullActiveToolNames`, which is ELIGIBILITY, not the deferred active set.
   */
  const PINNED_PLAN_MODE_TOOLS = [
    'Agent', 'AskUserQuestion', 'BrowserAccessibility', 'BrowserAct', 'BrowserClick', 'BrowserClose',
    'BrowserConsole', 'BrowserDownloads', 'BrowserDrag', 'BrowserElement', 'BrowserEvaluate',
    'BrowserFill', 'BrowserHover', 'BrowserIntercept', 'BrowserNavigate', 'BrowserNetwork',
    'BrowserOpen', 'BrowserQuery', 'BrowserRequestInput', 'BrowserScreenshot', 'BrowserScroll',
    'BrowserSelect', 'BrowserSnapshot', 'BrowserTabs', 'BrowserType', 'BrowserUpload', 'BrowserWait',
    'CodeSearch', 'CompassBlastRadius', 'CompassBuild', 'CompassContext', 'CompassDeadCode',
    'CompassQuery', 'CompassReviewContext', 'CompassSearch', 'CompassStats', 'Edit', 'ExitPlanMode',
    'FeedRead', 'ForgetMemory', 'GenerateImage', 'GetMemoryDetails', 'GetMemoryHistory', 'GetRelatedMemories',
    'GetSubagentResult', 'ListNotes', 'PowerShell', 'ResetObservationStaleness', 'SaveMemory',
    'SaveNote', 'SaveObservation', 'SearchMemories', 'SteerSubagent',
    'ToolSearch', 'UnforgetMemory', 'UpdateMemory', 'WebFetch', 'WebSearch',
    'YouTubeTranscript', 'bash', 'find', 'grep', 'ls', 'read', 'write',
  ];
  // `ToolSearch` (Slice 2) was added here after answering this block's question deliberately: SHOULD a
  // planning agent be able to call it? Yes — with browser/compass/MCP deferred, ToolSearch is the only
  // route back to them, so excluding it would leave a planner permanently unable to load a tool it needs
  // to research with, while plan mode is exactly where research happens. It is also read-only by
  // construction: it activates tools, and every activated tool still passes through the gate on use, so
  // it grants no capability the planner did not already have. Deliberately NOT in
  // `PLAN_MODE_EXCLUDED_TOOLS` (brief §2.5).
  // `GenerateImage` stays eligible like `Edit`/`write`: it is category `write`, so the gate's plan-mode
  // branch blocks it with a policy reason the model can re-plan against, instead of a missing tool.

  it('matches the pinned plan-mode tool set exactly (no tool arrives unreviewed)', () => {
    const deps = { ...fullyEnabled, mcpEnabled: false, mcpToolNames: [] };
    const excluded = new Set(PLAN_MODE_EXCLUDED_TOOLS);
    const actual = fullActiveToolNames(deps).filter((n) => !excluded.has(n));
    expect(actual.sort()).toEqual([...PINNED_PLAN_MODE_TOOLS].sort());
  });

  // The old INCLUSION expression, reproduced verbatim from the pre-inversion `applyActiveToolsForMode`.
  // Kept deliberately: it is the only assertion that states the inversion's behavioral delta as a set
  // difference, so it fails loudly if a later edit widens plan mode while updating the pinned list above.
  const LEGACY_READONLY = ['read', 'grep', 'find', 'ls', 'WebSearch', 'WebFetch', 'CodeSearch', 'FeedRead', 'YouTubeTranscript'];
  const LEGACY_INTERACTIVE = ['AskUserQuestion', 'ExitPlanMode', 'Agent', 'GetSubagentResult', 'SteerSubagent'];
  const LEGACY_PLAN_FILE = ['Edit', 'write'];
  const LEGACY_SHELL = ['bash', 'PowerShell'];

  // Slice 2 widened `gained` by exactly one name: `ToolSearch` joined the eligible universe. The delta
  // is still stated as a set difference (not relaxed to a `toContain`), so a later edit that widens plan
  // mode by anything else still fails here even after the pinned list above is updated.
  it('differs from the pre-inversion set by EXACTLY the browser tools, ToolSearch and GenerateImage', () => {
    const legacyAllowed = new Set([...LEGACY_READONLY, ...LEGACY_INTERACTIVE, ...LEGACY_PLAN_FILE, ...LEGACY_SHELL, ...COMPASS_PI_TOOL_NAMES, ...MEMORY_PI_TOOL_NAMES]);
    const legacy = fullActiveToolNames(fullyEnabled).filter((n) => legacyAllowed.has(n) || n.startsWith('mcp__'));

    const gained = planSet().filter((n) => !legacy.includes(n));
    const lost = legacy.filter((n) => !planSet().includes(n));

    expect(gained.sort()).toEqual([...BROWSER_PI_TOOL_NAMES, TOOL_TOOL_SEARCH, TOOL_GENERATE_IMAGE].sort());
    expect(lost).toEqual([]);
  });

  it('excludes EnterPlanMode and the team main tools, and nothing else', () => {
    expect([...PLAN_MODE_EXCLUDED_TOOLS].sort()).toEqual([TOOL_ENTER_PLAN_MODE, ...TEAM_MAIN_PI_TOOL_NAMES].sort());
    const names = planSet();
    expect(names).not.toContain(TOOL_ENTER_PLAN_MODE);
    for (const n of TEAM_MAIN_PI_TOOL_NAMES) expect(names, n).not.toContain(n);
  });

  it('keeps every tool the planner needs — interactive, shell, plan-file, module, web and MCP', () => {
    const names = planSet();
    for (const n of ['ExitPlanMode', 'AskUserQuestion', 'Agent', 'GetSubagentResult', 'SteerSubagent', 'Edit', 'write', 'bash', 'PowerShell', 'mcp__git__commit']) {
      expect(names, n).toContain(n);
    }
    for (const n of [...MEMORY_PI_TOOL_NAMES, ...COMPASS_PI_TOOL_NAMES, ...BROWSER_PI_TOOL_NAMES, ...WEB_TOOLS, ...PI_NATIVE_ACTIVE_TOOLS]) {
      expect(names, n).toContain(n);
    }
    for (const n of CUSTOM_TOOL_NAMES) {
      if (n === TOOL_ENTER_PLAN_MODE) continue;
      expect(names, n).toContain(n);
    }
  });

  // The root-cause guard, stated as the DEFAULT rather than as a per-group expectation. Asserting
  // "every group except team must be present" would be an anti-guard: correctly excluding a future
  // mutating subsystem would fail CI, while forgetting to exclude it would pass. What actually needs
  // protecting is that exclusion is DELIBERATE — a subsystem is absent from plan mode only because its
  // names are in PLAN_MODE_EXCLUDED_TOOLS, never because an allowlist forgot it.
  it('omits a catalog group only when its names are explicitly excluded', () => {
    const names = new Set(planSet());
    const excluded = new Set(PLAN_MODE_EXCLUDED_TOOLS);
    // Toggleable entries only: the core group's catalog names are webview DISPLAY names (`Read`,
    // `Glob`), not the pi-native active-set names (`read`, `find`), so they never match by identity.
    // Every toggleable subsystem names its tools by active-set identity, which is what plan mode filters.
    // The `team_*` AGENT tools are catalogued for the panel but built per team-agent, so they are in no
    // panel active set in ANY mode — their absence says nothing about plan mode.
    const agentOnly = new Set(TEAM_AGENT_PI_TOOL_NAMES);
    for (const entry of FULL_TOOL_CATALOG.filter((e) => e.toggleable && !agentOnly.has(e.name))) {
      if (names.has(entry.name)) continue;
      expect(
        excluded.has(entry.name),
        `${entry.name} (group ${entry.group}) is absent from plan mode but not in PLAN_MODE_EXCLUDED_TOOLS`,
      ).toBe(true);
    }
  });
});

/**
 * Slice 2: deferred tools in the live panel. The property under test is DURABILITY — Damocles calls
 * `refreshActiveTools()` on many unrelated events (settings toggles, MCP connects, permission-mode
 * changes), and before this slice any one of them would have silently deactivated a tool ToolSearch
 * had loaded mid-conversation. These drive the real `PiSession` seam (`activateDeferredTools`) and read
 * what actually reached `session.setActiveToolsByName`.
 */
describe('PiSession — ToolSearch activation survives every recompute (Slice 2)', () => {
  // `PiRuntime` is a process SINGLETON: without disposing it between cases, a later session reuses the
  // previous test's runtime and `H.getLastSession()` returns a stale session that this panel never
  // bound — every active-set assertion then reads an array nobody wrote. Mirrors the lifecycle block.
  beforeEach(() => {
    H.seq.length = 0;
    H.captured.services.length = 0;
    H.resetServices();
  });
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  /**
   * Browser AND web enabled. A helper leaving web disabled would make every "no web tool is active"
   * assertion below pass for the wrong reason — INELIGIBLE rather than deferred.
   */
  const subsystemsOn = () => {
    const cfg = vi.spyOn(testPlatform.settings, 'get');
    cfg.mockImplementation(settingsReader((key: string) => {
      if (key === 'damocles.browser.enabled') return true;
      if (key === 'damocles.pi.webSearch.enabled') return true;
      return undefined;
    }));
    return cfg;
  };

  const lastActive = (live: NonNullable<ReturnType<typeof H.getLastSession>>): string[] =>
    ((live.setActiveToolsByName as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] ?? []) as string[];

  it('starts a session with ToolSearch active and NO browser/compass/web/MCP tool active', async () => {
    // The demoable baseline: the first `setActiveToolsByName` of a session must already be the deferred
    // one. A wiring that applied deferral only on later recomputes would still pay the full schema cost
    // on exactly the request this feature exists to shrink — the first one.
    const cfg = subsystemsOn();
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    stubPanelMcp({
      allToolNames: () => ['mcp__ctx7__query_docs'],
      // `deferrableToolsSnapshot()` also asks the CLIENT for statuses and blurbs (never pi's registry —
      // that recurses through ToolSearch's own description getter), so both are stubbed.
      getServerStatuses: () => [],
      getAllToolDescriptors: () => [{ piName: 'mcp__ctx7__query_docs', serverName: 'ctx7', description: '' }],
    } as unknown as McpToolSource);
    const live = H.getLastSession()!;

    session.refreshActiveTools();
    const names = lastActive(live);

    expect(names).toContain(TOOL_TOOL_SEARCH);
    for (const n of BROWSER_PI_TOOL_NAMES) expect(names, n).not.toContain(n);
    for (const n of COMPASS_PI_TOOL_NAMES) expect(names, n).not.toContain(n);
    for (const n of WEB_TOOLS) expect(names, n).not.toContain(n);
    expect(names.filter((n) => n.startsWith('mcp__'))).toEqual([]);
    // ELIGIBLE yet absent from the active set — the distinction pure absence cannot make. The snapshot is
    // eligibility ∩ deferrable, so presence there says "held back", not "not available"; without it this
    // would pass identically against a build that just left web off.
    for (const n of WEB_TOOLS) expect(session.deferrableToolsSnapshot().names, n).toContain(n);
    // Everything NOT deferrable is untouched — this is a targeted deferral, not a smaller tool set.
    expect(names).toContain('read');
    expect(names).toContain('Edit');
    for (const n of CUSTOM_TOOL_NAMES) expect(names, n).toContain(n);

    cfg.mockRestore();
    await session.dispose();
  });

  it('keeps activated tools across refreshActiveTools() — an unrelated toggle cannot unload them', async () => {
    // The clobber bug this slice fixes, stated end-to-end: activate, then fire the exact call every
    // settings toggle makes. Without durable per-session state the recompute silently drops them.
    const cfg = subsystemsOn();
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;

    session.activateDeferredTools([...BROWSER_PI_TOOL_NAMES]);
    for (const n of BROWSER_PI_TOOL_NAMES) expect(lastActive(live), n).toContain(n);

    session.refreshActiveTools();
    for (const n of BROWSER_PI_TOOL_NAMES) expect(lastActive(live), n).toContain(n);
    // Compass was never asked for and must not ride along.
    for (const n of COMPASS_PI_TOOL_NAMES) expect(lastActive(live), n).not.toContain(n);

    cfg.mockRestore();
    await session.dispose();
  });

  it('refreshActiveTools also republishes ToolSearch, so a toggle reaches the description', async () => {
    // The active set and the ADVERTISED inventory are two different surfaces. pi captures a tool's
    // `description` at wrap time, so recomputing the active set alone leaves the model reading a menu
    // from before the toggle — live F5 caught exactly that (browser disabled, still advertised). The
    // republish is what asks pi to re-wrap, and this pins that the one funnel every toggle already goes
    // through drives BOTH surfaces.
    const cfg = subsystemsOn();
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const folder = cwdFolder()!;
    const republish = vi.spyOn(folder, 'republishToolSearch');

    session.refreshActiveTools();

    expect(republish).toHaveBeenCalled();
    cfg.mockRestore();
    republish.mockRestore();
    await session.dispose();
  });

  /**
   * INVARIANT 2, end to end. pi's `wrapToolDefinition` copies `description` as a plain STRING, so a live
   * getter alone goes stale and `pi.registerTool` is the only public re-wrap trigger. Toggling
   * `damocles.pi.webSearch.enabled` must therefore reach `republishToolSearch()` — otherwise the model
   * keeps ordering from a menu that still lists `web (5)` after the user turned web off, and gets an
   * inert group; or, worse for adoption, never learns web exists after the user turns it ON.
   *
   * The chain is FOUR hops, and no test covered it end to end before this slice:
   *   `extension.ts` onDidChangeConfiguration → `PiRuntime.refreshWebSearch()`
   *     → `FolderRuntime.refreshActiveTools()` → the refresher `PiSession.bindSession` registered
   *     → `PiSession.reloadForMcpToolChange()` → `refreshActiveTools()` → `republishToolSearch()`
   *
   * Entry is `refreshWebSearch()` — the seam `extension.ts`'s one-line listener calls — and everything
   * after it is the REAL wiring, not a spy. That matters because each hop was individually plausible
   * while the composition was unpinned: `refreshActiveTools` iterates a map a session must have
   * registered itself into, and `reloadForMcpToolChange` only reaches `refreshActiveTools` on its
   * registry-current fast path. A break anywhere in the middle is silent — the toggle appears to work,
   * the active set is right, and only the advertised menu is wrong.
   */
  it('toggling web republishes ToolSearch through the full refreshWebSearch chain (invariant 2)', async () => {
    const cfg = subsystemsOn();
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const runtime = PiRuntime.get('/fake/agent');
    const live = H.getLastSession()!;
    const republish = vi.spyOn(cwdFolder()!, 'republishToolSearch');

    await runtime.refreshWebSearch();

    // The description surface: reached, so the next wrap re-materializes the inventory.
    expect(republish).toHaveBeenCalled();
    // …and the active-set surface too, recomputed in the same pass — the two must not drift apart, which
    // is the failure the republish exists to prevent in the first place.
    const names = lastActive(live);
    expect(names).toContain(TOOL_TOOL_SEARCH);
    for (const n of WEB_TOOLS) expect(names, n).not.toContain(n);

    cfg.mockRestore();
    republish.mockRestore();
    await session.dispose();
  });

  it('survives the plan-mode round trip, and plan still excludes EnterPlanMode + the team tools', async () => {
    // `PLAN_MODE_EXCLUDED_TOOLS` is subtracted from the union, and the two sets are disjoint, so the
    // subtraction and the union commute. Asserting the round trip proves that concretely: entering and
    // leaving plan mode recomputes from `toolSearchActivated` rather than from the last applied array,
    // so neither transition can clobber a loaded tool — while plan mode keeps its own exclusions intact.
    const cfg = subsystemsOn();
    const opts = makeOptions([]);
    opts.teamService = { dispose: () => {}, cancelActiveTeam: () => {}, setRunListener: () => {}, running: false } as never;
    const session = new PiSession(opts);
    await session.initializeEarly();
    const live = H.getLastSession()!;

    session.activateDeferredTools([...BROWSER_PI_TOOL_NAMES]);

    await session.setPermissionMode('plan');
    const planNames = lastActive(live);
    for (const n of BROWSER_PI_TOOL_NAMES) expect(planNames, n).toContain(n);
    expect(planNames).toContain(TOOL_TOOL_SEARCH);
    expect(planNames).not.toContain(TOOL_ENTER_PLAN_MODE);
    for (const n of TEAM_MAIN_PI_TOOL_NAMES) expect(planNames, n).not.toContain(n);

    await session.setPermissionMode('default');
    const defaultNames = lastActive(live);
    for (const n of BROWSER_PI_TOOL_NAMES) expect(defaultNames, n).toContain(n);
    expect(defaultNames).toContain(TOOL_ENTER_PLAN_MODE);

    cfg.mockRestore();
    await session.dispose();
  });

  it('drops an activated tool when its subsystem is turned off (eligibility beats the preference)', async () => {
    // The acceptance criterion "a user-disabled browser tool stays absent even after ToolSearch loads
    // the group", driven through the live session rather than the pure function.
    const cfg = vi.spyOn(testPlatform.settings, 'get');
    let browserEnabled = true;
    cfg.mockImplementation(settingsReader((key: string) => (key === 'damocles.browser.enabled' ? browserEnabled : undefined)));

    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    session.activateDeferredTools([...BROWSER_PI_TOOL_NAMES]);
    expect(lastActive(live)).toContain(BROWSER_PI_TOOL_NAMES[0]);

    browserEnabled = false;
    session.refreshActiveTools();
    for (const n of BROWSER_PI_TOOL_NAMES) expect(lastActive(live), n).not.toContain(n);

    cfg.mockRestore();
    await session.dispose();
  });

  /**
   * Anthropic binds a thinking block's signature to the request prefix, and the tool NAME ARRAY is part
   * of that prefix. Damocles recomputes the active set on settings toggles, MCP connects and
   * permission-mode changes, so if any of those reordered the array it would invalidate thinking blocks
   * on an event that changed nothing the user can see. Order, not membership, is what this pins.
   */
  it('applyActiveToolsForMode writes a byte-identical name array when nothing changed', async () => {
    const cfg = subsystemsOn();
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    stubPanelMcp({
      allToolNames: () => ['mcp__ctx7__query_docs', 'mcp__ctx7__resolve_id'],
      getServerStatuses: () => [],
      getAllToolDescriptors: () => [],
    } as unknown as McpToolSource);
    const live = H.getLastSession()!;
    // Put the MCP names in the registry so `reloadForMcpToolChange` takes its fast path and re-applies
    // the set inline; the orphaned path defers the apply and would leave this event undriven.
    live.registryToolNames.add('mcp__ctx7__query_docs');
    live.registryToolNames.add('mcp__ctx7__resolve_id');

    // A tool group loaded mid-conversation, because an array built from a Set union is where an ordering
    // difference would actually show up.
    session.activateDeferredTools([...BROWSER_PI_TOOL_NAMES]);
    const baseline = lastActive(live);
    expect(baseline.length).toBeGreaterThan(0);

    const applies = (): string[][] => (live.setActiveToolsByName as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]) as string[][];
    const firstAfterActivation = applies().length;

    // Each of the three real entry points, fired with every input unchanged. Counting applies before and
    // after each one proves the event actually reached `applyActiveToolsForMode` rather than short-
    // circuiting somewhere, which a plain total would not distinguish.
    const beforeToggle = applies().length;
    session.refreshActiveTools();
    expect(applies().length).toBeGreaterThan(beforeToggle);

    const beforeMcp = applies().length;
    session.reloadForMcpToolChange();
    expect(applies().length).toBeGreaterThan(beforeMcp);

    const beforeMode = applies().length;
    await session.setPermissionMode('default');
    expect(applies().length).toBeGreaterThan(beforeMode);

    // `toEqual` on an array compares element ORDER as well as membership, which is the whole point: a
    // reordered active set still contains every name.
    for (const names of applies().slice(firstAfterActivation)) expect(names).toEqual(baseline);

    // Entering plan mode is a real prefix change and must still subtract, so the assertion above is not
    // passing because every call is trivially the same array.
    await session.setPermissionMode('plan');
    expect(lastActive(live)).not.toEqual(baseline);
    expect(lastActive(live)).not.toContain(TOOL_ENTER_PLAN_MODE);

    cfg.mockRestore();
    await session.dispose();
  });

  it('reset() drops back to the deferred baseline (a fresh conversation re-earns its tools)', async () => {
    // The activated set is conversation state, not user configuration: a context clear must not carry a
    // previous conversation's loaded tools into the fresh session's first request. `bindSession` clears
    // it on a session-ID change, which is what `reset()` produces.
    const cfg = subsystemsOn();
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const first = H.getLastSession()!;
    session.activateDeferredTools([...BROWSER_PI_TOOL_NAMES]);
    expect(lastActive(first)).toContain(BROWSER_PI_TOOL_NAMES[0]);

    // `reset()` chains `runtime.newSession()` onto `resetPromise`; a bare macrotask tick does not drain
    // that chain, so the fresh session's first apply would not have happened yet. `whenReplaced()` is
    // the public seam for exactly this wait (credit: extension-host's harness finding).
    session.reset();
    await session.whenReplaced();
    const second = H.getLastSession()!;
    expect(second).not.toBe(first);

    const names = lastActive(second);
    expect(names).toContain(TOOL_TOOL_SEARCH);
    for (const n of BROWSER_PI_TOOL_NAMES) expect(names, n).not.toContain(n);

    cfg.mockRestore();
    await session.dispose();
  });

  it('per-tool exposure through the real folder view: Off is ineligible, Always loaded is active and off the menu, On waits', async () => {
    const cfg = subsystemsOn();
    const tools = { context7: [{ name: 'resolve-library-id' }, { name: 'query-docs' }, { name: 'get-library-docs' }] };
    const user = managerWithFake(tools);
    const folder = managerWithFake(tools);
    const setting = { userValue: { context7: { 'resolve-library-id': 'off', 'get-library-docs': 'direct' } } };
    const view = new FolderMcpView(user.manager, folder.manager, () => ({ inspection: setting, trusted: true }));
    try {
      await user.manager.reconcile({ context7: specOf({ command: 'context7' }) });
      view.setUserVisible(['context7']);
      const session = new PiSession(makeOptions([]));
      await session.initializeEarly();
      stubPanelMcp(view);
      session.refreshActiveTools();

      const snap = session.deferrableToolsSnapshot();
      expect(snap.names).toContain('mcp__context7__query_docs');
      expect(snap.names).not.toContain('mcp__context7__resolve_library_id');
      expect(snap.names).not.toContain('mcp__context7__get_library_docs');
      expect(snap.mcpGroups.get('context7')).toEqual(['mcp__context7__query_docs']);
      expect([...(snap.mcpDescriptions?.keys() ?? [])]).toEqual(['mcp__context7__query_docs']);

      const eligible = (session as unknown as { fullActiveToolNames: () => string[] }).fullActiveToolNames();
      expect(eligible).not.toContain('mcp__context7__resolve_library_id');
      const lastActiveNames = (): string[] => lastActive(H.getLastSession()!);
      const active = lastActiveNames();
      expect(active).toContain('mcp__context7__get_library_docs');
      expect(active).not.toContain('mcp__context7__query_docs');
      expect(active).not.toContain('mcp__context7__resolve_library_id');

      // Activation stays inside the deferrable universe: the Off tool cannot be brought back.
      session.activateDeferredTools(['mcp__context7__resolve_library_id', 'mcp__context7__query_docs']);
      expect(lastActiveNames()).toContain('mcp__context7__query_docs');
      expect(lastActiveNames()).not.toContain('mcp__context7__resolve_library_id');

      await session.dispose();
    } finally {
      view.dispose();
      await user.manager.dispose();
      await folder.manager.dispose();
      cfg.mockRestore();
    }
  });

  it('exposes a deferrable snapshot whose names are exactly what ToolSearch may activate', async () => {
    // The port contract: `names` is the deferrable universe already intersected with eligibility, and
    // `loaded` reflects the live active set. A snapshot built from the raw catalogs instead of from
    // `eligible` would offer the model tools the session would then refuse to activate.
    const cfg = subsystemsOn();
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    stubPanelMcp({
      allToolNames: () => ['mcp__ctx7__query_docs'],
      getServerStatuses: () => [],
      // The snapshot sources MCP blurbs from the CLIENT, never from pi's tool registry (reading that
      // from ToolSearch's description getter recurses), so the stub must answer this too.
      getAllToolDescriptors: () => [{ piName: 'mcp__ctx7__query_docs', serverName: 'ctx-7', description: 'Query library docs' }],
    } as unknown as McpToolSource);

    const snap = session.deferrableToolsSnapshot();
    for (const n of BROWSER_PI_TOOL_NAMES) expect(snap.names, n).toContain(n);
    expect(snap.names).toContain('mcp__ctx7__query_docs');
    // The group is the server's name made printable, taken from the descriptor, never parsed from the tool name.
    expect(snap.mcpGroups.get('ctx_7')).toEqual(['mcp__ctx7__query_docs']);
    // Nothing non-deferrable is ever offered.
    expect(snap.names).not.toContain('read');
    expect(snap.names).not.toContain(TOOL_TOOL_SEARCH);
    // Blurbs come from the MCP client, keyed by pi tool name, and cover only deferrable tools. This is
    // what lets ToolSearch's description name MCP tools WITHOUT reading pi's registry — the read that
    // recursed through its own description getter and took every session down at startup.
    expect(snap.mcpDescriptions?.get('mcp__ctx7__query_docs')).toEqual({ description: 'Query library docs', group: 'ctx_7' });

    cfg.mockRestore();
    await session.dispose();
  });
});

/**
 * Slice 3 §3.5 — team agents. `buildTeamEngine()` is the seam a team spawn goes through, so these drive
 * the REAL `PiSession.buildTeamEngine()` and read what its `buildExtensionFactory` arrow actually
 * registers into a nested `pi`. That arrow is invoked PER AGENT SPAWN, which is the property that makes
 * `teamAgentToolNames()` observe live panel state — and which a hoisted local would silently break.
 */
describe('PiSession.buildTeamEngine — team agents get uniform deferral (Slice 3 §3.5)', () => {
  beforeEach(() => {
    H.seq.length = 0;
    H.captured.services.length = 0;
    H.resetServices();
  });
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  type ToolSearchLike = {
    name: string;
    execute: (id: string, p: { tools: string[] }, s: undefined, u: undefined, c: unknown) => Promise<{ details?: { matches: string[]; totalDeferredTools: number } }>;
  };
  const execCtx = { sessionManager: { getSessionId: () => 'team-agent-1' } };

  /** Config spy whose browser/team flags the test flips mid-run, mirroring a real settings toggle. */
  function configWith(flags: { browser: boolean; team: boolean }) {
    const cfg = vi.spyOn(testPlatform.settings, 'get');
    cfg.mockImplementation(settingsReader((key: string) => {
      if (key === 'damocles.browser.enabled') return flags.browser;
      if (key === 'damocles.team.enabled') return flags.team;
      return undefined;
    }));
    return cfg;
  }

  /** A minimal nested `pi` exposing the ExtensionAPI members the subagent factory + ToolSearch touch. */
  function nestedPi(initialActive: string[] = []) {
    const registered = new Map<string, ToolSearchLike>();
    let active = [...initialActive];
    return {
      registered,
      active: () => [...active],
      api: {
        on: () => {},
        registerTool: (tool: ToolSearchLike) => registered.set(tool.name, tool),
        getActiveTools: () => [...active],
        setActiveTools: (names: string[]) => { active = [...names]; },
        getAllTools: () => [],
      } as never,
    };
  }

  async function teamSession() {
    const opts = makeOptions([]);
    opts.teamService = { dispose: () => {}, cancelActiveTeam: () => {}, setRunListener: () => {}, running: false } as never;
    opts.compassService = { isEnabled: true } as never;
    const session = new PiSession(opts);
    await session.initializeEarly();
    return session;
  }

  /** The per-spawn context `team-runner.ts` hands `buildAgentToolset` at both spawn sites. */
  const spawnCtx = (agentId: string) => ({
    agentId,
    browserScopeId: `${agentId}#1`,
    agentName: 'specialist',
    role: 'specialist' as const,
  }) as never;

  it('a team agent\'s tools: carries ToolSearch and the deferrable names it must keep eligible', async () => {
    const cfg = configWith({ browser: true, team: true });
    const session = await teamSession();

    // `tools:` is composed the way `team-runner.ts` composes it — `toolNames` plus the spawn's frozen
    // `mcp.names`. Reading only `toolNames` would assert against half of what the session receives.
    const { toolNames, mcp } = session.buildTeamEngine().buildAgentToolset(spawnCtx('agent-1'));
    const names = [...toolNames, ...mcp.names];
    expect(names).toContain(TOOL_TOOL_SEARCH);
    for (const n of [...BROWSER_PI_TOOL_NAMES, ...COMPASS_PI_TOOL_NAMES]) expect(names, n).toContain(n);
    // The coordination tools this role carries are present, and per deferredToolNames never
    // deferrable, so a specialist can post to the scratchpad from turn one.
    for (const n of teamAgentPiToolNamesForRole('specialist')) expect(names, n).toContain(n);
    const deferrable = deferredToolNames(names, mcp.names);
    for (const n of TEAM_AGENT_PI_TOOL_NAMES) expect(deferrable, n).not.toContain(n);
    for (const n of COMPASS_PI_TOOL_NAMES) expect(deferrable, n).toContain(n);

    cfg.mockRestore();
    await session.dispose();
  });

  it('the spawned factory registers a working ToolSearch that loads compass mid-run', async () => {
    // End-to-end for the team half of the slice: build the engine, spawn a factory, register it into a
    // nested pi, and drive the resulting tool. Anything short of this leaves "does the port register in
    // the nested registry?" as an assertion about source rather than about behaviour.
    const cfg = configWith({ browser: true, team: true });
    const session = await teamSession();
    // Start from the deferred baseline a real nested session would have: the team_* tools active,
    // browser/compass held back. That is what `createSubagentSession` writes for a team agent.
    const baseline = ['read', 'Edit', TOOL_TOOL_SEARCH, ...TEAM_AGENT_PI_TOOL_NAMES];
    const nested = nestedPi(baseline);

    // ONE `buildAgentToolset` per spawn, and the SAME snapshot handed to `buildExtensionFactory` — the
    // shape `team-runner.ts` uses. Passing a freshly-built snapshot here instead would reintroduce the
    // second read this slice exists to remove, and the test would stop modelling the production path.
    const engine = session.buildTeamEngine();
    const { mcp } = engine.buildAgentToolset(spawnCtx('agent-1'));
    engine.buildExtensionFactory(spawnCtx('agent-1'), mcp, false)(nested.api);

    const tool = nested.registered.get(TOOL_TOOL_SEARCH);
    expect(tool).toBeDefined();

    const result = await tool!.execute('tc-1', { tools: ['compass'] }, undefined, undefined, execCtx);
    expect([...(result.details?.matches ?? [])].sort()).toEqual([...COMPASS_PI_TOOL_NAMES].sort());

    const after = nested.active();
    for (const n of COMPASS_PI_TOOL_NAMES) expect(after, n).toContain(n);
    // Purely additive: the coordination tools the specialist needs from turn one are still there.
    for (const n of baseline) expect(after, n).toContain(n);
    // …and the browser group it did NOT ask for stays deferred.
    for (const n of BROWSER_PI_TOOL_NAMES) expect(after, n).not.toContain(n);

    cfg.mockRestore();
    await session.dispose();
  });

  it('reads live panel state at SPAWN — a subsystem toggled on mid-run reaches the next agent', async () => {
    // The contract's load-bearing detail: `teamAgentToolNames()` is called INSIDE the per-spawn arrow.
    // Hoisting it to a `buildTeamEngine` local would freeze the deferrable set at team-construction time
    // and silently miss exactly this case. Driven by building the engine ONCE and spawning twice across
    // a toggle, which is the only shape that can tell the two implementations apart.
    const flags = { browser: false, team: true };
    const cfg = vi.spyOn(testPlatform.settings, 'get');
    cfg.mockImplementation(settingsReader((key: string) => {
      if (key === 'damocles.browser.enabled') return flags.browser;
      if (key === 'damocles.team.enabled') return flags.team;
      return undefined;
    }));

    const opts = makeOptions([]);
    opts.teamService = { dispose: () => {}, cancelActiveTeam: () => {}, setRunListener: () => {}, running: false } as never;
    const session = new PiSession(opts);
    await session.initializeEarly();
    const engine = session.buildTeamEngine(); // built ONCE, before the toggle

    const before = nestedPi([TOOL_TOOL_SEARCH]);
    engine.buildExtensionFactory(spawnCtx('agent-1'), engine.buildAgentToolset(spawnCtx('agent-1')).mcp, false)(before.api);
    // Browser off, compass unwired and no MCP manager ⇒ nothing deferrable ⇒ registration is skipped.
    expect(before.registered.get(TOOL_TOOL_SEARCH)).toBeUndefined();

    flags.browser = true; // the user enables the browser mid-run

    const after = nestedPi([TOOL_TOOL_SEARCH]);
    engine.buildExtensionFactory(spawnCtx('agent-2'), engine.buildAgentToolset(spawnCtx('agent-2')).mcp, false)(after.api);
    const afterTool = after.registered.get(TOOL_TOOL_SEARCH);
    expect(afterTool).toBeDefined();

    // The second agent's universe is the LIVE one — it can actually load the newly-enabled group.
    const result = await afterTool!.execute('tc-1', { tools: ['browser'] }, undefined, undefined, execCtx);
    expect(result.details?.totalDeferredTools).toBe(BROWSER_PI_TOOL_NAMES.length);
    for (const n of BROWSER_PI_TOOL_NAMES) expect(after.active(), n).toContain(n);

    cfg.mockRestore();
    await session.dispose();
  });
});

/**
 * Slice 1 (nested MCP) — the TEAM half, through the REAL `PiSession.buildTeamEngine()` (criterion 7).
 *
 * Every assertion below goes through the real engine's real `buildAgentToolset` arrow and the real
 * `buildExtensionFactory` arrow, with the panel's MCP source stubbed at the seam `PiSession`
 * actually reads (`FolderRuntime.mcp`). Nothing about the snapshot is faked: the
 * definitions are built by the real `buildNestedMcpToolset` from the real descriptors, so what a team
 * specialist would receive is what is asserted.
 */
/** The shared `McpClientManager.callTool` spy every stubbed manager in this block routes to. */
const mcpCallTool = vi.fn(async (piName: string, _args: Record<string, unknown>, _opts?: { signal?: AbortSignal }) => ({
  content: [{ type: 'text' as const, text: `result of ${piName}` }],
  isError: false,
}));

describe('PiSession.buildTeamEngine — a team specialist gets MCP (Slice 1, criterion 7)', () => {
  beforeEach(() => {
    mcpCallTool.mockClear();
    H.seq.length = 0;
    H.captured.services.length = 0;
    H.resetServices();
  });
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  const MCP_DESCRIPTORS = [
    { piName: 'mcp__git__status', serverName: 'git', kind: 'tool' as const, rawToolName: 'status', description: 'Show the working tree status', inputSchema: { type: 'object', properties: {} }, readOnly: true },
    { piName: 'mcp__git__commit', serverName: 'git', kind: 'tool' as const, rawToolName: 'commit', description: 'Create a commit', inputSchema: { type: 'object', properties: {} }, readOnly: false },
  ];

  const teamExecCtx = { sessionManager: { getSessionId: () => 'team-agent-1' } };

  /** A minimal nested `pi` exposing the ExtensionAPI members the subagent factory + ToolSearch touch. */
  /** The slice of a pi tool definition this nested-pi stub records and the tests then invoke. */
  interface NestedTool {
    name: string;
    description: string;
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: undefined,
      ctx: unknown,
    ) => Promise<unknown>;
  }

  function nestedTeamPi(initialActive: string[] = []) {
    const registered = new Map<string, NestedTool>();
    let active = [...initialActive];
    const registerTool = (tool: NestedTool): void => { registered.set(tool.name, tool); };
    return {
      registered,
      registerTool,
      active: () => [...active],
      api: {
        on: () => {},
        registerTool,
        getActiveTools: () => [...active],
        setActiveTools: (names: string[]) => { active = [...names]; },
        getAllTools: () => [...registered.values()].map((t) => ({ name: t.name, description: t.description })),
      } as never,
    };
  }

  /** A team session whose runtime reports the given MCP descriptors, plus the config spy. */
  async function teamSessionWithMcp(
    descriptors = MCP_DESCRIPTORS,
    flags = { browser: false, team: true },
    messages: ExtensionToWebviewMessage[] = [],
  ) {
    const cfg = vi.spyOn(testPlatform.settings, 'get');
    cfg.mockImplementation(settingsReader((key: string) => {
      if (key === 'damocles.browser.enabled') return flags.browser;
      if (key === 'damocles.team.enabled') return flags.team;
      return undefined;
    }));

    const opts = makeOptions(messages);
    opts.teamService = { dispose: () => {}, cancelActiveTeam: () => {}, setRunListener: () => {}, running: false } as never;
    const session = new PiSession(opts);
    await session.initializeEarly();

    let live = [...descriptors];
    stubPanelMcp({
      allToolNames: () => live.map((d) => d.piName),
      getServerStatuses: () => [],
      getAllToolDescriptors: () => [...live],
      getToolDescriptor: (piName: string) => live.find((d) => d.piName === piName),
      callTool: mcpCallTool,
    } as unknown as McpToolSource);

    return { session, cfg, setDescriptors: (next: typeof descriptors) => { live = [...next]; } };
  }

  const teamCtx = (agentId: string, role: 'lead' | 'specialist' = 'specialist') => ({
    agentId,
    browserScopeId: `${agentId}#1`,
    agentName: role,
    teamId: 'team-1',
    role,
  }) as never;

  const mcpNamesOf = (names: readonly string[]): string[] => names.filter((n) => n.startsWith('mcp__')).sort();

  it('criterion 1: the mcp__* names in `tools:` are SET-EQUAL to those in `customTools`', async () => {
    // §8's first bullet, at the team seam — the failure mode that shipped: team agents already passed
    // `mcp__*` names in `tools:` into a registry with no matching definitions, and pi dropped them
    // SILENTLY. Set equality in both directions is the only thing that catches it.
    const { session, cfg } = await teamSessionWithMcp();
    const engine = session.buildTeamEngine();

    const { toolNames, customTools, mcp } = engine.buildAgentToolset(teamCtx('agent-1'));
    const tools = [...toolNames, ...mcp.names]; // exactly what `team-runner.ts` composes

    expect(mcpNamesOf(tools)).toEqual(['mcp__git__commit', 'mcp__git__status']);
    expect(new Set(mcpNamesOf(tools))).toEqual(new Set(mcpNamesOf(customTools.map((t) => t.name))));
    expect(mcpNamesOf(tools)).toEqual(mcpNamesOf(customTools.map((t) => t.name)));
    // `teamAgentToolNames()` must NOT also carry them, or every MCP name lands in `tools:` twice and
    // pi's `setActiveToolsByName` (one definition per occurrence, no de-dup) makes the provider reject
    // the whole request.
    expect(mcpNamesOf(toolNames)).toEqual([]);
    expect(tools).toHaveLength(new Set(tools).size);

    cfg.mockRestore();
    await session.dispose();
  });

  it('a team agent never gets GenerateImage, by name or by definition, even when the panel has it eligible', async () => {
    const { session, cfg } = await teamSessionWithMcp();
    const panelNames = (session as unknown as { fullActiveToolNames(): string[] }).fullActiveToolNames();
    vi.spyOn(session as unknown as { fullActiveToolNames(): string[] }, 'fullActiveToolNames').mockReturnValue([...panelNames, TOOL_GENERATE_IMAGE]);
    const engine = session.buildTeamEngine();

    for (const role of ['lead', 'specialist'] as const) {
      const { toolNames, customTools } = engine.buildAgentToolset(teamCtx(`agent-${role}`, role));
      expect(toolNames, role).not.toContain(TOOL_GENERATE_IMAGE);
      expect(customTools.map((t) => t.name), role).not.toContain(TOOL_GENERATE_IMAGE);
    }

    cfg.mockRestore();
    await session.dispose();
  });

  it('criterion 3: the nested ToolSearch advertises the agent MCP tools with their blurbs', async () => {
    const { session, cfg } = await teamSessionWithMcp();
    const engine = session.buildTeamEngine();
    const { mcp } = engine.buildAgentToolset(teamCtx('agent-1'));
    const nested = nestedTeamPi([TOOL_TOOL_SEARCH, ...TEAM_AGENT_PI_TOOL_NAMES]);

    engine.buildExtensionFactory(teamCtx('agent-1'), mcp, false)(nested.api);

    const tool = nested.registered.get(TOOL_TOOL_SEARCH);
    expect(tool, 'a team specialist with MCP tools must get a ToolSearch to load them').toBeDefined();
    expect(tool!.description).toContain('git (2): mcp__git__status — Show the working tree status; mcp__git__commit — Create a commit');

    cfg.mockRestore();
    await session.dispose();
  });

  it('both composition sites: an Always-loaded tool is granted, never deferrable, and `deferrable ⊆ names`', async () => {
    // The per-tool exposure half of the frozen snapshot, asserted at BOTH spawn paths: a site that
    // passed `mcp.names` as the deferrable set would advertise and hold back a tool the user asked to
    // have loaded from the first turn.
    const direct = { ...MCP_DESCRIPTORS[0]!, exposure: 'direct' as const };
    const { session, cfg } = await teamSessionWithMcp([direct, MCP_DESCRIPTORS[1]!]);
    const teamEngine = session.buildTeamEngine();
    const subagentEngine = (session as unknown as {
      buildSubagentEngine: (pi: unknown) => {
        buildAgentToolset: (i: { agentId: string; agentName: string; mcpDisallowed: ReadonlySet<string> }) => { mcp: NestedMcpToolset };
      };
    }).buildSubagentEngine(getPiCodingAgent() as never);

    const snapshots = [
      teamEngine.buildAgentToolset(teamCtx('agent-1')).mcp,
      subagentEngine.buildAgentToolset({ agentId: 'a1', agentName: 'general-purpose', mcpDisallowed: new Set() }).mcp,
    ];
    for (const mcp of snapshots) {
      expect([...mcp.names].sort()).toEqual(['mcp__git__commit', 'mcp__git__status']);
      expect(mcp.deferrable).toEqual(['mcp__git__commit']);
      expect(mcp.direct).toEqual(['mcp__git__status']);
      const names = new Set(mcp.names);
      for (const name of mcp.deferrable) expect(names.has(name), name).toBe(true);
      expect([...mcp.descriptions.keys()]).toEqual(['mcp__git__commit']);
    }

    // The team agent's ToolSearch: the direct tool is off the menu and, asked for by name, reported active.
    const nested = nestedTeamPi([TOOL_TOOL_SEARCH, 'mcp__git__status']);
    teamEngine.buildExtensionFactory(teamCtx('agent-1'), snapshots[0]!, false)(nested.api);
    const tool = nested.registered.get(TOOL_TOOL_SEARCH)!;
    expect(tool.description).toContain('git (1): mcp__git__commit');
    expect(tool.description).not.toContain('mcp__git__status');
    const result = (await tool.execute('tc-1', { tools: ['mcp__git__status'] }, undefined, undefined, teamExecCtx)) as {
      details?: { matches: string[] };
      content: Array<{ text: string }>;
    };
    expect(result.details?.matches).toEqual([]);
    expect(result.content[0]!.text).toContain('Already active, no loading needed: mcp__git__status');

    cfg.mockRestore();
    await session.dispose();
  });

  it('both composition sites: a server whose every tool is Always loaded is answered as active, not unknown', async () => {
    // A deferred tool on another server, so the agent has a ToolSearch to ask.
    const docs = { ...MCP_DESCRIPTORS[0]!, piName: 'mcp__docs__search', serverName: 'docs', rawToolName: 'search', exposure: 'deferred' as const };
    const allDirect = [MCP_DESCRIPTORS[0]!, MCP_DESCRIPTORS[1]!].map((d) => ({ ...d, exposure: 'direct' as const }));
    const { session, cfg } = await teamSessionWithMcp([...allDirect, docs]);
    const teamEngine = session.buildTeamEngine();
    const subagentEngine = (session as unknown as {
      buildSubagentEngine: (pi: unknown) => {
        buildAgentToolset: (i: { agentId: string; agentName: string; mcpDisallowed: ReadonlySet<string> }) => { mcp: NestedMcpToolset };
      };
    }).buildSubagentEngine(getPiCodingAgent() as never);
    const subagentMcp = subagentEngine.buildAgentToolset({ agentId: 'a1', agentName: 'general-purpose', mcpDisallowed: new Set() }).mcp;
    expect([...subagentMcp.directGroups]).toEqual(['git']);

    const teamMcp = teamEngine.buildAgentToolset(teamCtx('agent-1')).mcp;
    const nested = nestedTeamPi([TOOL_TOOL_SEARCH, 'mcp__git__status', 'mcp__git__commit', 'mcp__docs__search']);
    teamEngine.buildExtensionFactory(teamCtx('agent-1'), teamMcp, false)(nested.api);
    const tool = nested.registered.get(TOOL_TOOL_SEARCH)!;
    const result = (await tool.execute('tc-1', { tools: ['git'] }, undefined, undefined, teamExecCtx)) as { content: Array<{ text: string }> };

    expect(result.content[0]!.text).toContain('Always loaded, no loading needed: git');
    expect(result.content[0]!.text).not.toContain('Unknown entries');

    cfg.mockRestore();
    await session.dispose();
  });

  it('criterion 4: `{tools:["git"]}` activates the specialist git tools, additively, and they EXECUTE', async () => {
    const { session, cfg } = await teamSessionWithMcp();
    const engine = session.buildTeamEngine();
    const { mcp } = engine.buildAgentToolset(teamCtx('agent-1'));
    // The deferred baseline a real team spawn writes: coordination tools active, MCP held back.
    const baseline = ['read', 'Edit', TOOL_TOOL_SEARCH, ...TEAM_AGENT_PI_TOOL_NAMES];
    const nested = nestedTeamPi(baseline);
    engine.buildExtensionFactory(teamCtx('agent-1'), mcp, false)(nested.api);
    for (const tool of mcp.tools) nested.registerTool(tool as unknown as NestedTool); // pi merges customTools likewise

    const tool = nested.registered.get(TOOL_TOOL_SEARCH)!;
    const result = (await tool.execute('tc-1', { tools: ['git'] }, undefined, undefined, teamExecCtx)) as {
      details?: { matches: string[] };
    };

    expect([...(result.details?.matches ?? [])].sort()).toEqual(['mcp__git__commit', 'mcp__git__status']);
    const after = nested.active();
    for (const n of mcp.names) expect(after, n).toContain(n);
    for (const n of baseline) expect(after, n).toContain(n); // strict superset — §4.5
    expect(after.length).toBeGreaterThan(baseline.length);

    // …and the activated tool is genuinely callable: it reaches `McpClientManager.callTool`.
    mcpCallTool.mockClear();
    const definition = nested.registered.get('mcp__git__commit')!;
    const controller = new AbortController();
    const callResult = (await definition.execute('tc-2', { message: 'ship it' }, controller.signal, undefined, {})) as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(mcpCallTool).toHaveBeenCalledTimes(1);
    expect(mcpCallTool.mock.calls[0]![0]).toBe('mcp__git__commit');
    expect(mcpCallTool.mock.calls[0]![1]).toEqual({ message: 'ship it' });
    expect((mcpCallTool.mock.calls[0]![2] as { signal?: AbortSignal }).signal).toBe(controller.signal);
    expect(callResult.content).toEqual([{ type: 'text', text: 'result of mcp__git__commit' }]);

    cfg.mockRestore();
    await session.dispose();
  });

  it('criterion 14: every team_* tool is ACTIVE from turn one while the MCP tools are deferred', async () => {
    // A specialist must be able to post to the scratchpad on its first step. `deferredToolNames`
    // intersects with browser ∪ compass ∪ web ∪ mcp, so no `team_*` name can be deferrable — no special
    // case, which is exactly what this pins. The MCP half is asserted in the SAME test so the two
    // cannot drift: "team tools active" alone is satisfied by not deferring anything at all.
    const { session, cfg } = await teamSessionWithMcp();
    const engine = session.buildTeamEngine();
    const { toolNames, mcp } = engine.buildAgentToolset(teamCtx('agent-1'));
    const eligible = [...toolNames, ...mcp.names];

    const deferrable = deferredToolNames(eligible, mcp.names);
    for (const n of TEAM_AGENT_PI_TOOL_NAMES) expect(deferrable, n).not.toContain(n);
    for (const n of mcp.names) expect(deferrable, n).toContain(n);

    // The baseline the runtime writes = eligible minus deferrable. Asserted as the real derivation.
    const baseline = eligible.filter((n) => !deferrable.includes(n));
    for (const n of teamAgentPiToolNamesForRole('specialist')) expect(baseline, n).toContain(n);
    for (const n of mcp.names) expect(baseline, n).not.toContain(n);
    expect(baseline).toContain(TOOL_TOOL_SEARCH);

    cfg.mockRestore();
    await session.dispose();
  });

  /**
   * A spawn's `tools:` names and its `customTools` definitions must be the SAME team set: pi drops a
   * name with no matching definition SILENTLY. The two halves are filtered in different modules
   * (`teamAgentToolNames` here, `buildTeamAgentPiTools` in team-tools), which is exactly why the
   * agreement is asserted through the real engine rather than read off either side.
   */
  it('registers exactly the team tools the agent ROLE may call, names and definitions alike', async () => {
    const { session, cfg } = await teamSessionWithMcp();
    const engine = session.buildTeamEngine();
    const teamOnly = (names: readonly string[]) => names.filter((n) => TEAM_AGENT_PI_TOOL_NAMES.includes(n)).sort();

    for (const role of ['lead', 'specialist'] as const) {
      const { toolNames, customTools } = engine.buildAgentToolset(teamCtx(`agent-${role}`, role));
      const expected = [...teamAgentPiToolNamesForRole(role)].sort();
      expect(teamOnly(toolNames), role).toEqual(expected);
      expect(teamOnly(customTools.map((t) => t.name)), role).toEqual(expected);
    }

    // The point of the filter: a role never carries the other role's tools, whose execute bodies throw.
    const forLead = new Set(teamAgentPiToolNamesForRole('lead'));
    const forSpecialist = new Set(teamAgentPiToolNamesForRole('specialist'));
    const specialistNames = engine.buildAgentToolset(teamCtx('agent-s', 'specialist')).toolNames;
    const leadNames = engine.buildAgentToolset(teamCtx('agent-l', 'lead')).toolNames;
    for (const n of [...forLead].filter((n) => !forSpecialist.has(n))) expect(specialistNames, n).not.toContain(n);
    for (const n of [...forSpecialist].filter((n) => !forLead.has(n))) expect(leadNames, n).not.toContain(n);

    cfg.mockRestore();
    await session.dispose();
  });

  it('a reviewer gets no write tool and a read-only flag computed from its names; an implementor is unchanged', async () => {
    const { session, cfg } = await teamSessionWithMcp();
    const engine = session.buildTeamEngine();
    const writeNames = (names: readonly string[]) => names.filter((n) => toolCategory(mapPiToolName(n)) === 'write');
    const ctx = (agentId: string, kind?: 'implementor' | 'reviewer') => ({ ...(teamCtx(agentId) as object), ...(kind ? { kind } : {}) }) as never;

    const implementor = engine.buildAgentToolset(ctx('agent-i', 'implementor'));
    const unset = engine.buildAgentToolset(ctx('agent-u'));
    const reviewer = engine.buildAgentToolset(ctx('agent-r', 'reviewer'));

    expect(writeNames(implementor.toolNames)).not.toEqual([]);
    expect(implementor.readOnly).toBe(false);
    expect(unset.toolNames).toEqual(implementor.toolNames);
    expect(writeNames(reviewer.toolNames)).toEqual([]);
    expect(reviewer.readOnly).toBe(true);
    // Only the write tools and the run-recording tool go: the reviewer keeps every other name the implementor has.
    const withheld = new Set([...writeNames(implementor.toolNames), 'team_record_verification']);
    expect(reviewer.toolNames).toEqual(implementor.toolNames.filter((n) => !withheld.has(n)));
    expect(implementor.toolNames).toContain('team_record_verification');
    expect(implementor.customTools.map((t) => t.name)).toContain('team_record_verification');
    expect(reviewer.customTools.map((t) => t.name)).not.toContain('team_record_verification');

    cfg.mockRestore();
    await session.dispose();
  });

  it("a reviewer's gate runs read-only shell commands and sends the rest to the approval flow", async () => {
    const { session, cfg } = await teamSessionWithMcp();
    const engine = session.buildTeamEngine();
    const reviewer = engine.buildAgentToolset({ ...(teamCtx('agent-r') as object), kind: 'reviewer' } as never);
    // The stub handler has no rule evaluation; a read-only verdict still consults the user's rules.
    const matchRule = vi.fn(async () => null);
    const canUseTool = vi.fn(async () => ({ behavior: 'allow' as const, updatedInput: {} }));
    Object.assign((session as unknown as { options: SessionOptions }).options.permissionHandler, { matchRule, canUseTool });
    const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>> = {};
    engine.buildExtensionFactory(teamCtx('agent-r'), reviewer.mcp, reviewer.readOnly)({
      ...(nestedTeamPi().api as object),
      on: (event: string, handler: (e: unknown, c: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>) => { handlers[event] = handler; },
    } as never);
    const call = (command: string) => handlers['tool_call']!(
      { type: 'tool_call', toolName: 'bash', toolCallId: `c-${command}`, input: { command } },
      { signal: undefined, sessionManager: { getSessionId: () => 'nested' } },
    );

    // The gate reads the settings rule once per call and hands that read to the approval flow.
    expect((await call('npm test'))?.block).toBeFalsy();
    expect(canUseTool).toHaveBeenCalledTimes(1);
    expect(canUseTool).toHaveBeenLastCalledWith('Bash', expect.anything(), expect.objectContaining({ rule: null }));
    expect((await call('git diff'))?.block).toBeFalsy();
    expect(matchRule).toHaveBeenCalledTimes(2);
    expect(canUseTool).toHaveBeenCalledTimes(1);

    cfg.mockRestore();
    await session.dispose();
  });

  it("a team agent's gate holds its shell call stoppable and hands the note to that agent's runner delivery", async () => {
    const { session, cfg } = await teamSessionWithMcp();
    const engine = session.buildTeamEngine();
    const deliverUserNote = vi.fn(() => true);
    const agent = { ...(teamCtx('agent-n') as object), deliverUserNote } as never;
    const { mcp, readOnly } = engine.buildAgentToolset(agent);
    const canUseTool = vi.fn(async () => ({ behavior: 'allow' as const, updatedInput: {} }));
    Object.assign((session as unknown as { options: SessionOptions }).options.permissionHandler, { canUseTool, matchRule: vi.fn(async () => null) });
    const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<{ block?: boolean } | undefined>> = {};
    engine.buildExtensionFactory(agent, mcp, readOnly)({
      ...(nestedTeamPi().api as object),
      on: (event: string, handler: (e: unknown, c: unknown) => Promise<{ block?: boolean } | undefined>) => { handlers[event] = handler; },
    } as never);

    const allowed = await handlers['tool_call']!(
      { type: 'tool_call', toolName: 'bash', toolCallId: 'team-call', input: { command: 'npm install' } },
      { signal: undefined, sessionManager: { getSessionId: () => 'nested' } },
    );

    expect(allowed?.block).toBeFalsy();
    expect(session.cancelToolCall('team-call', 'wrong package')).toBe(true);
    expect(deliverUserNote).toHaveBeenCalledWith('wrong package');

    cfg.mockRestore();
    await session.dispose();
  });

  it('criterion 14: a specialist cannot activate a team_* tool through ToolSearch (never deferrable)', async () => {
    const { session, cfg } = await teamSessionWithMcp();
    const engine = session.buildTeamEngine();
    const { mcp } = engine.buildAgentToolset(teamCtx('agent-1'));
    const nested = nestedTeamPi([TOOL_TOOL_SEARCH, ...TEAM_AGENT_PI_TOOL_NAMES]);
    engine.buildExtensionFactory(teamCtx('agent-1'), mcp, false)(nested.api);

    const tool = nested.registered.get(TOOL_TOOL_SEARCH)!;
    const result = (await tool.execute('tc-1', { tools: [TEAM_AGENT_PI_TOOL_NAMES[0]!] }, undefined, undefined, teamExecCtx)) as {
      details?: { matches: string[] };
      content: Array<{ text: string }>;
    };

    // Already active from turn one, so ToolSearch says so rather than resolving it.
    expect(result.details?.matches).toEqual([]);
    expect(result.content[0]!.text).toMatch(/Already active, no loading needed/);

    cfg.mockRestore();
    await session.dispose();
  });

  it('criterion 8: the specialist MCP set equals the panel eligible MCP set — uniform with subagents', async () => {
    // The team half of the uniformity claim. `buildNestedMcp` derives `eligible` from
    // `fullActiveToolNames()`, the SAME single read the `Agent`-tool subagent path uses, so "identical
    // set for the same panel state" is a property of that shared derivation rather than a coincidence
    // of two hand-maintained lists. (The Explore / general-purpose / read-only-user-agent three-way
    // comparison is in `subagents/__tests__/agent-manager.test.ts`.)
    const { session, cfg } = await teamSessionWithMcp();
    const engine = session.buildTeamEngine();

    const specialist = engine.buildAgentToolset(teamCtx('agent-1'));
    const lead = engine.buildAgentToolset(teamCtx('agent-2'));

    expect(mcpNamesOf(specialist.mcp.names)).toEqual(['mcp__git__commit', 'mcp__git__status']);
    expect(mcpNamesOf(lead.mcp.names)).toEqual(mcpNamesOf(specialist.mcp.names));
    // The gate classifier is the frozen one and agrees across agents built from the same panel state.
    expect(specialist.mcp.isReadOnly('mcp__git__status')).toBe(true);
    expect(specialist.mcp.isReadOnly('mcp__git__commit')).toBe(false);
    expect(lead.mcp.isReadOnly('mcp__git__status')).toBe(true);

    cfg.mockRestore();
    await session.dispose();
  });

  it('criterion 8, three ways: Explore, general-purpose and a team specialist get the IDENTICAL set', async () => {
    // The full uniformity claim, both spawn paths in ONE session so "the same panel state" is literal
    // rather than reconstructed. The subagent engine is private, so it is reached through the instance —
    // deliberately, because the alternative is re-deriving `buildNestedMcp` in the test, which would
    // compare the test's arithmetic against itself instead of the two production paths against each
    // other. `resolveAgentToolset` supplies each agent's REAL `mcpDisallowed` (none of these deny one).
    const { session, cfg } = await teamSessionWithMcp();
    const teamEngine = session.buildTeamEngine();
    const subagentEngine = (session as unknown as {
      buildSubagentEngine: (pi: unknown) => { buildAgentToolset: (i: { agentId: string; agentName: string; mcpDisallowed: ReadonlySet<string> }) => { mcp: { names: string[] } } };
    }).buildSubagentEngine(getPiCodingAgent() as never);

    const parent = (session as unknown as { fullActiveToolNames: () => string[] }).fullActiveToolNames();
    const explore = resolveAgentToolset(DEFAULT_AGENTS.get('Explore')!, parent);
    const general = resolveAgentToolset(DEFAULT_AGENTS.get('general-purpose')!, parent);
    // Precondition that makes this the uniformity case rather than two lookalikes: Explore uses an
    // EXPLICIT `tools:` list and holds no write tool; general-purpose is `tools: *` and holds one.
    expect(explore.names).not.toContain('Edit');
    expect(general.names).toContain('Edit');
    expect(explore.readOnly).toBe(true);

    const exploreMcp = subagentEngine.buildAgentToolset({ agentId: 'a1', agentName: 'Explore', mcpDisallowed: explore.mcpDisallowed }).mcp.names;
    const generalMcp = subagentEngine.buildAgentToolset({ agentId: 'a2', agentName: 'general-purpose', mcpDisallowed: general.mcpDisallowed }).mcp.names;
    const specialistMcp = teamEngine.buildAgentToolset(teamCtx('agent-3')).mcp.names;

    const expected = ['mcp__git__commit', 'mcp__git__status'];
    expect([...exploreMcp].sort()).toEqual(expected);
    expect([...generalMcp].sort()).toEqual(expected);
    expect([...specialistMcp].sort()).toEqual(expected);
    expect(new Set(exploreMcp)).toEqual(new Set(specialistMcp));
    expect(new Set(generalMcp)).toEqual(new Set(specialistMcp));

    cfg.mockRestore();
    await session.dispose();
  });

  it("every pi built-in override reaches the main, subagent and team toolsets under pi's own name, never excluded", async () => {
    const { session, cfg } = await teamSessionWithMcp();
    const main = H.fakePi.createAgentSessionFromServices.mock.calls.at(-1)![0] as unknown as { customTools: Array<{ name: string }>; excludeTools: string[] };
    const subagentEngine = (session as unknown as {
      buildSubagentEngine: (pi: unknown) => {
        buildAgentToolset: (i: { agentId: string; agentName: string; mcpDisallowed: ReadonlySet<string> }) => { customTools: { name: string }[] };
      };
    }).buildSubagentEngine(getPiCodingAgent() as never);
    const toolsets = {
      main: main.customTools.map((t) => t.name),
      subagent: subagentEngine.buildAgentToolset({ agentId: 'a1', agentName: 'general-purpose', mcpDisallowed: new Set<string>() }).customTools.map((t) => t.name),
      team: session.buildTeamEngine().buildAgentToolset(teamCtx('agent-1')).customTools.map((t) => t.name),
    };

    for (const [label, names] of Object.entries(toolsets)) {
      for (const name of OVERRIDE_TOOL_NAMES) expect(names, `${label} ${name}`).toContain(name);
    }
    expect(OVERRIDE_TOOL_NAMES).toContain('write');
    expect(main.excludeTools).toEqual([...PI_EXCLUDED_TOOLS]);
    for (const name of OVERRIDE_TOOL_NAMES) expect(PI_EXCLUDED_TOOLS).not.toContain(name);

    cfg.mockRestore();
    await session.dispose();
  });

  it('criterion 1, SUBAGENT path: the engine puts the snapshot`s definitions into customTools', async () => {
    // The one link `agent-manager.test.ts` cannot cover: its fake REPLACES `buildAgentToolset` with its
    // own re-implementation, so the real `[...buildSubagentCustomTools(...), ...mcp.tools]` in
    // `buildSubagentEngine` is never executed there. Deleting `...mcp.tools` used to leave the entire
    // repo green while every `Agent`-tool subagent got `mcp__*` names in `tools:` with no definitions
    // behind them — which pi drops SILENTLY. Asserted on the ENGINE's own output, at the composition
    // site, because that is the expression that can regress. (The team path has the same assertion.)
    const { session, cfg } = await teamSessionWithMcp();
    const subagentEngine = (session as unknown as {
      buildSubagentEngine: (pi: unknown) => {
        buildAgentToolset: (i: { agentId: string; agentName: string; mcpDisallowed: ReadonlySet<string> }) => {
          customTools: { name: string }[];
          mcp: { names: readonly string[] };
        };
      };
    }).buildSubagentEngine(getPiCodingAgent() as never);

    const { customTools, mcp } = subagentEngine.buildAgentToolset({
      agentId: 'a1',
      agentName: 'general-purpose',
      mcpDisallowed: new Set<string>(),
    });
    const built = customTools.map((t) => t.name);

    expect([...mcp.names].sort()).toEqual(['mcp__git__commit', 'mcp__git__status']); // not vacuous
    expect(built).toEqual(expect.arrayContaining([...mcp.names]));
    // And the non-MCP half is still there: appending must not have replaced the agent's own tools.
    expect(built).toContain(TOOL_EDIT);

    cfg.mockRestore();
    await session.dispose();
  });

  it('criterion 15: `damocles.mcp.enabled = false` removes MCP from a team specialist too', async () => {
    // Through `fullActiveToolNames()` — the single gate (`tool-status.ts:65` already does
    // `...(mcpEnabled ? mcpToolNames : [])`). `buildNestedMcp` adds no second check, deliberately, so
    // this is the one place the switch has to work and the only place it is asserted.
    const cfg = vi.spyOn(testPlatform.settings, 'get');
    let mcpEnabled = true;
    cfg.mockImplementation(settingsReader((key: string) => {
      if (key === 'damocles.mcp.enabled') return mcpEnabled;
      if (key === 'damocles.team.enabled') return true;
      if (key === 'damocles.browser.enabled') return false;
      return undefined;
    }));

    const opts = makeOptions([]);
    opts.teamService = { dispose: () => {}, cancelActiveTeam: () => {}, setRunListener: () => {}, running: false } as never;
    const session = new PiSession(opts);
    await session.initializeEarly();
    stubPanelMcp({
      allToolNames: () => MCP_DESCRIPTORS.map((d) => d.piName),
      getServerStatuses: () => [],
      getAllToolDescriptors: () => [...MCP_DESCRIPTORS],
      getToolDescriptor: (piName: string) => MCP_DESCRIPTORS.find((d) => d.piName === piName),
      callTool: mcpCallTool,
    } as unknown as McpToolSource);

    const engine = session.buildTeamEngine(); // ONE engine, built before the toggle
    const on = engine.buildAgentToolset(teamCtx('agent-1'));
    expect(mcpNamesOf(on.mcp.names)).toEqual(['mcp__git__commit', 'mcp__git__status']); // precondition

    mcpEnabled = false; // the user turns MCP off mid-run

    const off = engine.buildAgentToolset(teamCtx('agent-2'));
    expect(off.mcp.names).toEqual([]);
    expect(off.mcp.tools).toEqual([]);
    expect(mcpNamesOf(off.customTools.map((t) => t.name))).toEqual([]);
    // …and the earlier agent's frozen snapshot is untouched: the change reaches the NEXT spawn only.
    expect(mcpNamesOf(on.mcp.names)).toEqual(['mcp__git__commit', 'mcp__git__status']);

    cfg.mockRestore();
    await session.dispose();
  });

  it('criterion 15 / §4.6: ONE engine, TWO spawns across an MCP change — the second gets the NEWER set', async () => {
    // The derivation must live INSIDE the per-spawn arrow. An implementation that hoisted the snapshot
    // to `buildTeamEngine()` time would pass every single-spawn assertion above and fail only this one.
    const { session, cfg, setDescriptors } = await teamSessionWithMcp([MCP_DESCRIPTORS[0]!]);
    const engine = session.buildTeamEngine(); // built ONCE, before the change

    const first = engine.buildAgentToolset(teamCtx('agent-1'));
    expect(mcpNamesOf(first.mcp.names)).toEqual(['mcp__git__status']);

    setDescriptors(MCP_DESCRIPTORS); // a server advertises a second tool

    const second = engine.buildAgentToolset(teamCtx('agent-2'));
    expect(mcpNamesOf(second.mcp.names)).toEqual(['mcp__git__commit', 'mcp__git__status']);
    expect(mcpNamesOf(second.customTools.map((t) => t.name))).toEqual(['mcp__git__commit', 'mcp__git__status']);
    // Frozen at spawn: the first agent never sees the new tool.
    expect(mcpNamesOf(first.mcp.names)).toEqual(['mcp__git__status']);

    cfg.mockRestore();
    await session.dispose();
  });

  it('a workspace with NO MCP manager yields the empty snapshot and no MCP anywhere (no throw)', async () => {
    const cfg = vi.spyOn(testPlatform.settings, 'get');
    cfg.mockImplementation(settingsReader((key: string) => (key === 'damocles.team.enabled' ? true : undefined)));
    const opts = makeOptions([]);
    opts.teamService = { dispose: () => {}, cancelActiveTeam: () => {}, setRunListener: () => {}, running: false } as never;
    const session = new PiSession(opts);
    await session.initializeEarly();
    stubPanelMcp(null);

    const engine = session.buildTeamEngine();
    let built!: ReturnType<typeof engine.buildAgentToolset>;
    expect(() => { built = engine.buildAgentToolset(teamCtx('agent-1')); }).not.toThrow();

    expect(built.mcp.names).toEqual([]);
    expect(built.mcp.tools).toEqual([]);
    expect(built.mcp.isReadOnly('mcp__git__status')).toBe(false);
    expect(mcpNamesOf(built.toolNames)).toEqual([]);
    // The team_* tools are still there — no MCP must never mean no team agent.
    for (const n of teamAgentPiToolNamesForRole('specialist')) expect(built.customTools.map((t) => t.name), n).toContain(n);

    cfg.mockRestore();
    await session.dispose();
  });

  /**
   * Slice 2 — the spawn seam. A team agent's MCP tools must be handed the PARENT panel's bridge,
   * attributed to that agent, and that bridge must be reachable again at teardown and at dispose.
   * Asserted through the real `PiSession`, because "who is this dialog for?" is decided here.
   */
  const uiRequests = (messages: ExtensionToWebviewMessage[]) =>
    messages.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'extensionUiRequest' }> => m.type === 'extensionUiRequest');
  const uiCancels = (messages: ExtensionToWebviewMessage[]) =>
    messages.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'extensionUiCancel' }> => m.type === 'extensionUiCancel');
  /** pi's own shape for an UNBOUND session: a TRUTHY ui whose select resolves undefined, hasUI false. */
  const unboundCtx = { ui: { select: async () => undefined, input: async () => undefined, notify: () => {} }, hasUI: false };

  async function openNestedDialog(agentId: string) {
    const messages: ExtensionToWebviewMessage[] = [];
    const { session, cfg } = await teamSessionWithMcp(MCP_DESCRIPTORS, { browser: false, team: true }, messages);
    const engine = session.buildTeamEngine();
    const { customTools } = engine.buildAgentToolset(teamCtx(agentId));
    const status = customTools.find((t) => t.name === 'mcp__git__status')!;

    await (status.execute as unknown as (
      id: string, p: unknown, s: undefined, u: undefined, c: unknown,
    ) => Promise<unknown>)('tc-1', {}, undefined, undefined, unboundCtx);

    const opts = mcpCallTool.mock.calls.at(-1)![2] as { elicitationUi?: { select: (t: string, o: string[]) => Promise<string | undefined> } };
    // The agent's tools got a bridge even though pi handed them a no-op UI — the whole point.
    expect('elicitationUi' in opts).toBe(true);
    const pending = opts.elicitationUi!.select('MCP Input Request', ['Continue', 'Decline']);
    return { session, cfg, engine, messages, pending };
  }

  it('Slice 2 criterion 1: a specialist MCP elicitation reaches the PARENT panel, attributed', async () => {
    const { session, cfg, messages, pending } = await openNestedDialog('agent-1');

    expect(uiRequests(messages)).toHaveLength(1);
    expect(uiRequests(messages)[0]).toMatchObject({ agentId: 'agent-1', agentName: 'specialist', teamId: 'team-1' });

    // …and the panel answers it through the SAME `resolve` the webview response path uses.
    session.resolveExtensionUiResponse(uiRequests(messages)[0]!.requestId, 'Continue');
    await expect(pending).resolves.toBe('Continue');

    cfg.mockRestore();
    await session.dispose();
  });

  it('Slice 2 criterion 5: the engine teardown hook withdraws that agent dialog', async () => {
    const { session, cfg, engine, messages, pending } = await openNestedDialog('agent-1');
    const requestId = uiRequests(messages)[0]!.requestId;

    engine.cancelAgentDialogs('agent-1');

    expect(uiCancels(messages).map((m) => m.requestId)).toEqual([requestId]);
    await expect(pending).resolves.toBeUndefined(); // the awaiting MCP call is released, not hung

    cfg.mockRestore();
    await session.dispose();
  });

  it('Slice 2 criterion 6 (G5): disposing the panel cancels an in-flight NESTED dialog', async () => {
    // The teardown path that gets forgotten. `dispose()` already cancelled the panel's own dialogs;
    // nested ones live in the same map and must go with them — and the webview must be told.
    const { session, cfg, messages, pending } = await openNestedDialog('agent-1');
    const requestId = uiRequests(messages)[0]!.requestId;

    await session.dispose();

    expect(uiCancels(messages).map((m) => m.requestId)).toEqual([requestId]);
    await expect(pending).resolves.toBeUndefined();

    cfg.mockRestore();
  });
});

describe('PiSession auto-title — no write through a session replaced mid-completion (US-012)', () => {
  beforeEach(() => {
    H.seq.length = 0;
    H.captured.services.length = 0;
    H.resetServices();
    TITLE.impl = async () => null;
  });
  afterEach(async () => {
    TITLE.impl = async () => null;
    await PiRuntime.disposeInstance();
  });

  /** A title sub-call the test settles by hand, so the replacement lands inside the async window. */
  function deferredTitle(): { resolve: (title: string) => void } {
    let release!: (title: string) => void;
    const pending = new Promise<string>((r) => { release = r; });
    TITLE.impl = () => pending;
    return { resolve: (title) => release(title) };
  }

  it('names the session when it is still the live one', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const gate = deferredTitle();

    await session.sendMessage('go', undefined, 'c1', { content: 'go' });
    const live = H.getLastSession()!;
    gate.resolve('Fix The Parser');
    await new Promise((r) => setTimeout(r, 0));

    expect(live.setSessionName).toHaveBeenCalledWith('Fix The Parser');
    await session.dispose();
  });

  it('drops the title when a reset replaced the session during the completion', async () => {
    // The resurrection bug: reset()/delete disposes the old AgentSession and its file is removed, but
    // its SessionManager still believes it flushed — so a late setSessionName() appends past the rm and
    // recreates the file holding only that `session_info` line, which no reader can parse afterwards.
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const gate = deferredTitle();

    await session.sendMessage('go', undefined, 'c1', { content: 'go' });
    const first = H.getLastSession()!;

    session.reset();
    await session.whenReplaced();
    expect(H.getLastSession()).not.toBe(first);

    gate.resolve('Fix The Parser');
    await new Promise((r) => setTimeout(r, 0));

    expect(first.setSessionName).not.toHaveBeenCalled();
    await session.dispose();
  });

  it('detachFromDeletedSession replaces the session and clears its OWN webview', async () => {
    // The panel that owns a deleted session is often not the one the user clicked in, so the clear
    // has to go out through this panel's own message sink, not the deleting panel's host.
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const first = H.getLastSession();

    await session.detachFromDeletedSession();

    // Resolved only once the replacement is installed — the old manager can no longer append, which is
    // what makes the subsequent rm safe.
    expect(H.getLastSession()).not.toBe(first);
    expect(messages.filter((m) => m.type === 'sessionCleared')).toHaveLength(1);
    expect(messages.filter((m) => m.type === 'processing' && !m.isProcessing)).toHaveLength(1);
    await session.dispose();
  });

  it('drops the title when the panel was disposed during the completion', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const gate = deferredTitle();

    await session.sendMessage('go', undefined, 'c1', { content: 'go' });
    const live = H.getLastSession()!;

    await session.dispose();
    gate.resolve('Fix The Parser');
    await new Promise((r) => setTimeout(r, 0));

    expect(live.setSessionName).not.toHaveBeenCalled();
  });
});

describe('PiSession — the on-disk invariant, against a REAL pi SessionManager', () => {
  // The mocked harness can only prove the guard is reached. These drive the actual dependency on a
  // tmpdir, so what is asserted is the thing that matters: no file is recreated after the rm.
  let dir: string;

  beforeEach(() => {
    H.seq.length = 0;
    H.captured.services.length = 0;
    H.resetServices();
    TITLE.impl = async () => null;
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'damocles-session-'));
  });
  afterEach(async () => {
    H.setSessionManagerFactory(null);
    TITLE.impl = async () => null;
    await PiRuntime.disposeInstance();
    fsSync.rmSync(dir, { recursive: true, force: true });
  });

  async function seededManager(): Promise<{ sm: { getSessionFile(): string | undefined }; file: string }> {
    const sm = realPi.SessionManager.create('/cwd', dir);
    // pi buffers until a user or assistant message exists, so the prompt alone flips it to flushed = true
    // and puts the file on disk: a first turn that fails before any reply already meets the precondition.
    sm.appendMessage({ role: 'user', content: 'hello world' } as never);
    expect(fsSync.existsSync(sm.getSessionFile()!)).toBe(true);
    return { sm, file: sm.getSessionFile()! };
  }

  it('characterises the hazard: pi appends to a path it no longer has, recreating it unreadable', async () => {
    // Not a test of our code — a pin on the dependency behaviour the guards exist for. If pi ever
    // makes `_persist` re-check the file, this fails and the guards can be reconsidered.
    const { sm, file } = await seededManager();
    expect(fsSync.existsSync(file)).toBe(true);

    fsSync.rmSync(file);
    (sm as unknown as { appendSessionInfo(n: string): void }).appendSessionInfo('Late Title');

    expect(fsSync.existsSync(file)).toBe(true);
    const lines = fsSync.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).type).toBe('session_info');
    // …and that one-liner is what poisons every later read of the store.
    expect(() => realPi.SessionManager.open(file, dir)).toThrow(/not a valid pi session/);
  });

  it('a title landing after the file was deleted does NOT recreate it', async () => {
    const { file } = await seededManager();
    // The panel's live session opens that same real file, so its writes are real writes.
    H.setSessionManagerFactory(() => realPi.SessionManager.open(file, dir));

    let release!: (t: string) => void;
    TITLE.impl = () => new Promise<string>((r) => { release = r; });

    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    expect(live.sessionManager.getSessionFile()).toBe(file);

    await session.sendMessage('go', undefined, 'c1', { content: 'go' });

    // The delete path, in order: every holder detaches, THEN the file goes.
    await session.detachFromDeletedSession();
    fsSync.rmSync(file);

    release('Fix The Parser');
    await new Promise((r) => setTimeout(r, 0));

    expect(fsSync.existsSync(file)).toBe(false);
    await session.dispose();
  });

  it('a Stop records what it cut short, so a reload replays the call as abandoned and hides the wind-down error', async () => {
    const { file } = await seededManager();
    const live = realPi.SessionManager.open(file, dir);
    live.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'tc-1', name: 'read', arguments: { path: 'README.md' } }], stopReason: 'toolUse', timestamp: 0 } as never);
    live.appendMessage({ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'An earlier failure', timestamp: 0 } as never);
    H.setSessionManagerFactory(() => live);
    H.setSessionSetup((s) => { (s as unknown as { sessionId: string }).sessionId = live.getSessionId(); });
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    H.fireEvent({ type: 'tool_execution_start', toolCallId: 'tc-1', toolName: 'read', args: { path: 'README.md' } });
    // What pi writes after the abort signal: the call's aborted result, then the request it cut off.
    H.getLastSession()!.abort.mockImplementation(async () => {
      live.appendMessage({ role: 'toolResult', toolCallId: 'tc-1', toolName: 'read', content: [{ type: 'text', text: 'Operation aborted' }], isError: true, timestamp: 0 } as never);
      live.appendMessage({ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'This operation was aborted', timestamp: 0 } as never);
    });

    await session.interrupt();

    const { messages } = reconstructMessages(realPi.SessionManager.open(file, dir).getBranch());
    const tool = messages.flatMap((m) => (m.kind === 'assistant' ? m.tools : [])).find((t) => t.id === 'tc-1');
    expect(tool).toMatchObject({ stopped: true, isError: true });
    expect(messages.filter((m) => m.kind === 'error')).toEqual([{ kind: 'error', content: 'An earlier failure' }]);
    await session.dispose();
  });

  it('a Stop that settles after the session was deleted records nothing, so the file stays gone', async () => {
    const { file } = await seededManager();
    H.setSessionManagerFactory(() => realPi.SessionManager.open(file, dir));
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    H.fireEvent({ type: 'tool_execution_start', toolCallId: 'tc-1', toolName: 'read', args: { path: 'README.md' } });
    // pi's abort() waits for the one wind-down however many callers ask, the replacement included.
    let settle!: () => void;
    const windDown = new Promise<undefined>((resolve) => { settle = () => resolve(undefined); });
    H.getLastSession()!.abort.mockImplementation(() => windDown);

    const stopping = session.interrupt();
    const detaching = session.detachFromDeletedSession();
    settle();
    await Promise.all([stopping, detaching]);
    fsSync.rmSync(file);
    await new Promise((r) => setTimeout(r, 0));

    expect(fsSync.existsSync(file)).toBe(false);
    await session.dispose();
  });

  it('a lost session lease stops the manager writing at once, then detaches and tells the user', async () => {
    const { file } = await seededManager();
    const live = realPi.SessionManager.open(file, dir);
    H.setSessionManagerFactory(() => live);
    H.setSessionSetup((s) => { (s as unknown as { sessionId: string }).sessionId = live.getSessionId(); });
    const warn = vi.spyOn(testPlatform.notifications, 'warn');
    const messages: ExtensionToWebviewMessage[] = [];
    try {
      const session = new PiSession(makeOptions(messages));
      await session.initializeEarly();
      const first = H.getLastSession();
      const before = fsSync.readFileSync(file, 'utf8');

      session.onSessionLeaseLost(live.getSessionId());
      // Another process owns the file now; this manager's next append must not reach it.
      live.appendSessionInfo('Written after the lease was lost');
      expect(fsSync.readFileSync(file, 'utf8')).toBe(before);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('another Damocles window'));

      await vi.waitFor(() => expect(messages.some((m) => m.type === 'sessionCleared')).toBe(true));
      expect(H.getLastSession()).not.toBe(first);
      await session.dispose();
    } finally {
      H.setSessionSetup(null);
      warn.mockRestore();
    }
  });

  it('a handover another process asked for stops the turn and lets every write land before the lease goes', async () => {
    const { file } = await seededManager();
    const live = realPi.SessionManager.open(file, dir);
    live.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'tc-1', name: 'read', arguments: { path: 'README.md' } }], stopReason: 'toolUse', timestamp: 0 } as never);
    H.setSessionManagerFactory(() => live);
    // Only the stored session has its id; the fresh one the detach installs gets its own, as pi's newSession does.
    let made = 0;
    H.setSessionSetup((s) => { if (made++ === 0) (s as unknown as { sessionId: string }).sessionId = live.getSessionId(); });
    const warn = vi.spyOn(testPlatform.notifications, 'warn');
    const messages: ExtensionToWebviewMessage[] = [];
    const sessionId = live.getSessionId();
    const leaseHeld = (): boolean => fsSync.existsSync(sessionLeasePath(sessionId));
    const order: string[] = [];
    const record = (step: string): void => { if (order.at(-1) !== step) order.push(step); };
    try {
      const session = new PiSession(makeOptions(messages));
      await session.initializeEarly();
      expect(sessionLeasesOf(session)).toEqual([sessionId]);
      const first = H.getLastSession()!;
      (first as { isStreaming: boolean }).isStreaming = true;
      H.fireEvent({ type: 'tool_execution_start', toolCallId: 'tc-1', toolName: 'read', args: { path: 'README.md' } });
      first.abort.mockImplementation(async () => {
        record(`abort, lease held ${leaseHeld()}`);
        if (!first.isStreaming) return;
        live.appendMessage({ role: 'toolResult', toolCallId: 'tc-1', toolName: 'read', content: [{ type: 'text', text: 'Operation aborted' }], isError: true, timestamp: 0 } as never);
        (first as { isStreaming: boolean }).isStreaming = false;
      });
      const service = (session as unknown as { checkpointService: CheckpointService }).checkpointService;
      vi.spyOn(service, 'drain').mockImplementation(async () => { record(`drain, lease held ${leaseHeld()}`); });
      let settleAgents!: () => void;
      const agents = new Promise<void>((resolve) => { settleAgents = resolve; });
      const manager = (session as unknown as { subagentManager: { whenRunsSettled: () => Promise<void> } }).subagentManager;
      manager.whenRunsSettled = () => agents.then(() => record(`agents settled, lease held ${leaseHeld()}`));

      const handover = session.onSessionReleaseRequested(sessionId);
      await vi.waitFor(() => expect(messages.some((m) => m.type === 'sessionCleared')).toBe(true));
      // Replaced, but the aborted agents still write under the session's folder: the lease stays, and no panel here can take it.
      expect(H.getLastSession()).not.toBe(first);
      expect(leaseHeld()).toBe(true);
      expect(sessionLeaseBlocker(sessionId)).toEqual({ kind: 'writing' });
      expect(warn).not.toHaveBeenCalled();
      settleAgents();
      await handover;

      expect(order).toEqual(['abort, lease held true', 'drain, lease held true', 'agents settled, lease held true']);
      expect(leaseHeld()).toBe(false);
      expect(fsSync.existsSync(path.join(SESSION_LEASE_DIR, `${sessionId}.owner`))).toBe(false);
      expect(warn).toHaveBeenCalledWith('This conversation was opened in another Damocles window, so this panel closed it.');
      expect(messages.filter((m) => m.type === 'processing' && !m.isProcessing).length).toBeGreaterThan(0);
      // The Stop path ran, so a reload in the other window shows the cut-off call as stopped.
      const { messages: replayed } = reconstructMessages(realPi.SessionManager.open(file, dir).getBranch());
      expect(replayed.flatMap((m) => (m.kind === 'assistant' ? m.tools : [])).find((t) => t.id === 'tc-1')).toMatchObject({ stopped: true });
      const released = fsSync.readFileSync(file, 'utf8');
      await new Promise((r) => setTimeout(r, 0));
      expect(fsSync.readFileSync(file, 'utf8')).toBe(released);
      expect(sessionLeasesOf(session)).not.toContain(sessionId);
      await session.dispose();
    } finally {
      H.setSessionSetup(null);
      warn.mockRestore();
    }
  });

  it('a handover that fails to replace the session keeps the lease, since the old session is still installed and writable', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const sessionId = live.sessionId;
    const runtime = (session as unknown as { runtime: { newSession: () => Promise<unknown> } }).runtime;
    runtime.newSession = async () => { throw new Error('factory boom'); };
    const warn = vi.spyOn(testPlatform.notifications, 'warn');
    try {
      await expect(session.onSessionReleaseRequested(sessionId)).rejects.toThrow('factory boom');

      expect(H.getLastSession()).toBe(live);
      expect(sessionLeasesOf(session)).toEqual([sessionId]);
      expect(fsSync.existsSync(sessionLeasePath(sessionId))).toBe(true);
      // The writer left with the failed handover, so this panel's own hold is all that remains.
      expect(sessionLeaseBlocker(sessionId)).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await session.dispose();
    }
  });

  it('a handover that meets a dispose leaves the detach to it, replaces nothing, and releases the lease once', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const sessionId = live.sessionId;
    (live as { isStreaming: boolean }).isStreaming = true;
    // pi's abort() waits for the one wind-down however many callers ask.
    let windDown!: () => void;
    const wound = new Promise<undefined>((resolve) => { windDown = () => resolve(undefined); });
    live.abort.mockImplementation(() => wound);
    const warn = vi.spyOn(testPlatform.notifications, 'warn');
    try {
      const handover = session.onSessionReleaseRequested(sessionId);
      await new Promise((r) => setTimeout(r, 0));
      const disposing = session.dispose();
      await new Promise((r) => setTimeout(r, 0));
      expect(fsSync.existsSync(sessionLeasePath(sessionId))).toBe(true);
      windDown();
      await Promise.all([handover, disposing]);

      expect(fsSync.existsSync(sessionLeasePath(sessionId))).toBe(false);
      expect(warn).not.toHaveBeenCalled();
      // Nothing replaced the session of the panel being torn down.
      expect(H.getLastSession()).toBe(live);
      await expect(session.onSessionReleaseRequested(sessionId)).resolves.toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  describe("a prompt's sidecars land when pi commits its entry", () => {
    const output = (text: string) => ({ source: 'command' as const, commandLine: 'npm test', exitCode: 1, terminalTitle: 'pwsh', text, omittedLines: 0 });
    const blocks = [output('FAIL a.test.ts'), output('FAIL b.test.ts')].map(formatTerminalAttachmentBlock).join('\n');
    const info = (id: string) => ({ id, source: 'command' as const, commandLine: 'npm test', exitCode: 1, terminalTitle: 'pwsh', lineCount: 1, omittedLines: 0, preview: 'FAIL' });
    const TWO_ATTACHED = [info('t1'), info('t2')];

    async function panelOn(file: string, messages: ExtensionToWebviewMessage[] = []): Promise<{ session: PiSession; pi: NonNullable<ReturnType<typeof H.getLastSession>>; live: realPi.SessionManager }> {
      const live = realPi.SessionManager.open(file, dir);
      H.setSessionManagerFactory(() => live);
      const session = new PiSession(makeOptions(messages));
      await session.initializeEarly();
      return { session, pi: H.getLastSession()!, live };
    }

    /** What pi does with a user message it delivers: listeners see its message_end, then pi appends that same object. */
    function piCommits(live: realPi.SessionManager, text: string): void {
      const message = { role: 'user', content: [{ type: 'text', text }], timestamp: 0 };
      H.fireEvent({ type: 'message_end', message });
      live.appendMessage(message as never);
    }

    const lastReplayedUser = (file: string) => {
      const replayed = reconstructMessages(realPi.SessionManager.open(file, dir).getBranch()).messages.filter((m) => m.kind === 'user').at(-1);
      if (replayed?.kind !== 'user') throw new Error('no user message');
      return replayed;
    };

    it('a prompt pi queues into the running run reloads as the typed text and its chips once pi delivers it', async () => {
      const { file } = await seededManager();
      const { session, pi, live } = await panelOn(file);
      const followUps: string[] = [];
      Object.assign(pi, { isStreaming: true, getFollowUpMessages: () => followUps });
      (pi.prompt as ReturnType<typeof vi.fn>).mockImplementation(async (text: string, opts: { preflightResult: (d: string) => void }) => {
        followUps.push(text);
        opts.preflightResult('queued');
      });

      expect(await session.sendMessage(`${blocks}\nwhat failed?`, undefined, 'c1', { content: 'what failed?', terminalAttachments: TWO_ATTACHED })).toBe('sent');
      piCommits(live, followUps.shift()!);
      await Promise.resolve();

      const replayed = lastReplayedUser(file);
      expect(replayed.content).toBe('what failed?');
      expect(replayed.terminalAttachments).toHaveLength(2);
      await session.dispose();
    });

    it('a queued prompt a Stop withdrew leaves nothing behind, even for a later entry with its text', async () => {
      const { file } = await seededManager();
      const { session, pi, live } = await panelOn(file);
      const followUps: string[] = [];
      const sent = `${blocks}\nwhat failed?`;
      Object.assign(pi, { isStreaming: true, getFollowUpMessages: () => followUps });
      (pi.prompt as ReturnType<typeof vi.fn>).mockImplementationOnce(async (text: string, opts: { preflightResult: (d: string) => void }) => {
        followUps.push(text);
        opts.preflightResult('queued');
      });
      await session.sendMessage(sent, undefined, 'c1', { content: 'what failed?', terminalAttachments: TWO_ATTACHED });
      await session.interrupt();
      followUps.length = 0;
      Object.assign(pi, { isStreaming: false });

      // The user then types the wrapper text itself, which pi runs as a prompt of its own.
      (pi.prompt as ReturnType<typeof vi.fn>).mockImplementationOnce(async (text: string, opts: { preflightResult: (d: string) => void }) => {
        opts.preflightResult('started');
        piCommits(live, text);
        await Promise.resolve();
      });
      await session.sendMessage(sent, undefined, 'c2', { content: sent });

      const replayed = lastReplayedUser(file);
      expect(replayed.content).toBe(sent);
      expect(replayed.terminalAttachments).toBeUndefined();
      await session.dispose();
    });

    const IMAGE = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'iVBORw0KGgo=' } };
    const TYPED = [{ type: 'text' as const, text: 'what failed?' }, IMAGE];
    const SENT = [{ type: 'text' as const, text: blocks }, ...TYPED];
    const BROADCAST = { content: 'what failed?', contentBlocks: TYPED, terminalAttachments: TWO_ATTACHED };
    const sidecarsIn = (file: string) =>
      realPi.SessionManager.open(file, dir).getEntries().flatMap((e) => (e.type === 'custom' && ['damocles-terminal-attachments', 'damocles-original-input'].includes(e.customType) ? [e.customType] : []));

    /** pi's queue while a run streams: `prompt()` pushes the text onto the follow-ups and reports `queued`, `clearQueue()` empties it. */
    function queuesFollowUps(pi: NonNullable<ReturnType<typeof H.getLastSession>>): string[] {
      const followUps: string[] = [];
      Object.assign(pi, { isStreaming: true, getFollowUpMessages: () => followUps });
      (pi.clearQueue as ReturnType<typeof vi.fn>).mockImplementation(() => ({ steering: [], followUp: followUps.splice(0) }));
      (pi.prompt as ReturnType<typeof vi.fn>).mockImplementation(async (text: string, opts: { preflightResult: (d: string) => void }) => {
        followUps.push(text);
        opts.preflightResult('queued');
      });
      return followUps;
    }

    it('a queued prompt a Stop withdrew goes back to the composer with its text, image and chips, its echo withdrawn and no sidecar written', async () => {
      const { file } = await seededManager();
      const messages: ExtensionToWebviewMessage[] = [];
      const { session, pi, live } = await panelOn(file, messages);
      const followUps = queuesFollowUps(pi);
      let windDown!: () => void;
      const wound = new Promise<void>((resolve) => { windDown = resolve; });
      (pi.abort as ReturnType<typeof vi.fn>).mockImplementation(() => wound);
      const withdrawn = vi.fn();

      expect(await session.sendMessage(SENT, undefined, 'c1', BROADCAST, withdrawn)).toBe('sent');
      expect(messages).toContainEqual(expect.objectContaining({ type: 'userMessage', correlationId: 'c1', contentBlocks: TYPED, terminalAttachments: TWO_ATTACHED }));
      expect(withdrawn).not.toHaveBeenCalled();
      const stopped = session.interrupt();

      // Back at the Stop, not once a slow tool lets the run wind down.
      expect(followUps).toEqual([]);
      expect(withdrawn).toHaveBeenCalledOnce();
      // The webview takes the echo out and puts its typed text and image back in the composer.
      expect(messages.filter((m) => m.type === 'queueCancelled')).toEqual([{ type: 'queueCancelled', messageId: 'c1', returnToInput: true }]);
      piCommits(live, `${blocks}\nwhat failed?`);
      await Promise.resolve();
      expect(sidecarsIn(file)).toEqual([]);
      windDown();
      await stopped;
      await session.dispose();
    });

    it('a queued prompt a new chat drops goes back to the composer with its chips', async () => {
      const { file } = await seededManager();
      const messages: ExtensionToWebviewMessage[] = [];
      const { session, pi } = await panelOn(file, messages);
      queuesFollowUps(pi);
      const withdrawn = vi.fn();
      await session.sendMessage(SENT, undefined, 'c1', BROADCAST, withdrawn);

      session.clear();

      expect(withdrawn).toHaveBeenCalledOnce();
      expect(messages.filter((m) => m.type === 'queueCancelled')).toEqual([{ type: 'queueCancelled', messageId: 'c1', returnToInput: true }]);
      await session.whenReplaced().catch(() => undefined);
      await session.dispose();
    });

    it('a prompt pi queues into a run a Stop stopped while its input handlers ran is taken back out at once', async () => {
      const { file } = await seededManager();
      const messages: ExtensionToWebviewMessage[] = [];
      const { session, pi } = await panelOn(file, messages);
      const followUps = queuesFollowUps(pi);
      // pi's abort() waits for the one wind-down however many callers ask.
      let windDown!: () => void;
      const wound = new Promise<void>((resolve) => { windDown = resolve; });
      (pi.abort as ReturnType<typeof vi.fn>).mockImplementation(() => wound);
      (pi.prompt as ReturnType<typeof vi.fn>).mockImplementationOnce(async (text: string, opts: { preflightResult: (d: string) => void }) => {
        void session.interrupt();
        followUps.push(text);
        opts.preflightResult('queued');
      });
      const withdrawn = vi.fn();

      await session.sendMessage(SENT, undefined, 'c1', BROADCAST, withdrawn);

      // Still winding down: nothing but this prompt would take it out of pi's queue before the stopped run settles.
      expect(followUps).toEqual([]);
      expect(withdrawn).toHaveBeenCalledOnce();
      expect(messages.filter((m) => m.type === 'queueCancelled')).toEqual([{ type: 'queueCancelled', messageId: 'c1', returnToInput: true }]);
      windDown();
      await session.dispose();
    });

    it.each([
      ['pi expanded', '/review src', 'review prompt body src', undefined],
      ['Damocles expanded behind attachments', `${blocks}\nreview prompt body src`, `${blocks}\nreview prompt body src`, TWO_ATTACHED],
    ])('a template turn stopped after its prompt committed reloads as what the user typed (%s)', async (_how, sent, stored, attachments) => {
      const { file } = await seededManager();
      const { session, pi, live } = await panelOn(file);
      (pi.prompt as ReturnType<typeof vi.fn>).mockImplementation(async (_text: string, opts: { preflightResult: (d: string) => void }) => {
        opts.preflightResult('started');
        piCommits(live, stored);
        await Promise.resolve();
        await session.interrupt();
        throw new Error('This operation was aborted');
      });

      await session.sendMessage(sent, undefined, 'c1', { content: '/review src', ...(attachments ? { terminalAttachments: attachments } : {}) });

      const replayed = lastReplayedUser(file);
      expect(replayed.content).toBe('/review src');
      expect(replayed.terminalAttachments?.length ?? 0).toBe(attachments?.length ?? 0);
      await session.dispose();
    });
  });
});

describe('PiSession session-replacement contract (what a destructive delete is sequenced off)', () => {
  beforeEach(() => {
    H.seq.length = 0;
    H.captured.services.length = 0;
    H.resetServices();
  });
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  /** Park the next runtime build so a panel can be observed while `start()` is still in flight. */
  function parkNextStart(): { release: () => void } {
    const base = H.fakePi.createAgentSessionRuntime.getMockImplementation()!;
    let release!: () => void;
    const parked = new Promise<void>((r) => { release = r; });
    H.fakePi.createAgentSessionRuntime.mockImplementationOnce(async (...args) => {
      await parked;
      return base(...args);
    });
    return { release };
  }

  it('detach waits for an in-flight start(), so a resuming panel really lets go', async () => {
    // The gap this closes: mid-`start()` there is no runtime, so reset() bails and whenReplaced()
    // resolves at once — while start() goes on to open a manager on the path about to be removed.
    const gate = parkNextStart();
    const session = new PiSession(makeOptions([]));
    const starting = session.initializeEarly();
    await tick();

    const detaching = session.detachFromDeletedSession();
    gate.release();
    await detaching;
    await starting;

    // Two binds, each subscribing the adapter and the image cache: the one start() made, and the
    // replacement that detach forced. Without the wait there is only start()'s, and the panel is left live on the deleted file.
    expect(H.seq.filter((s) => s === 'subscribe')).toHaveLength(4);
  });

  it('a resume that lands while start() builds the runtime switches to it once the runtime exists', async () => {
    const gate = parkNextStart();
    const session = new PiSession(makeOptions([]));
    const switchTo = vi.spyOn(session as unknown as { switchToResumeTarget: (id: string) => Promise<void> }, 'switchToResumeTarget')
      .mockResolvedValue(undefined);
    const starting = session.initializeEarly();
    await tick();

    session.setResumeSession('sess-late');
    gate.release();
    await starting;
    await session.whenReplaced();

    expect(switchTo).toHaveBeenCalledWith('sess-late');
    await session.dispose();
  });

  it('whenReplaced() rejects when the replacement threw — the old session is still installed', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const runtime = (session as unknown as { runtime: { newSession: () => Promise<unknown> } }).runtime;
    const good = runtime.newSession.bind(runtime);
    runtime.newSession = async () => { throw new Error('factory boom'); };

    await expect(session.detachFromDeletedSession()).rejects.toThrow('factory boom');

    // …and one failure must not poison every later replacement (the chain re-serialises, it doesn't
    // inherit the rejection).
    runtime.newSession = good;
    session.reset();
    await expect(session.whenReplaced()).resolves.toBeUndefined();
    await session.dispose();
  });

  it('whenReplaced() rejects when a before-switch handler cancelled the replacement', async () => {
    // pi returns `{ cancelled: true }` WITHOUT tearing the old session down. Reported as success, that
    // is a live writer plus a deleted file.
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const runtime = (session as unknown as { runtime: { newSession: () => Promise<unknown> } }).runtime;
    runtime.newSession = async () => ({ cancelled: true });

    await expect(session.detachFromDeletedSession()).rejects.toThrow(/cancelled/);
    await session.dispose();
  });

  /** Hold the panel's subagent runs open until the returned release is called. */
  function holdSubagentRuns(session: PiSession): { release: () => void } {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const manager = (session as unknown as { subagentManager: { whenRunsSettled: () => Promise<void> } }).subagentManager;
    manager.whenRunsSettled = () => held;
    return { release };
  }

  it('detach resolves only once the agents it aborted have stopped writing', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const runs = holdSubagentRuns(session);

    let detached = false;
    const detaching = session.detachFromDeletedSession().then(() => { detached = true; });
    await session.whenReplaced();
    await tick();
    expect(detached).toBe(false);

    runs.release();
    await detaching;
    expect(detached).toBe(true);
    await session.dispose();
  });

  it('detach gives up on an aborted agent that never settles, so the delete is not blocked forever', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    holdSubagentRuns(session);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const detaching = session.detachFromDeletedSession();
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(detaching).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    await session.dispose();
  });
});

describe('PiSession teardown order: the turn stops before anything is let go', () => {
  beforeEach(() => {
    H.seq.length = 0;
    H.captured.services.length = 0;
    H.resetServices();
  });
  afterEach(async () => {
    H.setSessionSetup(null);
    H.setSessionManagerFactory(null);
    await PiRuntime.disposeInstance();
  });

  type Registries = { _panelRegistry: Map<string, unknown>; _checkpointRegistry: Map<string, unknown> };
  const registries = (): Registries => cwdFolder() as unknown as Registries;
  const serviceOf = (session: PiSession): CheckpointService => (session as unknown as { checkpointService: CheckpointService }).checkpointService;

  it('reset aborts the running turn before the checkpoint drain and the replacement', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const order: string[] = [];
    live.abort.mockImplementation(async () => { order.push('abort'); });
    vi.spyOn(serviceOf(session), 'drain').mockImplementation(async () => { order.push('drain'); });
    const runtime = (session as unknown as { runtime: { newSession: () => Promise<{ cancelled: boolean }> } }).runtime;
    const newSession = runtime.newSession.bind(runtime);
    runtime.newSession = async () => { order.push('newSession'); return newSession(); };

    session.reset();
    await session.whenReplaced();

    expect(order).toEqual(['abort', 'drain', 'newSession']);
    await session.dispose();
  });

  it('dispose stops the turn while its gate and checkpoint service are still registered, and unregisters after the drain', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const service = serviceOf(session);
    const seen: Array<{ step: string; gate: boolean; checkpoints: boolean }> = [];
    const snapshot = (step: string): void => {
      seen.push({ step, gate: registries()._panelRegistry.has(live.sessionId), checkpoints: registries()._checkpointRegistry.get(live.sessionId) === service });
    };
    live.abort.mockImplementation(async () => { snapshot('abort'); });
    vi.spyOn(service, 'drain').mockImplementation(async () => { snapshot('drain'); });

    await session.dispose();

    // A tool call during the abort reaches this panel's gate, not the "could not be approved" fallback.
    expect(seen).toEqual([
      { step: 'abort', gate: true, checkpoints: true },
      { step: 'drain', gate: true, checkpoints: true },
    ]);
    expect(registries()._panelRegistry.has(live.sessionId)).toBe(false);
  });
});

describe('PiSession session leases follow what the panel holds', () => {
  beforeEach(() => {
    H.seq.length = 0;
    H.captured.services.length = 0;
    H.resetServices();
  });
  afterEach(async () => {
    H.setSessionSetup(null);
    H.setSessionManagerFactory(null);
    await PiRuntime.disposeInstance();
  });

  it('a reset releases the old session and leases the new one', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const first = H.getLastSession()!.sessionId;
    expect(sessionLeasesOf(session)).toEqual([first]);

    session.reset();
    await session.whenReplaced();

    const second = H.getLastSession()!.sessionId;
    expect(second).not.toBe(first);
    expect(sessionLeasesOf(session)).toEqual([second]);
    await session.dispose();
  });

  it('a resume switch moves the lease to the resumed session', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const first = H.getLastSession()!.sessionId;
    const runtime = (session as unknown as { runtime: { newSession: () => Promise<unknown> } }).runtime;
    // The switch as pi runs it: a replacement session with the stored file's id, rebound to the panel.
    vi.spyOn(session as unknown as { switchToResumeTarget: (id: string) => Promise<void> }, 'switchToResumeTarget').mockImplementation(async (id) => {
      H.setSessionSetup((s) => { (s as unknown as { sessionId: string }).sessionId = id; });
      await runtime.newSession();
    });

    session.setResumeSession('sess-resumed');
    expect(sessionLeasesOf(session).sort()).toEqual([first, 'sess-resumed'].sort());
    await session.whenReplaced();

    expect(sessionLeasesOf(session)).toEqual(['sess-resumed']);
    await session.dispose();
  });

  it('dispose releases every lease the panel held', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    expect(sessionLeasesOf(session)).toHaveLength(1);

    await session.dispose();

    expect(sessionLeasesOf(session)).toEqual([]);
  });

  it('a lease lost while start() opens the session mutes the manager it then binds', async () => {
    const managers: Array<{ _persist: () => void; persisted: number }> = [];
    H.setSessionManagerFactory(() => {
      const manager = {
        persisted: 0,
        _persist(): void { manager.persisted++; },
        getBranch: () => [],
        getEntries: () => [],
        getLeafId: () => null,
        getSessionName: () => undefined,
        getSessionFile: () => undefined,
        appendSessionInfo: () => 'info',
        appendCustomEntry: () => 'custom',
      };
      managers.push(manager);
      return manager;
    });
    H.setSessionSetup((s) => { (s as unknown as { sessionId: string }).sessionId = 'sess-lost'; });
    const base = H.fakePi.createAgentSessionRuntime.getMockImplementation()!;
    let release!: () => void;
    const parked = new Promise<void>((resolve) => { release = resolve; });
    let opening!: () => void;
    const opened = new Promise<void>((resolve) => { opening = resolve; });
    H.fakePi.createAgentSessionRuntime.mockImplementationOnce(async (...args) => {
      opening();
      await parked;
      return base(...args);
    });
    const session = new PiSession(makeOptions([]));
    session.setResumeSession('sess-lost');
    const starting = session.initializeEarly();
    await opened;

    session.onSessionLeaseLost('sess-lost');
    release();
    await starting;

    managers[0]!._persist();
    expect(managers[0]!.persisted).toBe(0);
    await session.dispose();
  });

  it('a lease lost while the panel is being disposed mutes the manager and starts no detach', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const warn = vi.spyOn(testPlatform.notifications, 'warn');
    let aborted!: () => void;
    live.abort.mockImplementation(() => new Promise<undefined>((resolve) => { aborted = () => resolve(undefined); }));
    const persist = vi.fn();
    (live.sessionManager as unknown as { _persist: () => void })._persist = persist;

    const disposing = session.dispose();
    session.onSessionLeaseLost(live.sessionId);
    (live.sessionManager as unknown as { _persist: () => void })._persist();
    aborted();
    await disposing;
    await new Promise((r) => setTimeout(r, 0));

    expect(persist).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    // A detach would have replaced the session on the panel being torn down.
    expect(H.getLastSession()).toBe(live);
  });
});

/** A live session whose branch can fork at `a1`, the parent of user entry `u2`. */
async function forkableSession(messages: ExtensionToWebviewMessage[], parentTimestamp: string | undefined, extra?: Partial<SessionOptions>) {
  const onSpawnFork = vi.fn<(args: ForkSpawnArgs) => Promise<void>>(async () => undefined);
  const session = new PiSession({ ...makeOptions(messages, extra), onSpawnFork });
  await session.initializeEarly();
  const sm = H.getLastSession()!.sessionManager;
  (sm['getEntry'] as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
    id === 'u2' ? { id: 'u2', parentId: 'a1', type: 'message', timestamp: '2026-03-04T09:00:00.000Z' }
    : id === 'a1' ? { id: 'a1', parentId: 'u1', type: 'message', ...(parentTimestamp ? { timestamp: parentTimestamp } : {}) }
    : undefined,
  );
  (sm['getSessionFile'] as ReturnType<typeof vi.fn>).mockReturnValue('/fake/agent/sessions/cwd/2026-03-04T08-00-00-000Z_src.jsonl');
  sm['getSessionId'] = () => 'src';
  sm['getEntries'] = () => [];
  (H.fakePi.SessionManager as Record<string, unknown>)['open'] = () => ({
    getBranch: () => [],
    createBranchedSession: () => '/fake/agent/sessions/cwd/2026-03-04T10-00-00-000Z_fork.jsonl',
  });
  return { session, onSpawnFork };
}

describe('PiSession interruption notice and the pre-turn window', () => {
  beforeEach(() => {
    H.seq.length = 0;
    H.captured.services.length = 0;
    H.resetServices();
    vi.mocked(reconcileInterruptions).mockClear();
    vi.mocked(copyForkAgentData).mockClear();
  });
  afterEach(async () => {
    delete (H.fakePi.SessionManager as Record<string, unknown>)['open'];
    await PiRuntime.disposeInstance();
  });

  function deferred(): { promise: Promise<void>; release: () => void } {
    let release!: () => void;
    const promise = new Promise<void>((r) => { release = r; });
    return { promise, release };
  }

  it('ESC then a prompt: the notice naming the stopped subagent is sent once, before the prompt', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const getBranch = live.sessionManager['getBranch'] as ReturnType<typeof vi.fn<() => unknown[]>>;
    getBranch.mockReturnValue([
      ...getBranch(),
      { type: 'custom', id: 'inv1', customType: DAMOCLES_AGENT_INVOCATION_ENTRY, data: { kind: 'subagent', id: 'agent-1', toolCallId: 't1', resume: false } },
    ]);

    await session.interrupt();
    await session.sendMessage('go on', undefined, 'c1', { content: 'go on' });
    await session.sendMessage('and again', undefined, 'c2', { content: 'and again' });

    const send = live.sendCustomMessage as ReturnType<typeof vi.fn>;
    const prompt = live.prompt as ReturnType<typeof vi.fn>;
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0] as NoticeMessage).toMatchObject({
      customType: DAMOCLES_INTERRUPTION_NOTICE,
      details: { agents: [{ kind: 'subagent', id: 'agent-1', toolCallId: 't1' }] },
    });
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(send.mock.invocationCallOrder[0]!).toBeLessThan(prompt.mock.invocationCallOrder[0]!);
    await session.dispose();
  });

  it('ESC while the reconcile is pending: no prompt runs and the message goes back to the composer', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    session.requestInterruptionCheck();
    const gate = deferred();
    vi.mocked(reconcileInterruptions).mockImplementationOnce(async () => {
      await gate.promise;
      return [];
    });

    const sending = session.sendMessage('go', undefined, 'c1', { content: 'go' });
    await vi.waitFor(() => expect(reconcileInterruptions).toHaveBeenCalledTimes(1));
    await session.interrupt();
    gate.release();
    await sending;

    expect(live.prompt).not.toHaveBeenCalled();
    expect(messages.some((m) => m.type === 'userMessage')).toBe(false);
    expect(messages).toContainEqual({ type: 'interruptRecovery', correlationId: 'c1', promptContent: 'go' });
    expect(session.processing).toBe(false);
    await session.dispose();
  });

  it('a session replaced while the reconcile is pending gets neither the notice nor the prompt', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const first = H.getLastSession()!;
    session.requestInterruptionCheck();
    const gate = deferred();
    vi.mocked(reconcileInterruptions).mockImplementationOnce(async (sources) => {
      await gate.promise;
      await sources.send({ customType: DAMOCLES_INTERRUPTION_NOTICE, content: 'notice', display: false, details: { agents: [] } });
      return [];
    });

    const sending = session.sendMessage('go', undefined, 'c1', { content: 'go' });
    await vi.waitFor(() => expect(reconcileInterruptions).toHaveBeenCalledTimes(1));
    session.reset();
    await session.whenReplaced();
    gate.release();
    await sending;

    const replacement = H.getLastSession()!;
    expect(replacement).not.toBe(first);
    expect(first.sendCustomMessage).not.toHaveBeenCalled();
    expect(first.prompt).not.toHaveBeenCalled();
    expect(replacement.prompt).not.toHaveBeenCalled();
    expect(messages).toContainEqual({ type: 'interruptRecovery', correlationId: 'c1', promptContent: 'go' });
    await session.dispose();
  });

  it('a failed reconcile warns and the turn still runs', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    session.requestInterruptionCheck();
    vi.mocked(reconcileInterruptions).mockRejectedValueOnce(new Error('EBUSY'));

    await session.sendMessage('go', undefined, 'c1', { content: 'go' });

    expect(messages.some((m) => m.type === 'notification' && m.notificationType === 'warning')).toBe(true);
    expect(live.prompt).toHaveBeenCalledTimes(1);
    await session.dispose();
  });

  it('a fork copies agent data cut at the parent entry\'s timestamp', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const { session, onSpawnFork } = await forkableSession(messages, '2026-03-04T08:30:00.123Z');
    vi.mocked(copyForkAgentData).mockResolvedValueOnce([]);

    await session.rewindFiles('u2', 'fork-conversation');

    expect(copyForkAgentData).toHaveBeenCalledTimes(1);
    expect(vi.mocked(copyForkAgentData).mock.calls[0]![0]).toMatchObject({
      sourceSessionId: 'src',
      targetSessionId: 'fork',
      forkPointMs: Date.parse('2026-03-04T08:30:00.123Z'),
    });
    expect(messages.some((m) => m.type === 'notification')).toBe(false);
    expect(onSpawnFork.mock.calls[0]![0].piBranchedSessionId).toBe('fork');
    await session.dispose();
  });

  it('a fork copies the Injected Context records of the prompts before the fork point', async () => {
    const copySessionInjections = vi.fn(async () => 1);
    const { session, onSpawnFork } = await forkableSession([], '2026-03-04T08:30:00.123Z', {
      memoryService: { isEnabled: true, copySessionInjections } as unknown as MemoryService,
    });
    const getBranch = H.getLastSession()!.sessionManager['getBranch'] as ReturnType<typeof vi.fn>;
    getBranch.mockImplementation((id?: string) => (id === 'a1' ? STORED_CONVERSATION.slice(0, 4) : STORED_CONVERSATION));
    vi.mocked(copyForkAgentData).mockResolvedValueOnce([]);

    await session.rewindFiles('u2', 'fork-conversation');

    expect(copySessionInjections).toHaveBeenCalledTimes(1);
    expect(copySessionInjections).toHaveBeenCalledWith('src', 'fork', 2);
    expect(copySessionInjections.mock.invocationCallOrder[0]!).toBeLessThan(onSpawnFork.mock.invocationCallOrder[0]!);
    await session.dispose();
  });

  it('a failed injection-record copy still opens the fork', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const copySessionInjections = vi.fn(async () => { throw new Error('SQLITE_BUSY'); });
    const { session, onSpawnFork } = await forkableSession(messages, '2026-03-04T08:30:00.123Z', {
      memoryService: { isEnabled: true, copySessionInjections } as unknown as MemoryService,
    });
    vi.mocked(copyForkAgentData).mockResolvedValueOnce([]);

    await session.rewindFiles('u2', 'fork-conversation');

    expect(copySessionInjections).toHaveBeenCalledTimes(1);
    expect(onSpawnFork).toHaveBeenCalledTimes(1);
    expect(onSpawnFork.mock.calls[0]![0].piBranchedSessionId).toBe('fork');
    await session.dispose();
  });

  it('a fresh-panel fork copies no Injected Context records', async () => {
    const copySessionInjections = vi.fn(async () => 0);
    const { session, onSpawnFork } = await forkableSession([], '2026-03-04T08:30:00.123Z', {
      memoryService: { isEnabled: true, copySessionInjections } as unknown as MemoryService,
    });
    // A branch with no user or assistant message has no file to resume, so the fork opens as a fresh panel.
    const getBranch = H.getLastSession()!.sessionManager['getBranch'] as ReturnType<typeof vi.fn>;
    getBranch.mockReturnValue([{ id: 'm0', type: 'model_change', parentId: null }]);

    await session.rewindFiles('u2', 'fork-conversation');

    expect(copySessionInjections).not.toHaveBeenCalled();
    expect(onSpawnFork.mock.calls[0]![0].piBranchedSessionId).toBeUndefined();
    await session.dispose();
  });

  it('a fork whose branch holds a prompt and no reply is branched, since pi writes it when the fork is made', async () => {
    const copySessionInjections = vi.fn(async () => 0);
    const { session, onSpawnFork } = await forkableSession([], '2026-03-04T08:30:00.123Z', {
      memoryService: { isEnabled: true, copySessionInjections } as unknown as MemoryService,
    });
    const getBranch = H.getLastSession()!.sessionManager['getBranch'] as ReturnType<typeof vi.fn>;
    getBranch.mockReturnValue(STORED_CONVERSATION.slice(0, 1));

    await session.rewindFiles('u2', 'fork-conversation');

    expect(copySessionInjections).toHaveBeenCalledTimes(1);
    expect(onSpawnFork.mock.calls[0]![0].piBranchedSessionId).toBe('fork');
    await session.dispose();
  });

  it('a fork whose parent entry has no timestamp copies nothing, warns, and still opens', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const { session, onSpawnFork } = await forkableSession(messages, undefined);

    await session.rewindFiles('u2', 'fork-conversation');

    expect(copyForkAgentData).not.toHaveBeenCalled();
    expect(messages.some((m) => m.type === 'notification' && m.notificationType === 'warning')).toBe(true);
    expect(onSpawnFork).toHaveBeenCalledTimes(1);
    await session.dispose();
  });
});

describe('PiSession undelivered background results', () => {
  beforeEach(() => {
    H.seq.length = 0;
    H.captured.services.length = 0;
    H.resetServices();
    vi.mocked(collectUndeliveredFromFiles).mockReset();
    vi.mocked(resolvePiSessionFile).mockReset();
    (H.fakePi.SessionManager as Record<string, unknown>)['open'] = () => ({ kind: 'opened', getBranch: () => [] });
  });
  afterEach(async () => {
    H.setSessionSetup(null);
    delete (H.fakePi.SessionManager as Record<string, unknown>)['open'];
    await PiRuntime.disposeInstance();
  });

  type Priv = {
    processingFlag: boolean;
    stopForBudget: () => void;
    undeliveredScanPending: boolean;
    tryBackgroundKeepAlive: () => Promise<unknown>;
    adapter: { beginTurn: (correlationId?: string) => void };
  };
  type Manager = Pick<AgentManager, 'abort' | 'getRecord'> & { agents: Map<string, AgentRecord> };
  type FakeSession = NonNullable<ReturnType<typeof H.getLastSession>>;
  type ResultsCall = { message: { customType: string; details: { agents: Array<{ agentId?: string; id?: string; toolCallId: string }> } }; order: number };
  const priv = (s: PiSession): Priv => s as unknown as Priv;
  const managerOf = (s: PiSession): Manager => (s as unknown as { subagentManager: Manager }).subagentManager;
  const branchOf = (live: FakeSession) => live.sessionManager['getBranch'] as ReturnType<typeof vi.fn<() => unknown[]>>;
  const appendBranch = (live: FakeSession, entries: unknown[]) => branchOf(live).mockReturnValue([...branchOf(live)(), ...entries]);

  const X = 'aaaaaaa1-0000-4a1';
  const Y = 'aaaaaaa2-0000-4a2';
  const Z = 'aaaaaaa3-0000-4a3';

  /** The parent branch entries of a background spawn of `id` by Agent call `toolCallId`. */
  function backgroundSpawn(id: string, toolCallId: string): unknown[] {
    return [
      { type: 'custom', id: `inv-${toolCallId}`, customType: DAMOCLES_AGENT_INVOCATION_ENTRY, data: { kind: 'subagent', id, toolCallId, resume: false } },
      { type: 'message', id: `res-${toolCallId}`, message: { role: 'toolResult', toolCallId, toolName: 'Agent', content: [], details: { agentId: id, status: 'async_launched' } } },
    ];
  }

  /** A background record held by the panel's real manager. */
  function held(session: PiSession, id: string, toolCallId: string, over: Partial<AgentRecord> = {}): AgentRecord {
    const record: AgentRecord = {
      id, type: 'Explore', description: `task ${id}`, status: 'completed', toolCallId, background: true, result: `result of ${id}`,
      toolUses: 0, startedAt: 0, lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 }, usage: emptyAgentUsage(), compactionCount: 0,
      ...over,
    };
    managerOf(session).agents.set(id, record);
    return record;
  }

  /** A finished background record held by the manager, invoked by `toolCallId` on the live branch. */
  function finishedBackground(session: PiSession, id: string, toolCallId: string, extraBranch: unknown[] = []): AgentRecord {
    const record = held(session, id, toolCallId);
    appendBranch(H.getLastSession()!, [...backgroundSpawn(id, toolCallId), ...extraBranch]);
    return record;
  }

  /** Agent files recording these finished invocations; the scan keeps the branch's latest invocations not yet delivered. */
  function filesHold(results: UndeliveredFileResult[]): void {
    vi.mocked(collectUndeliveredFromFiles).mockImplementation(async ({ branch, isLive }) => {
      const index = subagentBranchIndex(branch);
      const delivered = deliveredBackgroundResults(index);
      const latest = new Set([...latestSubagentInvocations(index).values()].map((inv) => inv.toolCallId));
      return { results: results.filter((r) => latest.has(r.toolCallId) && !isLive(r.agentId) && !delivered.has(r.toolCallId)), incomplete: false };
    });
  }
  const fileResult = (agentId: string, toolCallId: string): UndeliveredFileResult => ({
    agentId,
    toolCallId,
    launch: { agentId, kind: 'subagent', agentType: 'Explore', description: `task ${agentId}`, prompt: 'p', background: true },
    status: { status: 'completed', result: `result of ${agentId}` },
  });

  /** Stored sessions every id resolves to, bound in this order with these ids and branches. */
  function storedSessions(sessions: Array<{ id: string; branch: unknown[] }>): void {
    vi.mocked(resolvePiSessionFile).mockImplementation(async (_cwd, id) => `/fake/agent/sessions/cwd/2026-01-01T00-00-00-000Z_${id}.jsonl`);
    const queue = [...sessions];
    H.setSessionSetup((s) => {
      const next = queue.shift();
      if (!next) return;
      const fake = s as unknown as FakeSession;
      (fake as { sessionId: string }).sessionId = next.id;
      branchOf(fake).mockReturnValue([...next.branch]);
    });
  }

  const sentOfType = (live: FakeSession, customType: string): ResultsCall[] => {
    const send = live.sendCustomMessage as ReturnType<typeof vi.fn>;
    return send.mock.calls
      .map((c, i) => ({ message: c[0] as ResultsCall['message'], order: send.mock.invocationCallOrder[i]! }))
      .filter((c) => c.message.customType === customType);
  };
  const resultsSent = (live: FakeSession) => sentOfType(live, SUBAGENT_RESULTS_CUSTOM_TYPE);
  const deliveredCalls = (live: FakeSession) => resultsSent(live).map((c) => c.message.details.agents.map((a) => a.toolCallId));
  const toolText = (result: unknown) => (result as { content: Array<{ text: string }> }).content[0]!.text;
  const customTool = (name: string) => H.captured.customTools.find((t) => t.name === name)!;

  it('delivers a live result before beginTurn on the next prompt, once, and the keep-alive then injects nothing for it', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const beginTurn = vi.spyOn(priv(session).adapter, 'beginTurn');
    finishedBackground(session, X, 't1');

    await session.interrupt();
    await session.sendMessage('go on', undefined, 'c1', { content: 'go on' });
    await session.sendMessage('and again', undefined, 'c2', { content: 'and again' });

    const sent = resultsSent(live);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message).toMatchObject({ display: false, details: { agents: [{ agentId: X, toolCallId: 't1', status: 'completed' }] } });
    expect(sent[0]!.order).toBeLessThan(beginTurn.mock.invocationCallOrder[0]!);
    expect(await priv(session).tryBackgroundKeepAlive()).toBeUndefined();
    await session.dispose();
  });

  it('delivers on every prompt, so a result that finished before a budget stop reaches the next prompt', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    await session.sendMessage('first', undefined, 'c1', { content: 'first' });

    finishedBackground(session, Y, 't2');
    // The budget-stopped turn settles without the keep-alive, which leaves the result undelivered.
    priv(session).processingFlag = true;
    priv(session).stopForBudget();
    priv(session).processingFlag = false;
    await session.sendMessage('second', undefined, 'c2', { content: 'second' });

    const sent = resultsSent(live);
    const prompt = live.prompt as ReturnType<typeof vi.fn>;
    expect(deliveredCalls(live)).toEqual([['t2']]);
    expect(sent[0]!.order).toBeGreaterThan(prompt.mock.invocationCallOrder[0]!);
    expect(sent[0]!.order).toBeLessThan(prompt.mock.invocationCallOrder[1]!);
    await session.dispose();
  });

  it('a live result whose invocation the branch already delivered is not sent again', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    finishedBackground(session, X, 't3', [
      { type: 'message', id: 'r1', message: { role: 'toolResult', toolCallId: 'tc-get', toolName: 'GetSubagentResult', content: [], details: { agentId: X, toolCallId: 't3', status: 'completed' } } },
    ]);

    await session.sendMessage('go', undefined, 'c1', { content: 'go' });

    expect(resultsSent(live)).toEqual([]);
    await session.dispose();
  });

  it('the agent-file scan runs once after a bind, and again after a scan that failed', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    priv(session).undeliveredScanPending = true;
    vi.mocked(collectUndeliveredFromFiles).mockRejectedValueOnce(new Error('EBUSY'));

    await session.sendMessage('one', undefined, 'c1', { content: 'one' });
    expect(messages.some((m) => m.type === 'notification' && m.notificationType === 'warning')).toBe(true);
    expect(live.prompt).toHaveBeenCalledTimes(1);

    await session.sendMessage('two', undefined, 'c2', { content: 'two' });
    await session.sendMessage('three', undefined, 'c3', { content: 'three' });

    expect(collectUndeliveredFromFiles).toHaveBeenCalledTimes(2);
    expect(priv(session).undeliveredScanPending).toBe(false);
    await session.dispose();
  });

  it('a resume at start scans the agent files once and delivers before beginTurn; the next prompt delivers nothing', async () => {
    storedSessions([{ id: 'sess-stored', branch: backgroundSpawn(X, 'tx') }]);
    filesHold([fileResult(X, 'tx')]);
    const session = new PiSession(makeOptions([]));
    session.setResumeSession('sess-stored');
    await session.initializeEarly();
    const live = H.getLastSession()!;
    expect(live.sessionId).toBe('sess-stored');
    const beginTurn = vi.spyOn(priv(session).adapter, 'beginTurn');

    await session.sendMessage('one', undefined, 'c1', { content: 'one' });
    await session.sendMessage('two', undefined, 'c2', { content: 'two' });

    expect(collectUndeliveredFromFiles).toHaveBeenCalledTimes(1);
    expect(deliveredCalls(live)).toEqual([['tx']]);
    expect(resultsSent(live)[0]!.order).toBeLessThan(beginTurn.mock.invocationCallOrder[0]!);
    expect(beginTurn).toHaveBeenCalledTimes(2);
    await session.dispose();
  });

  it('a resume switch scans the agent files once and delivers before beginTurn; the next prompt delivers nothing', async () => {
    storedSessions([{ id: 'sess-A', branch: [] }, { id: 'sess-B', branch: backgroundSpawn(X, 'tx') }]);
    filesHold([fileResult(X, 'tx')]);
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    session.setResumeSession('sess-B');
    await session.whenReplaced();
    const live = H.getLastSession()!;
    expect(live.sessionId).toBe('sess-B');
    const beginTurn = vi.spyOn(priv(session).adapter, 'beginTurn');

    await session.sendMessage('one', undefined, 'c1', { content: 'one' });
    await session.sendMessage('two', undefined, 'c2', { content: 'two' });

    expect(collectUndeliveredFromFiles).toHaveBeenCalledTimes(1);
    expect(deliveredCalls(live)).toEqual([['tx']]);
    expect(resultsSent(live)[0]!.order).toBeLessThan(beginTurn.mock.invocationCallOrder[0]!);
    await session.dispose();
  });

  it("a resume switch returns everything queued in the old conversation to the input, and none of it reaches the other", async () => {
    storedSessions([{ id: 'sess-A', branch: [] }, { id: 'sess-B', branch: [] }]);
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const a = H.getLastSession()!;
    const followUps: string[] = [];
    Object.assign(a, { isStreaming: true, getFollowUpMessages: () => followUps });
    (a.clearQueue as ReturnType<typeof vi.fn>).mockImplementation(() => ({ steering: [], followUp: followUps.splice(0) }));
    (a.prompt as ReturnType<typeof vi.fn>).mockImplementationOnce(async (text: string, opts: { preflightResult: (d: string) => void }) => {
      followUps.push(text);
      opts.preflightResult('queued');
    });
    const withdrawn = vi.fn();
    expect(await session.sendMessage('also look at this', undefined, 'c1', { content: 'also look at this' }, withdrawn)).toBe('sent');
    expect(session.queueInput('for A', 'q1')).toBe('queued');
    // A cancel note pi accepted and echoed in A, not yet delivered.
    (session as unknown as { injectedNotes: Array<{ text: string; echoed: boolean }> }).injectedNotes.push({ text: 'skip it', echoed: true });
    messages.length = 0;

    session.setResumeSession('sess-B');

    expect(messages.filter((m) => m.type === 'queueCancelled')).toEqual([
      { type: 'queueCancelled', messageId: 'q1', returnToInput: true },
      { type: 'queueCancelled', messageId: 'c1', returnToInput: true },
    ]);
    expect(withdrawn).toHaveBeenCalledOnce();
    await session.whenReplaced();
    const b = H.getLastSession()!;
    expect(b.sessionId).toBe('sess-B');
    (b as { isStreaming: boolean }).isStreaming = true;
    expect(session.queueInput('for B', 'q2')).toBe('queued');
    await vi.waitFor(() => expect(b.prompt).toHaveBeenCalled());
    expect((b.prompt as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(['for B']);
    // A's note left with A's transcript, so a Stop in B reports no note of its own discarded.
    await session.interrupt();
    expect(messages.some((m) => m.type === 'notification' && m.message.includes('discarded your cancel note'))).toBe(false);
    await session.dispose();
  });

  it('a card-stopped agent is delivered before the interruption notice, which lists only the agent ESC killed', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const card = held(session, X, 'tx', { status: 'running', result: 'half done' });
    held(session, Y, 'ty', { status: 'running' });
    appendBranch(live, [...backgroundSpawn(X, 'tx'), ...backgroundSpawn(Y, 'ty')]);
    managerOf(session).abort(X, 'user');

    await session.interrupt();
    await session.sendMessage('go on', undefined, 'c1', { content: 'go on' });

    const results = resultsSent(live);
    const notices = sentOfType(live, DAMOCLES_INTERRUPTION_NOTICE);
    expect(card).toMatchObject({ status: 'stopped', stopReason: 'user' });
    expect(results.map((c) => c.message.details.agents.map((a) => a.agentId))).toEqual([[X]]);
    expect(notices.map((c) => c.message.details.agents.map((a) => a.id))).toEqual([[Y]]);
    expect(results[0]!.order).toBeLessThan(notices[0]!.order);
    await session.dispose();
  });

  it("a resume switch retires the bound session's agents: the other session never reaches them, and the first gets its result at its next bind", async () => {
    const aBranch = backgroundSpawn(X, 'tx');
    storedSessions([{ id: 'sess-A', branch: aBranch }, { id: 'sess-B', branch: [] }, { id: 'sess-A', branch: aBranch }]);
    filesHold([fileResult(X, 'tx')]);
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const a = H.getLastSession()!;
    held(session, X, 'tx');
    await session.interrupt();
    const running = held(session, Z, 'tz', { status: 'running' });
    appendBranch(a, backgroundSpawn(Z, 'tz'));

    session.setResumeSession('sess-B');
    await session.whenReplaced();
    const b = H.getLastSession()!;
    expect(b.sessionId).toBe('sess-B');
    // Retired as a panel close retires them, so each stays resumable or deliverable from its file.
    expect(running).toMatchObject({ status: 'stopped', stopReason: 'shutdown' });
    expect(managerOf(session).getRecord(X)).toBeUndefined();
    expect(managerOf(session).getRecord(Z)).toBeUndefined();

    await session.sendMessage('in B', undefined, 'c1', { content: 'in B' });
    expect(resultsSent(b)).toEqual([]);
    expect(await priv(session).tryBackgroundKeepAlive()).toBeUndefined();
    const fetched = await customTool('GetSubagentResult').execute(...(['tc-get', { agent_id: X }, undefined, undefined, {}] as never[]));
    expect(toolText(fetched)).toBe(`No subagent with id "${X}" was launched in this conversation.`);
    const steered = await customTool('SteerSubagent').execute(...(['tc-steer', { agent_id: X, message: 'go' }, undefined, undefined, {}] as never[]));
    expect(toolText(steered)).toBe(`No subagent found with id "${X}".`);

    session.setResumeSession('sess-A');
    await session.whenReplaced();
    const aAgain = H.getLastSession()!;
    expect(aAgain.sessionId).toBe('sess-A');
    await session.sendMessage('back in A', undefined, 'c2', { content: 'back in A' });
    expect(deliveredCalls(aAgain)).toEqual([['tx']]);
    await session.dispose();
  });

  it("a resume switch cancels the bound session's team and binds the other session only once the team run settled", async () => {
    storedSessions([{ id: 'sess-A', branch: [] }, { id: 'sess-B', branch: [] }]);
    let settle!: () => void;
    const runSettled = new Promise<void>((resolve) => { settle = resolve; });
    const order: string[] = [];
    const teamService = {
      dispose: () => {},
      setRunListener: () => {},
      running: false,
      cancelActiveTeam: vi.fn(() => { order.push('cancel'); return true; }),
      whenRunSettled: vi.fn(() => runSettled.then(() => { order.push('settled'); })),
    };
    const session = new PiSession(makeOptions([], { teamService: teamService as unknown as NonNullable<SessionOptions['teamService']> }));
    await session.initializeEarly();

    session.setResumeSession('sess-B');
    await vi.waitFor(() => expect(teamService.whenRunSettled).toHaveBeenCalled());
    // Still waiting on the team, so A is bound and B's file is not open yet.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(H.getLastSession()!.sessionId).not.toBe('sess-B');
    settle();
    await session.whenReplaced();

    expect(H.getLastSession()!.sessionId).toBe('sess-B');
    // A shutdown stop, which keeps the team resumable from session A and tells it why it stopped.
    expect(teamService.cancelActiveTeam).toHaveBeenCalledWith('shutdown');
    expect(order).toEqual(['cancel', 'settled']);
    await session.dispose();
  });

  it('a resume switch that fails after retiring the agents leaves their results and interruptions to the next prompt on the old session', async () => {
    storedSessions([{ id: 'sess-A', branch: [] }]);
    filesHold([fileResult(X, 'tx')]);
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const a = H.getLastSession()!;
    held(session, X, 'tx');
    held(session, Z, 'tz', { status: 'running' });
    appendBranch(a, [...backgroundSpawn(X, 'tx'), ...backgroundSpawn(Z, 'tz')]);
    // pi opens the target file before tearing the bound session down, so an unreadable file throws with it still bound.
    (session as unknown as { runtime: { switchSession: () => Promise<unknown> } }).runtime.switchSession = vi.fn(async () => {
      throw new Error('corrupt session file');
    });

    session.setResumeSession('sess-B');
    await session.whenReplaced();
    expect(H.getLastSession()).toBe(a);
    expect(managerOf(session).getRecord(X)).toBeUndefined();
    await session.sendMessage('go on', undefined, 'c1', { content: 'go on' });

    expect(deliveredCalls(a)).toEqual([['tx']]);
    expect(sentOfType(a, DAMOCLES_INTERRUPTION_NOTICE).map((c) => c.message.details.agents.map((ag) => ag.id))).toEqual([[Z]]);
    await session.dispose();
  });

  it('an incomplete agent-file scan stays pending, so the next prompt delivers what a transient read error held back', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    appendBranch(live, backgroundSpawn(X, 'tx'));
    priv(session).undeliveredScanPending = true;
    filesHold([fileResult(X, 'tx')]);
    vi.mocked(collectUndeliveredFromFiles).mockResolvedValueOnce({ results: [], incomplete: true });

    await session.sendMessage('one', undefined, 'c1', { content: 'one' });
    expect(resultsSent(live)).toEqual([]);
    expect(priv(session).undeliveredScanPending).toBe(true);
    expect(messages.some((m) => m.type === 'notification' && m.notificationType === 'warning')).toBe(true);

    await session.sendMessage('two', undefined, 'c2', { content: 'two' });
    await session.sendMessage('three', undefined, 'c3', { content: 'three' });

    expect(deliveredCalls(live)).toEqual([['tx']]);
    expect(collectUndeliveredFromFiles).toHaveBeenCalledTimes(2);
    expect(priv(session).undeliveredScanPending).toBe(false);
    await session.dispose();
  });

  it('a failed agent-file scan still delivers the live results first, so the notice never also lists a card-stopped agent', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    held(session, X, 'tx', { status: 'running', result: 'half done' });
    appendBranch(live, backgroundSpawn(X, 'tx'));
    managerOf(session).abort(X, 'user');
    priv(session).undeliveredScanPending = true;
    session.requestInterruptionCheck();
    vi.mocked(collectUndeliveredFromFiles).mockRejectedValueOnce(new Error('EBUSY'));

    await session.sendMessage('go on', undefined, 'c1', { content: 'go on' });
    await session.sendMessage('again', undefined, 'c2', { content: 'again' });

    expect(deliveredCalls(live)).toEqual([['tx']]);
    expect(sentOfType(live, DAMOCLES_INTERRUPTION_NOTICE)).toEqual([]);
    await session.dispose();
  });

  it('while a run streams, the prompt-start delivery leaves the results to that run\'s keep-alive and keeps the scan pending', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    finishedBackground(session, X, 'tx');
    priv(session).undeliveredScanPending = true;
    session.requestInterruptionCheck();
    // A run a cancel note opened: pi would defer a custom message to that run's settle, after its keep-alive read D.
    live.isStreaming = true;

    await session.sendMessage('go', undefined, 'c1', { content: 'go' });

    expect(resultsSent(live)).toEqual([]);
    expect(sentOfType(live, DAMOCLES_INTERRUPTION_NOTICE)).toEqual([]);
    expect(priv(session).undeliveredScanPending).toBe(true);
    expect(await priv(session).tryBackgroundKeepAlive()).toMatchObject({ details: { agents: [{ agentId: X, toolCallId: 'tx' }] } });
    await session.dispose();
  });

  it('a turn held in its settle while a resume switch retires its agents commits no plan-mode nudge to the retired session', async () => {
    storedSessions([{ id: 'sess-A', branch: [] }, { id: 'sess-B', branch: [] }]);
    let releaseTeam!: () => void;
    const teamSettled = new Promise<void>((resolve) => { releaseTeam = resolve; });
    const teamService = { dispose: () => {}, setRunListener: () => {}, running: false, cancelActiveTeam: vi.fn(() => true), whenRunSettled: vi.fn(() => teamSettled) };
    const session = new PiSession(makeOptions([], { teamService: teamService as unknown as NonNullable<SessionOptions['teamService']> }));
    await session.initializeEarly();
    await session.setPermissionMode('plan');
    let finishRun!: (text: string) => void;
    held(session, Z, 'tz', { status: 'running', promise: new Promise<string>((resolve) => { finishRun = resolve; }) });
    appendBranch(H.getLastSession()!, backgroundSpawn(Z, 'tz'));
    const onBeforeSettle = (session as unknown as { onBeforeSettle: (e: unknown) => Promise<unknown> }).onBeforeSettle.bind(session);
    const settle = onBeforeSettle({
      type: 'agent_before_settle', entries: [], continue: false,
      context: { contextMessages: [{ role: 'user', content: [{ type: 'text', text: 'plan it' }] }, { role: 'assistant', stopReason: 'stop', content: [] }] },
    });

    session.setResumeSession('sess-B');
    await vi.waitFor(() => expect(teamService.whenRunSettled).toHaveBeenCalled());
    // The background run winds down while the switch still waits on the team, which releases the held settle.
    finishRun('');

    expect(await settle).toBeUndefined();
    releaseTeam();
    await session.whenReplaced();
    expect(H.getLastSession()!.sessionId).toBe('sess-B');
    await session.dispose();
  });

  it('a record whose invocation entry failed to append is still delivered while its Agent call is on the branch', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const callWithoutInvocation = (id: string, toolCallId: string): unknown[] => [
      { type: 'message', id: `a-${toolCallId}`, message: { role: 'assistant', content: [{ type: 'toolCall', id: toolCallId, name: 'Agent', arguments: { description: 'd', prompt: 'p', subagent_type: 'Explore', run_in_background: true } }] } },
      { type: 'message', id: `res-${toolCallId}`, message: { role: 'toolResult', toolCallId, toolName: 'Agent', content: [], details: { agentId: id, status: 'async_launched' } } },
    ];
    held(session, X, 'tx');
    appendBranch(live, callWithoutInvocation(X, 'tx'));
    // Invoked on a branch a rewind left, so neither its entry nor its call is on this one.
    held(session, Y, 'ty');

    const fetched = await customTool('GetSubagentResult').execute(...(['tc-get', { agent_id: X }, undefined, undefined, {}] as never[]));
    expect(toolText(fetched)).not.toContain('was launched in this conversation');
    await session.sendMessage('go', undefined, 'c1', { content: 'go' });

    expect(deliveredCalls(live)).toEqual([['tx']]);
    await session.dispose();
  });

  it('a prompt the budget refuses and an extension command deliver nothing; the next real prompt delivers', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    finishedBackground(session, X, 'tx');
    const budget = session as unknown as { budgetLimitForEnforcement: () => number | null };
    const limit = budget.budgetLimitForEnforcement;
    budget.budgetLimitForEnforcement = () => 0;

    await session.sendMessage('refused', undefined, 'c1', { content: 'refused' });
    expect(resultsSent(live)).toEqual([]);

    budget.budgetLimitForEnforcement = limit;
    live.extensionRunner.getCommand.mockImplementation((name: string) => (name === 'todos' ? { name } : undefined));
    await session.sendMessage('/todos', undefined, 'c2', { content: '/todos' });
    expect(resultsSent(live)).toEqual([]);

    await session.sendMessage('real', undefined, 'c3', { content: 'real' });
    expect(deliveredCalls(live)).toEqual([['tx']]);
    await session.dispose();
  });

  it('the delivery, interruption-notice and invocation-record warnings reach the user in the UI language', async () => {
    const greek = elBundle as Record<string, string>;
    const t = vi.spyOn(testPlatform.localization, 't').mockImplementation((message) => greek[message] ?? message);
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    priv(session).undeliveredScanPending = true;
    session.requestInterruptionCheck();
    vi.mocked(collectUndeliveredFromFiles).mockRejectedValueOnce(new Error('EBUSY'));
    vi.mocked(reconcileInterruptions).mockRejectedValueOnce(new Error('EBUSY'));
    (live.sessionManager['appendCustomEntry'] as ReturnType<typeof vi.fn>).mockImplementationOnce(() => { throw new Error('EPERM'); });
    try {
      await session.sendMessage('go', undefined, 'c1', { content: 'go' });
      session.recordAgentInvocation({ kind: 'subagent', id: X, toolCallId: 'tx', resume: false });
    } finally {
      t.mockRestore();
    }

    const warnings = messages.flatMap((m) => (m.type === 'notification' && m.notificationType === 'warning' ? [m.message] : []));
    expect(warnings).toEqual([
      greek['Could not deliver the results of finished background subagents; they will be retried with your next message.'],
      greek['Could not record which agents were interrupted; the model will not be told it can resume them.'],
      greek['Could not record a subagent in the session file. After a reload its card will not be restored, and the model will not receive a result it has not received by then.'],
    ]);
    expect(warnings.every((w) => typeof w === 'string' && /[α-ω]/.test(w))).toBe(true);
    await session.dispose();
  });

  it('two prompts that both read the results before either appended deliver them once', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    finishedBackground(session, X, 'tx');
    priv(session).undeliveredScanPending = true;
    // Both prompts park in the file scan, after reading the live list and before either appends.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(collectUndeliveredFromFiles).mockImplementation(async () => { await gate; return { results: [], incomplete: false }; });

    const both = Promise.all([
      session.sendMessage('one', undefined, 'c1', { content: 'one' }),
      session.sendMessage('two', undefined, 'c2', { content: 'two' }),
    ]);
    await vi.waitFor(() => expect(collectUndeliveredFromFiles).toHaveBeenCalledTimes(2));
    release();
    await both;

    expect(deliveredCalls(live)).toEqual([['tx']]);
    await session.dispose();
  });

  it('the keep-alive injects only results the branch has not delivered, and never a draft pi already committed', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    finishedBackground(session, X, 't4', [
      { type: 'custom_message', id: 'm1', customType: SUBAGENT_RESULTS_CUSTOM_TYPE, content: 'x', display: false, details: { agents: [{ agentId: X, toolCallId: 't4', status: 'completed', result: 'r' }] } },
    ]);
    finishedBackground(session, Y, 't5');
    // Z's record ran an invocation this branch has since superseded.
    finishedBackground(session, Z, 't6', [
      { type: 'custom', id: 'inv-t7', customType: DAMOCLES_AGENT_INVOCATION_ENTRY, data: { kind: 'subagent', id: Z, toolCallId: 't7', resume: true } },
    ]);

    const draft = (await priv(session).tryBackgroundKeepAlive()) as { customType: string; content: string; display: boolean; details: { agents: Array<{ toolCallId: string }> } };
    expect(draft.details.agents.map((a) => a.toolCallId)).toEqual(['t5']);

    // pi commits the settle's draft to the branch before the next settle runs.
    appendBranch(live, [{ type: 'custom_message', id: 'm2', ...draft }]);
    expect(await priv(session).tryBackgroundKeepAlive()).toBeUndefined();
    await session.dispose();
  });
});

/**
 * Graceful budget stop (US-008). These tests encode the six-site `_aborting` audit: FOUR turn-holding
 * reads must honor a budget stop via `stopRequested()`, and TWO reads must deliberately keep testing
 * `_aborting` alone. A find-and-replace of `_aborting` would pass typecheck AND lint while silently
 * breaking slash commands and error reporting — the two regression guards below are what catch it.
 */
describe('PiSession graceful budget stop (US-008)', () => {
  beforeEach(() => {
    H.seq.length = 0;
    H.captured.services.length = 0;
    H.resetServices();
    H.setSessionSetup(null);
  });
  afterEach(async () => {
    H.setSessionSetup(null);
    await PiRuntime.disposeInstance();
    vi.restoreAllMocks();
  });

  type SettleEvt = { type: 'agent_before_settle'; entries: unknown[]; continue: boolean; context: { contextMessages: unknown[] } };
  type Priv = {
    processingFlag: boolean;
    _budgetStopRequested: boolean;
    stopForBudget: () => void;
    tryBackgroundKeepAlive: () => Promise<unknown>;
    tryPlanModeHold: (event: SettleEvt) => unknown;
    adapter: { endTurnWithoutAgentRun: () => void; markAborted: () => void; addExternalCost: (deltaUsd: number) => void };
    subagentManager: Record<string, unknown>;
  };
  const priv = (s: PiSession): Priv => s as unknown as Priv;
  const cleanStop: SettleEvt = {
    type: 'agent_before_settle',
    entries: [],
    continue: false,
    context: {
      contextMessages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'p' }] },
      ],
    },
  };

  /** Cross the hard limit mid-turn exactly as the adapter's `onBudgetStop` dep does. */
  function budgetStop(session: PiSession): void {
    priv(session).processingFlag = true;
    priv(session).stopForBudget();
  }

  type FakeAgent = { finishTurn?: FinishTurn };

  /** pi's completed-turn context. The budget decider reads none of it, so an empty one is enough. */
  const anyTurn = {} as AgentTurnContext;

  /** One model round-trip boundary, the only state pi consults the installed deciders in. */
  async function decideTurn(agent: FakeAgent): Promise<AgentTurnDecision | undefined> {
    return (await agent.finishTurn?.(anyTurn)) as AgentTurnDecision | undefined;
  }

  /** Arm dollar enforcement: a `maxBudgetUsd` setting AND a dollar-metered credential (the gate is a
   *  no-op on a flat subscription, so both are required for the pre-prompt block to run at all). */
  function withBudget(limit: number): void {
    vi.spyOn(PiRuntime.get('/fake/agent'), 'getClaudeAuthStatus').mockReturnValue({ mode: 'apikey' });
    vi.spyOn(testPlatform.settings, 'get').mockImplementation(settingsReader((key: string) => (key === 'damocles.maxBudgetUsd' ? limit : undefined)));
  }

  /** Drive `onBeforeSettle` through the registered panel context (the real dispatch path). */
  async function fireBeforeSettle(event: SettleEvt): Promise<unknown> {
    const live = H.getLastSession()!;
    const panel = (cwdFolder() as unknown as {
      _panelRegistry: Map<string, { onBeforeSettle?: (e: SettleEvt) => Promise<unknown> }>;
    })._panelRegistry.get(live.sessionId as string)!;
    return panel.onBeforeSettle!(event);
  }

  it('a budget stop makes the turn decider answer end and does NOT abort the agent', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const markAborted = vi.spyOn(priv(session).adapter, 'markAborted');

    // Installed at bind time, and silent while under budget.
    expect(typeof live.agent.finishTurn).toBe('function');
    expect(await decideTurn(live.agent)).toBeUndefined();

    budgetStop(session);

    // The decider reads the field live — pi snapshots the FUNCTION at run start, then calls it once
    // per model round-trip, so a boolean captured into the closure would freeze at the run's value.
    expect(await decideTurn(live.agent)).toEqual({ action: 'end' });
    // Graceful: the in-flight assistant message and its tool results must finish, so nothing tears
    // the stream and no sessionCancelled is emitted.
    expect(live.abort).not.toHaveBeenCalled();
    expect(markAborted).not.toHaveBeenCalled();
    await session.dispose();
  });

  it('a budget stop still aborts background subagents (they run outside the round-trip boundary)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const abortAll = vi.fn();
    priv(session).subagentManager.abortAll = abortAll;

    budgetStop(session);

    expect(abortAll).toHaveBeenCalledTimes(1);
    await session.dispose();
  });

  it('stopForBudget is inert when no turn is in flight', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    priv(session).processingFlag = false;

    priv(session).stopForBudget();

    expect(priv(session)._budgetStopRequested).toBe(false);
    await session.dispose();
  });

  // --- the FOUR turn-holding sites that must honor a budget stop -----------------------------------
  // Sites 2-4 are driven directly: the coordinator's own check (site 1) would otherwise mask them, so
  // a regression in any one of the three would hide behind a passing coordinator test.

  it('turn-hold site 1/4: onBeforeSettle declines to extend a budget-stopped turn', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    await session.setPermissionMode('plan');
    // Assert the coordinator's OWN check, not just the absence of a draft: the two downstream holds
    // bail on a budget stop themselves, so they would mask a regression here. A held parent turn that
    // resumes spends again, so the coordinator must not even reach them.
    const keepAlive = vi.spyOn(session as unknown as { tryBackgroundKeepAlive: () => Promise<unknown> }, 'tryBackgroundKeepAlive');
    budgetStop(session);

    expect(await fireBeforeSettle(cleanStop)).toBeUndefined();

    expect(keepAlive).not.toHaveBeenCalled();
    await session.dispose();
  });

  it('turn-hold site 2/4: tryBackgroundKeepAlive entry check declines under a budget stop', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const mgr = priv(session).subagentManager;
    mgr.hasPendingBackground = vi.fn(() => true);
    mgr.waitForBackground = vi.fn(async () => undefined);
    mgr.deliverableLive = vi.fn(() => [{ type: 'Explore', description: 'd', result: 'r' }]);
    budgetStop(session);

    expect(await priv(session).tryBackgroundKeepAlive()).toBeUndefined();

    // Bailed at the entry check — it never looked for pending work, so no continuation is requested.
    expect(mgr.hasPendingBackground).not.toHaveBeenCalled();
    expect(mgr.deliverableLive).not.toHaveBeenCalled();
    await session.dispose();
  });

  it('turn-hold site 3/4: tryBackgroundKeepAlive re-check after the await declines under a budget stop', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const mgr = priv(session).subagentManager;
    mgr.hasPendingBackground = vi.fn(() => true);
    // The limit is crossed WHILE waiting for background agents. The post-await re-check is the only
    // thing between that and an injected synthesis round the user is already over budget for.
    mgr.waitForBackground = vi.fn(async () => { budgetStop(session); });
    mgr.deliverableLive = vi.fn(() => [{ type: 'Explore', description: 'd', result: 'r' }]);

    expect(await priv(session).tryBackgroundKeepAlive()).toBeUndefined();

    expect(mgr.waitForBackground).toHaveBeenCalledTimes(1);
    await session.dispose();
  });

  it('queueInput refuses a steer once the budget stop is pending, even while the run is still streaming', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    live.isStreaming = true;
    expect(session.queueInput('before the limit', 'q1')).toBe('queued');

    budgetStop(session);

    // pi's settle boundary continues the run on a non-empty queue whatever the decider answered, so an
    // accepted steer here is one more billed round trip past a limit the user set as hard.
    expect(session.queueInput('after the limit', 'q2')).toBe(false);
    await session.dispose();
  });

  it('turn-hold site 4/4: tryPlanModeHold declines to extend a budget-stopped turn', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    await session.setPermissionMode('plan');
    budgetStop(session);

    expect(priv(session).tryPlanModeHold(cleanStop)).toBeUndefined();
    await session.dispose();
  });

  // --- the TWO sites that must NOT change (regression guards) --------------------------------------

  it('REGRESSION GUARD (deliberate non-change): the slash-command turn release keys off _aborting only, so it still releases the turn while a budget stop is pending', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const release = vi.spyOn(priv(session).adapter, 'endTurnWithoutAgentRun');
    // An extension slash command: prompt() handles it synchronously and starts NO agent run, so nothing
    // else settles the turn. Gating this branch on stopRequested() would hang the spinner forever.
    live.prompt = vi.fn(async () => { budgetStop(session); });

    await session.sendMessage('/todos', undefined, 'c1', { content: '/todos' });

    expect(release).toHaveBeenCalledTimes(1);
    await session.dispose();
  });

  it('REGRESSION GUARD (deliberate non-change): the prompt() catch keys off _aborting only, so a genuine failure during a budget-stopped turn still surfaces an error', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    // A real failure that merely COINCIDES with a budget stop. Gating the catch on stopRequested()
    // would silently swallow it as if the user had pressed ESC — the error card would never appear.
    live.prompt = vi.fn(async () => { budgetStop(session); throw new Error('provider exploded'); });

    await session.sendMessage('hi', undefined, 'c1', { content: 'hi' });

    expect(messages.some((m) => m.type === 'error' && m.message === 'provider exploded')).toBe(true);
    await session.dispose();
  });

  // --- flag lifetime ------------------------------------------------------------------------------

  it('clears _budgetStopRequested at the start of the next send and in the finally, so a raised limit lets the session run again', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;

    // Start-of-send clear: a stop left over from a previous turn must not refuse the next one (the
    // pre-prompt budget block, not this flag, is what refuses a send while still over the limit).
    priv(session)._budgetStopRequested = true;
    let seenInsidePrompt: boolean | null = null;
    live.prompt = vi.fn(async () => { seenInsidePrompt = priv(session)._budgetStopRequested; });
    await session.sendMessage('hi', undefined, 'c1', { content: 'hi' });
    expect(seenInsidePrompt).toBe(false);

    // Finally clear: a stop raised mid-turn is dropped once that turn settles, so raising the limit
    // and sending again runs normally rather than stopping after the first round-trip.
    live.prompt = vi.fn(async () => { budgetStop(session); });
    await session.sendMessage('again', undefined, 'c2', { content: 'again' });
    expect(priv(session)._budgetStopRequested).toBe(false);
    expect(await decideTurn(live.agent)).toBeUndefined();
    await session.dispose();
  });

  it('re-installs the turn decider on the NEW Agent after a session replacement (/clear), not left stuck', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const first = H.getLastSession()!;
    budgetStop(session);
    expect(await decideTurn(first.agent)).toEqual({ action: 'end' });

    session.reset(); // -> runtime.newSession() -> setRebindSession -> bindSession
    await new Promise((r) => setTimeout(r, 0));

    const replacement = H.getLastSession()!;
    expect(replacement).not.toBe(first);
    // A replacement session brings a NEW Agent, so the decider must be installed again per bind.
    expect(typeof replacement.agent.finishTurn).toBe('function');
    // reset() clears the flag, so the new Agent is not born already refusing to run — the next send is
    // NOT what clears it. `resteerQueuedInputs` and `sendCustomMessage(triggerTurn:true)` start work
    // outside sendMessage's try/finally, so a flag left set here truncates whichever runs first.
    expect(priv(session)._budgetStopRequested).toBe(false);
    expect(await decideTurn(replacement.agent)).toBeUndefined();
    await session.dispose();
  });

  it('keeps the hook pi already installed, and adds one wrapper however many deciders and rebinds there are', async () => {
    // pi's AgentSession dispatches every extension `turn_end` through `agent.finishTurn`, so a decider
    // that replaced the field instead of deferring to it would silently drop the checkpoint handler.
    let priorCalls = 0;
    let priorDecision: AgentTurnDecision | undefined = { action: 'continue' };
    H.setSessionSetup((s) => {
      s.agent.finishTurn = (): AgentTurnDecision | undefined => { priorCalls++; return priorDecision; };
    });
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;

    expect(await decideTurn(live.agent)).toEqual({ action: 'continue' });
    expect(priorCalls).toBe(1);

    budgetStop(session);
    expect(await decideTurn(live.agent)).toEqual({ action: 'end' });
    expect(priorCalls).toBe(2);

    // A second decider plus a rebind: one wrapper, so the prior hook still runs once per turn rather
    // than once per layer, and each decider is still consulted. The rebind goes through a replacement
    // session, the only shape pi ever rebinds with, so this agent's wrapper must survive untouched.
    priv(session)._budgetStopRequested = false;
    const wrapper = live.agent.finishTurn;
    let teamCalls = 0;
    installTurnDecider(live.agent as unknown as Agent, TEAM_TERMINAL_HOOK, () => { teamCalls++; return undefined; });
    session.reset();
    await new Promise((r) => setTimeout(r, 0));
    expect(H.getLastSession()!).not.toBe(live);
    expect(live.agent.finishTurn).toBe(wrapper);
    priorCalls = 0;
    priorDecision = undefined;

    expect(await decideTurn(live.agent)).toBeUndefined();
    expect(priorCalls).toBe(1);
    expect(teamCalls).toBe(1);

    budgetStop(session);
    expect(await decideTurn(live.agent)).toEqual({ action: 'end' });
    expect(priorCalls).toBe(2);
    expect(teamCalls).toBe(2);
    await session.dispose();
  });

  it('a throwing decider holds no opinion, leaving the other decider and pi\'s own hook intact', async () => {
    // pi awaits `finishTurn` unguarded, so an escaping throw makes it replace the completed turn's
    // outcome with a synthetic error and re-emit turn_end: the checkpoint handler runs twice and the
    // user sees an error card for a turn that finished.
    let priorCalls = 0;
    H.setSessionSetup((s) => {
      s.agent.finishTurn = (): AgentTurnDecision | undefined => { priorCalls++; return undefined; };
    });
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    installTurnDecider(live.agent as unknown as Agent, TEAM_TERMINAL_HOOK, () => { throw new Error('decider exploded'); });
    budgetStop(session);

    expect(await decideTurn(live.agent)).toEqual({ action: 'end' });
    expect(priorCalls).toBe(1);
    await session.dispose();
  });

  it('beginAbort clears _budgetStopRequested, so the flag never outlives the turn it stopped', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    budgetStop(session);

    await session.interrupt();

    expect(priv(session)._budgetStopRequested).toBe(false);
    expect(await decideTurn(live.agent)).toBeUndefined();
    await session.dispose();
  });

  // --- what the user is told, and what the stop leaves behind ---------------------------------------

  it('tells the user the turn was cut short, exactly once even when the limit is crossed twice in one turn', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();

    budgetStop(session);
    priv(session).stopForBudget(); // a second crossing in the same turn (parent spend, then a subagent)

    const notices = messages.filter((m) => m.type === 'notification');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ notificationType: 'warning' });
    expect((notices[0] as { message: string }).message).toMatch(/budget limit/i);
    await session.dispose();
  });

  it('a second crossing in the same turn does not re-kill subagents or re-clear the queue', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const abortAll = vi.fn();
    priv(session).subagentManager.abortAll = abortAll;

    budgetStop(session);
    priv(session).stopForBudget();

    expect(abortAll).toHaveBeenCalledTimes(1);
    await session.dispose();
  });

  it('returns the queued steer a budget stop would otherwise strand to the input (chip + pi steering queue)', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    live.isStreaming = true;
    expect(session.queueInput('mid-turn thought', 'q1')).toBe('queued');
    (live.clearQueue as ReturnType<typeof vi.fn>).mockClear();
    messages.length = 0;

    budgetStop(session);

    // The chip must not stay pending: the pre-prompt block refuses the next send, so nothing else
    // would ever drain it. Its text was never sent, so it goes back to the input as on ESC.
    expect(messages.filter((m) => m.type === 'queueCancelled')).toEqual([{ type: 'queueCancelled', messageId: 'q1', returnToInput: true }]);
    // …and pi's own steering queue must be dropped too, or the stale steer replays into a later turn.
    expect(live.clearQueue).toHaveBeenCalled();
    await session.dispose();
  });

  it('a budget stop followed by ESC still cancels: sessionCancelled, markAborted, no lingering stop flag', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const markAborted = vi.spyOn(priv(session).adapter, 'markAborted');
    budgetStop(session);

    await session.interrupt();

    expect(markAborted).toHaveBeenCalledTimes(1);
    expect(live.abort).toHaveBeenCalledTimes(1);
    expect(messages.some((m) => m.type === 'sessionCancelled')).toBe(true);
    expect(priv(session)._budgetStopRequested).toBe(false);
    await session.dispose();
  });

  it('ESC first: a budget crossing that lands after it is inert (no notice, no second abortAll)', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    priv(session).processingFlag = true;
    await session.interrupt();
    const abortAll = vi.fn();
    priv(session).subagentManager.abortAll = abortAll;
    messages.length = 0;

    priv(session).stopForBudget(); // the adapter's in-flight check fires after beginAbort won the race

    expect(priv(session)._budgetStopRequested).toBe(false);
    expect(abortAll).not.toHaveBeenCalled();
    expect(messages.some((m) => m.type === 'notification')).toBe(false);
    await session.dispose();
  });

  it('dispose() during a budget-stopped turn tears down cleanly', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    budgetStop(session);

    await expect(session.dispose()).resolves.toBeUndefined();

    expect(messages.some((m) => m.type === 'error')).toBe(false);
  });

  // --- the pre-prompt gate: the bound that must survive into the NEXT turn --------------------------

  it('refuses the next turn when parent + SUBAGENT spend crosses the limit ($0.40 + $0.70 vs $1.00)', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    withBudget(1.0);
    live.sessionManager.getEntries = vi.fn(() => [{ type: 'message', message: { role: 'assistant', usage: { cost: { total: 0.4 } } } }]);
    // Subagent spend lives on the adapter, not in pi's session stats. A gate that measured only the
    // parent would admit this turn while the adapter's in-flight check considers the limit crossed.
    priv(session).adapter.addExternalCost(0.7);

    await session.sendMessage('again', undefined, 'c1', { content: 'again' });

    expect(live.prompt).not.toHaveBeenCalled();
    const exceeded = messages.find((m) => m.type === 'budgetExceeded');
    expect(exceeded).toMatchObject({ finalSpend: 1.1, limit: 1.0 });
    expect(messages.some((m) => m.type === 'processing' && m.isProcessing === false)).toBe(true);
    // `beginTurn` (which re-arms the adapter's in-flight enforcement) is the first thing to emit
    // processing:true, and it is unreachable past this gate — which is why re-arming per turn cannot
    // re-emit a budget banner while the session is still over the limit.
    expect(messages.some((m) => m.type === 'processing' && m.isProcessing === true)).toBe(false);
    await session.dispose();
  });

  it('still admits a turn when parent + subagent spend is under the limit', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    withBudget(1.0);
    live.sessionManager.getEntries = vi.fn(() => [{ type: 'message', message: { role: 'assistant', usage: { cost: { total: 0.4 } } } }]);
    priv(session).adapter.addExternalCost(0.2);

    await session.sendMessage('again', undefined, 'c1', { content: 'again' });

    expect(live.prompt).toHaveBeenCalledTimes(1);
    await session.dispose();
  });

  it('admits a fork whose parent spent past the limit, because the gate counts only its own spend', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    withBudget(1.0);
    live.sessionManager.getHeader = vi.fn(() => ({ timestamp: '2026-01-02T00:00:00.000Z' }));
    live.sessionManager.getEntries = vi.fn(() => [
      { type: 'message', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'assistant', usage: { cost: { total: 5.2 } } } },
      { type: 'message', timestamp: '2026-01-02T00:00:01.000Z', message: { role: 'assistant', usage: { cost: { total: 0.12 } } } },
    ]);

    await session.sendMessage('again', undefined, 'c1', { content: 'again' });

    expect(live.prompt).toHaveBeenCalledTimes(1);
    await session.dispose();
  });
});

/**
 * The provider-fallback warning (B4/B7/B8). `makeOptions` never set `secrets`, so `start()` skipped the
 * sync entirely and this whole half of the release was unreachable from the suite — a
 * `syncCustomProviders` that returned `undefined` would have thrown out of every startup with the suite
 * still green. These drive the real `start()` path with a SecretStorage stand-in.
 */
describe('PiSession custom-provider fallback warning', () => {
  beforeEach(() => {
    H.seq.length = 0;
    H.captured.services.length = 0;
    H.resetServices();
  });
  afterEach(async () => {
    await PiRuntime.disposeInstance();
    vi.restoreAllMocks();
  });

  type SyncResult = { wired: string[]; notWired: string[]; timedOut: boolean };

  function stubSync(result: SyncResult): PiRuntime {
    const runtime = PiRuntime.get('/fake/agent');
    vi.spyOn(runtime, 'syncCustomProviders').mockResolvedValue(result);
    return runtime;
  }

  /** The warning is fire-and-forget, so let its microtasks run before asserting. */
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  function startWith(model: string, result: SyncResult): { session: PiSession; warn: ReturnType<typeof vi.spyOn> } {
    stubSync(result);
    const warn = vi.spyOn(testPlatform.notifications, 'warn');
    const session = new PiSession(makeOptions([], { model, secrets: FAKE_SECRETS }));
    return { session, warn };
  }

  it('names the NOT-WIRED provider and both models by display name, and offers Reload Window', async () => {
    const { session, warn } = startWith('deepseek-v4-flash', { wired: [], notWired: ['deepseek'], timedOut: true });
    await session.initializeEarly();
    await settle();

    expect(warn).toHaveBeenCalledTimes(1);
    const [message, action] = warn.mock.calls[0] as [string, string];
    // Display names, never the raw pi ids the user has never seen (`deepseek` / `deepseek-v4-flash`).
    expect(message).toContain('DeepSeek');
    expect(message).toContain('DeepSeek V4 Flash');
    expect(message).toContain('Opus 5.5');
    expect(message).not.toContain('deepseek-v4-flash');
    expect(action).toBe('Reload Window');
    await session.dispose();
  });

  it('says nothing when the provider is in NEITHER list — no secret is a user-caused absence, not a timeout', async () => {
    // The whole point of the notWired contract: a deleted key deauthenticates the provider, so it is in
    // neither list. Testing `!wired.includes(provider)` here diagnosed a timeout and offered a reload
    // that cannot possibly help.
    const { session, warn } = startWith('deepseek-v4-flash', { wired: ['stepfun'], notWired: [], timedOut: true });
    await session.initializeEarly();
    await settle();

    expect(warn).not.toHaveBeenCalled();
    await session.dispose();
  });

  it('says nothing when the requested model still resolved despite the timeout', async () => {
    H.getServices().modelRuntime.getModel = (provider: string, id: string) =>
      (provider === 'deepseek' && id === 'deepseek-v4-flash'
        ? { id, name: 'DeepSeek V4 Flash', api: 'anthropic-messages', provider, contextWindow: 1_000_000 }
        : undefined) as never;
    const { session, warn } = startWith('deepseek-v4-flash', { wired: [], notWired: ['deepseek'], timedOut: true });
    await session.initializeEarly();
    await settle();

    expect(warn).not.toHaveBeenCalled();
    await session.dispose();
  });

  it('says nothing for a first-party model (no piProvider), even on a timeout', async () => {
    const { session, warn } = startWith('claude-opus-5-5', { wired: [], notWired: ['deepseek'], timedOut: true });
    await session.initializeEarly();
    await settle();

    expect(warn).not.toHaveBeenCalled();
    await session.dispose();
  });

  it('warns even when NO model could be resolved — the genuinely broken case must not be silent', async () => {
    // `resolveInitialModel` found nothing authed, so `modelValue` still equals the requested value. The
    // old "did the model change?" guard read that as "nothing to report".
    H.getServices().modelRuntime.hasConfiguredAuth = () => false;
    const { session, warn } = startWith('deepseek-v4-flash', { wired: [], notWired: ['deepseek'], timedOut: true });
    await session.initializeEarly();
    await settle();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0] as string).toContain('no signed-in model could be selected');
    await session.dispose();
  });

  it('shows ONE modal per PiRuntime, not one per open panel', async () => {
    const { session, warn } = startWith('deepseek-v4-flash', { wired: [], notWired: ['deepseek'], timedOut: true });
    const second = new PiSession(makeOptions([], { model: 'deepseek-v4-flash', secrets: FAKE_SECRETS }));
    await session.initializeEarly();
    await second.initializeEarly();
    await settle();

    expect(warn).toHaveBeenCalledTimes(1);
    await session.dispose();
    await second.dispose();
  });

  it('"Reload Window" reloads the window', async () => {
    stubSync({ wired: [], notWired: ['deepseek'], timedOut: true });
    vi.spyOn(testPlatform.notifications, 'warn').mockResolvedValue('Reload Window' as never);
    const session = new PiSession(makeOptions([], { model: 'deepseek-v4-flash', secrets: FAKE_SECRETS }));

    await session.initializeEarly();
    await settle();

    expect(testPlatform.lifecycle.reloads).toBe(1);
    await session.dispose();
  });

  it('a failing reload command is handled, not dropped as an unhandled rejection', async () => {
    stubSync({ wired: [], notWired: ['deepseek'], timedOut: true });
    vi.spyOn(testPlatform.notifications, 'warn').mockResolvedValue('Reload Window' as never);
    // A PLAIN rejecting function, not a vi mock: vi.fn() attaches its own handler to the promise it
    // returns, which swallows the very unhandled rejection this test exists to detect.
    const lifecycle = testPlatform.lifecycle as { reload: () => Promise<void> };
    const realReload = lifecycle.reload;
    lifecycle.reload = () => Promise.reject(new Error('command registry down'));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    const session = new PiSession(makeOptions([], { model: 'deepseek-v4-flash', secrets: FAKE_SECRETS }));

    try {
      await session.initializeEarly();
      await settle();
      await settle();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      lifecycle.reload = realReload;
    }
    await session.dispose();
  });

  it('degrades silently on the accepted residual: timed out with an EMPTY notWired', async () => {
    // The abort can fire at index 0, before any secret was read, so `timedOut` does NOT imply that
    // notWired names anyone (contract-notWired, Amendment 1). Naming a provider we never confirmed
    // would be a worse lie than silence — and nothing may interpolate `undefined` into user-facing text.
    const messages: ExtensionToWebviewMessage[] = [];
    stubSync({ wired: [], notWired: [], timedOut: true });
    const warn = vi.spyOn(testPlatform.notifications, 'warn');
    const session = new PiSession(makeOptions(messages, { model: 'deepseek-v4-flash', secrets: FAKE_SECRETS }));

    await session.initializeEarly();
    await settle();

    expect(warn).not.toHaveBeenCalled();
    expect(H.getLastSession()).not.toBeNull();
    expect(messages.some((m) => JSON.stringify(m).includes('undefined'))).toBe(false);
    await session.dispose();
  });

  it('start() survives a sync that reports nothing wired and no timeout', async () => {
    const { session, warn } = startWith('deepseek-v4-flash', { wired: [], notWired: [], timedOut: false });
    await session.initializeEarly();
    await settle();

    expect(H.getLastSession()).not.toBeNull();
    expect(warn).not.toHaveBeenCalled();
    await session.dispose();
  });
});

/**
 * The MAIN `buildCustomTools` call site's note delivery. The other two sites are reachable from a bare
 * PiSession and are covered in `tools/__tests__/note-delivery.test.ts`; this one lives inside the
 * runtime factory, so only this harness can reach it.
 */
describe('cancel note delivery: the main build site', () => {
  beforeEach(() => {
    H.seq.length = 0;
    H.captured.services.length = 0;
    H.captured.customTools = [];
    H.resetServices();
  });
  afterEach(async () => {
    H.setBashExecute(async () => ({ content: [], details: undefined }));
    await PiRuntime.disposeInstance();
  });

  /** Hold a bash call open until the signal it was handed aborts, so the Stop click lands on a live call. */
  function holdBashUntilAborted(): void {
    H.setBashExecute((async (_id: string, _params: unknown, signal?: AbortSignal) => {
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { content: [{ type: 'text', text: 'partial' }], details: undefined };
    }) as unknown as (...a: never[]) => Promise<unknown>);
  }

  /** The live pi session mid-run, as a Stop click finds it: a prompt is queued and reported accepted. */
  function streamingPanelSession(): { prompt: ReturnType<typeof vi.fn>; steer: ReturnType<typeof vi.fn>; sendUserMessage: ReturnType<typeof vi.fn> } {
    const live = H.getLastSession() as unknown as { isStreaming: boolean; prompt: ReturnType<typeof vi.fn>; steer: ReturnType<typeof vi.fn>; sendUserMessage: ReturnType<typeof vi.fn> };
    live.isStreaming = true;
    live.prompt.mockImplementation(async (_text: string, opts?: { preflightResult?: (disposition: string) => void }) => {
      opts?.preflightResult?.('queued');
    });
    return live;
  }

  it('queues the note on the PANEL session as a real user turn and echoes it into the transcript', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    holdBashUntilAborted();

    const bash = H.captured.customTools.find((t) => t.name === 'bash');
    // Non-vacuous: without a real bash tool from the real factory the assertions below say nothing.
    expect(bash).toBeDefined();
    const piSession = streamingPanelSession();
    const pending = (bash!.execute as unknown as (id: string, p: unknown, s?: AbortSignal, u?: unknown, c?: unknown) => Promise<unknown>)('call-1', { command: 'sleep 300' }, undefined, undefined, {});

    expect(session.cancelToolCall('call-1', 'wrong loop, use seq 1 5')).toBe(true);
    await pending;

    // Steered, so pi hands it to the model at the next tool boundary of this run rather than after it.
    expect(piSession.prompt).toHaveBeenCalledWith('wrong loop, use seq 1 5', {
      expandPromptTemplates: false,
      streamingBehavior: 'steer',
      source: 'extension',
      preflightResult: expect.any(Function),
    });

    const echo = messages.filter((m) => m.type === 'userMessage');
    expect(echo).toHaveLength(1);
    expect(echo[0]).toMatchObject({ type: 'userMessage', content: 'wrong loop, use seq 1 5', isInjected: true });
    expect(echo[0]).not.toHaveProperty('isCommandEcho');
    await session.dispose();
  });

  it('delivers a note starting with a slash as literal text, never as a command', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    holdBashUntilAborted();

    const bash = H.captured.customTools.find((t) => t.name === 'bash');
    expect(bash).toBeDefined();
    const piSession = streamingPanelSession();
    const pending = (bash!.execute as unknown as (id: string, p: unknown, s?: AbortSignal, u?: unknown, c?: unknown) => Promise<unknown>)('call-2', { command: 'sleep 300' }, undefined, undefined, {});

    expect(session.cancelToolCall('call-2', '/compact and use seq 1 5')).toBe(true);
    await pending;

    // `expandPromptTemplates: false` is the guard: pi's prompt() dispatches an extension command and
    // expands skills and templates only when it is true, so the note can never be executed or throw.
    expect(piSession.prompt).toHaveBeenCalledWith('/compact and use seq 1 5', expect.objectContaining({ expandPromptTemplates: false, streamingBehavior: 'steer' }));
    expect(piSession.sendUserMessage).not.toHaveBeenCalled();
    expect(piSession.steer).not.toHaveBeenCalled();
    // The text reaches the transcript exactly as typed, with no expansion and no leading-slash stripping.
    expect(messages.filter((m) => m.type === 'userMessage')[0]).toMatchObject({ content: '/compact and use seq 1 5' });
    await session.dispose();
  });

  it('dispose empties the cancel store, so a call it still held cannot keep the session reachable', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    H.setBashExecute((async () => { await gate; return { content: [], details: undefined }; }) as unknown as (...a: never[]) => Promise<unknown>);

    const bash = H.captured.customTools.find((t) => t.name === 'bash');
    expect(bash).toBeDefined();
    const run = bash!.execute as unknown as (id: string, p: unknown, s?: AbortSignal, u?: unknown, c?: unknown) => Promise<unknown>;
    const probe = run('call-probe', { command: 'sleep 300' }, undefined, undefined, {});
    const held = run('call-held', { command: 'sleep 300' }, undefined, undefined, {});
    // Not vacuous: an entry registered the same way is live right now, so the store is not simply empty.
    // `cancel` is idempotent, so the probe is a second id rather than a second cancel of the same one.
    const store = (session as unknown as { shellCancel: { cancel: (id: string) => boolean } }).shellCancel;
    expect(store.cancel('call-probe')).toBe(true);

    await session.dispose();

    // Each entry closes over its build context, so one that never releases pins the disposed PiSession,
    // its subagent manager and its message bus for the life of the host.
    expect(store.cancel('call-held')).toBe(false);
    release();
    await Promise.all([probe, held]);
  });

  it('queues nothing when the user cancelled without a note', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    holdBashUntilAborted();

    const bash = H.captured.customTools.find((t) => t.name === 'bash');
    expect(bash).toBeDefined();
    const pending = (bash!.execute as unknown as (id: string, p: unknown, s?: AbortSignal, u?: unknown, c?: unknown) => Promise<unknown>)('call-3', { command: 'sleep 300' }, undefined, undefined, {});

    expect(session.cancelToolCall('call-3')).toBe(true);
    await pending;

    const piSession = H.getLastSession() as unknown as { prompt: ReturnType<typeof vi.fn> };
    expect(piSession.prompt).not.toHaveBeenCalled();
    expect(messages.filter((m) => m.type === 'userMessage')).toEqual([]);
    await session.dispose();
  });
});


/**
 * The session job is panel-scoped: one per `PiSession`, disposed with it, never shared between panels.
 * A host-wide singleton would compile and pass every single-panel test while killing another panel's
 * commands on dispose, so the two-instance case is the one that matters here.
 */
describe('the shell session job is scoped to the panel', () => {
  beforeEach(() => {
    JOB.created.length = 0;
    JOB.next = 0;
    H.resetServices();
  });
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  it('creates exactly one per PiSession and disposes it with the session', async () => {
    const session = new PiSession(makeOptions([]));
    expect(JOB.created).toHaveLength(1);
    expect(JOB.created[0]?.disposed).toBe(0);

    await session.dispose();

    expect(JOB.created[0]?.disposed).toBe(1);
  });

  it('gives two concurrent sessions their own job, so disposing one cannot reach the other', async () => {
    const first = new PiSession(makeOptions([]));
    const second = new PiSession(makeOptions([]));
    expect(JOB.created).toHaveLength(2);

    await first.dispose();

    // The surviving panel's commands must be untouched; a shared handle would have closed here.
    expect(JOB.created[0]?.disposed).toBe(1);
    expect(JOB.created[1]?.disposed).toBe(0);

    await second.dispose();
    expect(JOB.created[1]?.disposed).toBe(1);
  });

  it('survives a reset, because the panel owns it and the conversation does not', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    expect(JOB.created).toHaveLength(1);

    H.seq.length = 0;
    session.reset();
    await new Promise((r) => setTimeout(r, 0));
    // Non-vacuous: a reset that never replaced the pi session would leave every assertion below trivially true.
    expect(H.seq.filter((e) => e === 'subscribe')).toHaveLength(2);

    // A job rebuilt per conversation would mint a second handle and close the first, killing anything the
    // user had deliberately backgrounded before the reset.
    expect(JOB.created).toHaveLength(1);
    expect(JOB.created[0]?.disposed).toBe(0);

    await session.dispose();
    expect(JOB.created[0]?.disposed).toBe(1);
  });

  it('hands the same job to the main, subagent and team tool builders', async () => {
    const builds = vi.mocked(buildCustomTools);
    builds.mockClear();
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();

    // One handle for the panel means every context nests in it; a second would unnest one of them.
    expect(JOB.created).toHaveLength(1);

    const internals = session as unknown as {
      buildSubagentEngine: (pi: unknown) => { buildAgentToolset: (i: { agentId: string; agentName: string; mcpDisallowed: ReadonlySet<string> }) => unknown };
      buildTeamAgentCustomTools: (pi: unknown, ctx: unknown) => unknown;
    };
    internals.buildSubagentEngine(getPiCodingAgent() as never).buildAgentToolset({
      agentId: 'a1',
      agentName: 'general-purpose',
      mcpDisallowed: new Set<string>(),
    });
    internals.buildTeamAgentCustomTools(getPiCodingAgent() as never, {
      agentId: 'agent-1',
      agentName: 'specialist',
      browserScopeId: 'agent-1#1',
      teamId: 'team-1',
      role: 'specialist',
      deliverUserNote: () => true,
    });

    // The main factory site, then the subagent site, then the team site. Reading the deps each site
    // passed is the only way to see a builder that silently omits the job.
    const [main, subagent, team] = builds.mock.calls.map((c) => c[0]);
    expect(builds).toHaveBeenCalledTimes(3);
    // Not vacuous: without this, three `undefined`s would satisfy the identity checks below.
    expect(main?.shellJob).toBeDefined();
    expect(subagent?.shellJob).toBe(main?.shellJob);
    expect(team?.shellJob).toBe(main?.shellJob);
    // The cancel store is panel-scoped for the same reason, so one Stop finds the call whoever ran it.
    expect(subagent?.shellCancel).toBe(main?.shellCancel);
    expect(team?.shellCancel).toBe(main?.shellCancel);
    await session.dispose();
  });
});

/**
 * A team agent's cost label is decided by the credential its own model runs on, so the resolver needs
 * the live Claude auth mode. Reading it here is the only place that mode reaches team resolution.
 */
describe('team role dollar billing', () => {
  beforeEach(() => {
    H.seq.length = 0;
    H.resetServices();
  });

  async function billingFor(mode: string): Promise<boolean> {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    vi.spyOn(PiRuntime.get('/fake/agent'), 'getClaudeAuthStatus').mockReturnValue({ mode } as never);
    const resolved = session.resolveTeamRole('lead');
    await session.dispose();
    return resolved.dollarBilled;
  }

  it('bills an API-key session', async () => {
    expect(await billingFor('apikey')).toBe(true);
  });

  it('does not bill a subscription session', async () => {
    expect(await billingFor('allowance')).toBe(false);
  });
});

/**
 * Account state is derived from five inputs and has one publisher: the panel model, its catalog entry,
 * the Claude auth mode, the OpenAI auth state and the prefer-API-key flag. These pin that the publisher
 * runs on every input change, and that it always restates what the builder would produce right then.
 */
describe('PiSession account state publication', () => {
  beforeEach(() => {
    H.seq.length = 0;
    H.resetServices();
    // Earlier suites leave auth spies on the runtime singleton, and these assert exact account values.
    vi.restoreAllMocks();
    vi.spyOn(PiRuntime.get('/fake/agent'), 'getClaudeAuthStatus').mockReturnValue({ mode: 'none' });
  });
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  function published(messages: ExtensionToWebviewMessage[]): AccountInfo | undefined {
    const last = messages.filter((m) => m.type === 'accountInfo').at(-1);
    return last?.type === 'accountInfo' ? last.data : undefined;
  }

  /** What the builder produces from the session's live inputs, read through its public surface. */
  function expectedFor(session: PiSession, preferApiKey = false): AccountInfo {
    const runtime = PiRuntime.get('/fake/agent');
    return buildAccountInfo({
      modelValue: session.currentModel ?? '',
      modelInfo: session.getModelInfo(),
      claudeAuthMode: runtime.getClaudeAuthStatus().mode,
      openaiAuthStatus: runtime.getOpenAIAuthStatus(),
      preferApiKey,
    });
  }

  /** Teach the fake registry the OpenAI provider, so a switch to a GPT model resolves; `codex` adds it to the Codex catalog. */
  function registerOpenAIModel(codex = false): void {
    const registry = H.getServices().modelRuntime;
    const anthropicOnly = registry.getModel;
    registry.getModel = (provider: string, id: string) =>
      (provider === 'openai' || (codex && provider === 'openai-codex')) && id === 'gpt-6.1-sol'
        ? { id, name: 'GPT-6.1 Sol', api: 'anthropic-messages', provider, contextWindow: 272_000 }
        : anthropicOnly(provider, id);
  }

  it('publishes at start, so a panel has account state before its first turn', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();

    expect(published(messages)).toEqual({ model: 'claude-opus-5-5', dollarBilled: false });
    await session.dispose();
  });

  it('publishes nothing once the runtime is retired, and builds no new runtime to do it', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const before = messages.length;
    await PiRuntime.disposeInstance();

    session.publishAccountInfo();

    expect(messages.length).toBe(before);
    expect(PiRuntime.exists).toBe(false);
    await session.dispose();
  });

  it('republishes on a model switch, carrying the new model billing', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const runtime = PiRuntime.get('/fake/agent');
    vi.spyOn(runtime, 'getOpenAIAuthStatus').mockReturnValue({ apiKey: true, chatgpt: false, codex: false });
    registerOpenAIModel();

    session.setModel('gpt-6.1-sol');

    // The panel model was a subscription-billed Claude one; the switch target is metered by the key.
    expect(published(messages)).toEqual({ model: 'gpt-6.1-sol', dollarBilled: true });
    await session.dispose();
  });

  it('does not republish when a model switch is refused, because nothing changed', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const before = messages.filter((m) => m.type === 'accountInfo').length;

    session.setModel('gpt-6.1-sol'); // no OpenAI credential and no registry entry

    expect(session.currentModel).toBe('claude-opus-5-5');
    expect(messages.filter((m) => m.type === 'accountInfo')).toHaveLength(before);
    await session.dispose();
  });

  it('republishes an auth change with the new credential', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const runtime = PiRuntime.get('/fake/agent');
    vi.spyOn(runtime, 'getClaudeAuthStatus').mockReturnValue({ mode: 'apikey' });

    session.publishAccountInfo();

    expect(published(messages)).toEqual({ model: 'claude-opus-5-5', dollarBilled: true });
    await session.dispose();
  });

  it('republishes a prefer-API-key change with the new token source', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    let preferApiKey = false;
    const session = new PiSession(makeOptions(messages, { getPreferOpenAIApiKey: () => preferApiKey }));
    await session.initializeEarly();
    const runtime = PiRuntime.get('/fake/agent');
    vi.spyOn(runtime, 'getOpenAIAuthStatus').mockReturnValue({ apiKey: true, chatgpt: false, codex: true });
    registerOpenAIModel(true);
    session.setModel('gpt-6.1-sol');
    expect(published(messages)).toEqual({ model: 'gpt-6.1-sol', dollarBilled: false });

    preferApiKey = true;
    session.publishAccountInfo();

    expect(published(messages)).toEqual({ model: 'gpt-6.1-sol', dollarBilled: true });
    await session.dispose();
  });

  it('bills the key for a GPT model outside the Codex catalog, although a Codex grant exists', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const runtime = PiRuntime.get('/fake/agent');
    vi.spyOn(runtime, 'getOpenAIAuthStatus').mockReturnValue({ apiKey: true, chatgpt: false, codex: true });
    registerOpenAIModel();

    session.setModel('gpt-6.1-sol');

    expect(published(messages)).toEqual({ model: 'gpt-6.1-sol', dollarBilled: true });
    await session.dispose();
  });

  it('resolves GPT-6.1 Sol to openai under ChatGPT as a subscription, and the prefer toggle flips billing with no login', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    let preferApiKey = false;
    const session = new PiSession(makeOptions(messages, { getPreferOpenAIApiKey: () => preferApiKey }));
    await session.initializeEarly();
    const runtime = PiRuntime.get('/fake/agent');
    vi.spyOn(runtime, 'getOpenAIAuthStatus').mockReturnValue({ apiKey: true, chatgpt: true, codex: false });
    const signIn = vi.spyOn(runtime, 'signInChatGPT');
    registerOpenAIModel();
    session.setModel('gpt-6.1-sol');
    expect(session.currentModel).toBe('gpt-6.1-sol');
    expect(published(messages)).toEqual({ model: 'gpt-6.1-sol', dollarBilled: false });

    preferApiKey = true;
    session.publishAccountInfo();
    expect(published(messages)).toEqual({ model: 'gpt-6.1-sol', dollarBilled: true });

    preferApiKey = false;
    session.publishAccountInfo();
    expect(published(messages)).toEqual({ model: 'gpt-6.1-sol', dollarBilled: false });
    expect(signIn).not.toHaveBeenCalled();
    await session.dispose();
  });

  it('publishes what the builder produces from the same inputs, in every state it reaches', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const runtime = PiRuntime.get('/fake/agent');
    expect(published(messages)).toEqual(expectedFor(session));

    vi.spyOn(runtime, 'getClaudeAuthStatus').mockReturnValue({ mode: 'extra' });
    session.publishAccountInfo();
    expect(published(messages)).toEqual(expectedFor(session));

    vi.spyOn(runtime, 'getOpenAIAuthStatus').mockReturnValue({ apiKey: true, chatgpt: false, codex: false });
    registerOpenAIModel();
    session.setModel('gpt-6.1-sol');
    expect(published(messages)).toEqual(expectedFor(session));
    await session.dispose();
  });
});

describe('cache-warming mode reaches pi (US-slice3)', () => {
  beforeEach(() => {
    H.seq.length = 0;
    H.captured.services.length = 0;
    H.resetServices();
  });
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  /** Stub `damocles.cacheWarming` with a value the test can change between reads. */
  function stubCacheWarming(read: () => string): void {
    vi.spyOn(testPlatform.settings, 'get').mockImplementation(settingsReader((key: string) => (key === 'damocles.cacheWarming' ? read() : undefined)));
  }

  // The assertion the slice turns on: the mode must READ BACK through `getCacheWarmingMode()`, the
  // getter pi's CacheWarmer calls. The fake reads `globalSettings`, which `applyOverrides` never
  // writes, so routing the mode through `applyOverrides` would leave this at the "streaming" default.
  it('reads back through getCacheWarmingMode at session start', async () => {
    stubCacheWarming(() => 'idle');
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();

    expect(H.getServices().settingsManager.getCacheWarmingMode()).toBe('idle');
    await session.dispose();
  });

  it('re-applies the mode when damocles.cacheWarming changes mid-session, with no reload', async () => {
    let mode = 'streaming';
    stubCacheWarming(() => mode);
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const sm = H.getServices().settingsManager;
    expect(sm.getCacheWarmingMode()).toBe('streaming');

    mode = 'off';
    fireSettingChange('damocles.cacheWarming');

    expect(sm.getCacheWarmingMode()).toBe('off');
    expect(sm.setCacheWarmingMode).toHaveBeenLastCalledWith('off');
    await session.dispose();
  });

  it('ignores a config change to an unrelated damocles setting', async () => {
    let mode = 'streaming';
    stubCacheWarming(() => mode);
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const sm = H.getServices().settingsManager;
    const callsAtStart = sm.setCacheWarmingMode.mock.calls.length;

    mode = 'off';
    fireSettingChange('damocles.team.enabled');

    expect(sm.setCacheWarmingMode.mock.calls.length).toBe(callsAtStart);
    expect(sm.getCacheWarmingMode()).toBe('streaming');
    await session.dispose();
  });
});

describe('per-model auto-compact budgets reach pi', () => {
  beforeEach(() => {
    H.seq.length = 0;
    H.captured.services.length = 0;
    H.resetServices();
  });
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  /** Stub `damocles.autoCompact` with a value the test can change between reads. */
  function stubAutoCompact(read: () => AutoCompactConfig): void {
    vi.spyOn(testPlatform.settings, 'get').mockImplementation(settingsReader((key: string) => (key === 'damocles.autoCompact' ? read() : undefined)));
  }

  /** The `compaction` override last written to the settings manager. */
  function lastCompaction(): Record<string, unknown> {
    const calls = H.getServices().settingsManager.applyOverrides.mock.calls;
    return (calls.at(-1)?.[0] as { compaction: Record<string, unknown> }).compaction;
  }

  // The session model is claude-opus-5-5 and the fake resolves its window to 1_000_000.
  it('applies the plain trigger percent when no model override exists', async () => {
    stubAutoCompact(() => ({ enabled: true, triggerPercent: 80 }));
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();

    expect(lastCompaction()).toEqual({ enabled: true, reserveTokens: 200_000 });
    await session.dispose();
  });

  it('honours an override for the active model', async () => {
    stubAutoCompact(() => ({ enabled: true, triggerPercent: 80, modelOverrides: { 'claude-opus-5-5': { triggerPercent: 55 } } }));
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();

    expect(lastCompaction().reserveTokens).toBe(450_000);
    await session.dispose();
  });

  it('ignores an override keyed to a model other than the active one', async () => {
    stubAutoCompact(() => ({ enabled: true, triggerPercent: 80, modelOverrides: { 'gpt-6.1-sol': { triggerPercent: 55 } } }));
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();

    expect(lastCompaction().reserveTokens).toBe(200_000);
    await session.dispose();
  });

  it('leaves keepRecentTokens out when the override sets only triggerPercent', async () => {
    stubAutoCompact(() => ({ enabled: true, triggerPercent: 80, modelOverrides: { 'claude-opus-5-5': { triggerPercent: 60 } } }));
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();

    expect(lastCompaction()).toEqual({ enabled: true, reserveTokens: 400_000 });
    await session.dispose();
  });

  it('passes keepRecentTokens and the plain reserve when the override sets only keepRecentPercent', async () => {
    stubAutoCompact(() => ({ enabled: true, triggerPercent: 80, modelOverrides: { 'claude-opus-5-5': { keepRecentPercent: 10 } } }));
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();

    expect(lastCompaction()).toEqual({ enabled: true, reserveTokens: 200_000, keepRecentTokens: 100_000 });
    await session.dispose();
  });

  it('re-asserts the override when damocles.autoCompact changes mid-session', async () => {
    let cfg: AutoCompactConfig = { enabled: true, triggerPercent: 80 };
    stubAutoCompact(() => cfg);
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    expect(lastCompaction().reserveTokens).toBe(200_000);

    cfg = { enabled: true, triggerPercent: 80, modelOverrides: { 'claude-opus-5-5': { triggerPercent: 55 } } };
    fireSettingChange('damocles.autoCompact');

    expect(lastCompaction().reserveTokens).toBe(450_000);
    await session.dispose();
  });
});

describe('PiSession: the first prompt waits for servers with Always-loaded tools', () => {
  beforeEach(() => {
    H.seq.length = 0;
    H.captured.services.length = 0;
    H.resetServices();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await PiRuntime.disposeInstance();
  });

  /** A source whose servers (`ctx` by default) are still connecting until `connect()` emits tools-changed. */
  function connectingSource(servers: string[] = ['ctx']) {
    let pending = [...servers];
    const listeners = new Set<() => void>();
    const source = {
      allToolNames: () => [],
      getAllToolDescriptors: () => [],
      getServerStatuses: () => [],
      pendingDirectServers: vi.fn(() => [...pending]),
      onToolsChanged: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as McpToolSource;
    const connect = (): void => {
      pending = [];
      for (const listener of [...listeners]) listener();
    };
    return { source, connect, listeners };
  }

  async function startedSession(messages: ExtensionToWebviewMessage[]) {
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    return session;
  }

  const waitNotices = (messages: ExtensionToWebviewMessage[]) =>
    messages.filter((m) => m.type === 'notification' && m.message.startsWith('Waiting for MCP server'));

  it('ends as soon as the server connects, and says which server it waits for', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = await startedSession(messages);
    const { source, connect, listeners } = connectingSource();
    stubPanelMcp(source);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    let done = false;
    const waiting = session.waitForAlwaysLoadedMcp('s1').then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(done).toBe(false);
    expect(waitNotices(messages)).toEqual([{ type: 'notification', notificationType: 'info', message: 'Waiting for MCP server ctx' }]);

    connect();
    await waiting;
    expect(done).toBe(true);
    expect(listeners.size).toBe(0);
    await session.dispose();
  });

  it('proceeds after 10 s when the server never connects', async () => {
    const session = await startedSession([]);
    const { source, listeners } = connectingSource();
    stubPanelMcp(source);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    let done = false;
    const waiting = session.waitForAlwaysLoadedMcp('s1').then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(done).toBe(true);
    expect(listeners.size).toBe(0);
    await session.dispose();
  });

  it('a stop ends the wait at once', async () => {
    const session = await startedSession([]);
    const { source } = connectingSource();
    stubPanelMcp(source);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    let done = false;
    const waiting = session.waitForAlwaysLoadedMcp('s1').then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(1_000);
    session.cancel();
    await vi.advanceTimersByTimeAsync(0);
    await waiting;
    expect(done).toBe(true);
    await session.dispose();
  });

  it('waits only on the first prompt of a session, and not at all when nothing Always-loaded is connecting', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = await startedSession(messages);
    const { source, connect } = connectingSource();
    stubPanelMcp(source);
    connect();

    await session.waitForAlwaysLoadedMcp('s1');
    expect(waitNotices(messages)).toEqual([]);

    const again = connectingSource();
    stubPanelMcp(again.source);
    await session.waitForAlwaysLoadedMcp('s1');
    expect(again.source.pendingDirectServers).not.toHaveBeenCalled();
    expect(waitNotices(messages)).toEqual([]);
    await session.dispose();
  });

  it('names several servers in the plural, and says which are still connecting when the wait gives up', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = await startedSession(messages);
    const { source } = connectingSource(['ctx', 'git']);
    stubPanelMcp(source);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const waiting = session.waitForAlwaysLoadedMcp('s1');
    await vi.advanceTimersByTimeAsync(10_000);
    await waiting;

    expect(waitNotices(messages).map((m) => (m as { message: string }).message)).toEqual(['Waiting for MCP servers ctx, git']);
    expect(messages).toContainEqual({
      type: 'notification',
      notificationType: 'info',
      message: 'MCP servers ctx, git are still connecting. Their Always-loaded tools join from the next turn after they connect.',
    });
    await session.dispose();
  });

  type FakeSession = NonNullable<ReturnType<typeof H.getLastSession>>;

  /**
   * pi 0.99.2's `prompt()` for a run it opens: the `before_agent_start` handlers run (the Damocles one
   * holds on the panel's wait), then `preflightResult('started')` is called synchronously and a throw
   * from it rejects `prompt()`, then `_runAgentPrompt` resets the abort flag and the agent loop calls
   * the provider with no abort check before the first request. `abort()` before the run is a no-op,
   * which is the default fake's.
   */
  function piPromptAfterWait(session: PiSession, live: FakeSession): { requests: number } {
    const provider = { requests: 0 };
    live.prompt.mockImplementation((async (_text: string, opts?: { preflightResult?: (disposition: string) => void }) => {
      await session.waitForAlwaysLoadedMcp(live.sessionId);
      opts?.preflightResult?.('started');
      provider.requests += 1;
    }) as never);
    return provider;
  }

  /** Start a send whose prompt is parked in the wait; `settled()` reports whether the send finished. */
  async function sendParkedInWait(session: PiSession, messages: ExtensionToWebviewMessage[]) {
    let done = false;
    const sending = session.sendMessage('go', undefined, 'c1', { content: 'go' }).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(waitNotices(messages)).toHaveLength(1);
    expect(done).toBe(false);
    return { sending, settled: () => done };
  }

  const errors = (messages: ExtensionToWebviewMessage[]) => messages.filter((m) => m.type === 'error');

  it('a stop during the wait sends no provider request and puts the message back in the composer', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = await startedSession(messages);
    const live = H.getLastSession()!;
    stubPanelMcp(connectingSource().source);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const provider = piPromptAfterWait(session, live);

    const parked = await sendParkedInWait(session, messages);
    session.cancel();
    await vi.advanceTimersByTimeAsync(0);

    expect(parked.settled()).toBe(true);
    expect(provider.requests).toBe(0);
    expect(messages).toContainEqual({ type: 'interruptRecovery', correlationId: 'c1', promptContent: 'go' });
    expect(errors(messages)).toEqual([]);
    expect(session.processing).toBe(false);
    await session.dispose();
  });

  it('a new chat during the wait sends no provider request, on the old session or the new one', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = await startedSession(messages);
    const first = H.getLastSession()!;
    stubPanelMcp(connectingSource().source);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const provider = piPromptAfterWait(session, first);

    const parked = await sendParkedInWait(session, messages);
    session.reset();
    await vi.advanceTimersByTimeAsync(0);
    await session.whenReplaced();

    expect(parked.settled()).toBe(true);
    expect(provider.requests).toBe(0);
    expect(H.getLastSession()).not.toBe(first);
    expect(H.getLastSession()!.prompt).not.toHaveBeenCalled();
    expect(errors(messages)).toEqual([]);
    await session.dispose();
  });

  it('a resume switch during the wait sends no provider request', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = await startedSession(messages);
    const first = H.getLastSession()!;
    stubPanelMcp(connectingSource().source);
    vi.mocked(resolvePiSessionFile).mockImplementationOnce(async (_cwd, id) => `/fake/agent/sessions/cwd/2026-01-01T00-00-00-000Z_${id}.jsonl`);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const provider = piPromptAfterWait(session, first);

    const parked = await sendParkedInWait(session, messages);
    session.setResumeSession('sess-target');
    await vi.advanceTimersByTimeAsync(0);
    await session.whenReplaced();

    expect(parked.settled()).toBe(true);
    expect(provider.requests).toBe(0);
    expect(H.getLastSession()).not.toBe(first);
    expect(errors(messages)).toEqual([]);
    await session.dispose();
  });

  it('a prompt nothing stopped still runs after the wait', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = await startedSession(messages);
    const live = H.getLastSession()!;
    const { source, connect } = connectingSource();
    stubPanelMcp(source);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const provider = piPromptAfterWait(session, live);

    const parked = await sendParkedInWait(session, messages);
    connect();
    await parked.sending;

    expect(provider.requests).toBe(1);
    expect(messages.some((m) => m.type === 'interruptRecovery')).toBe(false);
    await session.dispose();
  });
});

describe('PiSession: damocles.mcp.toolExposure and the panel ToolSearch', () => {
  beforeEach(() => {
    H.seq.length = 0;
    H.captured.services.length = 0;
    H.resetServices();
  });
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  it('a change from any writer re-applies the active set and re-sends the panel its MCP status', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const status = vi.fn();
    session.setMcpStatusListener(status);
    live.setActiveToolsByName.mockClear();

    fireSettingChange('damocles.mcp.toolExposure');

    expect(live.setActiveToolsByName).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(1);
    await session.dispose();
  });

  it('the snapshot names the groups of eligible Always-loaded tools, which hold no deferrable entry', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    stubPanelMcp({
      allToolNames: () => ['mcp__ctx__a', 'mcp__docs__b', 'mcp__off__c'],
      getAllToolDescriptors: () => [
        { piName: 'mcp__ctx__a', serverName: 'ctx', description: 'A', exposure: 'direct' },
        { piName: 'mcp__docs__b', serverName: 'docs', description: 'B', exposure: 'deferred' },
        { piName: 'mcp__off__c', serverName: 'off', description: 'C', exposure: 'off' },
      ],
      getServerStatuses: () => [],
    } as unknown as McpToolSource);

    const snapshot = session.deferrableToolsSnapshot();

    expect(snapshot.directMcpGroups).toEqual(new Set(['ctx']));
    expect([...snapshot.mcpGroups.keys()]).toEqual(['docs']);
    await session.dispose();
  });
});

describe('PiSession GenerateImage runs with the model its approval prompt showed', () => {
  it('bills the approved model, not a setting changed between the approval and the run', async () => {
    void testPlatform.settings.update('damocles.imageGeneration.model', 'changed/model', 'user');
    const base = makeOptions([]);
    const permissionHandler = { ...base.permissionHandler, takeApprovedImageModel: (id: string) => (id === 'g1' ? 'approved/model' : undefined) };
    const session = new PiSession({ ...base, permissionHandler: permissionHandler as unknown as SessionOptions['permissionHandler'] });
    await session.initializeEarly();
    const generateImages = vi.fn(async () => ({ stopReason: 'error', output: [], errorMessage: 'stub' }));
    Object.assign(PiRuntime.get().modelRuntime!, {
      getModelOfType: (_type: string, provider: string, id: string) => ({ id, provider, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }),
      generateImages,
    });

    const tool = H.captured.customTools.find((t) => t.name === TOOL_GENERATE_IMAGE)!;
    const target = path.join(os.tmpdir(), `dam-approved-model-${process.pid}.png`);
    await (tool.execute as (...args: unknown[]) => Promise<unknown>)('g1', { prompt: 'a fox', file_path: target }, undefined, undefined, undefined);

    expect(generateImages).toHaveBeenCalledWith(expect.objectContaining({ id: 'approved/model' }), expect.anything(), expect.anything());
    await session.dispose();
  });
});

describe('PiSession with no project folder takes no checkpoints', () => {
  beforeEach(() => {
    H.seq.length = 0;
    H.captured.services.length = 0;
    H.resetServices();
  });
  afterEach(async () => {
    H.setSessionSetup(null);
    H.setSessionManagerFactory(null);
    delete (H.fakePi.SessionManager as Record<string, unknown>)['open'];
    await PiRuntime.disposeInstance();
  });

  type Registries = { _panelRegistry: Map<string, PanelGateContext>; _checkpointRegistry: Map<string, unknown> };
  const prompt = (id: string, text: string) => ({ type: 'message', id, message: { role: 'user', content: [{ type: 'text', text }] } });

  it('creates no checkpoint service, and neither its gate nor a subagent gate has a baseline to wait on', async () => {
    const session = new PiSession(makeOptions([], { projectScope: false }));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const folder = cwdFolder()!;
    const registries = folder as unknown as Registries;

    expect(session.fileCheckpoints).toBe(false);
    expect((session as unknown as { checkpointService: unknown }).checkpointService).toBeNull();
    expect(registries._checkpointRegistry.has(live.sessionId)).toBe(false);
    const gate = registries._panelRegistry.get(live.sessionId)!;
    expect(gate).not.toHaveProperty('checkpointBaseline');
    const subagentEngine = (session as unknown as { buildSubagentEngine(pi: unknown, folder: unknown): object }).buildSubagentEngine(getPiCodingAgent(), folder);
    expect(subagentEngine).not.toHaveProperty('checkpointBaseline');
    await session.dispose();
  });

  it('makes every prompt a conversation rewind point and refuses a file rewind or undo with the reason', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages, { projectScope: false }));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const getBranch = live.sessionManager.getBranch as ReturnType<typeof vi.fn>;
    getBranch.mockReturnValue([]);
    (live.prompt as ReturnType<typeof vi.fn>).mockImplementation(async (_text: string, opts: unknown) => {
      piRuns(opts, getBranch, [prompt('u1', 'list my downloads')]);
    });

    await session.sendMessage('list my downloads', undefined, 'c1', { content: 'list my downloads' });
    await session.rewindFiles('u1', 'code-only');
    await session.undoRewind('r1');

    expect(messages.filter((m) => m.type === 'checkpointInfo').at(-1)).toEqual({ type: 'checkpointInfo', userMessageIds: ['u1'] });
    const reason = 'This chat has no project folder, so its files have no checkpoints to restore.';
    expect(messages.flatMap((m) => (m.type === 'rewindError' ? [m.message] : []))).toEqual([reason, reason]);
    await session.dispose();
  });

  it('a fork runs no checkpoint git work and still copies the agent data', async () => {
    const { session, onSpawnFork } = await forkableSession([], '2026-03-04T08:30:00.123Z', { projectScope: false });
    // The source's legacy repo exists, so only the no-project rule keeps the fork from cloning it.
    const sourceGit = getGitDir(getRepoDir('/fake/agent/sessions/cwd/2026-03-04T08-00-00-000Z_src.jsonl'));
    fsSync.mkdirSync(sourceGit, { recursive: true });
    const cloneFrom = vi.spyOn(RepoManager, 'cloneFrom').mockResolvedValue(undefined);
    const carry = vi.spyOn(session as unknown as { carryCheckpointsToFork: () => Promise<void> }, 'carryCheckpointsToFork').mockResolvedValue(undefined);
    vi.mocked(copyForkAgentData).mockClear();
    vi.mocked(copyForkAgentData).mockResolvedValueOnce([]);
    try {
      await session.rewindFiles('u2', 'fork-conversation');

      expect(cloneFrom).not.toHaveBeenCalled();
      expect(carry).not.toHaveBeenCalled();
      expect(copyForkAgentData).toHaveBeenCalledTimes(1);
      expect(vi.mocked(copyForkAgentData).mock.calls[0]![0]).toMatchObject({ sourceSessionId: 'src', targetSessionId: 'fork' });
      expect(onSpawnFork.mock.calls[0]![0].piBranchedSessionId).toBe('fork');
    } finally {
      cloneFrom.mockRestore();
      fsSync.rmSync(sourceGit, { recursive: true, force: true });
      await session.dispose();
    }
  });

  it('a project chat still checkpoints and waits on its baseline', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const registries = cwdFolder() as unknown as Registries;

    expect(registries._checkpointRegistry.has(live.sessionId)).toBe(true);
    expect(registries._panelRegistry.get(live.sessionId)?.checkpointBaseline?.folder).toBe('/cwd');
    await session.dispose();
  });
});

describe("the panel gate's cancel handle", () => {
  beforeEach(() => {
    H.seq.length = 0;
    H.captured.services.length = 0;
    H.resetServices();
  });
  afterEach(async () => {
    H.setSessionSetup(null);
    H.setSessionManagerFactory(null);
    await PiRuntime.disposeInstance();
  });

  it('steers the note of a Stop on a call the gate still holds into the panel session', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const gate = (cwdFolder() as unknown as { _panelRegistry: Map<string, PanelGateContext> })._panelRegistry.get(live.sessionId)!;
    gate.shellCancel.admit('held-call', undefined);

    expect(session.cancelToolCall('held-call', 'wrong folder')).toBe(true);
    await vi.waitFor(() => expect(live.prompt).toHaveBeenCalledWith('wrong folder', expect.objectContaining({ streamingBehavior: 'steer', expandPromptTemplates: false })));
    await session.dispose();
  });
});

describe('a resumed conversation continues on the model and thinking level its file recorded', () => {
  const SONNET = { id: 'claude-sonnet-5-5', name: 'Sonnet', api: 'anthropic-messages', provider: 'anthropic', contextWindow: 1_000_000 };
  const recorded = (provider: string, modelId: string, thinkingLevel?: string) => [
    { type: 'model_change', id: 'm1', provider, modelId },
    ...(thinkingLevel ? [{ type: 'thinking_level_change', id: 't1', thinkingLevel }] : []),
    { type: 'message', id: 'u1', message: { role: 'user', content: 'hello' } },
  ];

  beforeEach(() => {
    H.seq.length = 0;
    H.captured.services.length = 0;
    H.resetServices();
    const opus = H.getServices().modelRuntime.getModel;
    H.getServices().modelRuntime.getModel = (provider: string, id: string) => (provider === 'anthropic' && id === SONNET.id ? SONNET : opus(provider, id)) as never;
    vi.mocked(resolvePiSessionFile).mockImplementation(async (_cwd, id) => `/fake/agent/sessions/cwd/2026-01-01T00-00-00-000Z_${id}.jsonl`);
  });
  afterEach(async () => {
    delete (H.fakePi.SessionManager as Record<string, unknown>)['open'];
    vi.mocked(resolvePiSessionFile).mockReset();
    await PiRuntime.disposeInstance();
  });

  async function restore(branch: unknown[], hasConfiguredAuth = true) {
    (H.fakePi.SessionManager as Record<string, unknown>)['open'] = () => ({ kind: 'opened', getBranch: () => branch });
    H.getServices().modelRuntime.hasConfiguredAuth = () => hasConfiguredAuth;
    const restored = vi.fn();
    const session = new PiSession(makeOptions([], { onRecordedSelection: restored }));
    session.setResumeSession('stored');
    await session.initializeEarly();
    const created = H.fakePi.createAgentSessionFromServices.mock.calls.at(-1)![0] as unknown as { model?: { id: string } };
    return { session, restored, createdOn: created.model?.id, modelValue: (session as unknown as { modelValue: string }).modelValue };
  }

  it('hands pi the recorded model and reports it with the recorded level, so the panel shows and resolves them', async () => {
    const { session, restored, createdOn, modelValue } = await restore(recorded('anthropic', 'claude-sonnet-5-5', 'xhigh'));
    expect(createdOn).toBe('claude-sonnet-5-5');
    expect(modelValue).toBe('claude-sonnet-5-5');
    expect(restored).toHaveBeenCalledExactlyOnceWith('claude-sonnet-5-5', 'xhigh');
    await session.dispose();
  });

  it('keeps the panel model when the recorded one is no longer signed in, or not in the catalog', async () => {
    const unsigned = await restore(recorded('anthropic', 'claude-sonnet-5-5', 'xhigh'), false);
    expect(unsigned.restored).not.toHaveBeenCalled();
    expect(unsigned.modelValue).toBe('claude-opus-5-5');
    await unsigned.session.dispose();
    await PiRuntime.disposeInstance();

    const unknown = await restore(recorded('openrouter', 'claude-sonnet-5-5', 'xhigh'));
    expect(unknown.restored).not.toHaveBeenCalled();
    expect(unknown.createdOn).toBe('claude-opus-5-5');
    await unknown.session.dispose();
  });

  it('publishes the account of the recorded model when a started panel switches to the conversation', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const restored = vi.fn();
    const session = new PiSession(makeOptions(messages, { onRecordedSelection: restored }));
    await session.initializeEarly();
    const manager = H.fakePi.SessionManager.create.mock.results.at(-1)!.value as { getBranch: () => unknown[] };
    manager.getBranch = () => recorded('anthropic', 'claude-sonnet-5-5', 'high');

    session.setResumeSession('stored');
    await session.whenReplaced();

    expect(restored).toHaveBeenCalledExactlyOnceWith('claude-sonnet-5-5', 'high');
    const accounts = messages.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'accountInfo' }> => m.type === 'accountInfo');
    expect(accounts.at(-1)?.data.model).toBe('claude-sonnet-5-5');
    await session.dispose();
  });

  it('starts a new conversation on the panel model', async () => {
    const restored = vi.fn();
    const session = new PiSession(makeOptions([], { onRecordedSelection: restored }));
    await session.initializeEarly();
    expect(restored).not.toHaveBeenCalled();
    await session.dispose();
  });
});
