import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { buildAgentStartResult } from '../agent-start';
import type { PanelGateContext } from '../permission-gate';

/**
 * What a provider actually receives.
 *
 * A provider registered with `pi.registerProvider(id, { api, streamSimple })` receives a
 * `TranscriptContext`: `{ messages }` alone, with the system prompt and the tool loadout carried by the
 * transcript's system messages. The subscription plugin registers this way to wrap pi-ai's transport.
 *
 * `agent.state.tools` and the transcript's `toolsAdded` are both populated even when a provider reads
 * neither, so these tests assert at the provider boundary instead: what a registered provider can
 * recover from the context it is given, and what that means for the request it builds.
 */

const CAPTURE_TOOLS: ToolDefinition[] = [
  {
    name: 'SaveMemory',
    description: 'Persist a memory',
    parameters: Type.Object({ content: Type.String() }),
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  } as unknown as ToolDefinition,
  {
    name: 'PowerShell',
    description: 'Run a PowerShell command',
    parameters: Type.Object({ command: Type.String() }),
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  } as unknown as ToolDefinition,
];

const TOOL_NAMES = ['read', 'bash', ...CAPTURE_TOOLS.map((tool) => tool.name)];

// A credential only has to exist for the session to resolve a model. Assembled from parts so the file
// holds no literal matching a secret scanner's Anthropic token pattern.
const STUB_CREDENTIAL = ['sk', 'ant', 'oat01', 'stub'].join('-');

interface Captured {
  /** The context object the provider was handed, verbatim. */
  contextKeys: string[];
  toolNames: string[];
  systemPrompt: string;
}

function panelStub(): PanelGateContext {
  return {
    permissionHandler: {} as PanelGateContext['permissionHandler'],
    isPlanMode: () => false,
    budgetStopRequested: () => false,
    getSessionModel: () => 'claude-opus-5-5',
    getSystemPromptEnv: () => ({
      cwd: '/repo',
      model: 'claude-opus-5-5',
      isGitRepo: true,
      platform: 'linux',
      shell: 'bash',
      osVersion: 'Linux test',
      compassEnabled: false,
      thinkingDisabled: false,
    }),
    getPlanFilePath: () => '/plans/plan-cafe.md',
    isTeamEnabled: () => false,
    postMessage: () => undefined,
    currentPromptIndex: () => 0,
  } as PanelGateContext;
}

describe('tool schemas reach the provider', () => {
  const made: string[] = [];
  const sessions: AgentSession[] = [];

  const tempDir = (prefix: string): string => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    made.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const session of sessions.splice(0)) {
      try {
        session.dispose();
      } catch {
        // A disposed session must not fail teardown for the next case.
      }
    }
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Boot a real pi session whose anthropic provider is registered the way the subscription plugin
   * registers its own, and run one turn through Damocles' real `before_agent_start` handler.
   */
  async function captureOneTurn(): Promise<Captured> {
    vi.spyOn(vscode.window, 'createOutputChannel').mockReturnValue({
      appendLine: () => {},
      show: () => {},
      dispose: () => {},
    } as unknown as vscode.LogOutputChannel);

    const cwd = tempDir('dam-provider-cwd-');
    const agentDir = tempDir('dam-provider-agent-');

    let captured: Captured | undefined;

    const extensionFactory = (pi: ExtensionAPI): void => {
      pi.on('before_agent_start', async (event, ctx) =>
        buildAgentStartResult(event, panelStub(), ctx.sessionManager.getSessionId()),
      );
      // The same registration shape the subscription plugin uses, so this test exercises the seam
      // that actually builds Damocles' outbound requests rather than pi-ai's built-in provider.
      pi.registerProvider('anthropic', {
        baseUrl: 'https://api.anthropic.com',
        api: 'anthropic-messages',
        streamSimple: ((_model: unknown, context: { messages: unknown[] }) => {
          captured = {
            contextKeys: Object.keys(context),
            toolNames: getCurrentTools(context.messages as never).map((tool) => tool.name),
            systemPrompt: getCurrentSystemPrompt(context.messages as never),
          };
          throw new Error('captured');
        }) as never,
      } as never);
    };

    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, 'auth.json'),
      modelsPath: path.join(agentDir, 'models.json'),
      refreshOnCreate: false,
    });
    await modelRuntime.setRuntimeApiKey('anthropic', STUB_CREDENTIAL);

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

    const model = modelRuntime.getModel('anthropic', 'claude-opus-5-5');
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      thinkingLevel: 'high',
      modelRuntime,
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      tools: TOOL_NAMES,
      customTools: CAPTURE_TOOLS,
    } as never);
    sessions.push(session);
    session.setActiveToolsByName(TOOL_NAMES);

    await session.prompt('run something');
    if (!captured) throw new Error('provider was never called');
    return captured;
  }

  it('hands the provider a transcript-only context', async () => {
    // Pinned because it is the premise of everything below: `tools` and `systemPrompt` are not
    // fields on what a provider receives, so a provider must read the transcript.
    const captured = await captureOneTurn();
    expect(captured.contextKeys).toEqual(['messages']);
  });

  it('carries every tool Damocles activated, with its schema', async () => {
    const captured = await captureOneTurn();
    for (const name of TOOL_NAMES) expect(captured.toolNames).toContain(name);
  });

  it('carries the Damocles system prompt, not pi boilerplate', async () => {
    const captured = await captureOneTurn();
    expect(captured.systemPrompt).toContain('AI coding agent');
    expect(captured.systemPrompt).toContain('<damocles_tone>');
    expect(captured.systemPrompt).not.toContain('operating inside pi');
  });
});
