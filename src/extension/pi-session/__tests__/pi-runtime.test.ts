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

describe('nodeSupportsPi (B5)', () => {
  it('reflects the running Node major against the pi minimum', () => {
    const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
    expect(nodeSupportsPi()).toBe(major >= PI_MIN_NODE_MAJOR);
  });
});
