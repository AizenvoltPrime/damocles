import type { ClassifierRejection } from '../../shared/types/settings';

/**
 * How long a refused classifier credential is skipped before one request probes it again. A 402 can
 * clear with no credential change (credit added to the same key), so a refusal never blocks for good.
 */
export const CLASSIFIER_PROBE_AFTER_MS: number = 5 * 60_000;

const REJECTION_BY_STATUS: Readonly<Record<number, ClassifierRejection>> = {
  401: 'unauthorized',
  402: 'payment-required',
  403: 'forbidden',
};

/** A refusal of the credential itself, as opposed to a failure of one request (429, 5xx, a timeout). */
export function credentialRejectionOf(status: number | undefined): ClassifierRejection | null {
  return status === undefined ? null : (REJECTION_BY_STATUS[status] ?? null);
}

export type ClassifierOutcome =
  | { kind: 'answered' }
  | { kind: 'rejected'; reason: ClassifierRejection }
  | { kind: 'failed' };

interface OpenBreaker {
  reason: ClassifierRejection;
  openedAt: number;
  probing: boolean;
}

/** One request's claim on a provider; a reset in between makes its outcome stale. */
export interface ClassifierTicket {
  readonly provider: string;
  readonly generation: number;
  /** The breaker this request probes, or null when none was open at claim: only its probe may clear it or end its probe. */
  readonly probes: Readonly<OpenBreaker> | null;
}

export interface ClassifierBreakers {
  /** Whether selection may route a request to `provider` now. */
  admits(provider: string): boolean;
  /** Claims a request right after selection; on a breaker past its cooldown this is the one probe. */
  claim(provider: string): ClassifierTicket;
  settle(ticket: ClassifierTicket, outcome: ClassifierOutcome): void;
  /** The provider's credential changed, so its last refusal no longer describes it. */
  reset(provider: string): void;
  /** The last refusal of `provider`'s credential, until an answer or a reset clears it. */
  rejection(provider: string): ClassifierRejection | undefined;
  /** Fires when any provider's rejection appears, changes or clears. */
  onChange(listener: () => void): () => void;
}

/** Per-provider circuit breakers for the Jev classifier; see "Memory judges on Jev" in docs/invariants.md. */
export function createClassifierBreakers(now: () => number = () => performance.now()): ClassifierBreakers {
  const open = new Map<string, OpenBreaker>();
  const generations = new Map<string, number>();
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const generationOf = (provider: string): number => generations.get(provider) ?? 0;

  return {
    admits(provider) {
      const breaker = open.get(provider);
      return !breaker || (!breaker.probing && now() - breaker.openedAt >= CLASSIFIER_PROBE_AFTER_MS);
    },

    claim(provider) {
      const breaker = open.get(provider) ?? null;
      if (breaker) breaker.probing = true;
      return { provider, generation: generationOf(provider), probes: breaker };
    },

    settle(ticket, outcome) {
      if (ticket.generation !== generationOf(ticket.provider)) return;
      const breaker = open.get(ticket.provider);
      // A request claimed before this breaker opened says nothing newer than the refusal that opened it.
      if (breaker && ticket.probes !== breaker) return;
      if (outcome.kind === 'answered') {
        if (!breaker) return;
        open.delete(ticket.provider);
        notify();
      } else if (outcome.kind === 'rejected') {
        open.set(ticket.provider, { reason: outcome.reason, openedAt: now(), probing: false });
        if (breaker?.reason !== outcome.reason) notify();
      } else if (breaker) {
        // A transient failure says nothing about the credential: the next request probes again.
        breaker.probing = false;
      }
    },

    reset(provider) {
      generations.set(provider, generationOf(provider) + 1);
      if (open.delete(provider)) notify();
    },

    rejection(provider) {
      return open.get(provider)?.reason;
    },

    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
