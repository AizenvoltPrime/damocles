import type { StructuredCompletionRequest, StructuredCompletionResult } from '../../pi-session/structured-completion';
import { DAMOCLES_DESIGN_DECISION } from '../../pi-session/session-store/constants';
import type { DecisionConflictJudge } from '../decision-conflicts';
import type { DecisionLedger } from '../decisions';
import type { DesignDecisionConflict, DesignDecisionSourceKind } from '../../../shared/types/design';
import type { DesignDecisionRecord } from '../design-entries';

let n = 0;
/** A session entry with an id, as pi's branch holds it. */
export const entry = (fields: Record<string, unknown>): Record<string, unknown> => ({ id: `k${++n}`, parentId: null, timestamp: '2026-01-01T00:00:00.000Z', ...fields });

/** A decision entry core appended. */
export const decisionEntry = (record: DesignDecisionRecord): Record<string, unknown> => entry({ type: 'custom', customType: DAMOCLES_DESIGN_DECISION, data: record });

export const record = (id: string, title: string, chosen: string, extra: Partial<DesignDecisionRecord> & { kind?: DesignDecisionSourceKind } = {}): DesignDecisionRecord => {
  const { kind = 'question', ...rest } = extra;
  return { v: 1, id, title, chosen, rejected: [], source: { kind, ref: kind === 'question' ? `${title}?` : 'b-1' }, files: [], ...rest };
};

/** A ledger over an in-memory branch; `changed` counts the design.changed sends, and `refuse` makes `ensureCurrent` throw it. */
export function memoryLedger(folder: string, entries: Record<string, unknown>[] = []): DecisionLedger & { readonly entries: Record<string, unknown>[]; changes: number; failures: unknown[]; refuse: Error | undefined } {
  const ledger = {
    folder,
    designId: 'contacts-abcd1234',
    entries,
    changes: 0,
    failures: [] as unknown[],
    refuse: undefined as Error | undefined,
    branch: () => entries,
    ensureCurrent: async () => {
      if (ledger.refuse) throw ledger.refuse;
    },
    append: (customType: string, data: Record<string, unknown>) => {
      entries.push(entry({ type: 'custom', customType, data }));
    },
    changed: () => {
      ledger.changes++;
    },
    writeFailed: (err: unknown) => {
      ledger.failures.push(err);
    },
  };
  return ledger;
}

/** A judge whose sub-call answers with `answer` for each request, which it records. */
export function judgeOf(answer: (request: StructuredCompletionRequest) => StructuredCompletionResult<unknown> | Promise<StructuredCompletionResult<unknown>>, hasModel = true): DecisionConflictJudge & { readonly requests: StructuredCompletionRequest[] } {
  const requests: StructuredCompletionRequest[] = [];
  return {
    requests,
    hasModel: () => hasModel,
    complete: async <T>(request: StructuredCompletionRequest) => {
      requests.push(request);
      return (await answer(request)) as StructuredCompletionResult<T>;
    },
    attribution: { cwd: '/ws', sessionId: 'design-1' },
  };
}

/** A judge that flags nothing. */
export const cleanJudge = () => judgeOf(() => ({ kind: 'answered', value: { flags: [] } }));

/** A judge that flags `flags` whenever the decisions it reads hold their ids. */
export const flaggingJudge = (flags: readonly DesignDecisionConflict[]) => judgeOf((request) => ({
  kind: 'answered',
  value: { flags: flags.filter((flag) => request.userMessage.includes(`"id":"${flag.id}"`)) },
}));

/** A judge with no background model. */
export const noModelJudge = () => judgeOf(() => ({ kind: 'unreachable' }), false);

export const signal = (): AbortSignal => new AbortController().signal;
