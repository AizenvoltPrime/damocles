import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceAgentRegistry } from '../workspace-agent-registry';
import { DEFAULT_AGENT_NAMES } from '../types';
import type { ParseFrontmatter } from '../custom-agents';
import { createFakePlatform, type FakePlatform } from '../../../../__mocks__/fake-platform';
import { installLogSink } from '../../../logger';

// While held is set, each load finishes reading and then waits for its release, so a test settles overlapping loads in any order.
const H = vi.hoisted(() => ({ held: null as null | Array<{ readonly includeProjectScope: boolean; readonly release: () => void }> }));

vi.mock('../custom-agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../custom-agents')>();
  return {
    ...actual,
    loadCustomAgents: async (...args: Parameters<typeof actual.loadCustomAgents>) => {
      const loaded = await actual.loadCustomAgents(...args);
      const held = H.held;
      if (held !== null) await new Promise<void>((release) => held.push({ includeProjectScope: args[2].includeProjectScope, release }));
      return loaded;
    },
  };
});

/** Minimal YAML-ish frontmatter parser for the tests (key: value, with bool/number coercion). */
const parseFrontmatter: ParseFrontmatter = ((content: string) => {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
  const fm: Record<string, unknown> = {};
  if (m?.[1] !== undefined) {
    for (const line of m[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const raw = line.slice(idx + 1).trim();
      fm[key] = raw === 'true' ? true : raw === 'false' ? false : /^-?\d+$/.test(raw) ? Number(raw) : raw;
    }
  }
  return { frontmatter: fm, body: m ? m[2] : content };
}) as ParseFrontmatter;

let cwd: string;
let home: string;
let registry: WorkspaceAgentRegistry | null = null;
let fake: FakePlatform;

function writeAgentAt(base: string, dir: string, name: string, frontmatter: string, body = 'BODY'): void {
  mkdirSync(join(base, dir), { recursive: true });
  writeFileSync(join(base, dir, `${name}.md`), `---\n${frontmatter}\n---\n${body}`);
}

function writeAgent(dir: string, name: string, frontmatter: string, body = 'BODY'): void {
  writeAgentAt(cwd, dir, name, frontmatter, body);
}

/** Construct, then wait for the first load to register its agents. */
async function loadedRegistry(): Promise<WorkspaceAgentRegistry> {
  const reg = makeRegistry();
  await reg.whenLoaded();
  return reg;
}

/** Construct with the test's isolated home dir so real `~/.claude/agents` is never scanned. */
function makeRegistry(): WorkspaceAgentRegistry {
  registry = new WorkspaceAgentRegistry(cwd, parseFrontmatter, fake.trust, fake.fileWatchers, { homeDir: home });
  return registry;
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'damocles-ws-agents-'));
  home = mkdtempSync(join(tmpdir(), 'damocles-ws-home-'));
  fake = createFakePlatform();
});
afterEach(() => {
  for (const load of H.held ?? []) load.release();
  H.held = null;
  registry?.dispose();
  registry = null;
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('WorkspaceAgentRegistry', () => {
  it('exposes the embedded default agents', async () => {
    const names = (await loadedRegistry()).getRegistry().getAllTypes();
    for (const name of DEFAULT_AGENT_NAMES) expect(names).toContain(name);
  });

  it('merges project markdown agents in when the workspace is trusted', async () => {
    fake.trust.setTrusted(true);
    writeAgent('.pi/agents', 'Reviewer', 'description: Reviews code');
    const config = (await loadedRegistry()).getRegistry().getAgentConfig('Reviewer');
    expect(config?.description).toBe('Reviews code');
    expect(config?.source).toBe('project-pi');
  });

  it('trust-gates project markdown agents out when the workspace is untrusted', async () => {
    fake.trust.setTrusted(false);
    writeAgent('.pi/agents', 'Secret', 'description: untrusted');
    expect((await loadedRegistry()).getRegistry().getAgentConfig('Secret')).toBeUndefined();
    // The embedded defaults are still present (trust gates only project scope).
    for (const name of DEFAULT_AGENT_NAMES) expect(registry!.getRegistry().getAllTypes()).toContain(name);
  });

  it('loads global agents (nested ~/.claude/agents) regardless of trust', async () => {
    fake.trust.setTrusted(false);
    writeAgentAt(home, '.claude/agents/engineering', 'engineering-ai', 'name: AI Engineer\ndescription: builds AI');
    const config = (await loadedRegistry()).getRegistry().getAgentConfig('AI Engineer');
    expect(config?.description).toBe('builds AI');
    expect(config?.source).toBe('global');
  });

  it('watches every discovery dir, including both .damocles dirs, from its network-rule base', async () => {
    makeRegistry();

    // A workspace glob reports no events from a directory outside the workspace folders, so every global dir has its own
    // watcher; each names its scope root as base, so the watcher factory judges a link on the dir's path by the network rule.
    expect(fake.fileWatchers.watchers.map((w) => [w.base, w.glob])).toEqual([
      [home, '.claude/agents/**'],
      [home, '.pi/agent/agents/**'],
      [join(home, '.damocles'), 'agents/**'],
      [cwd, '.claude/agents/**'],
      [cwd, '.pi/agents/**'],
      [cwd, '.damocles/agents/**'],
    ]);
  });

  it('merges .damocles project agents in when the workspace is trusted', async () => {
    fake.trust.setTrusted(true);
    writeAgent('.damocles/agents', 'Reviewer', 'description: Reviews code');
    const config = (await loadedRegistry()).getRegistry().getAgentConfig('Reviewer');
    expect(config?.description).toBe('Reviews code');
    expect(config?.source).toBe('project-damocles');
  });

  it('trust-gates .damocles project agents out when the workspace is untrusted', async () => {
    fake.trust.setTrusted(false);
    writeAgent('.damocles/agents', 'Reviewer', 'description: Reviews code');
    expect((await loadedRegistry()).getRegistry().getAgentConfig('Reviewer')).toBeUndefined();
  });

  it('surfaces project agents when the user grants trust, with no window reload', async () => {
    fake.trust.setTrusted(false);
    writeAgent('.damocles/agents', 'Reviewer', 'description: Reviews code');
    const reg = await loadedRegistry();
    expect(reg.getRegistry().getAgentConfig('Reviewer')).toBeUndefined();

    fake.trust.grantTrust([cwd]);
    await reg.whenLoaded();
    expect(reg.getRegistry().getAgentConfig('Reviewer')?.description).toBe('Reviews code');
  });

  it('stops reloading on a trust grant once disposed', async () => {
    fake.trust.setTrusted(false);
    writeAgent('.damocles/agents', 'Reviewer', 'description: Reviews code');
    const reg = await loadedRegistry();
    reg.dispose();
    registry = null;

    fake.trust.grantTrust([cwd]);
    await reg.whenLoaded();

    expect(reg.getRegistry().getAgentConfig('Reviewer')).toBeUndefined();
  });

  it('registers only the latest of two overlapping loads: a grant then a revoke ends with no project agent', async () => {
    fake.trust.setTrusted(false);
    writeAgent('.damocles/agents', 'Reviewer', 'description: Reviews code');
    const reg = await loadedRegistry();
    H.held = [];
    fake.trust.grantTrust([cwd]);
    fake.trust.revokeTrust([cwd]);
    await vi.waitFor(() => expect(H.held).toHaveLength(2));
    const granted = H.held.find((load) => load.includeProjectScope)!;
    const revoked = H.held.find((load) => !load.includeProjectScope)!;

    revoked.release();
    await reg.whenLoaded();
    granted.release();
    await new Promise((resolve) => setImmediate(resolve));

    expect(reg.getRegistry().getAgentConfig('Reviewer')).toBeUndefined();
  });

  it('registers no project agent from a trusted load that lands after a revoke started the next load', async () => {
    fake.trust.setTrusted(false);
    writeAgent('.damocles/agents', 'Reviewer', 'description: Reviews code');
    const reg = await loadedRegistry();
    H.held = [];
    fake.trust.grantTrust([cwd]);
    fake.trust.revokeTrust([cwd]);
    await vi.waitFor(() => expect(H.held).toHaveLength(2));

    H.held.find((load) => load.includeProjectScope)!.release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(reg.getRegistry().getAgentConfig('Reviewer')).toBeUndefined();
    H.held.find((load) => !load.includeProjectScope)!.release();
    await reg.whenLoaded();

    expect(reg.getRegistry().getAgentConfig('Reviewer')).toBeUndefined();
  });

  // Readers that do not wait for the reload (a queued spawn's start, a new session's tool list) read the registry as it is.
  it('withdraws the project agents the moment trust is revoked, before the reload lands, restoring a user agent one shadowed, and tells its listeners', async () => {
    fake.trust.setTrusted(true);
    writeAgent('.damocles/agents', 'Reviewer', 'description: Reviews code');
    writeAgentAt(home, '.claude/agents', 'Global', 'description: everywhere');
    writeAgent('.claude/agents', 'Explore', 'description: the project\'s own Explore');
    writeAgentAt(home, '.claude/agents', 'Shared', 'description: the user\'s');
    writeAgent('.damocles/agents', 'Shared', 'description: the project\'s');
    const reg = await loadedRegistry();
    expect(reg.getRegistry().getAgentConfig('Explore')?.source).toBe('project-claude');
    expect(reg.getRegistry().getAgentConfig('Shared')?.description).toBe('the project\'s');
    const changes = vi.fn();
    reg.onChange(changes);
    H.held = [];

    fake.trust.revokeTrust([cwd]);

    expect(reg.getRegistry().getAgentConfig('Reviewer')).toBeUndefined();
    expect(reg.getRegistry().getAgentConfig('Explore')?.isDefault).toBe(true);
    expect(reg.getRegistry().getAgentConfig('Global')?.description).toBe('everywhere');
    expect(reg.getRegistry().getAgentConfig('Shared')?.description).toBe('the user\'s');
    expect(changes).toHaveBeenCalledTimes(1);
  });

  // A burst of reloads, each started before the last settles, must not hold a reader back until the burst ends.
  it('settles a wait once a load started no earlier than the newest one before it registered, while a later load is still in flight', async () => {
    fake.trust.setTrusted(false);
    writeAgent('.damocles/agents', 'Reviewer', 'description: Reviews code');
    const reg = await loadedRegistry();
    H.held = [];
    fake.trust.grantTrust([cwd]);
    await vi.waitFor(() => expect(H.held).toHaveLength(1));
    let settled = false;
    void reg.whenLoaded().then(() => { settled = true; });
    fake.trust.grantTrust([cwd]);
    await vi.waitFor(() => expect(H.held).toHaveLength(2));

    H.held[0]!.release();
    await vi.waitFor(() => expect(settled).toBe(true));

    expect(reg.getRegistry().getAgentConfig('Reviewer')?.description).toBe('Reviews code');
  });

  it('keeps notifying after a listener throws, logs the failure, and still settles the load', async () => {
    const lines: string[] = [];
    installLogSink({ appendLine: (line) => lines.push(line), show: () => undefined, dispose: () => undefined });
    fake.trust.setTrusted(false);
    writeAgent('.damocles/agents', 'Reviewer', 'description: Reviews code');
    const reg = await loadedRegistry();
    const after = vi.fn();
    reg.onChange(() => { throw new Error('listener boom'); });
    reg.onChange(after);

    fake.trust.grantTrust([cwd]);
    await reg.whenLoaded();

    expect(after).toHaveBeenCalledTimes(1);
    expect(reg.getRegistry().getAgentConfig('Reviewer')?.description).toBe('Reviews code');
    expect(lines.some((line) => line.includes('[WorkspaceAgentRegistry] a change listener failed') && line.includes('listener boom'))).toBe(true);
  });

  it('settles and registers a load whose link targets cannot be watched, and logs why', async () => {
    const lines: string[] = [];
    installLogSink({ appendLine: (line) => lines.push(line), show: () => undefined, dispose: () => undefined });
    const outside = mkdtempSync(join(tmpdir(), 'damocles-ws-outside-'));
    try {
      writeAgentAt(outside, 'agents', 'eng', 'name: Eng\ndescription: linked');
      mkdirSync(join(home, '.claude', 'agents'), { recursive: true });
      symlinkSync(join(outside, 'agents'), join(home, '.claude', 'agents', 'eng'), process.platform === 'win32' ? 'junction' : 'dir');
      const target = realpathSync.native(join(outside, 'agents'));
      const watch = fake.fileWatchers.watch.bind(fake.fileWatchers);
      vi.spyOn(fake.fileWatchers, 'watch').mockImplementation((base, glob) => {
        if (base === target) throw new Error('watch refused');
        return watch(base, glob);
      });

      const reg = await loadedRegistry();

      expect(reg.getRegistry().getAgentConfig('Eng')?.description).toBe('linked');
      expect(lines.some((line) => line.includes('[WorkspaceAgentRegistry] watching the link targets of a load failed') && line.includes('watch refused'))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  // A linked subfolder has no .md suffix, and no recursive watch enters a link, so only its own entry's events reload the registry.
  it('reloads when a linked agents subfolder is made, re-pointed or removed', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'damocles-ws-outside-'));
    const agents = join(home, '.claude', 'agents');
    const link = join(agents, 'eng');
    const linkTo = (folder: string): void => symlinkSync(join(outside, folder), link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      writeAgentAt(outside, 'one', 'eng', 'name: Eng\ndescription: one');
      writeAgentAt(outside, 'two', 'eng', 'name: Eng\ndescription: two');
      mkdirSync(agents, { recursive: true });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const reg = await loadedRegistry();
      const fire = async (event: 'fireCreate' | 'fireChange' | 'fireDelete'): Promise<void> => {
        for (const watcher of fake.fileWatchers.watchers.filter((w) => !w.disposed && w.base === home)) watcher[event](link);
        await vi.advanceTimersByTimeAsync(1000);
        await reg.whenLoaded();
      };
      const description = (): string | undefined => reg.getRegistry().getAgentConfig('Eng')?.description;
      linkTo('one');
      await fire('fireCreate');
      expect(description()).toBe('one');

      unlinkSync(link);
      linkTo('two');
      await fire('fireChange');
      expect(description()).toBe('two');

      unlinkSync(link);
      await fire('fireDelete');
      expect(description()).toBeUndefined();
    } finally {
      vi.useRealTimers();
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reloads when a followed link target changes', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'damocles-ws-outside-'));
    try {
      writeAgentAt(outside, 'agents', 'eng', 'name: Eng\ndescription: before');
      mkdirSync(join(home, '.claude', 'agents'), { recursive: true });
      symlinkSync(join(outside, 'agents'), join(home, '.claude', 'agents', 'eng'), process.platform === 'win32' ? 'junction' : 'dir');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const reg = await loadedRegistry();
      expect(reg.getRegistry().getAgentConfig('Eng')?.description).toBe('before');
      const target = fake.fileWatchers.watchers.find((w) => w.base === realpathSync.native(join(outside, 'agents')));
      expect(target).toBeDefined();

      writeAgentAt(outside, 'agents', 'eng', 'name: Eng\ndescription: after');
      target!.fireChange(join(realpathSync.native(join(outside, 'agents')), 'eng.md'));
      await vi.advanceTimersByTimeAsync(1000);
      await reg.whenLoaded();

      expect(reg.getRegistry().getAgentConfig('Eng')?.description).toBe('after');
    } finally {
      vi.useRealTimers();
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
