import { describe, it, expect, vi } from 'vitest';

const H = vi.hoisted(() => ({
  exec: vi.fn(async (..._args: unknown[]) => ({ stdout: 'before\n', bytes: Buffer.from('before\n'), stderr: '' })),
}));

vi.mock('../../pi-loader', () => ({
  initPiLoader: async () => ({
    SessionManager: {
      open: () => ({
        getLeafId: () => 'leaf',
        getBranch: () => [{ type: 'custom', customType: 'damocles-checkpoint', data: { userEntryId: 'u1', beforeCommit: 'a'.repeat(40) } }],
      }),
    },
  }),
}));
vi.mock('../reading', () => ({ resolvePiSessionFile: async () => '/sessions/--ws--/s1.jsonl' }));
vi.mock('../session-dir', () => ({ ensurePiSessionDir: () => '/sessions/--ws--' }));
vi.mock('../../checkpoints', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../checkpoints')>()),
  getCheckpointEntries: (branch: Array<{ data: unknown }>) => branch.map((entry) => entry.data),
}));
vi.mock('../../checkpoints/exec', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../checkpoints/exec')>()),
  exec: H.exec,
}));
vi.mock('../../../logger', () => ({ log: vi.fn() }));

import { getPiFileCheckpointContent } from '../rewind';
import { PORTABLE_CONFIG } from '../../checkpoints';

describe('getPiFileCheckpointContent', () => {
  // A deep checkpoint repo passes Windows' 260-character path limit; without longpaths git reports the file absent.
  it('reads the checkpoint text with the preview git config (long paths, no EOL conversion)', async () => {
    const content = await getPiFileCheckpointContent('/ws', 's1', 'u1', '/ws/src/a.ts');

    expect(content).toBe('before\n');
    const args = H.exec.mock.calls[0]?.[1] as string[];
    // The preview reads with the checkpoint repo's own config, so no user setting (global excludes, fsmonitor, filters) differs from a restore.
    expect(args.slice(0, PORTABLE_CONFIG.length)).toEqual([...PORTABLE_CONFIG]);
    expect(args).toEqual(expect.arrayContaining(['core.autocrlf=false', 'core.longpaths=true', 'core.excludesFile=']));
    expect(args.slice(-2)).toEqual(['show', `${'a'.repeat(40)}:src/a.ts`]);
  });
});
