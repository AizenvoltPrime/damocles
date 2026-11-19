import { describe, it, expect, vi } from 'vitest';
import { DiffManager } from '../diff-manager';
import type { DiffView, EditorService } from '../../../platform/editor-service';
import { diffService } from '../../diff';

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
    const manager = new DiffManager(editorWith(views), 'host-1', () => null, diffService());
    for (const id of ['a', 'b', 'c']) await manager.showDiffView(id, '/tmp/x.txt', 'old', 'new');

    await expect(manager.dispose()).resolves.toBeUndefined();
    expect(closed.sort()).toEqual(['a', 'c']);
  });

  it('forgets a view whose close failed, so a later close does not retry it', async () => {
    const close = vi.fn(async () => { throw new Error('gone'); });
    const manager = new DiffManager(editorWith([{ close }]), 'host-1', () => null, diffService());
    await manager.showDiffView('a', '/tmp/x.txt', 'old', 'new');

    await expect(manager.closeDiffView('a')).resolves.toBeUndefined();
    await manager.dispose();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('opens no view after it', async () => {
    const showDiff = vi.fn(async (): Promise<DiffView> => ({ close: async () => undefined }));
    const manager = new DiffManager({ showDiff } as unknown as EditorService, 'host-1', () => null, diffService());

    await manager.dispose();
    await manager.showDiffView('a', '/tmp/x.txt', 'old', 'new');

    expect(showDiff).not.toHaveBeenCalled();
  });

  it('closes a view the host opens while it runs', async () => {
    let open!: (view: DiffView) => void;
    const editor = { showDiff: () => new Promise<DiffView>((resolve) => (open = resolve)) } as unknown as EditorService;
    const close = vi.fn(async () => undefined);
    const manager = new DiffManager(editor, 'host-1', () => null, diffService());

    const showing = manager.showDiffView('a', '/tmp/x.txt', 'old', 'new');
    await manager.dispose();
    open({ close });
    await showing;

    expect(close).toHaveBeenCalledTimes(1);
  });
});
