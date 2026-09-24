import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import * as vscode from 'vscode';
import { __watchers } from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentSession, AgentSessionServices, ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';

const H = vi.hoisted(() => ({ home: '' }));

// The global context file and user asset dirs resolve through `os.homedir()`; a temp home keeps the
// developer's own `~/.damocles` out of every assertion about which instructions a folder loads.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = () => (H.home !== '' ? H.home : actual.homedir());
  return { ...actual, homedir, default: { ...actual, homedir } };
});

import { FolderRuntime } from '../folder-runtime';
import { PiRuntime } from '../pi-runtime';
import { initPiLoader, type PiCodingAgentModule } from '../pi-loader';
import { McpClientManager } from '../mcp/mcp-client-manager';
import type { PanelGateContext } from '../permission-gate';
import type { CheckpointService } from '../checkpoint-service';
import { folderKey } from '../../workspace-folders/folder-key';

beforeAll(() => {
  vi.spyOn(vscode.window, 'createOutputChannel').mockReturnValue({
    appendLine: () => {},
    show: () => {},
    dispose: () => {},
  } as unknown as vscode.LogOutputChannel);
});

/** A folder runtime with no services, for the registry and republisher bookkeeping that needs none. */
function bareFolder(made: FolderRuntime[], cwd = '/tmp/ws'): FolderRuntime {
  const folder = new FolderRuntime({
    pi: {} as PiCodingAgentModule,
    cwd,
    agentDir: '/tmp/agent',
    modelRuntime: {} as ModelRuntime,
    userMcp: new McpClientManager(),
    createFolderMcp: (reservedPrefixes) => new McpClientManager({ reservedPrefixes }),
    renameSession: async () => undefined,
  });
  made.push(folder);
  return folder;
}

describe('per-session registries are released by their owner only', () => {
  const made: FolderRuntime[] = [];
  afterEach(async () => {
    for (const folder of made.splice(0)) await folder.dispose();
  });

  type Registries = {
    _panelRegistry: Map<string, unknown>;
    _checkpointRegistry: Map<string, unknown>;
    _activeToolRefreshers: Map<string, unknown>;
  };
  const entries = (folder: FolderRuntime) => {
    const r = folder as unknown as Registries;
    return [r._panelRegistry, r._checkpointRegistry, r._activeToolRefreshers].map((m) => m.get('sess-x'));
  };
  const owner = () => ({ gate: {} as PanelGateContext, checkpoints: {} as CheckpointService, refresh: () => {} });
  const register = (folder: FolderRuntime, o: ReturnType<typeof owner>) => {
    folder.registerPanel('sess-x', o.gate);
    folder.registerCheckpointService('sess-x', o.checkpoints);
    folder.registerActiveToolRefresher('sess-x', o.refresh);
  };
  const unregister = (folder: FolderRuntime, o: ReturnType<typeof owner>) => {
    folder.unregisterPanel('sess-x', o.gate);
    folder.unregisterCheckpointService('sess-x', o.checkpoints);
    folder.unregisterActiveToolRefresher('sess-x', o.refresh);
  };

  it("a late unregister from the previous owner leaves the new owner's entry in all three registries", () => {
    // Two panels can hold one session id; the older closing after the newer registered must not strip
    // the newer's gate, or every tool call there hits the fail-closed fallback.
    const folder = bareFolder(made);
    const older = owner();
    const newer = owner();
    register(folder, older);
    register(folder, newer);

    unregister(folder, older);

    expect(entries(folder)).toEqual([newer.gate, newer.checkpoints, newer.refresh]);
  });

  it("the current owner's unregister still removes its entries", () => {
    const folder = bareFolder(made);
    const only = owner();
    register(folder, only);

    unregister(folder, only);

    expect(entries(folder)).toEqual([undefined, undefined, undefined]);
  });
});

describe('ToolSearch republishers', () => {
  const made: FolderRuntime[] = [];
  afterEach(async () => {
    for (const folder of made.splice(0)) await folder.dispose();
  });

  /**
   * The only private reach-through here, and only for SIZE — growth is invisible from the public
   * surface, since a disposed closure that no longer fires looks identical to one still held. All
   * behaviour is asserted through the public seam.
   */
  const registeredCount = (folder: FolderRuntime): number =>
    (folder as unknown as { _toolSearchRepublishers: Set<() => void> })._toolSearchRepublishers.size;

  it('fires EVERY registered extension instance, not just the newest', () => {
    // `prepareSessionExtensions` reloads the resource loader per session, so each panel's session binds
    // its own extension instance while earlier panels keep theirs. A single-slot field held only the
    // last one, leaving every earlier panel's ToolSearch description frozen for the session's life.
    const folder = bareFolder(made);
    const fired: string[] = [];
    folder.registerToolSearchRepublisher(() => fired.push('panelA'));
    folder.registerToolSearchRepublisher(() => fired.push('panelB'));

    folder.republishToolSearch();

    expect(fired).toEqual(['panelA', 'panelB']);
  });

  it('the returned disposer removes exactly its own entry and leaves peers firing', () => {
    // "Exactly its own" is the load-bearing half: a disposer that cleared the set, or keyed off anything
    // but closure identity, would silently freeze every live panel's menu.
    const folder = bareFolder(made);
    const fired: string[] = [];
    const disposeA = folder.registerToolSearchRepublisher(() => fired.push('panelA'));
    folder.registerToolSearchRepublisher(() => fired.push('panelB'));
    folder.registerToolSearchRepublisher(() => fired.push('panelC'));

    disposeA();
    folder.republishToolSearch();

    expect(fired).toEqual(['panelB', 'panelC']);
    expect(registeredCount(folder)).toBe(2);

    // Double-disposal is a real path (shutdown then teardown) and must not disturb peers.
    disposeA();
    fired.length = 0;
    folder.republishToolSearch();
    expect(fired).toEqual(['panelB', 'panelC']);
    expect(registeredCount(folder)).toBe(2);
  });

  it('a throwing republisher is NOT retired: it stays registered, retries next time, and never aborts its peers', () => {
    // A LIVE panel whose `registerTool` failed for any unrelated reason must not be dropped for good,
    // which would freeze its menu with no further error.
    const folder = bareFolder(made);
    const fired: string[] = [];
    let attempts = 0;
    let failing = true;
    folder.registerToolSearchRepublisher(() => {
      attempts++;
      if (failing) throw new Error('extension context is no longer active');
      fired.push('recovered');
    });
    folder.registerToolSearchRepublisher(() => fired.push('live'));

    folder.republishToolSearch();
    expect(attempts).toBe(1);
    expect(fired).toEqual(['live']);
    expect(registeredCount(folder)).toBe(2);

    folder.republishToolSearch();
    expect(attempts).toBe(2);
    expect(fired).toEqual(['live', 'live']);

    failing = false;
    fired.length = 0;
    folder.republishToolSearch();
    expect(fired).toEqual(['recovered', 'live']);
    expect(registeredCount(folder)).toBe(2);
  });

  it('does not grow across repeated teardowns — the count tracks live instances, not lifetime registrations', () => {
    const folder = bareFolder(made);
    const fired: string[] = [];
    folder.registerToolSearchRepublisher(() => fired.push('survivor'));
    expect(registeredCount(folder)).toBe(1);

    for (let i = 0; i < 20; i++) {
      const dispose = folder.registerToolSearchRepublisher(() => fired.push(`transient-${i}`));
      expect(registeredCount(folder)).toBe(2);
      dispose();
      expect(registeredCount(folder)).toBe(1);
    }

    folder.republishToolSearch();
    expect(fired).toEqual(['survivor']);
  });

  it('dispose() clears the republisher registry, not just the active-tool refreshers', async () => {
    const folder = bareFolder(made);
    const fired: string[] = [];
    const dispose = folder.registerToolSearchRepublisher(() => fired.push('gone'));

    await folder.dispose();

    expect(registeredCount(folder)).toBe(0);
    folder.republishToolSearch();
    expect(fired).toEqual([]);
    // A shutdown in flight when the folder went down disposes afterwards; `Set.delete` on a cleared set
    // is inert, so this must not throw.
    expect(() => dispose()).not.toThrow();
  });
});

/**
 * The lifetime of an extension instance NO session ever binds. Only a bound instance receives
 * `session_shutdown`, so only it can retire itself. Bare reloads (asset watchers, trust grant, plugin
 * swaps) and the instance minted at services creation are unbound, so the folder runtime retires them —
 * and must never do so to one that HAS gone live.
 */
describe('unbound extension instances', () => {
  const made: FolderRuntime[] = [];
  afterEach(async () => {
    for (const folder of made.splice(0)) await folder.dispose();
  });

  const registeredCount = (folder: FolderRuntime): number =>
    (folder as unknown as { _toolSearchRepublishers: Set<() => void> })._toolSearchRepublishers.size;

  interface FakeLoader {
    /** Republisher calls, in order, labelled by the instance that owns them. */
    fired: string[];
    failNextReload: () => void;
  }

  /**
   * Stands in for the folder's services so the reload paths are drivable without booting pi. Faithful in
   * the two respects the bookkeeping depends on: factories run INSIDE `reload()` (so a reload can identify
   * the instance it just minted), and the reload keeps awaiting afterwards, so overlapping reloads
   * interleave — an atomic fake would make the serialization test vacuous. The creation instance goes
   * through the same adoption `createServices` performs.
   */
  function attachFakeServices(folder: FolderRuntime): FakeLoader {
    const fired: string[] = [];
    let failNext = false;
    let seq = 0;
    const services = {
      resourceLoader: {
        reload: async (): Promise<void> => {
          await Promise.resolve();
          if (failNext) {
            failNext = false;
            throw new Error('packageManager.resolve failed');
          }
          const id = `instance-${++seq}`;
          folder.registerToolSearchRepublisher(() => fired.push(id));
          await Promise.resolve();
        },
        extendResources: () => undefined,
        getExtensions: () => ({ runtime: { pendingProviderRegistrations: [] }, errors: [] }),
      },
    };
    const internals = folder as unknown as { _services: unknown; _trackCurrentInstanceAsUnbound(): void };
    internals._services = services;
    folder.registerToolSearchRepublisher(() => fired.push('init'));
    internals._trackCurrentInstanceAsUnbound();
    return { fired, failNextReload: () => { failNext = true; } };
  }

  it('two bare reloads leave exactly ONE unbound republisher, not two', async () => {
    const folder = bareFolder(made);
    const loader = attachFakeServices(folder);

    await folder.reloadBare();
    await folder.reloadBare();

    folder.republishToolSearch();
    expect(loader.fired).toEqual(['instance-2']);
    expect(registeredCount(folder)).toBe(1);

    loader.fired.length = 0;
    await folder.reloadBare();
    await folder.reloadBare();
    folder.republishToolSearch();
    expect(loader.fired).toEqual(['instance-4']);
    expect(registeredCount(folder)).toBe(1);
  });

  it('a session-bound reload retires the previous BARE instance and keeps the one it mints', async () => {
    const folder = bareFolder(made);
    const loader = attachFakeServices(folder);

    await folder.prepareSessionExtensions(); // first session: binds the creation instance, no reload
    await folder.reloadBare(); // instance-1, unbound
    await folder.prepareSessionExtensions(); // second session: reload → instance-2, then binds it

    folder.republishToolSearch();
    expect(loader.fired).toEqual(['init', 'instance-2']);
    expect(registeredCount(folder)).toBe(2);
  });

  it('NEVER retires a live session-bound panel’s republisher, however many reloads follow', async () => {
    const folder = bareFolder(made);
    const loader = attachFakeServices(folder);

    await folder.prepareSessionExtensions(); // panel A binds the creation instance
    await folder.prepareSessionExtensions(); // panel B binds instance-1

    await folder.reloadBare(); // instance-2
    await folder.reloadBare(); // instance-3
    await folder.reloadBare(); // instance-4

    folder.republishToolSearch();
    expect(loader.fired).toEqual(['init', 'instance-1', 'instance-4']);
    expect(registeredCount(folder)).toBe(3);
  });

  it('hands the startup instance to the first session instead of retiring it', async () => {
    // The subscription reconcile hot-reloads right after the first folder's creation, and pi's
    // `_buildRuntime` binds whatever the loader holds, so the first session binds THAT instance.
    const folder = bareFolder(made);
    const loader = attachFakeServices(folder);

    await folder.reloadBare(); // startup reconcile: instance-1 supersedes the creation instance
    await folder.prepareSessionExtensions(); // first session binds instance-1 without reloading
    await folder.reloadBare(); // instance-2 must not touch the now-bound instance-1

    folder.republishToolSearch();
    expect(loader.fired).toEqual(['instance-1', 'instance-2']);
    expect(registeredCount(folder)).toBe(2);
  });

  it('a failed session-bound reload releases the instance the session binds instead of retiring it', async () => {
    const folder = bareFolder(made);
    const loader = attachFakeServices(folder);

    await folder.prepareSessionExtensions(); // first session binds the creation instance
    await folder.reloadBare(); // instance-1, unbound
    loader.failNextReload();
    await folder.prepareSessionExtensions(); // reload throws → the session binds instance-1
    await folder.reloadBare(); // instance-2

    folder.republishToolSearch();
    expect(loader.fired).toEqual(['init', 'instance-1', 'instance-2']);
  });

  it('a failed BARE reload keeps its claim on the instance still in place', async () => {
    const folder = bareFolder(made);
    const loader = attachFakeServices(folder);

    await folder.reloadBare(); // instance-1
    loader.failNextReload();
    await expect(folder.reloadBare()).rejects.toThrow('packageManager.resolve failed');
    await folder.reloadBare(); // instance-2 supersedes instance-1, which must still be retired

    folder.republishToolSearch();
    expect(loader.fired).toEqual(['instance-2']);
    expect(registeredCount(folder)).toBe(1);
  });

  it('overlapping reloads serialize, so neither adopts the other’s instance', async () => {
    // A billing toggle (bare) and a panel starting (session-bound) can be issued in the same tick; each
    // reload reads "the instance I just minted" from one slot, so they must not interleave.
    const folder = bareFolder(made);
    const loader = attachFakeServices(folder);

    await folder.prepareSessionExtensions(); // panel A binds the creation instance

    const bare = folder.reloadBare();
    const bound = folder.prepareSessionExtensions();
    await Promise.all([bare, bound]);

    folder.republishToolSearch();
    expect(loader.fired).toEqual(['init', 'instance-2']);
    expect(registeredCount(folder)).toBe(2);
  });
});

/** Two workspace folders on one real pi runtime. */
describe('folder runtimes on real pi', () => {
  const made: string[] = [];
  const sessions: AgentSession[] = [];

  const tempDir = (prefix: string): string => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    made.push(dir);
    return dir;
  };

  afterEach(async () => {
    for (const session of sessions.splice(0)) session.dispose();
    await PiRuntime.disposeInstance();
    H.home = '';
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(file: string, content: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  /** Two folders, each with its own instructions, skill, markdown agent and hook, under a temp home. */
  function twoFolders(): { a: string; b: string; runtime: PiRuntime } {
    H.home = tempDir('damocles-fr-home-');
    write(path.join(H.home, '.damocles', 'AGENTS.md'), 'Global rules.\n');
    const a = tempDir('damocles-fr-a-');
    const b = tempDir('damocles-fr-b-');
    for (const [dir, name] of [[a, 'alpha'], [b, 'beta']] as const) {
      write(path.join(dir, 'CLAUDE.md'), `${name} rules.\n`);
      write(path.join(dir, `${name}-marker.txt`), `${name} marker`);
      write(path.join(dir, '.damocles', 'skills', `${name}-skill`, 'SKILL.md'), `---\nname: ${name}-skill\ndescription: ${name} skill\n---\nBody.\n`);
      write(path.join(dir, '.damocles', 'agents', `${name}-agent.md`), `---\nname: ${name}-agent\ndescription: ${name} agent\n---\nYou are ${name}.\n`);
      write(path.join(dir, '.damocles', 'hooks.json'), JSON.stringify({ hooks: { tool_call: [{ command: `${name}-hook` }] } }));
    }
    return { a, b, runtime: PiRuntime.get(tempDir('damocles-fr-agent-')) };
  }

  const contextOf = (services: AgentSessionServices): string =>
    services.resourceLoader.getAgentsFiles().agentsFiles.map((f) => f.content).join('\n');

  async function sessionOn(services: AgentSessionServices): Promise<AgentSession> {
    const pi = await initPiLoader();
    if (!pi) throw new Error('pi failed to load');
    const { session } = await pi.createAgentSessionFromServices({ services, sessionManager: pi.SessionManager.inMemory(services.cwd) });
    sessions.push(session);
    return session;
  }

  it('loads each folder’s own CLAUDE.md plus the global one, on one shared model runtime', async () => {
    const { a, b, runtime } = twoFolders();
    const [fa, fb] = await Promise.all([runtime.folder(a), runtime.folder(b)]);

    expect(contextOf(fa.services)).toContain('alpha rules.');
    expect(contextOf(fa.services)).toContain('Global rules.');
    expect(contextOf(fa.services)).not.toContain('beta rules.');
    expect(contextOf(fb.services)).toContain('beta rules.');
    expect(contextOf(fb.services)).toContain('Global rules.');
    expect(contextOf(fb.services)).not.toContain('alpha rules.');

    const prompt = (await sessionOn(fb.services)).systemPrompt;
    expect(prompt).toContain('beta rules.');
    expect(prompt).not.toContain('alpha rules.');

    // A reload of one folder re-reads only that folder's files.
    await fa.reloadBare();
    expect(contextOf(fb.services)).not.toContain('alpha rules.');
    expect(contextOf(fa.services)).toContain('alpha rules.');

    expect(fa.services.modelRuntime).toBe(runtime.modelRuntime);
    expect(fb.services.modelRuntime).toBe(runtime.modelRuntime);
  }, 60_000);

  it('creates one runtime per folder key and lists only finished ones', async () => {
    const { a, b, runtime } = twoFolders();
    const [first, second] = await Promise.all([runtime.folder(a), runtime.folder(a)]);
    expect(second).toBe(first);
    expect(first.cwd).toBe(a);
    expect(first.key).toBe(folderKey(a));
    if (process.platform === 'win32') expect(await runtime.folder(a.toUpperCase())).toBe(first);

    expect(runtime.folders()).toEqual([first]);
    const fb = await runtime.folder(b);
    expect(runtime.folders()).toEqual([first, fb]);
  }, 60_000);

  it('points cwd, project skills, markdown agents and hooks at the folder', async () => {
    const { a, b, runtime } = twoFolders();
    const fa = await runtime.folder(a);
    const fb = await runtime.folder(b);

    expect(fb.services.cwd).toBe(b);
    const read = (await sessionOn(fb.services)).getToolDefinition('read');
    if (!read) throw new Error('pi native `read` is not registered on this session');
    const result = await read.execute('cwd-probe', { path: 'beta-marker.txt' }, undefined, undefined, undefined as never);
    expect(JSON.stringify(result.content)).toContain('beta marker');

    const skills = (folder: typeof fa) => folder.services.resourceLoader.getSkills().skills.map((s) => s.name);
    expect(skills(fb)).toContain('beta-skill');
    expect(skills(fb)).not.toContain('alpha-skill');
    expect(skills(fa)).toContain('alpha-skill');

    const agents = (folder: typeof fa) => folder.getWorkspaceAgentRegistry().getRegistry().getAvailableConfigs().map((c) => c.name);
    expect(agents(fb)).toContain('beta-agent');
    expect(agents(fb)).not.toContain('alpha-agent');

    const hooks = (folder: typeof fa) => folder.getHooksDispatchDeps().config.getEntries('tool_call').map((e) => e.command);
    expect(fb.getHooksDispatchDeps().workspaceRoot).toBe(b);
    expect(hooks(fb)).toContain('beta-hook');
    expect(hooks(fb)).not.toContain('alpha-hook');
  }, 60_000);

  it('keeps the pristine-session rule and the ToolSearch republishers per folder', async () => {
    const { a, b, runtime } = twoFolders();
    const fa = await runtime.folder(a);
    const fb = await runtime.folder(b);
    const reloadA = vi.spyOn(fa.services.resourceLoader, 'reload');
    const reloadB = vi.spyOn(fb.services.resourceLoader, 'reload');
    const republishers = (folder: FolderRuntime) =>
      (folder as unknown as { _toolSearchRepublishers: Set<() => void> })._toolSearchRepublishers.size;
    expect(republishers(fa)).toBe(1);
    expect(republishers(fb)).toBe(1);

    await fa.prepareSessionExtensions(); // A's first session binds A's creation instance
    await fb.prepareSessionExtensions(); // so does B's, even though A already bound one
    expect(reloadA).not.toHaveBeenCalled();
    expect(reloadB).not.toHaveBeenCalled();

    await fa.prepareSessionExtensions(); // A's second session reloads A only
    expect(reloadA).toHaveBeenCalledTimes(1);
    expect(reloadB).not.toHaveBeenCalled();
    expect(republishers(fa)).toBe(2);
    expect(republishers(fb)).toBe(1);

    await fb.reloadBare();
    await fb.reloadBare();
    expect(republishers(fa)).toBe(2);
    expect(republishers(fb)).toBe(2);
  }, 60_000);

  it('fans an MCP tools change out to every folder', async () => {
    const { a, b, runtime } = twoFolders();
    const fa = await runtime.folder(a);
    const fb = await runtime.folder(b);
    const refreshed: string[] = [];
    fa.registerActiveToolRefresher('sess-a', () => refreshed.push('a'));
    fb.registerActiveToolRefresher('sess-b', () => refreshed.push('b'));

    (runtime.getUserMcp() as unknown as { emitToolsChanged(): void }).emitToolsChanged();

    expect(refreshed.sort()).toEqual(['a', 'b']);
  }, 60_000);

  it('disposes one folder without touching the other', async () => {
    const { a, b, runtime } = twoFolders();
    const fa = await runtime.folder(a);
    const fb = await runtime.folder(b);
    const anchoredOn = (dir: string) =>
      __watchers.filter((w) => w.globPattern instanceof vscode.RelativePattern && w.globPattern.base === dir);
    expect(anchoredOn(a).length).toBeGreaterThan(0);

    await runtime.disposeFolder(fa.key);

    expect(fa.disposed).toBe(true);
    expect(anchoredOn(a).every((w) => w.disposed)).toBe(true);
    expect(runtime.folders()).toEqual([fb]);
    await expect(fb.reloadBare()).resolves.toBeUndefined();
    expect(contextOf(fb.services)).toContain('beta rules.');

    const again = await runtime.folder(a);
    expect(again).not.toBe(fa);

    await PiRuntime.disposeInstance();
    expect(fb.disposed).toBe(true);
    expect(again.disposed).toBe(true);
  }, 60_000);
});

describe('createSubagentSession store', () => {
  const made: string[] = [];
  const tempDir = (prefix: string): string => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    made.push(dir);
    return dir;
  };

  afterEach(async () => {
    await PiRuntime.disposeInstance();
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const assistantMessage = (provider: string, model: string) =>
    ({
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      api: 'anthropic-messages',
      provider,
      model,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: Date.now(),
    }) as unknown as Parameters<SessionManager['appendMessage']>[0];

  const baseOpts = (workspace: string) => ({
    cwd: workspace,
    systemPrompt: 'probe',
    tools: [],
    customTools: [],
    extensionFactory: () => {},
  });

  /** A signed-in reasoning model from the runtime's own catalog, so the reopen check can resolve it. */
  async function reasoningModel(runtime: PiRuntime) {
    await runtime.modelRuntime!.setRuntimeApiKey('anthropic', 'test-key');
    const model = runtime.modelRuntime!.getModels('anthropic').find((m) => m.reasoning);
    if (!model) throw new Error('no anthropic reasoning model in the catalog');
    expect(runtime.modelRuntime!.hasConfiguredAuth('anthropic')).toBe(true);
    return model;
  }

  it('a file store writes into the given dir under the given id, from the first assistant message on', async () => {
    const workspace = tempDir('damocles-store-ws-');
    const agentDir = tempDir('damocles-store-agent-');
    const storeDir = path.join(workspace, 'sess-1', 'subagents');
    const runtime = PiRuntime.get(agentDir);
    const folder = await runtime.folder(workspace);

    const session = await folder.createSubagentSession({ ...baseOpts(workspace), store: { kind: 'file', dir: storeDir, id: 'agent-1' } });
    const file = session.sessionManager.getSessionFile()!;
    expect(path.dirname(file)).toBe(storeDir);
    expect(path.basename(file)).toMatch(/_agent-1\.jsonl$/);
    expect(session.sessionManager.getSessionId()).toBe('agent-1');
    expect(fs.existsSync(file)).toBe(false);

    session.sessionManager.appendCustomEntry('damocles-agent-launch', { agentId: 'agent-1' });
    session.sessionManager.appendMessage(assistantMessage('anthropic', 'claude'));
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { type: string; id: string });
    expect(lines[0]).toMatchObject({ type: 'session', id: 'agent-1' });
    expect(lines.map((l) => l.type)).toContain('custom');
    folder.forgetSubagentSession(session);
  }, 60_000);

  it('reopen restores the messages, the recorded model and the thinking level from the file', async () => {
    const workspace = tempDir('damocles-store-ws-');
    const agentDir = tempDir('damocles-store-agent-');
    const storeDir = path.join(workspace, 'sess-1', 'subagents');
    const runtime = PiRuntime.get(agentDir);
    const folder = await runtime.folder(workspace);
    const model = await reasoningModel(runtime);

    const session = await folder.createSubagentSession({
      ...baseOpts(workspace),
      model,
      thinkingLevel: 'medium',
      store: { kind: 'file', dir: storeDir, id: 'agent-1' },
    });
    session.sessionManager.appendCustomEntry('damocles-agent-launch', { agentId: 'agent-1' });
    session.sessionManager.appendMessage(assistantMessage(model.provider, model.id));
    const file = session.sessionManager.getSessionFile()!;
    folder.forgetSubagentSession(session);

    const reopened = await folder.createSubagentSession({ ...baseOpts(workspace), store: { kind: 'reopen', path: file, agentId: 'agent-1' } });
    expect(reopened.sessionManager.getSessionFile()).toBe(file);
    expect(reopened.sessionManager.getSessionId()).toBe('agent-1');
    expect(reopened.messages.map((m) => m.role)).toEqual(['assistant']);
    expect(reopened.model?.provider).toBe(model.provider);
    expect(reopened.model?.id).toBe(model.id);
    expect(reopened.thinkingLevel).toBe('medium');
    expect(() => folder.assertResumableModel(file, 'agent-1')).not.toThrow();
    folder.forgetSubagentSession(reopened);
  }, 60_000);

  it('reopen throws the resume error, instead of falling back, when the recorded model is unavailable', async () => {
    const workspace = tempDir('damocles-store-ws-');
    const agentDir = tempDir('damocles-store-agent-');
    const storeDir = path.join(workspace, 'sess-1', 'subagents');
    const runtime = PiRuntime.get(agentDir);
    const folder = await runtime.folder(workspace);
    await reasoningModel(runtime);

    const session = await folder.createSubagentSession({ ...baseOpts(workspace), store: { kind: 'file', dir: storeDir, id: 'agent-1' } });
    session.sessionManager.appendMessage(assistantMessage('anthropic', 'no-such-model'));
    const file = session.sessionManager.getSessionFile()!;
    folder.forgetSubagentSession(session);

    const error = 'Cannot resume "agent-1": its model anthropic/no-such-model is not configured or not signed in.';
    await expect(
      folder.createSubagentSession({ ...baseOpts(workspace), store: { kind: 'reopen', path: file, agentId: 'agent-1' } }),
    ).rejects.toThrow(error);
    expect(() => folder.assertResumableModel(file, 'agent-1')).toThrow(error);
  }, 60_000);

  it('reopen throws the resume error when the recorded model exists but its provider is not signed in', async () => {
    const workspace = tempDir('damocles-store-ws-');
    const agentDir = tempDir('damocles-store-agent-');
    const storeDir = path.join(workspace, 'sess-1', 'subagents');
    const runtime = PiRuntime.get(agentDir);
    const folder = await runtime.folder(workspace);
    const models = runtime.modelRuntime!;
    const signedOut = models.getModels().find((m) => !models.hasConfiguredAuth(m.provider));
    if (!signedOut) throw new Error('every catalog provider is signed in, so no signed-out model can be recorded');

    const session = await folder.createSubagentSession({ ...baseOpts(workspace), store: { kind: 'file', dir: storeDir, id: 'agent-1' } });
    session.sessionManager.appendMessage(assistantMessage(signedOut.provider, signedOut.id));
    const file = session.sessionManager.getSessionFile()!;
    folder.forgetSubagentSession(session);

    const error = `Cannot resume "agent-1": its model ${signedOut.provider}/${signedOut.id} is not configured or not signed in.`;
    expect(() => folder.assertResumableModel(file, 'agent-1')).toThrow(error);
    await expect(
      folder.createSubagentSession({ ...baseOpts(workspace), store: { kind: 'reopen', path: file, agentId: 'agent-1' } }),
    ).rejects.toThrow(error);
  }, 60_000);
});
