import { describe, expect, it } from 'vitest';
import type { CoreEndpoint } from '../../core-protocol';
import { createForeignViews } from '../platform/foreign-views';

function views() {
  const emitted: unknown[] = [];
  const endpoint = { emit: (event: string, payload: unknown) => emitted.push([event, payload]) } as unknown as CoreEndpoint;
  return { foreign: createForeignViews(endpoint), emitted };
}

describe('foreign views (core side)', () => {
  it('posts a proxy\'s messages to main as panel.foreignPost with the remote view id', async () => {
    const { foreign, emitted } = views();
    const host = foreign.attach('loopback', 'view-1');
    await expect(host.postMessage({ type: 'transcriptionResult', text: 'hi' })).resolves.toBe(true);
    expect(emitted).toEqual([['panel.foreignPost', { viewId: 'view-1', message: { type: 'transcriptionResult', text: 'hi' } }]]);
  });

  it('keeps one proxy per view and refuses the same view id for another host', () => {
    const { foreign } = views();
    const host = foreign.attach('loopback', 'view-1');
    expect(foreign.attach('loopback', 'view-1')).toBe(host);
    expect(() => foreign.attach('ssh+other', 'view-1')).toThrow('another host');
    expect(foreign.get('view-1')).toBe(host);
  });

  it('posts nothing once detached, and loads no page or resource of this computer', async () => {
    const { foreign, emitted } = views();
    const host = foreign.attach('loopback', 'view-1');
    let disposed = false;
    host.onDispose(() => {
      disposed = true;
    });
    expect(() => host.setHtml('<p>')).toThrow();
    expect(() => host.asResourceUri('/etc/passwd')).toThrow();
    foreign.detach('view-1');
    expect(disposed).toBe(true);
    expect(foreign.get('view-1')).toBeUndefined();
    await expect(host.postMessage({ type: 'transcriptionResult', text: 'late' })).resolves.toBe(false);
    expect(emitted).toEqual([]);
  });

  it('refuses a binary post, which cannot cross to a remote view', () => {
    const { foreign } = views();
    const host = foreign.attach('loopback', 'view-1');
    expect(() => host.postMessage({ type: 'frame', data: new Uint8Array(2) })).toThrow('binary');
  });
});
