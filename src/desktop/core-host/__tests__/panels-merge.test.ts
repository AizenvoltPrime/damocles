// A daemon's core panel hands its views to the panel holding its conversation by asking the daemon views.merge; a local core's
// panel, whose one device opens no second panel of a conversation, has no merge.
import { describe, expect, it } from 'vitest';
import type { CoreEndpoint } from '../../core-protocol';
import { createCorePanels } from '../platform/panels';

function proxies(merges: boolean) {
  const asked: unknown[] = [];
  const answers: Array<{ resolve: (merged: boolean) => void; reject: (err: Error) => void }> = [];
  const endpoint = {
    postPanel: () => undefined,
    request: (method: string, params: unknown) => {
      asked.push([method, params]);
      return new Promise<boolean>((resolve, reject) => answers.push({ resolve, reject }));
    },
    onPanel: () => ({ dispose: () => undefined }),
    onMirror: () => ({ dispose: () => undefined }),
    emit: () => undefined,
  } as unknown as CoreEndpoint;
  const panels = createCorePanels({ endpoint, resourceRoot: '/app', merges });
  return { panels, asked, answers };
}

describe('a core panel\'s merge into the panel holding its conversation', () => {
  it('asks the daemon views.merge with both views and settles with its answer', async () => {
    const { panels, asked, answers } = proxies(true);
    const holder = panels.attach('view-1');
    const duplicate = panels.attach('view-2');
    const merged = duplicate.mergeInto!(holder);
    expect(asked).toEqual([['views.merge', { viewId: 'view-2', into: 'view-1' }]]);
    answers[0]!.resolve(true);
    await expect(merged).resolves.toBe(true);
    const refused = duplicate.mergeInto!(holder);
    answers[1]!.resolve(false);
    await expect(refused).resolves.toBe(false);
  });

  it('settles as not merged when the daemon\'s answer fails, so the restore falls back to opening empty', async () => {
    const { panels, answers } = proxies(true);
    const merged = panels.attach('view-2').mergeInto!(panels.attach('view-1'));
    answers[0]!.reject(new Error('the connection closed'));
    await expect(merged).resolves.toBe(false);
  });

  it('asks nothing for a holder that is no panel of this core', async () => {
    const { panels, asked } = proxies(true);
    const elsewhere = createCorePanels({ endpoint: { onPanel: () => ({ dispose: () => undefined }), onMirror: () => ({ dispose: () => undefined }) } as unknown as CoreEndpoint, resourceRoot: '/app', merges: true }).attach('view-9');
    await expect(panels.attach('view-2').mergeInto!(elsewhere)).resolves.toBe(false);
    expect(asked).toEqual([]);
  });

  it('is absent on a local core', () => {
    const { panels } = proxies(false);
    expect(panels.attach('view-2').mergeInto).toBeUndefined();
  });
});
