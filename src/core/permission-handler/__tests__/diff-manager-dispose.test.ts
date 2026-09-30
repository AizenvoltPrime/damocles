import { describe, it, expect, vi } from 'vitest';
import { DiffManager } from '../diff-manager';
import type { DiffView, EditorService } from '../../../platform/editor-service';

vi.mock('../../logger', () => ({ log: vi.fn() }));

function editorWith(views: DiffView[]): EditorService {
  let next = 0;
  return { showDiff: async () => views[next++]! } as unknown as EditorService;
}

describe('DiffManager.dispose', () => {
  it('closes every view even when one close fails, and never rejects', async () => {
    const closed: string[] = [];
    const views: DiffView[] = [
      { close: async () => { closed.push('a'); } },
      { close: async () => { throw new Error('host closed the view first'); } },
      { close: async () => { closed.push('c'); } },
    ];
    const manager = new DiffManager(editorWith(views), 'host-1');
    for (const id of ['a', 'b', 'c']) await manager.showDiffView(id, '/tmp/x.txt', 'old', 'new');

    await expect(manager.dispose()).resolves.toBeUndefined();
    expect(closed.sort()).toEqual(['a', 'c']);
  });

  it('forgets a view whose close failed, so a later close does not retry it', async () => {
    const close = vi.fn(async () => { throw new Error('gone'); });
    const manager = new DiffManager(editorWith([{ close }]), 'host-1');
    await manager.showDiffView('a', '/tmp/x.txt', 'old', 'new');

    await expect(manager.closeDiffView('a')).resolves.toBeUndefined();
    await manager.dispose();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
