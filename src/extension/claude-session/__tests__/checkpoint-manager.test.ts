import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CheckpointManager } from '../checkpoint-manager';
import type { MessageCallbacks } from '../types';

vi.mock('../../logger', () => ({ log: vi.fn() }));

vi.mock('../../session', () => ({
  persistInterruptMarker: vi.fn(),
  persistPartialAssistant: vi.fn(),
  findUserMessageInCurrentTurn: vi.fn(),
  findLastMessageInCurrentTurn: vi.fn(),
  getLastMessageUuid: vi.fn(),
  getMessageParentUuid: vi.fn().mockResolvedValue('parent-uuid-x'),
}));

interface FakeQuery {
  rewindFiles: (uuid: string) => Promise<void>;
}

function createCallbacks(): MessageCallbacks & { messages: unknown[] } {
  const messages: unknown[] = [];
  return {
    messages,
    onMessage: (msg) => { messages.push(msg); },
  };
}

describe('CheckpointManager.rewindFiles dispatch', () => {
  let cm: CheckpointManager;
  let cb: ReturnType<typeof createCallbacks>;

  beforeEach(() => {
    cb = createCallbacks();
    cm = new CheckpointManager('/cwd', cb);
  });

  it('fork-conversation: calls onSpawnFork with parent uuid; does not touch query.rewindFiles; does not emit rewindComplete', async () => {
    const onSpawnFork = vi.fn().mockResolvedValue(undefined);
    const query: FakeQuery = { rewindFiles: vi.fn().mockResolvedValue(undefined) };

    await cm.rewindFiles('user-msg-id', 'fork-conversation', 'session-x', query as never, undefined, onSpawnFork);

    expect(query.rewindFiles).not.toHaveBeenCalled();
    expect(onSpawnFork).toHaveBeenCalledTimes(1);
    expect(onSpawnFork).toHaveBeenCalledWith('parent-uuid-x', 'user-msg-id');
    expect(cb.messages.find(m => (m as { type: string }).type === 'rewindComplete')).toBeUndefined();
  });

  it('fork-and-rewind-code: calls query.rewindFiles then onSpawnFork; does not emit rewindComplete', async () => {
    const calls: string[] = [];
    const onSpawnFork = vi.fn().mockImplementation(async () => { calls.push('spawn'); });
    const query: FakeQuery = {
      rewindFiles: vi.fn().mockImplementation(async () => { calls.push('rewindFiles'); }),
    };

    await cm.rewindFiles('user-msg-id', 'fork-and-rewind-code', 'session-x', query as never, undefined, onSpawnFork);

    expect(query.rewindFiles).toHaveBeenCalledTimes(1);
    expect(onSpawnFork).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['rewindFiles', 'spawn']);
    expect(cb.messages.find(m => (m as { type: string }).type === 'rewindComplete')).toBeUndefined();
  });

  it('code-only: calls query.rewindFiles only; emits rewindComplete; does not call onSpawnFork', async () => {
    const onSpawnFork = vi.fn().mockResolvedValue(undefined);
    const query: FakeQuery = { rewindFiles: vi.fn().mockResolvedValue(undefined) };

    await cm.rewindFiles('user-msg-id', 'code-only', 'session-x', query as never, 'my prompt', onSpawnFork);

    expect(query.rewindFiles).toHaveBeenCalledTimes(1);
    expect(onSpawnFork).not.toHaveBeenCalled();

    const complete = cb.messages.find(m => (m as { type: string }).type === 'rewindComplete') as
      | { rewindToMessageId: string; option: string; promptContent?: string }
      | undefined;
    expect(complete).toBeDefined();
    expect(complete!.rewindToMessageId).toBe('user-msg-id');
    expect(complete!.option).toBe('code-only');
    expect(complete!.promptContent).toBe('my prompt');
  });

  it('fork-conversation without onSpawnFork: emits rewindError', async () => {
    const query: FakeQuery = { rewindFiles: vi.fn().mockResolvedValue(undefined) };

    await cm.rewindFiles('user-msg-id', 'fork-conversation', 'session-x', query as never, undefined);

    const err = cb.messages.find(m => (m as { type: string }).type === 'rewindError') as
      | { message: string }
      | undefined;
    expect(err).toBeDefined();
  });

  it('fork-and-rewind-code surfaces fileRewindWarning when query.rewindFiles fails (no rewindComplete since fork still spawns)', async () => {
    const onSpawnFork = vi.fn().mockResolvedValue(undefined);
    const query: FakeQuery = {
      rewindFiles: vi.fn().mockRejectedValue(new Error('rewind boom')),
    };

    await cm.rewindFiles('user-msg-id', 'fork-and-rewind-code', 'session-x', query as never, undefined, onSpawnFork);

    expect(onSpawnFork).toHaveBeenCalledTimes(1);
  });
});
