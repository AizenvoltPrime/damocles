import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { AgentRunner } from '../agent-runner';
import { MessageBus } from '../message-bus';
import type { AgentResult, AgentRunConfig } from '../types';
import { withSettingsPolicy } from '../../pi-session/settings-policy';
import { createSubagentExtensionFactory } from '../../pi-session/subagents/subagent-extension-factory';
import { ShellCancelStore } from '../../pi-session/tools/shell-cancel-registry';
import type { GatePermissionContext } from '../../pi-session/permission-gate';
import type { HooksConfigService } from '../../pi-session/hooks/config';
import type { HookEntry } from '../../pi-session/hooks/types';
import { DAMOCLES_TURN_STOPPED_ENTRY } from '../../pi-session/session-store/constants';
import { trackRunLifecycle } from '../../pi-session/run-lifecycle';

/**
 * A member's Stop against the configured hooks its stopped run's wind-down runs, on a real pi session built as
 * `FolderRuntime.createSubagentSession` builds a team member's, driven by the real `AgentRunner`, with real hook
 * processes. Each hook here never answers on its own, so only the Stop can end it before its 60 s timeout.
 */

// Assembled from parts so the file holds no literal matching a secret scanner's token pattern.
const STUB_CREDENTIAL = ['sk', 'ant', 'oat01', 'stub'].join('-');

const made: string[] = [];
const sessions: AgentSession[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  // Windows releases a killed hook's working folder a moment after the process is gone.
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A hook that starts a child of its own, writes both pids, and never answers. */
function hangingHook(dir: string): { entry: HookEntry; pids: () => number[] | undefined } {
  const pidFile = path.join(dir, 'pids');
  const script = [
    "process.stdin.on('data', () => {}).on('end', () => {",
    "  const child = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });",
    `  require('fs').writeFileSync(${JSON.stringify(pidFile)}, process.pid + ' ' + child.pid);`,
    '  setInterval(() => {}, 1000);',
    '});',
  ].join('\n');
  return {
    entry: { command: [process.execPath, '-e', script] },
    pids: () => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').split(' ').map(Number) : undefined),
  };
}

/** A hook that records that it ran. */
function recordingHook(dir: string): { entry: HookEntry; ran: () => boolean } {
  const ranFile = path.join(dir, 'ran');
  const script = `process.stdin.on('data', () => {}).on('end', () => require('fs').writeFileSync(${JSON.stringify(ranFile)}, 'ran'));`;
  return { entry: { command: [process.execPath, '-e', script] }, ran: () => fs.existsSync(ranFile) };
}

// Sequential (`agent-loop.js:372-416` in pi-agent-core 1.4.0), so an abort after the first call leaves the second unstarted.
const sequentialTool = (name: string): ToolDefinition => ({
  name,
  label: name,
  description: `The ${name} tool`,
  parameters: Type.Object({}),
  executionMode: 'sequential',
  execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
} as unknown as ToolDefinition);

/** A team member session whose `createSubagentExtensionFactory` runs `hooks` and takes `stopSignal`. */
async function memberSession(hooks: Record<string, HookEntry[]>, stopSignal: AbortSignal, responses: FauxResponseStep[]): Promise<AgentSession> {
  const cwd = tempDir('dam-stop-hook-cwd-');
  const agentDir = tempDir('dam-stop-hook-agent-');
  const faux = createFauxCore({ api: 'anthropic-messages', provider: 'anthropic', models: [{ id: 'claude-opus-5-5' }] });
  faux.setResponses(responses);
  const fauxProvider = (pi: ExtensionAPI): void => {
    pi.registerProvider('anthropic', { baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages', streamSimple: faux.streamSimple } as never);
  };
  const gate = createSubagentExtensionFactory({
    permissionHandler: {
      matchRule: async () => null,
      decide: () => 'ask',
      isPlanFile: () => false,
      canUseTool: async (_name: string, input: Record<string, unknown>) => ({ behavior: 'allow', updatedInput: input }),
    } as unknown as GatePermissionContext['permissionHandler'],
    isPlanMode: () => false,
    shellCancel: new ShellCancelStore().forContext(() => undefined),
    worktreeIsolation: () => undefined,
    readOnlyShell: false,
    parentToolUseId: 'member-1',
    deferrableToolNames: [],
    hooks: {
      config: { getEntries: (key: string) => hooks[key] ?? [], hasEntries: (key: string) => (hooks[key] ?? []).length > 0 } as unknown as HooksConfigService,
      workspaceRoot: cwd,
      userHome: os.homedir(),
    },
    stopSignal,
  });
  const settingsManager = withSettingsPolicy(SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off' }, { projectTrusted: true }));
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, 'auth.json'),
    modelsPath: path.join(agentDir, 'models.json'),
    refreshOnCreate: false,
  });
  await modelRuntime.setRuntimeApiKey('anthropic', STUB_CREDENTIAL);
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    modelRuntime,
    settingsManager,
    resourceLoaderOptions: {
      extensionFactories: [fauxProvider, gate],
      systemPromptOverride: () => 'You are a team specialist.',
      appendSystemPromptOverride: () => [],
      noContextFiles: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    },
  });
  const tools = [sequentialTool('team_standby'), sequentialTool('noop')];
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(cwd),
    model: modelRuntime.getModel('anthropic', 'claude-opus-5-5')!,
    thinkingLevel: 'off',
    tools: tools.map((tool) => tool.name),
    customTools: tools,
  });
  sessions.push(session);
  if (services.resourceLoader.getExtensions().errors.length > 0) throw new Error('the team extension did not load');
  session.setActiveToolsByName(tools.map((tool) => tool.name));
  session.setAutoCompactionEnabled(false);
  return session;
}

function runMember(session: AgentSession, stop: AbortController): Promise<AgentResult> {
  const config: AgentRunConfig = {
    agentId: 'member-1',
    name: 'worker',
    role: 'specialist',
    initial: { kind: 'prompt', text: 'do the task' },
    // Bound as `TeamRunner.createMemberSession` binds a member's session.
    createSession: async () => {
      trackRunLifecycle(session);
      return session;
    },
    forgetSession: (s) => s.dispose(),
    abortSignal: stop.signal,
    messageBus: new MessageBus('team-1'),
    onMessage: () => undefined,
    onWindDown: () => undefined,
    teamId: 'team-1',
    bindNoteDelivery: () => () => undefined,
    bindTakeUndelivered: () => () => undefined,
    keepAlive: () => false,
  };
  return new AgentRunner().startAgent(config);
}

/** The run's result, or a rejection naming the wait, so a Stop that never lands fails here rather than at the test timeout. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms))]);
}

describe("a member's Stop during a hook its run is waiting on", () => {
  it('kills a PostToolUse hook that never answers with its child, ends the member, persists the cut batch, and runs no SubagentStop hook', async () => {
    const dir = tempDir('dam-stop-hook-');
    const postToolUse = hangingHook(dir);
    const subagentStop = recordingHook(dir);
    const stop = new AbortController();
    const session = await memberSession(
      { tool_result: [postToolUse.entry], subagent_end: [subagentStop.entry] },
      stop.signal,
      [fauxAssistantMessage([fauxToolCall('team_standby', {}, { id: 'c1' }), fauxToolCall('noop', {}, { id: 'c2' })], { stopReason: 'toolUse' })],
    );

    const run = runMember(session, stop);
    await vi.waitFor(() => expect(postToolUse.pids()).toBeDefined(), { timeout: 10_000 });
    const [parent, child] = postToolUse.pids()!;
    stop.abort();
    const result = await within(run, 10_000, 'the stopped member');

    expect(result.status).toBe('cancelled');
    await vi.waitFor(() => expect([alive(parent!), alive(child!)]).toEqual([false, false]), { timeout: 10_000 });
    const stopped = session.sessionManager.getBranch().flatMap((e) => (e.type === 'custom' && e.customType === DAMOCLES_TURN_STOPPED_ENTRY ? [e.data] : []));
    expect(stopped).toEqual([{ toolCallIds: ['c2'], entryIds: [] }]);
    expect(subagentStop.ran()).toBe(false);
  }, 30_000);

  it('kills a SubagentStop hook that never answers with its child after the run settled, and ends the member', async () => {
    const dir = tempDir('dam-stop-hook-');
    const subagentStop = hangingHook(dir);
    const stop = new AbortController();
    const session = await memberSession({ subagent_end: [subagentStop.entry] }, stop.signal, [fauxAssistantMessage('Done.')]);

    const run = runMember(session, stop);
    await vi.waitFor(() => expect(subagentStop.pids()).toBeDefined(), { timeout: 10_000 });
    const [parent, child] = subagentStop.pids()!;
    stop.abort();
    const result = await within(run, 10_000, 'the stopped member');

    expect(result.status).toBe('cancelled');
    await vi.waitFor(() => expect([alive(parent!), alive(child!)]).toEqual([false, false]), { timeout: 10_000 });
  }, 30_000);
});
