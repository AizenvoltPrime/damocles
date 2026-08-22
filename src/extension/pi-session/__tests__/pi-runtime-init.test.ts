import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock the pi loader + agent-dir so init()'s caching/lifecycle logic can be exercised on any Node
// version (the real value-import path needs Node >=22). The fake pi exposes only what _doInit uses.
const H = vi.hoisted(() => {
  const createServicesSpy = vi.fn();
  const fakePi = {
    createAgentSessionServices: createServicesSpy,
    DefaultPackageManager: class {
      getInstalledPath(): string | undefined {
        return undefined;
      }
    },
  };
  return { createServicesSpy, fakePi, ctrl: { loadable: true }, home: '' };
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

vi.mock('../agent-dir', () => ({
  ensurePiAgentDir: (dir: string) => dir,
  PI_AGENT_DIR: '/fake/agent',
}));

import * as vscode from 'vscode';
import { __trustEmitter, __watchers, type FakeFileSystemWatcher } from 'vscode';
import { PiRuntime } from '../pi-runtime';

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

const registeredCount = (runtime: PiRuntime): number =>
  (runtime as unknown as { _toolSearchRepublishers: Set<() => void> })._toolSearchRepublishers.size;

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
 * extension factory does, so the runtime's retire and adopt bookkeeping is observable.
 */
function trackLoader(runtime: PiRuntime): LoaderProbe {
  const probe: LoaderProbe = { skillPaths: [], fired: [], extendCalls: 0 };
  let seq = 0;
  const mint = (): void => {
    const id = `instance-${++seq}`;
    runtime.registerToolSearchRepublisher(() => probe.fired.push(id));
  };
  H.createServicesSpy.mockImplementation(async (options: unknown) => {
    const additional = (options as { resourceLoaderOptions: { additionalSkillPaths: string[] } })
      .resourceLoaderOptions.additionalSkillPaths;
    probe.skillPaths = [...additional];
    mint();
    return {
      ...fakeServices(),
      resourceLoader: {
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

function fakeServices() {
  return {
    cwd: '/cwd',
    agentDir: '/agent',
    settingsManager: { getPackages: () => [] },
    modelRuntime: { getAvailableSnapshot: () => [], refresh: vi.fn(async () => undefined) },
    resourceLoader: { extendResources: vi.fn(), reload: vi.fn(async () => undefined) },
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
    H.createServicesSpy.mockResolvedValue(fakeServices());
    H.home = tempDir('pi-home-');
    setTrusted(true);
    __trustEmitter.clear();
    __watchers.length = 0;
  });
  afterEach(async () => {
    await PiRuntime.disposeInstance();
    __trustEmitter.clear();
    setTrusted(realIsTrusted);
    H.home = '';
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates services exactly once across concurrent and repeat init() calls', async () => {
    const runtime = PiRuntime.get('/cwd', '/agent');
    await Promise.all([runtime.init(), runtime.init()]);
    await runtime.init();
    expect(H.createServicesSpy).toHaveBeenCalledTimes(1);
  });

  it('clears the cached promise on failure so a later init() retries', async () => {
    H.ctrl.loadable = false;
    const runtime = PiRuntime.get('/cwd', '/agent');
    await expect(runtime.init()).rejects.toThrow(/failed to load/);

    H.ctrl.loadable = true;
    await expect(runtime.init()).resolves.toBeUndefined();
    expect(H.createServicesSpy).toHaveBeenCalledTimes(1);
    expect(runtime.services).not.toBeNull();
  });

  it('rejects init() after dispose (no resurrection of a disposed runtime)', async () => {
    const runtime = PiRuntime.get('/cwd', '/agent');
    await runtime.init();
    await runtime.dispose();
    expect(runtime.services).toBeNull();
    await expect(runtime.init()).rejects.toThrow(/disposed/);
  });

  it('pushes a project .codex/skills dir into the loader via extendResources on init', async () => {
    const cwd = tempDir('pi-codex-');
    makeSkill(cwd, '.codex/skills', 'demo');

    const extendResources = vi.fn();
    H.createServicesSpy.mockResolvedValue({ ...fakeServices(), resourceLoader: { extendResources, reload: vi.fn(async () => undefined) } });

    const runtime = PiRuntime.get(cwd, '/agent');
    await runtime.init();

    expect(extendResources).toHaveBeenCalled();
    expect(skillPathsOf(extendResources)).toContain(path.join(cwd, '.codex', 'skills'));
  });

  it('ranks a project .damocles/skills dir above the .claude and .codex ones', async () => {
    const cwd = tempDir('pi-damocles-');
    makeSkill(cwd, '.damocles/skills', 'demo');
    makeSkill(cwd, '.claude/skills', 'demo');
    makeSkill(cwd, '.codex/skills', 'demo');

    const extendResources = vi.fn();
    H.createServicesSpy.mockResolvedValue({ ...fakeServices(), resourceLoader: { extendResources, reload: vi.fn(async () => undefined) } });

    const runtime = PiRuntime.get(cwd, '/agent');
    await runtime.init();

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
    H.createServicesSpy.mockResolvedValue({ ...fakeServices(), resourceLoader: { extendResources, reload: vi.fn(async () => undefined) } });

    const runtime = PiRuntime.get(cwd, '/agent');
    await runtime.init();

    const paths = skillPathsOf(extendResources);
    expect(paths.filter((p) => p.startsWith(cwd))).toEqual([]);
    expect(paths).toContain(path.join(H.home, '.damocles', 'skills'));
    expect(paths).toContain(path.join(H.home, '.claude', 'skills'));
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

    const runtime = PiRuntime.get(cwd, '/agent');
    const probe = trackLoader(runtime);
    await runtime.init();

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

    const runtime = PiRuntime.get(cwd, '/agent');
    const probe = trackLoader(runtime);
    await runtime.init();

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

    const runtime = PiRuntime.get(cwd, '/agent');
    const probe = trackLoader(runtime);
    await runtime.init();
    expect(registeredCount(runtime)).toBe(1);

    setTrusted(true);
    __trustEmitter.fire();
    await vi.waitFor(() => expect(probe.extendCalls).toBe(1));

    runtime.republishToolSearch();
    expect(probe.fired).toEqual(['instance-2']);
    expect(registeredCount(runtime)).toBe(1);

    // A second grant-driven reload has to retire instance-2 in turn, which it can only do if the
    // first one was adopted rather than stranded.
    probe.fired.length = 0;
    __trustEmitter.fire();
    await vi.waitFor(() => expect(probe.extendCalls).toBe(2));

    runtime.republishToolSearch();
    expect(probe.fired).toEqual(['instance-3']);
    expect(registeredCount(runtime)).toBe(1);
  });

  it('disposes the trust listener, so a granted trust cannot reload a disposed runtime', async () => {
    const runtime = PiRuntime.get('/cwd', '/agent');
    await runtime.init();
    expect(__trustEmitter.cbs.length).toBeGreaterThan(0);

    await PiRuntime.disposeInstance();

    expect(__trustEmitter.cbs).toEqual([]);
  });

  // VS Code reports no event from a bare glob string outside the opened workspace folders, so a
  // user-scope watcher registered that way never fires and the edit only lands on the next reload.
  it('anchors every user-scope asset watcher on a Uri and registers no bare glob', async () => {
    const cwd = tempDir('pi-watchers-');
    const runtime = PiRuntime.get(cwd, '/agent');
    await runtime.init();

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
