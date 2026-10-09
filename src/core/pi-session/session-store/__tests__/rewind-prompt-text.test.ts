import { describe, it, expect, vi } from 'vitest';
import { formatTerminalAttachmentBlock } from '../../../terminal-attachment';
import { formatIdeContextBlock } from '../../../../shared/ide-context';
import { DAMOCLES_TERMINAL_ATTACHMENTS_ENTRY } from '../constants';

const H = vi.hoisted(() => ({ branch: [] as unknown[] }));

vi.mock('../../pi-loader', () => ({
  initPiLoader: async () => ({
    SessionManager: {
      open: () => ({ getLeafId: () => 'leaf', getBranch: () => H.branch, getEntries: () => H.branch }),
    },
  }),
}));
vi.mock('../reading', () => ({ resolvePiSessionFile: async () => '/sessions/--ws--/s1.jsonl' }));
vi.mock('../session-dir', () => ({ ensurePiSessionDir: () => '/sessions/--ws--' }));
vi.mock('../../checkpoints', async (importOriginal) => {
  const records = (branch: Array<{ customType?: string; data?: { kind?: string } }>, kind: string | undefined) =>
    branch.filter((entry) => entry.customType === 'damocles-checkpoint' && entry.data?.kind === kind).map((entry) => entry.data);
  return {
    ...(await importOriginal<typeof import('../../checkpoints')>()),
    getCheckpointEntries: (branch: never) => records(branch, undefined),
    getNotRewindableEntries: (branch: never) => records(branch, 'not-rewindable'),
    getPreRewindEntries: () => [],
    execSafe: async () => ({ ok: false, error: 'no git here' }),
  };
});
vi.mock('../../../logger', () => ({ log: vi.fn() }));

import { getPiRewindHistory } from '../rewind';

const block = formatTerminalAttachmentBlock({ source: 'command', commandLine: 'npm test', exitCode: 1, terminalTitle: 'pwsh', text: 'FAIL a.test.ts', omittedLines: 0 });
const ide = formatIdeContextBlock({ type: 'opened_file', filePath: '/ws/a.ts' });
const user = (id: string, text: string) => ({ type: 'message', id, timestamp: '2026-10-08T10:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text }] } });
const attachments = (userEntryId: string) => ({ type: 'custom', id: `ta-${userEntryId}`, customType: DAMOCLES_TERMINAL_ATTACHMENTS_ENTRY, data: { userEntryId, count: 1 } });
const createdAt = '2026-10-08T10:00:00.000Z';

describe('rewind rows of a prompt sent with terminal attachments and no recorded original input', () => {
  H.branch = [
    user('u1', `${block}\nfirst typed`),
    attachments('u1'),
    { type: 'custom', id: 'cp-1', customType: 'damocles-checkpoint', data: { v: 2, userEntryId: 'u1', prompt: `${block}\nfirst typed`, beforeCommit: 'a'.repeat(40), fileChanges: [], createdAt } },
    user('u2', `${block}\n${ide}\nsecond typed`),
    attachments('u2'),
    { type: 'custom', id: 'nr-2', customType: 'damocles-checkpoint', data: { v: 3, kind: 'not-rewindable', userEntryId: 'u2', reason: 'baseline-timeout', params: {}, createdAt } },
  ];

  it('show the typed text on checkpoint and not-rewindable rows', async () => {
    const { items } = await getPiRewindHistory('/ws', 's1', 1024);
    expect(Object.fromEntries(items.map((item) => [item.messageId, item.content]))).toEqual({ u1: 'first typed', u2: 'second typed' });
  });

  it('show the typed text on the rows of a chat with no file checkpoints', async () => {
    const { items } = await getPiRewindHistory('/ws', 's1', 1024, false);
    expect(Object.fromEntries(items.map((item) => [item.messageId, item.content]))).toEqual({ u1: 'first typed', u2: 'second typed' });
  });
});
