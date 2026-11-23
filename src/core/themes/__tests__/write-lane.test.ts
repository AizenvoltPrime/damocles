import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { lock } = vi.hoisted(() => ({ lock: vi.fn() }));
vi.mock('proper-lockfile', () => ({ lock }));

import { LocalizedError } from '../../../shared/localized-text';
import { writeFileAtomic } from '../store';
import { createWriteLane } from '../write-lane';

let root: string;
let compromise: (err: Error) => void;
let release: ReturnType<typeof vi.fn>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-write-lane-'));
  release = vi.fn(async () => undefined);
  lock.mockReset();
  lock.mockImplementation(async (_folder: string, options: { onCompromised: (err: Error) => void }) => {
    compromise = options.onCompromised;
    return release;
  });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the theme store\'s write lane', () => {
  it('stops a change at its next write once the lock is lost, and the next run starts with its own lock', async () => {
    const lane = createWriteLane(root);
    const first = path.join(root, 'first.json');
    const second = path.join(root, 'second.json');
    const run = lane.run(async () => {
      await writeFileAtomic(first, 'one', { held: lane.held });
      compromise(new Error('the lock was taken over'));
      await writeFileAtomic(second, 'two', { held: lane.held });
    });
    const lost = await run.then(() => undefined, (err: unknown) => err);
    expect(lost).toBeInstanceOf(LocalizedError);
    expect((lost as LocalizedError).text.message).toBe('The lock on the theme folder was lost, so the change stopped before its next write. Try again.');
    expect(fs.readdirSync(root)).toEqual(['first.json']);
    expect(release).not.toHaveBeenCalled();
    await lane.run(async () => writeFileAtomic(second, 'two', { held: lane.held }));
    expect(fs.readFileSync(second, 'utf8')).toBe('two');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('answers what the change answered when the lock cannot be released, and says so in the log', async () => {
    release.mockRejectedValue(new Error('ENOENT: the lock folder is gone'));
    const lines: string[] = [];
    const lane = createWriteLane(root, (line) => lines.push(line));
    expect(await lane.run(async () => 'made')).toBe('made');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('the lock folder is gone');
    await expect(lane.run(async () => {
      throw new Error('the change failed');
    })).rejects.toThrow('the change failed');
    expect(await lane.run(async () => 'next')).toBe('next');
  });

  it('refuses in words a user can read when the lock cannot be taken', async () => {
    const lane = createWriteLane(root);
    lock.mockRejectedValueOnce(Object.assign(new Error('Lock file is already being held'), { code: 'ELOCKED' }));
    const held = await lane.run(async () => 'never').then(() => undefined, (err: unknown) => err);
    expect(held).toBeInstanceOf(LocalizedError);
    expect((held as LocalizedError).text).toEqual({ message: 'Another Damocles is changing the themes. Try again in a moment.' });
    lock.mockRejectedValueOnce(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
    const denied = await lane.run(async () => 'never').then(() => undefined, (err: unknown) => err);
    expect((denied as LocalizedError).text.message).toBe('Damocles could not lock the theme folder: {0}');
  });
});
