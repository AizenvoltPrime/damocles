import { describe, it, expect, vi, afterEach } from 'vitest';
import { CLASSIFIER_PROBE_AFTER_MS, createClassifierBreakers, credentialRejectionOf } from '../classifier-breaker';

function breakersAt(start = 1_000_000) {
  let clock = start;
  const timers = new Set<{ at: number; run: () => void }>();
  const schedule = (run: () => void, ms: number): (() => void) => {
    const timer = { at: clock + ms, run };
    timers.add(timer);
    return () => void timers.delete(timer);
  };
  const breakers = createClassifierBreakers(() => clock, schedule);
  const changes = vi.fn();
  breakers.onChange(changes);
  const advance = (ms: number): void => {
    clock += ms;
    for (const timer of [...timers]) {
      if (timer.at > clock) continue;
      timers.delete(timer);
      timer.run();
    }
  };
  return { breakers, changes, advance, pendingTimers: () => timers.size };
}

const PAYMENT = { kind: 'rejected', reason: 'payment-required' } as const;

describe('credentialRejectionOf', () => {
  it('maps only the statuses that describe the credential', () => {
    expect(credentialRejectionOf(401)).toBe('unauthorized');
    expect(credentialRejectionOf(402)).toBe('payment-required');
    expect(credentialRejectionOf(403)).toBe('forbidden');
    for (const status of [400, 404, 429, 500, 503, undefined]) expect(credentialRejectionOf(status)).toBeNull();
  });
});

describe('createClassifierBreakers', () => {
  afterEach(() => vi.restoreAllMocks());

  it('admits a provider whose credential was never refused, and transient failures leave it closed', () => {
    const { breakers, changes } = breakersAt();
    breakers.settle(breakers.claim('openrouter'), { kind: 'failed' });
    expect(breakers.admits('openrouter')).toBe(true);
    expect(breakers.rejection('openrouter')).toBeUndefined();
    expect(changes).not.toHaveBeenCalled();
  });

  // Each change of `admits` notifies, so a status read on change names the provider the next request goes to.
  it('a refusal skips the provider for the cooldown, then admits exactly one probe, notifying at each change of admission', () => {
    const { breakers, changes, advance } = breakersAt();
    breakers.settle(breakers.claim('openrouter'), PAYMENT);
    expect(breakers.rejection('openrouter')).toBe('payment-required');
    expect(changes).toHaveBeenCalledTimes(1);
    expect(breakers.admits('openrouter')).toBe(false);
    expect(breakers.admits('typesafe')).toBe(true);

    advance(CLASSIFIER_PROBE_AFTER_MS - 1);
    expect(breakers.admits('openrouter')).toBe(false);
    expect(changes).toHaveBeenCalledTimes(1);
    advance(1);
    expect(breakers.admits('openrouter')).toBe(true);
    expect(changes).toHaveBeenCalledTimes(2);

    const probe = breakers.claim('openrouter');
    expect(breakers.admits('openrouter')).toBe(false);
    expect(changes).toHaveBeenCalledTimes(3);
    breakers.settle(probe, { kind: 'answered' });
    expect(breakers.admits('openrouter')).toBe(true);
    expect(breakers.rejection('openrouter')).toBeUndefined();
    expect(changes).toHaveBeenCalledTimes(4);
  });

  it('claiming a provider with no refusal notifies nothing', () => {
    const { breakers, changes } = breakersAt();
    breakers.settle(breakers.claim('openrouter'), { kind: 'answered' });
    expect(changes).not.toHaveBeenCalled();
  });

  it('a reset or an answer cancels the cooldown timer, and a refused probe restarts it', () => {
    const { breakers, advance, pendingTimers } = breakersAt();
    breakers.settle(breakers.claim('openrouter'), PAYMENT);
    expect(pendingTimers()).toBe(1);
    breakers.reset('openrouter');
    expect(pendingTimers()).toBe(0);

    breakers.settle(breakers.claim('typesafe'), PAYMENT);
    advance(CLASSIFIER_PROBE_AFTER_MS);
    breakers.settle(breakers.claim('typesafe'), PAYMENT);
    expect(pendingTimers()).toBe(1);
    advance(CLASSIFIER_PROBE_AFTER_MS);
    breakers.settle(breakers.claim('typesafe'), { kind: 'answered' });
    expect(pendingTimers()).toBe(0);

    breakers.settle(breakers.claim('openai'), PAYMENT);
    breakers.dispose();
    expect(pendingTimers()).toBe(0);
  });

  it('a refused probe restarts the cooldown, and its settle notifies only when the reason changes', () => {
    const { breakers, changes, advance } = breakersAt();
    breakers.settle(breakers.claim('openrouter'), PAYMENT);
    advance(CLASSIFIER_PROBE_AFTER_MS);
    const probe = breakers.claim('openrouter');
    changes.mockClear();
    breakers.settle(probe, PAYMENT);
    expect(changes).not.toHaveBeenCalled();
    expect(breakers.admits('openrouter')).toBe(false);

    advance(CLASSIFIER_PROBE_AFTER_MS);
    const second = breakers.claim('openrouter');
    changes.mockClear();
    breakers.settle(second, { kind: 'rejected', reason: 'unauthorized' });
    expect(breakers.rejection('openrouter')).toBe('unauthorized');
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it('a transient failure of the probe keeps the refusal and lets the next request probe, which notifies', () => {
    const { breakers, changes, advance } = breakersAt();
    breakers.settle(breakers.claim('openrouter'), PAYMENT);
    advance(CLASSIFIER_PROBE_AFTER_MS);
    const probe = breakers.claim('openrouter');
    changes.mockClear();
    breakers.settle(probe, { kind: 'failed' });
    expect(breakers.rejection('openrouter')).toBe('payment-required');
    expect(breakers.admits('openrouter')).toBe(true);
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it('a credential change clears the refusal at once and voids outcomes of requests sent with the old key', () => {
    const { breakers, changes } = breakersAt();
    const inFlight = breakers.claim('openrouter');
    breakers.settle(breakers.claim('openrouter'), PAYMENT);

    breakers.reset('openrouter');
    expect(breakers.admits('openrouter')).toBe(true);
    expect(breakers.rejection('openrouter')).toBeUndefined();
    expect(changes).toHaveBeenCalledTimes(2);

    breakers.settle(inFlight, PAYMENT);
    expect(breakers.admits('openrouter')).toBe(true);
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it('an OpenAI credential change resets only the OpenAI breaker, and voids its request sent with the old credential', () => {
    const { breakers } = breakersAt();
    const sentWithKey = breakers.claim('openai');
    breakers.settle(breakers.claim('typesafe'), PAYMENT);
    breakers.settle(breakers.claim('openai'), { kind: 'rejected', reason: 'unauthorized' });

    breakers.reset('openai');
    breakers.settle(sentWithKey, { kind: 'rejected', reason: 'unauthorized' });
    expect(breakers.rejection('openai')).toBeUndefined();
    expect(breakers.admits('openai')).toBe(true);
    expect(breakers.rejection('typesafe')).toBe('payment-required');
  });

  it('an answer to a request claimed before the refusal never clears it, whatever the settle order', () => {
    const { breakers, changes } = breakersAt();
    const batches = [breakers.claim('openrouter'), breakers.claim('openrouter'), breakers.claim('openrouter')];
    breakers.settle(batches[1]!, { kind: 'answered' });
    breakers.settle(batches[0]!, PAYMENT);
    breakers.settle(batches[2]!, { kind: 'answered' });

    expect(breakers.rejection('openrouter')).toBe('payment-required');
    expect(breakers.admits('openrouter')).toBe(false);
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it('a request claimed before the refusal cannot end the probe, so no second probe is admitted', () => {
    const { breakers, advance } = breakersAt();
    const early = breakers.claim('openrouter');
    breakers.settle(breakers.claim('openrouter'), PAYMENT);
    advance(CLASSIFIER_PROBE_AFTER_MS);
    const probe = breakers.claim('openrouter');

    breakers.settle(early, { kind: 'failed' });
    expect(breakers.admits('openrouter')).toBe(false);
    breakers.settle(early, PAYMENT);
    expect(breakers.admits('openrouter')).toBe(false);

    breakers.settle(probe, { kind: 'answered' });
    expect(breakers.rejection('openrouter')).toBeUndefined();
  });

  it('defaults to the monotonic clock, so a wall-clock step back does not lengthen the cooldown', () => {
    let monotonic = 50_000;
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
    vi.spyOn(Date, 'now').mockImplementation(() => 9_000_000_000_000);
    const breakers = createClassifierBreakers();
    breakers.settle(breakers.claim('openrouter'), PAYMENT);
    vi.spyOn(Date, 'now').mockImplementation(() => 1_000);
    monotonic += CLASSIFIER_PROBE_AFTER_MS;
    expect(breakers.admits('openrouter')).toBe(true);
  });

  it('stops notifying a listener once it unsubscribes', () => {
    const { breakers } = breakersAt();
    const listener = vi.fn();
    const stop = breakers.onChange(listener);
    stop();
    breakers.settle(breakers.claim('typesafe'), PAYMENT);
    expect(listener).not.toHaveBeenCalled();
  });
});
