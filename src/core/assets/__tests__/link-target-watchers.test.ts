import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakePlatform, type FakePlatform } from '../../../__mocks__/fake-platform';
import { DRIVE_ANSWER_TTL_MS } from '../../local-links';
import { LinkTargetWatchers } from '../link-target-watchers';

const ROOT = path.sep === '\\' ? 'C:\\clone' : '/clone';
const at = (...parts: string[]): string => path.join(ROOT, ...parts);

let platform: FakePlatform;

beforeEach(() => {
  platform = installFakePlatform();
});

function live(): string[] {
  return platform.fileWatchers.watchers.filter((watcher) => !watcher.disposed).map((watcher) => `${watcher.base}|${watcher.glob}`);
}

describe('LinkTargetWatchers', () => {
  it('watches every file target of one folder with one shallow watch, reporting only those files', () => {
    const onChange = vi.fn();
    const watchers = new LinkTargetWatchers(platform.fileWatchers, onChange);

    watchers.sync([{ base: ROOT, files: [at('pickup.md')] }, { base: ROOT, files: [at('drop.md')] }]);

    expect(live()).toEqual([`${ROOT}|*`]);
    const watcher = platform.fileWatchers.watcher(ROOT, '*');
    watcher.fireChange(at('other.md'));
    expect(onChange).not.toHaveBeenCalled();
    watcher.fireDelete(at('pickup.md'));
    watcher.fireCreate(at('drop.md'));
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('reports every change a folder target\'s glob matches', () => {
    const onChange = vi.fn();
    const watchers = new LinkTargetWatchers(platform.fileWatchers, onChange);

    watchers.sync([{ base: at('commands'), glob: '*.md' }]);
    platform.fileWatchers.watcher(at('commands'), '*.md').fireChange(at('commands', 'a.md'));

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('keeps a watch a later sync still names, adds new ones and drops the rest', () => {
    const watchers = new LinkTargetWatchers(platform.fileWatchers, () => undefined);
    watchers.sync([{ base: at('a'), glob: '*.md' }, { base: at('b'), glob: '*.md' }]);
    const kept = platform.fileWatchers.watcher(at('a'), '*.md');

    watchers.sync([{ base: at('a'), glob: '*.md' }, { base: at('c'), files: [at('c', 'x.md')] }]);

    expect(live().sort()).toEqual([`${at('a')}|*.md`, `${at('c')}|*`].sort());
    expect(kept.disposed).toBe(false);
    expect(platform.fileWatchers.watchers).toHaveLength(3);
  });

  it('follows a changed file set of a folder it keeps watching', () => {
    const onChange = vi.fn();
    const watchers = new LinkTargetWatchers(platform.fileWatchers, onChange);
    watchers.sync([{ base: ROOT, files: [at('a.md')] }]);
    watchers.sync([{ base: ROOT, files: [at('b.md')] }]);
    const watcher = platform.fileWatchers.watcher(ROOT, '*');

    watcher.fireChange(at('a.md'));
    expect(onChange).not.toHaveBeenCalled();
    watcher.fireChange(at('b.md'));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('fires once for a retry target after the drive probe\'s answer expired, and not for one a later sync drops or after a dispose', () => {
    vi.useFakeTimers();
    try {
      const onChange = vi.fn();
      const watchers = new LinkTargetWatchers(platform.fileWatchers, onChange);

      watchers.sync([{ retry: true }]);
      vi.advanceTimersByTime(DRIVE_ANSWER_TTL_MS / 2);
      watchers.sync([{ retry: true }]);
      vi.advanceTimersByTime(DRIVE_ANSWER_TTL_MS / 2 - 1);
      expect(onChange).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onChange).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(10 * DRIVE_ANSWER_TTL_MS);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(live()).toEqual([]);

      watchers.sync([{ retry: true }]);
      watchers.sync([]);
      vi.advanceTimersByTime(DRIVE_ANSWER_TTL_MS);
      watchers.sync([{ retry: true }]);
      watchers.dispose();
      vi.advanceTimersByTime(DRIVE_ANSWER_TTL_MS);
      expect(onChange).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('calls its own retry callback, when given one, instead of the change callback', () => {
    vi.useFakeTimers();
    try {
      const onChange = vi.fn();
      const onRetry = vi.fn();
      const watchers = new LinkTargetWatchers(platform.fileWatchers, onChange, onRetry);

      watchers.sync([{ base: ROOT, files: [at('pickup.md')] }, { retry: true }]);
      vi.advanceTimersByTime(DRIVE_ANSWER_TTL_MS);
      platform.fileWatchers.watcher(ROOT, '*').fireChange(at('pickup.md'));

      expect([onRetry.mock.calls.length, onChange.mock.calls.length]).toEqual([1, 1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disposes every watch and ignores a later sync', () => {
    const watchers = new LinkTargetWatchers(platform.fileWatchers, () => undefined);
    watchers.sync([{ base: ROOT, glob: '*.md' }]);

    watchers.dispose();
    watchers.sync([{ base: at('later'), glob: '*.md' }]);

    expect(live()).toEqual([]);
  });
});
