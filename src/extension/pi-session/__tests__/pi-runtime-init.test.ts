import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock the pi loader + agent-dir so init()'s caching/lifecycle logic can be exercised on any Node
// version (the real value-import path needs Node >=22). The fake pi exposes only what _doInit uses.
const H = vi.hoisted(() => {
  const createServicesSpy = vi.fn();
  const settingsCreateSpy = vi.fn((_cwd: string, _agentDir: string, options?: { projectTrusted: boolean }) => ({ options }));
  const modelRuntime = { getAvailableSnapshot: () => [], refresh: vi.fn(async () => undefined) };
  const fakePi = {
    createAgentSessionServices: createServicesSpy,
    SettingsManager: { create: settingsCreateSpy },
    ModelRuntime: { create: vi.fn(async () => modelRuntime) },
    DefaultPackageManager: class {
      getInstalledPath(): string | undefined {
        return undefined;
      }
    },
  };
  return { createServicesSpy, settingsCreateSpy, modelRuntime, fakePi, ctrl: { loadable: true }, home: '' };
});

// The user-scope asset dirs are resolved through `os.homedir()`. Redirect it to a temp dir so the
// developer's real `~/.claude` cannot leak into (or decide) an assertion about the loader's paths.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = () => (H.home !== '' ? H.home : actual.homedir());
  return { ...actual, homedir, default: { ...actual, homedir } };
});

vi.mock('../pi-loader', () => ({
  initPiLoader: vi.fn(async () => (H.ctrl.loadable ? H.fakePi : null)),
  getPiCodingAgent: vi.fn(() => (H.ctrl.loadable ? H.fakePi : null)),
  PI_MIN_NODE_MAJOR: 22,
  nodeSupportsPi: () => true,
}));

// Only the fs-touching seed is stubbed; `cacheWarmingSetting` stays real so the mode a test configures
// travels the production path.
vi.mock('../agent-dir', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-dir')>()),
  ensurePiAgentDir: (dir: string) => dir,
  PI_AGENT_DIR: '/fake/agent',
}));

import * as vscode from 'vscode';
import { __trustEmitter, __watchers, type FakeFileSystemWatcher } from 'vscode';
import { PiRuntime } from '../pi-runtime';
import { FolderRuntime } from '../folder-runtime';

const realIsTrusted = vscode.workspace.isTrusted;

function setTrusted(trusted: boolean): void {
  vscode.__setTrusted(trusted);
}

/** Create `<root>/<rel>/<name>/SKILL.md` and return the containing skills dir. */
function makeSkill(root: string, rel: string, name: string): string {
  const skillsDir = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.join(skillsDir, name), { recursive: true });
  fs.writeFileSync(
    path.join(skillsDir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: d\n---\n`,
    'utf8',
  );
  return skillsDir;
}

/** The `skillPaths` argument of the first `extendResources` call, as plain paths. */
function skillPathsOf(extendResources: ReturnType<typeof vi.fn>): string[] {
  const arg = extendResources.mock.calls[0]?.[0] as { skillPaths: { path: string }[] };
  return arg.skillPaths.map((s) => s.path);
}

const registeredCount = (folder: FolderRuntime): number =>
  (folder as unknown as { _toolSearchRepublishers: Set<() => void> })._toolSearchRepublishers.size;

interface LoaderProbe {
  /** The loader's effective skill-path order: the reload base plus whatever extendResources merged in. */
  skillPaths: string[];
  /** Ids of the republishers `republishToolSearch()` reached, in call order. */
  fired: string[];
  /** `extendResources` calls. It is the last step of a reload, so it is the barrier to wait on. */
  extendCalls: number;
}

/**
 * Hand `createAgentSessionServices` a resource loader that tracks the effective skill-path order.
 * `reload()` rebuilds the base list from the `additionalSkillPaths` array it was constructed with,
 * read live on every call, and `extendResources` merges its argument primary-first with dedupe, which
 * is what `mergePaths` does in pi's `resource-loader.ts`. The `extendResources` argument on its own
 * cannot show the order the agent ends up with. Every reload also mints a republisher, as pi's
 * extension factory does, so the folder runtime's retire and adopt bookkeeping is observable.
 */
function trackLoader(): LoaderProbe {
  const probe: LoaderProbe = { skillPaths: [], fired: [], extendCalls: 0 };
  let seq = 0;
  const creating: FolderRuntime[] = [];
  const createServices = FolderRuntime.prototype.createServices;
  vi.spyOn(FolderRuntime.prototype, 'createServices').mockImplementation(async function (this: FolderRuntime) {
    creating.push(this);
    await createServices.call(this);
  });
  const mint = (): void => {
    const id = `instance-${++seq}`;
    creating.at(-1)!.registerToolSearchRepublisher(() => probe.fired.push(id));
  };
  H.createServicesSpy.mockImplementation(async (options: unknown) => {
    const additional = (options as { resourceLoaderOptions: { additionalSkillPaths: string[] } })
      .resourceLoaderOptions.additionalSkillPaths;
    probe.skillPaths = [...additional];
    mint();
    return {
      ...fakeServices(),
      resourceLoader: {
        getExtensions: noExtensions,
        reload: vi.fn(async () => {
          probe.skillPaths = [...additional];
          mint();
        }),
        extendResources: vi.fn((paths: { skillPaths: { path: string }[] }) => {
          probe.skillPaths = [...new Set([...probe.skillPaths, ...paths.skillPaths.map((s) => s.path)])];
          probe.extendCalls += 1;
        }),
      },
    };
  });
  return probe;
}

/** The watcher registered for `<base>` + `<glob>`, so a test names the directory it drives. */
function watcherFor(base: string, glob: string): FakeFileSystemWatcher {
  const found = __watchers.find((w) => {
    const p = w.globPattern;
    if (!(p instanceof vscode.RelativePattern) || p.pattern !== glob) return false;
    const anchor = typeof p.base === 'string' ? p.base : (p.base as { fsPath: string }).fsPath;
    return anchor === base;
  });
  if (!found) throw new Error(`no watcher registered for ${base} + ${glob}`);
  return found;
}

const noExtensions = () => ({ errors: [], runtime: { pendingProviderRegistrations: [] } });

function fakeServices() {
  return {
    cwd: '/cwd',
    agentDir: '/agent',
    settingsManager: { getPackages: () => [], setProjectTrusted: vi.fn(), isProjectTrusted: vi.fn(() => true) },
    modelRuntime: { getAvailableSnapshot: () => [], refresh: vi.fn(async () => undefined) },
    resourceLoader: { getExtensions: noExtensions, extendResources: vi.fn(), reload: vi.fn(async () => undefined) },
    diagnostics: [],
  };
}

describe('PiRuntime.init lifecycle', () => {
  const tempDirs: string[] = [];

  function tempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    H.ctrl.loadable = true;
    H.createServicesSpy.mockReset();
    H.settingsCreateSpy.mockClear();
    H.createServicesSpy.mockResolvedValue(fakeServices());
    H.home = tempDir('pi-home-');
    setTrusted(true);
    __trustEmitter.clear();
    __watchers.length = 0;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await PiRuntime.disposeInstance();
    __trustEmitter.clear();
    setTrusted(realIsTrusted);
    H.home = '';
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates no folder services on init, and one set per folder across concurrent and repeat requests', async () => {
    const runtime = PiRuntime.get('/agent');
    await Promise.all([runtime.init(), runtime.init()]);
    expect(H.createServicesSpy).not.toHaveBeenCalled();

    const [a, again] = await Promise.all([runtime.folder('/cwd'), runtime.folder('/cwd')]);
    await runtime.folder('/cwd');
    expect(again).toBe(a);
    expect(H.createServicesSpy).toHaveBeenCalledTimes(1);

    await runtime.folder('/other');
    expect(H.createServicesSpy).toHaveBeenCalledTimes(2);
  });

  it('builds every folder on the one shared model runtime', async () => {
    const runtime = PiRuntime.get('/agent');
    await runtime.folder('/cwd');
    await runtime.folder('/other');

    expect(runtime.modelRuntime).toBe(H.modelRuntime);
    for (const [options] of H.createServicesSpy.mock.calls) {
      expect((options as { modelRuntime: unknown }).modelRuntime).toBe(H.modelRuntime);
    }
  });

  it('keeps package operations on user-scope settings rooted at the agent dir', async () => {
    const runtime = PiRuntime.get('/agent');
    await runtime.init();

    expect(H.settingsCreateSpy).toHaveBeenCalledWith('/agent', '/agent');
  });

  it('clears the cached promise on failure so a later init() retries', async () => {
    H.ctrl.loadable = false;
    const runtime = PiRuntime.get('/agent');
    await expect(runtime.init()).rejects.toThrow(/failed to load/);

    H.ctrl.loadable = true;
    await expect(runtime.init()).resolves.toBeUndefined();
    expect(runtime.modelRuntime).not.toBeNull();
  });

  it('rejects init() after dispose (no resurrection of a disposed runtime)', async () => {
    const runtime = PiRuntime.get('/agent');
    await runtime.init();
    await runtime.dispose();
    expect(runtime.modelRuntime).toBeNull();
    await expect(runtime.init()).rejects.toThrow(/disposed/);
    await expect(runtime.folder('/cwd')).rejects.toThrow(/disposed/);
  });

  it('pushes a project .codex/skills dir into the loader via extendResources on init', async () => {
    const cwd = tempDir('pi-codex-');
    makeSkill(cwd, '.codex/skills', 'demo');

    const extendResources = vi.fn();
    H.createServicesSpy.mockResolvedValue({ ...fakeServices(), resourceLoader: { getExtensions: noExtensions, extendResources, reload: vi.fn(async () => undefined) } });

    const runtime = PiRuntime.get('/agent');
    await runtime.folder(cwd);

    expect(extendResources).toHaveBeenCalled();
    expect(skillPathsOf(extendResources)).toContain(path.join(cwd, '.codex', 'skills'));
  });

  it('ranks a project .damocles/skills dir above the .claude and .codex ones', async () => {
    const cwd = tempDir('pi-damocles-');
    makeSkill(cwd, '.damocles/skills', 'demo');
    makeSkill(cwd, '.claude/skills', 'demo');
    makeSkill(cwd, '.codex/skills', 'demo');

    const extendResources = vi.fn();
    H.createServicesSpy.mockResolvedValue({ ...fakeServices(), resourceLoader: { getExtensions: noExtensions, extendResources, reload: vi.fn(async () => undefined) } });

    const runtime = PiRuntime.get('/agent');
    await runtime.folder(cwd);

    const paths = skillPathsOf(extendResources);
    const damocles = paths.indexOf(path.join(cwd, '.damocles', 'skills'));
    const claude = paths.indexOf(path.join(cwd, '.claude', 'skills'));
    const codex = paths.indexOf(path.join(cwd, '.codex', 'skills'));
    expect(damocles).toBeGreaterThanOrEqual(0);
    expect(claude).toBeGreaterThan(damocles);
    expect(codex).toBeGreaterThan(damocles);
  });

  // pi expands SKILL.md into the system prompt, so a project skill from an untrusted repo would be
  // injected text the user never vetted. User-scope skills are the user's own and stay loaded.
  it('keeps every project dir out of the loader in an untrusted workspace', async () => {
    const cwd = tempDir('pi-untrusted-');
    makeSkill(cwd, '.damocles/skills', 'projectskill');
    makeSkill(cwd, '.claude/skills', 'projectskill');
    makeSkill(cwd, '.codex/skills', 'projectskill');
    makeSkill(H.home, '.damocles/skills', 'userskill');
    makeSkill(H.home, '.claude/skills', 'userskill');
    setTrusted(false);

    const extendResources = vi.fn();
    H.createServicesSpy.mockResolvedValue({ ...fakeServices(), resourceLoader: { getExtensions: noExtensions, extendResources, reload: vi.fn(async () => undefined) } });

    const runtime = PiRuntime.get('/agent');
    await runtime.folder(cwd);

    const paths = skillPathsOf(extendResources);
    expect(paths.filter((p) => p.startsWith(cwd))).toEqual([]);
    expect(paths).toContain(path.join(H.home, '.damocles', 'skills'));
    expect(paths).toContain(path.join(H.home, '.claude', 'skills'));
  });

  // pi's project layer (`.pi/settings.json` packages, `.pi/extensions`) installs and runs repo code.
  it.each([true, false])('hands pi a settings manager whose project trust matches the window (trusted=%s)', async (trusted) => {
    setTrusted(trusted);
    const runtime = PiRuntime.get('/agent');
    await runtime.folder('/cwd');

    expect(H.settingsCreateSpy).toHaveBeenCalledWith('/cwd', '/agent', { projectTrusted: trusted });
    const created = H.settingsCreateSpy.mock.results.at(-1)?.value;
    expect((H.createServicesSpy.mock.calls[0]?.[0] as { settingsManager: unknown }).settingsManager).toBe(created);
  });

  it('trusts the project layer before the trust-grant reload', async () => {
    setTrusted(false);
    const services = fakeServices();
    const order: string[] = [];
    services.settingsManager.setProjectTrusted.mockImplementation(() => void order.push('trusted'));
    services.resourceLoader.reload.mockImplementation(async () => void order.push('reload'));
    H.createServicesSpy.mockResolvedValue(services);
    const runtime = PiRuntime.get('/agent');
    await runtime.folder('/cwd');

    setTrusted(true);
    __trustEmitter.fire();

    await vi.waitFor(() => expect(order).toEqual(['trusted', 'reload']));
    expect(services.settingsManager.setProjectTrusted).toHaveBeenCalledWith(true);
  });

  it('trusts a folder whose creation was still running when trust was granted', async () => {
    setTrusted(false);
    let projectTrusted = true;
    const order: string[] = [];
    const services = fakeServices();
    services.settingsManager.isProjectTrusted.mockImplementation(() => projectTrusted);
    services.settingsManager.setProjectTrusted.mockImplementation((trusted: boolean) => {
      projectTrusted = trusted;
      order.push('trusted');
    });
    services.resourceLoader.reload.mockImplementation(async () => void order.push('reload'));
    let created!: () => void;
    H.createServicesSpy.mockImplementationOnce(async (options: { settingsManager: { options: { projectTrusted: boolean } } }) => {
      projectTrusted = options.settingsManager.options.projectTrusted;
      await new Promise<void>((resolve) => { created = resolve; });
      return services;
    });
    const runtime = PiRuntime.get('/agent');

    const creating = runtime.folder('/cwd');
    await vi.waitFor(() => expect(H.createServicesSpy).toHaveBeenCalled());
    expect(projectTrusted).toBe(false);
    // The grant lands while the folder is not yet published, so the listener cannot reach it.
    setTrusted(true);
    __trustEmitter.fire();
    created();
    const folder = await creating;

    expect(folder.services.settingsManager.isProjectTrusted()).toBe(true);
    expect(order).toEqual(['trusted', 'reload']);
  });

  it('trusts every folder’s project layer before that folder’s trust-grant reload', async () => {
    setTrusted(false);
    const order: string[] = [];
    const servicesFor = (label: string) => {
      const services = fakeServices();
      services.settingsManager.setProjectTrusted.mockImplementation(() => void order.push(`trusted:${label}`));
      services.resourceLoader.reload.mockImplementation(async () => void order.push(`reload:${label}`));
      return services;
    };
    H.createServicesSpy.mockResolvedValueOnce(servicesFor('a')).mockResolvedValueOnce(servicesFor('b'));
    const runtime = PiRuntime.get('/agent');
    await runtime.folder('/a');
    await runtime.folder('/b');
    expect(H.settingsCreateSpy).toHaveBeenCalledWith('/a', '/agent', { projectTrusted: false });
    expect(H.settingsCreateSpy).toHaveBeenCalledWith('/b', '/agent', { projectTrusted: false });

    setTrusted(true);
    __trustEmitter.fire();

    await vi.waitFor(() => expect(order).toHaveLength(4));
    expect(order.indexOf('trusted:a')).toBeLessThan(order.indexOf('reload:a'));
    expect(order.indexOf('trusted:b')).toBeLessThan(order.indexOf('reload:b'));
  });

  // The additional paths are computed once at services construction, so admitting the project dirs
  // after a trust grant needs a reload. Without one the badges clear but the agent still cannot run
  // the skill. The order matters as much as the membership: pi's loader is first-wins on a name
  // collision, so a project skill behind the user one is a project skill that never runs.
  it('reloads and ranks the project dir ahead of the user dir when workspace trust is granted', async () => {
    const cwd = tempDir('pi-trustgrant-');
    makeSkill(cwd, '.damocles/skills', 'projectskill');
    makeSkill(H.home, '.damocles/skills', 'userskill');
    setTrusted(false);

    const probe = trackLoader();
    const runtime = PiRuntime.get('/agent');
    await runtime.folder(cwd);

    expect(probe.skillPaths).toEqual([path.join(H.home, '.damocles', 'skills')]);

    setTrusted(true);
    __trustEmitter.fire();

    await vi.waitFor(() =>
      expect(probe.skillPaths).toEqual([
        path.join(cwd, '.damocles', 'skills'),
        path.join(H.home, '.damocles', 'skills'),
      ]),
    );
  });

  // Same inversion, reached without a trust grant: a project skills dir created after init only
  // reaches the loader through the watcher's reload, which is the door the watchers exist for.
  it('ranks a project dir created after init ahead of the user dir', async () => {
    const cwd = tempDir('pi-latedir-');
    makeSkill(H.home, '.damocles/skills', 'userskill');

    const probe = trackLoader();
    const runtime = PiRuntime.get('/agent');
    await runtime.folder(cwd);

    expect(probe.skillPaths).toEqual([path.join(H.home, '.damocles', 'skills')]);

    const projectSkills = makeSkill(cwd, '.damocles/skills', 'projectskill');
    watcherFor(cwd, '.damocles/skills/**').emitCreate(path.join(projectSkills, 'projectskill', 'SKILL.md'));

    await vi.waitFor(
      () =>
        expect(probe.skillPaths).toEqual([
          path.join(cwd, '.damocles', 'skills'),
          path.join(H.home, '.damocles', 'skills'),
        ]),
      { timeout: 2_000 },
    );
  });

  // A trust grant starts no session, so nothing else will ever retire the instance its reload mints.
  // If that site asked for a session-bound reload instead, the minted instance would be stranded and
  // the next reload would leave two live republishers for one loader.
  it('retires the superseded unbound republisher on a trust grant and adopts exactly one', async () => {
    const cwd = tempDir('pi-trustrepub-');
    makeSkill(cwd, '.damocles/skills', 'projectskill');
    setTrusted(false);

    const probe = trackLoader();
    const runtime = PiRuntime.get('/agent');
    const folder = await runtime.folder(cwd);
    expect(registeredCount(folder)).toBe(1);

    setTrusted(true);
    __trustEmitter.fire();
    await vi.waitFor(() => expect(probe.extendCalls).toBe(1));

    folder.republishToolSearch();
    expect(probe.fired).toEqual(['instance-2']);
    expect(registeredCount(folder)).toBe(1);

    // A second grant-driven reload has to retire instance-2 in turn, which it can only do if the
    // first one was adopted rather than stranded.
    probe.fired.length = 0;
    __trustEmitter.fire();
    await vi.waitFor(() => expect(probe.extendCalls).toBe(2));

    folder.republishToolSearch();
    expect(probe.fired).toEqual(['instance-3']);
    expect(registeredCount(folder)).toBe(1);
  });

  it('disposes the trust listener, so a granted trust cannot reload a disposed runtime', async () => {
    const runtime = PiRuntime.get('/agent');
    await runtime.folder('/cwd');
    expect(__trustEmitter.cbs.length).toBeGreaterThan(0);

    await PiRuntime.disposeInstance();

    expect(__trustEmitter.cbs).toEqual([]);
  });

  // VS Code reports no event from a bare glob string outside the opened workspace folders, so a
  // user-scope watcher registered that way never fires and the edit only lands on the next reload.
  it('anchors every user-scope asset watcher on a Uri and registers no bare glob', async () => {
    const cwd = tempDir('pi-watchers-');
    const runtime = PiRuntime.get('/agent');
    await runtime.folder(cwd);

    expect(__watchers.filter((w) => !(w.globPattern instanceof vscode.RelativePattern))).toEqual([]);

    // The mock keeps `RelativePattern.base` as the constructor argument (VS Code normalizes it to a
    // path string), which is what tells a Uri-anchored pattern from a workspace-relative one.
    const userAnchored = __watchers
      .map((w) => w.globPattern as unknown as { base: unknown; pattern: string })
      .filter((p) => typeof p.base !== 'string');
    expect(userAnchored.length).toBeGreaterThan(0);
    for (const p of userAnchored) {
      expect((p.base as { fsPath: string }).fsPath.startsWith(H.home)).toBe(true);
    }

    // The user's own global instructions file has its own watcher, so editing it hot-reloads too.
    expect(
      userAnchored.some(
        (p) =>
          (p.base as { fsPath: string }).fsPath === path.join(H.home, '.damocles') &&
          p.pattern.includes('AGENTS.md'),
      ),
    ).toBe(true);
  });
});
