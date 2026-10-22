import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionFactory,
  type LoadExtensionsResult,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { createFauxCore, type FauxResponseStep } from '@earendil-works/pi-ai';
import { withSettingsPolicy } from '../settings-policy';

/**
 * Real nested pi sessions, built as `FolderRuntime.createSubagentSession` builds one, whose user agent folder holds a pi
 * extension (`<agentDir>/extensions/`, which pi loads into every session, `package-manager.js:2055` in pi 1.4.0) with an
 * `agent_settled` handler. pi hands that handler no abort signal (`agent.js:217-219` in pi-agent-core 1.4.0), so a held
 * one keeps a stopped run from settling until the test releases it. With `beforeSettle` it also has an
 * `agent_before_settle` handler whose held draft pi commits once the handler returns, even after a stop
 * (`agent-session.js:1572-1573` in pi-coding-agent 1.4.0).
 */

/** The custom type of the draft a held `agent_before_settle` handler returns. */
export const HELD_DRAFT_ENTRY = 'held-settle-draft';

// Assembled from parts so the file holds no literal matching a secret scanner's token pattern.
const STUB_CREDENTIAL = ['sk', 'ant', 'oat01', 'stub'].join('-');

// The extension module is loaded by pi's own loader, so the hold reaches it through the process global.
const HOLDS = Symbol.for('damocles.test.heldSettle');
type Holds = Map<string, () => Promise<void> | undefined>;
const holds = ((globalThis as Record<symbol, unknown>)[HOLDS] ??= new Map()) as Holds;
// The user extension's own `pi`, through which a test makes it open a run as an extension does (`sendUserMessage`).
const APIS = Symbol.for('damocles.test.heldSettleApi');
const apis = ((globalThis as Record<symbol, unknown>)[APIS] ??= new Map()) as Map<string, ExtensionAPI>;
// Text the user extension's next `agent_settled` handler sends once its hold returns, which pi defers into that settle (`agent-session.js:1632-1634`).
const SETTLED_SENDS = Symbol.for('damocles.test.heldSettleSend');
const settledSends = ((globalThis as Record<symbol, unknown>)[SETTLED_SENDS] ??= new Map()) as Map<string, string>;

export interface HeldSettleSession {
  session: AgentSession;
  /** The path pi loaded the user extension from. */
  extensionPath: string;
  /** Makes the extension's next `agent_settled` handler wait until `release`, and resolves once it is waiting. */
  hold: () => { waiting: Promise<void>; release: () => void };
  /** The same for the next `agent_before_settle` handler, which then returns a `HELD_DRAFT_ENTRY` draft. Needs `beforeSettle`. */
  holdBeforeSettle: () => { waiting: Promise<void>; release: () => void };
  /** The same for the next `input` handler, which holds a prompt in `prompt()` before pi opens its run. Needs `input`. */
  holdInput: () => { waiting: Promise<void>; release: () => void };
  /** The same for the next `before_agent_start` handler, which holds a run pi is preparing. Needs `beforeAgentStart`. */
  holdBeforeAgentStart: () => { waiting: Promise<void>; release: () => void };
  /** The user extension sends `text` with `pi.sendUserMessage`, which opens a run on an idle session. Not with `mainChat`. */
  sendFromExtension: (text: string) => void;
  /** The user extension's next `agent_settled` handler sends `text` as it returns, which pi runs after that settle. Not with `mainChat`. */
  sendFromNextSettle: (text: string) => void;
}

/** A member or subagent session file, as `FolderRuntime.createSubagentSession` opens one. */
export type HeldSettleStore = { kind: 'file'; dir: string; id: string } | { kind: 'reopen'; path: string };

interface BootOptions {
  /** The nested agent's gate, as its owner builds it. */
  extensionFactory?: ExtensionFactory;
  customTools?: ToolDefinition[];
  /** Persists the session to a real file; in memory without it. */
  store?: HeldSettleStore;
  /** Registers the `agent_before_settle` handler `holdBeforeSettle` holds. */
  beforeSettle?: boolean;
  /**
   * Builds the session's extensions as `FolderRuntime` builds the main chat's, which drops every path-loaded one
   * (`extensionsOverride` in `folder-runtime.ts`), so the user extension is installed but never runs and the held handlers
   * are an inline extension's, as Damocles' own configured Stop hook dispatch in `agent_settled` is.
   */
  mainChat?: boolean;
  /**
   * Registers the `input` handler `holdInput` holds, the inline extension's with `mainChat` and else the user extension's. pi awaits it in `prompt()` before `_startRun`
   * (`agent-session.js:1652`, `:1693` in pi-coding-agent 1.4.0), where the main chat's prompt waits only on the auth check (`:1682-1683`).
   */
  input?: boolean;
  /**
   * Registers the user extension's `before_agent_start` handler `holdBeforeAgentStart` holds. pi awaits it in `_prepareRun`,
   * after `_startRun` marked the session busy and before the run's `agent_start` (`agent-session.js:1424-1428`, `:1488`).
   */
  beforeAgentStart?: boolean;
}

export function heldSettleSessions(): {
  boot: (responses: FauxResponseStep[], options?: BootOptions) => Promise<HeldSettleSession>;
  dispose: () => void;
} {
  const made: string[] = [];
  const sessions: AgentSession[] = [];
  const releases: Array<() => void> = [];

  const tempDir = (prefix: string): string => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    made.push(dir);
    return dir;
  };

  const boot = async (responses: FauxResponseStep[], options: BootOptions = {}): Promise<HeldSettleSession> => {
    const cwd = tempDir('dam-held-settle-cwd-');
    const agentDir = tempDir('dam-held-settle-agent-');
    const extensionPath = path.join(agentDir, 'extensions', 'held-settle.js');
    fs.mkdirSync(path.dirname(extensionPath));
    const beforeSettleKey = `${agentDir}#before`;
    const inputKey = `${agentDir}#input`;
    const beforeAgentStartKey = `${agentDir}#start`;
    const heldInline = (pi: ExtensionAPI): void => {
      pi.on('agent_settled', async () => {
        await holds.get(agentDir)?.();
      });
      if (options.input) {
        pi.on('input', async () => {
          await holds.get(inputKey)?.();
          return undefined;
        });
      }
      if (!options.beforeSettle) return;
      pi.on('agent_before_settle', async (event) => {
        const held = holds.get(beforeSettleKey);
        if (!held) return undefined;
        await held();
        return { entries: [...event.entries, { type: 'custom', customType: HELD_DRAFT_ENTRY, data: {} }] } as never;
      });
    };
    fs.writeFileSync(extensionPath, [
      'export default function (pi) {',
      `  globalThis[Symbol.for('damocles.test.heldSettleApi')]?.set(${JSON.stringify(agentDir)}, pi);`,
      "  pi.on('agent_settled', async () => {",
      `    await globalThis[Symbol.for('damocles.test.heldSettle')]?.get(${JSON.stringify(agentDir)})?.();`,
      `    const sends = globalThis[Symbol.for('damocles.test.heldSettleSend')];`,
      `    const text = sends?.get(${JSON.stringify(agentDir)});`,
      `    if (text !== undefined) { sends.delete(${JSON.stringify(agentDir)}); pi.sendUserMessage(text); }`,
      '  });',
      ...(options.beforeAgentStart ? [
        "  pi.on('before_agent_start', async () => {",
        `    await globalThis[Symbol.for('damocles.test.heldSettle')]?.get(${JSON.stringify(beforeAgentStartKey)})?.();`,
        '    return undefined;',
        '  });',
      ] : []),
      ...(options.input && !options.mainChat ? [
        "  pi.on('input', async () => {",
        `    await globalThis[Symbol.for('damocles.test.heldSettle')]?.get(${JSON.stringify(inputKey)})?.();`,
        '    return undefined;',
        '  });',
      ] : []),
      ...(options.beforeSettle ? [
        "  pi.on('agent_before_settle', async (event) => {",
        `    const held = globalThis[Symbol.for('damocles.test.heldSettle')]?.get(${JSON.stringify(beforeSettleKey)});`,
        '    if (!held) return undefined;',
        '    await held();',
        `    return { entries: [...event.entries, { type: 'custom', customType: ${JSON.stringify(HELD_DRAFT_ENTRY)}, data: {} }] };`,
        '  });',
      ] : []),
      '}',
      '',
    ].join('\n'));

    const faux = createFauxCore({ api: 'anthropic-messages', provider: 'anthropic', models: [{ id: 'claude-opus-5-5' }] });
    faux.setResponses(responses);
    const fauxProvider = (pi: ExtensionAPI): void => {
      pi.registerProvider('anthropic', { baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages', streamSimple: faux.streamSimple } as never);
    };
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
        extensionFactories: [fauxProvider, ...(options.mainChat ? [heldInline] : []), ...(options.extensionFactory ? [options.extensionFactory] : [])],
        ...(options.mainChat ? { extensionsOverride: (base: LoadExtensionsResult) => ({ ...base, extensions: base.extensions.filter((e) => e.path.startsWith('<inline:')) }) } : {}),
        systemPromptOverride: () => 'You are a nested agent.',
        appendSystemPromptOverride: () => [],
        noContextFiles: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
      },
    });
    const loaded = services.resourceLoader.getExtensions();
    if (loaded.errors.length > 0) throw new Error(`an extension did not load: ${JSON.stringify(loaded.errors)}`);
    if (loaded.extensions.some((extension) => extension.path === extensionPath) === Boolean(options.mainChat)) {
      throw new Error(options.mainChat ? 'the main chat ran the user extension' : 'pi did not load the user extension');
    }
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: options.store?.kind === 'file' ? SessionManager.create(cwd, options.store.dir, { id: options.store.id })
        : options.store?.kind === 'reopen' ? SessionManager.open(options.store.path, undefined, cwd)
        : SessionManager.inMemory(cwd),
      model: modelRuntime.getModel('anthropic', 'claude-opus-5-5')!,
      thinkingLevel: 'off',
      tools: (options.customTools ?? []).map((tool) => tool.name),
      customTools: options.customTools ?? [],
    });
    session.setActiveToolsByName((options.customTools ?? []).map((tool) => tool.name));
    session.setAutoCompactionEnabled(false);
    sessions.push(session);

    const holdAt = (key: string): { waiting: Promise<void>; release: () => void } => {
      let markWaiting!: () => void;
      const waiting = new Promise<void>((resolve) => { markWaiting = resolve; });
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      releases.push(release);
      holds.set(key, () => {
        holds.delete(key);
        markWaiting();
        return released;
      });
      return { waiting, release };
    };
    const holdBeforeSettle = (): { waiting: Promise<void>; release: () => void } => {
      if (!options.beforeSettle) throw new Error('boot the session with beforeSettle to hold agent_before_settle');
      return holdAt(beforeSettleKey);
    };
    const holdInput = (): { waiting: Promise<void>; release: () => void } => {
      if (!options.input) throw new Error('boot the session with input to hold input');
      return holdAt(inputKey);
    };
    const extensionApi = (): ExtensionAPI => {
      const api = options.mainChat ? undefined : apis.get(agentDir);
      if (!api) throw new Error('the user extension runs only in a nested session');
      return api;
    };
    const sendFromExtension = (text: string): void => extensionApi().sendUserMessage(text);
    const sendFromNextSettle = (text: string): void => {
      extensionApi();
      settledSends.set(agentDir, text);
    };
    const holdBeforeAgentStart = (): { waiting: Promise<void>; release: () => void } => {
      if (!options.beforeAgentStart) throw new Error('boot the session with beforeAgentStart to hold before_agent_start');
      return holdAt(beforeAgentStartKey);
    };
    return { session, extensionPath, hold: () => holdAt(agentDir), holdBeforeSettle, holdInput, holdBeforeAgentStart, sendFromExtension, sendFromNextSettle };
  };

  const dispose = (): void => {
    for (const release of releases.splice(0)) release();
    for (const session of sessions.splice(0)) {
      try {
        session.dispose();
      } catch {
        // A disposed session must not fail teardown for the next case.
      }
    }
    for (const dir of made.splice(0)) {
      holds.delete(dir);
      holds.delete(`${dir}#before`);
      holds.delete(`${dir}#input`);
      holds.delete(`${dir}#start`);
      apis.delete(dir);
      settledSends.delete(dir);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  };

  return { boot, dispose };
}
