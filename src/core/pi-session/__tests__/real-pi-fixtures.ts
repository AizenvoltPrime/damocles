import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ModelRuntime,
  type ExtensionAPI,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { PermissionHandler } from '../../permission-handler';
import type { SessionOptions } from '../../session-types';
import { PiRuntime } from '../pi-runtime';
import { PiSession } from '../pi-session';
import { withSettingsPolicy } from '../settings-policy';
import { trackRunLifecycle } from '../run-lifecycle';
import { withPerCallCancel } from '../tools/cancellable-shell';
import { ShellCancelStore } from '../tools/shell-cancel-registry';
import { createFakePlatform } from '../../../__mocks__/fake-platform';

/**
 * A real pi session and agent loop with a scripted provider in place of the model, for tests whose
 * outcome depends on pi's own queue and event order.
 */

// Assembled from parts so the file holds no literal matching a secret scanner's token pattern.
const STUB_CREDENTIAL = ['sk', 'ant', 'oat01', 'stub'].join('-');

/**
 * The process's PiRuntime initialised on `agentDir`, as production's `start()` finds it, with anthropic signed in. A session
 * built on the model runtime it returns has its chat's model resolved and checked through the registry pi runs on.
 */
export async function seatPiRuntime(agentDir: string): Promise<ModelRuntime> {
  // One a lazy `PiRuntime.get()` made earlier has the default agent dir and no model runtime.
  if (PiRuntime.exists && PiRuntime.get().agentDir !== agentDir) await PiRuntime.disposeInstance();
  const runtime = PiRuntime.get(agentDir);
  await runtime.init();
  const models = runtime.modelRuntime;
  if (!models) throw new Error('PiRuntime.init left no model runtime');
  await models.setRuntimeApiKey('anthropic', STUB_CREDENTIAL);
  return models;
}

interface Message {
  role: string;
  content?: unknown;
  toolCallId?: string;
}

/** The text of a user message, or the role and tool call of anything else, so a context reads as a list. */
export function describeMessage(message: Message): string {
  if (message.role === 'user') {
    const parts = Array.isArray(message.content) ? message.content : [];
    return `user: ${parts.map((p: { text?: string }) => p.text ?? '').join('')}`;
  }
  return message.role === 'toolResult' ? `toolResult: ${message.toolCallId}` : message.role;
}

/** A shell that stays alive after the abort until the test releases it, as a real process does until it exits. */
export function blockingShell(): { definition: ToolDefinition; started: Promise<void>; release: () => void } {
  let release!: () => void;
  const exited = new Promise<void>((resolve) => { release = resolve; });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const definition = {
    name: 'PowerShell',
    label: 'PowerShell',
    description: 'Run a PowerShell command',
    parameters: Type.Object({ command: Type.String() }),
    execute: async (_id: string, _params: unknown, signal?: AbortSignal) => {
      markStarted();
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
      await exited;
      throw new Error('Command aborted');
    },
  } as unknown as ToolDefinition;
  return { definition, started, release };
}

export const callPowerShell = fauxAssistantMessage(
  fauxToolCall('PowerShell', { command: 'Start-Sleep -Seconds 60; echo done' }, { id: 'call-1' }),
  { stopReason: 'toolUse' },
);

export function panelSession(emitted: ExtensionToWebviewMessage[]): PiSession {
  const options = {
    cwd: '/cwd',
    projectScope: true,
    platform: createFakePlatform(),
    permissionHandler: { getPermissionMode: () => 'default', setPendingPromptsListener: () => {}, setPromptOwnerResolver: () => {}, pendingPrompts: () => [], repostPendingPrompts: () => {} } as unknown as PermissionHandler,
    onMessage: (message: ExtensionToWebviewMessage) => emitted.push(message),
    resolveThinking: () => ({ thinkingDisabled: true, effort: null }),
  } as unknown as SessionOptions;
  return new PiSession(options);
}

/** Makes `session` the panel's live session without running `start()`. */
export function bindPanel(panel: PiSession, session: AgentSession): void {
  // `bindSession` binds the session's run lifecycle with its event subscriptions, and lets go of it with them; this binding has no adapter.
  const internals = panel as unknown as { runtime: unknown; runLifecycle: unknown; unsubscribe: (() => void) | null; modelValue: string; desiredModel: unknown };
  const run = trackRunLifecycle(session);
  internals.runtime = { session };
  // The chat's model, which `start()` commits with the session it builds on it; a send without one is refused.
  internals.desiredModel = session.model;
  internals.modelValue = session.model?.id ?? '';
  internals.runLifecycle = run;
  internals.unsubscribe = () => {
    if (internals.runLifecycle === run) internals.runLifecycle = null;
    run.dispose();
  };
}

/** The panel's own note delivery bound to `session`, and a store whose Stop click reaches it. */
export function wire(
  shell: ReturnType<typeof blockingShell>,
  session: () => AgentSession | undefined,
  panel: PiSession,
): { tool: ToolDefinition; store: ShellCancelStore } {
  const deliver = (panel as unknown as { noteDeliveryForMain: (s: () => AgentSession | undefined) => (text: string) => void }).noteDeliveryForMain(session);
  const store = new ShellCancelStore();
  return { tool: withPerCallCancel(shell.definition, store.forContext(deliver)), store };
}

export interface RealPi {
  session: AgentSession;
  /** The session's working folder, a fresh temporary one per boot. */
  cwd: string;
  /** The context of every model call, in order. */
  contexts: string[][];
}

/** Boots real pi sessions on a seated PiRuntime and removes what they leave behind; await `dispose` from `afterEach`. */
export function realPiSessions(): {
  boot: (tool: ToolDefinition, responses: FauxResponseStep[], extend?: (pi: ExtensionAPI) => void, sessionManager?: (cwd: string) => SessionManager) => Promise<RealPi>;
  dispose: () => Promise<void>;
} {
  const made: string[] = [];
  const sessions: AgentSession[] = [];
  let seated: Promise<ModelRuntime> | null = null;

  const tempDir = (prefix: string): string => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    made.push(dir);
    return dir;
  };

  // `sessionManager` defaults to an in-memory one; a file-backed one lets a later boot resume the file on another cwd.
  const boot = async (tool: ToolDefinition, responses: FauxResponseStep[], extend?: (pi: ExtensionAPI) => void, sessionManager?: (cwd: string) => SessionManager): Promise<RealPi> => {
    const cwd = tempDir('dam-note-cwd-');
    const agentDir = tempDir('dam-note-agent-');
    const contexts: string[][] = [];
    const faux = createFauxCore({ api: 'anthropic-messages', provider: 'anthropic', models: [{ id: 'claude-opus-5-5' }] });
    faux.setResponses(
      responses.map((step): FauxResponseStep => (context, options, state, model) => {
        contexts.push((context.messages as unknown as Message[]).filter((m) => m.role !== 'system').map(describeMessage));
        return typeof step === 'function' ? step(context, options, state, model) : step;
      }),
    );
    const extensionFactory = (pi: ExtensionAPI): void => {
      pi.registerProvider('anthropic', { baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages', streamSimple: faux.streamSimple } as never);
      extend?.(pi);
    };
    // Built as FolderRuntime builds the folder's services, since pi's queue behaviour depends on it.
    const settingsManager = withSettingsPolicy(SettingsManager.create(cwd, agentDir, { projectTrusted: true }));
    seated ??= seatPiRuntime(tempDir('dam-note-runtime-'));
    const modelRuntime = await seated;
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [extensionFactory],
    } as never);
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model: modelRuntime.getModel('anthropic', 'claude-opus-5-5'),
      thinkingLevel: 'off',
      modelRuntime,
      settingsManager,
      resourceLoader,
      sessionManager: sessionManager?.(cwd) ?? SessionManager.inMemory(cwd),
      tools: ['PowerShell'],
      customTools: [tool],
    } as never);
    sessions.push(session);
    session.setActiveToolsByName(['PowerShell']);
    return { session, cwd, contexts };
  };

  const dispose = async (): Promise<void> => {
    for (const session of sessions.splice(0)) {
      try {
        session.dispose();
      } catch {
        // A disposed session must not fail teardown for the next case.
      }
    }
    if (seated) {
      seated = null;
      await PiRuntime.disposeInstance();
    }
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  };

  return { boot, dispose };
}
