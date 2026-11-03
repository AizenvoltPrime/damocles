import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplyRetry } from '../apply-retry';

describe('createApplyRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('attempts once per delay while each attempt fails, then gives up', async () => {
    const attempt = vi.fn();
    const retry = createApplyRetry('test', [10, 20], attempt);
    attempt.mockImplementation(() => retry.failed());

    retry.failed();
    await vi.advanceTimersByTimeAsync(9);
    expect(attempt).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(attempt).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('keeps one attempt pending however many failures arrive meanwhile', async () => {
    const attempt = vi.fn();
    const retry = createApplyRetry('test', [10, 20], attempt);
    retry.failed();
    retry.failed();
    await vi.advanceTimersByTimeAsync(100);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('starts the attempts over on a reset, which cancels the pending one', async () => {
    const attempt = vi.fn();
    const retry = createApplyRetry('test', [10], attempt);
    retry.failed();
    await vi.advanceTimersByTimeAsync(10);
    retry.failed();
    await vi.advanceTimersByTimeAsync(100);
    expect(attempt).toHaveBeenCalledTimes(1);

    retry.reset();
    retry.failed();
    retry.reset();
    await vi.advanceTimersByTimeAsync(100);
    expect(attempt).toHaveBeenCalledTimes(1);
    retry.failed();
    await vi.advanceTimersByTimeAsync(10);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('attempts nothing after dispose', async () => {
    const attempt = vi.fn();
    const retry = createApplyRetry('test', [10], attempt);
    retry.failed();
    retry.dispose();
    retry.failed();
    await vi.advanceTimersByTimeAsync(100);
    expect(attempt).not.toHaveBeenCalled();
  });
});
