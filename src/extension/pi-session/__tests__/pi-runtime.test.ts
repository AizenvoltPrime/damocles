import { describe, it, expect, afterEach } from 'vitest';
import { PiRuntime } from '../pi-runtime';
import { nodeSupportsPi, PI_MIN_NODE_MAJOR } from '../pi-loader';

describe('PiRuntime singleton (B1)', () => {
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  it('returns one shared instance regardless of get() arguments', () => {
    const a = PiRuntime.get('/tmp/workspace-a');
    const b = PiRuntime.get('/tmp/workspace-b');
    expect(a).toBe(b);
    expect(PiRuntime.exists).toBe(true);
  });

  it('disposeInstance clears the singleton so a fresh instance can be created', async () => {
    const a = PiRuntime.get('/tmp/workspace-a');
    await PiRuntime.disposeInstance();
    expect(PiRuntime.exists).toBe(false);
    const c = PiRuntime.get('/tmp/workspace-a');
    expect(c).not.toBe(a);
  });
});

describe('ToolSearch republishers', () => {
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  /** Reach the private set through the only seam that fills it, without widening the public API. */
  const publish = (runtime: PiRuntime, fn: () => void): void => {
    (runtime as unknown as { _toolSearchRepublishers: Set<() => void> })._toolSearchRepublishers.add(fn);
  };

  it('fires EVERY registered extension instance, not just the newest', () => {
    // `prepareSessionExtensions` reloads the resource loader per session, so each panel's session binds
    // its own extension instance while earlier panels keep theirs. A single-slot field held only the
    // last one, leaving every earlier panel's ToolSearch description frozen for the session's life —
    // silently, because that instance is live rather than stale.
    const runtime = PiRuntime.get('/tmp/ws');
    const fired: string[] = [];
    publish(runtime, () => fired.push('panelA'));
    publish(runtime, () => fired.push('panelB'));

    runtime.republishToolSearch();

    expect(fired).toEqual(['panelA', 'panelB']);
  });

  it('drops a retired instance whose runtime rejects the call, and still fires the live ones', () => {
    // pi's `assertActive` throws once an extension ctx is superseded. That throw is the ONLY signal the
    // closure is dead, so it must both prune and not abort the remaining republishers.
    const runtime = PiRuntime.get('/tmp/ws');
    const fired: string[] = [];
    publish(runtime, () => { throw new Error('extension context is no longer active'); });
    publish(runtime, () => fired.push('live'));

    runtime.republishToolSearch();
    expect(fired).toEqual(['live']);

    runtime.republishToolSearch();
    expect(fired).toEqual(['live', 'live']);
    const remaining = (runtime as unknown as { _toolSearchRepublishers: Set<() => void> })._toolSearchRepublishers;
    expect(remaining.size).toBe(1);
  });
});

describe('nodeSupportsPi (B5)', () => {
  it('reflects the running Node major against the pi minimum', () => {
    const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
    expect(nodeSupportsPi()).toBe(major >= PI_MIN_NODE_MAJOR);
  });
});
