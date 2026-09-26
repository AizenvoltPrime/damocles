import * as vscode from 'vscode';
import { log } from './logger';
import { formatPerfLine, type PerfFields } from '../shared/perf-line';

export type { PerfFields };

export interface PerfSpan {
  end(fields?: PerfFields): void;
}

let activationStart: number | undefined;

/** A span that logs on `end`; with `minMs`, only when it took longer than that. */
export function perfSpan(label: string, options?: { minMs?: number }): PerfSpan {
  const start = performance.now();
  return {
    end(fields?: PerfFields): void {
      const ms = performance.now() - start;
      if (options?.minMs !== undefined && ms <= options.minMs) return;
      log(formatPerfLine(label, ms, fields));
    },
  };
}

/** Times `fn`; when `fn` returns a native Promise, logs when it settles, with `failed=true` on rejection, and rethrows. */
export function timed<T>(label: string, fn: () => T, fields?: PerfFields): T {
  const span = perfSpan(label);
  let result: T;
  try {
    result = fn();
  } catch (err) {
    span.end({ ...fields, failed: true });
    throw err;
  }
  if (result instanceof Promise) {
    return result.then(
      (value) => {
        span.end(fields);
        return value;
      },
      (err: unknown) => {
        span.end({ ...fields, failed: true });
        throw err;
      },
    ) as T;
  }
  span.end(fields);
  return result;
}

/** Must be the first statement of `activate()`. */
export function markActivationStart(): void {
  activationStart = performance.now();
}

export function markSinceActivation(event: string, fields?: PerfFields): void {
  if (activationStart === undefined) return;
  log(formatPerfLine(event, performance.now() - activationStart, fields));
}

/** Gates the costlier diagnostics, such as payload size estimates. */
export function perfDebugEnabled(): boolean {
  return vscode.workspace.getConfiguration('damocles').get<boolean>('debug') === true;
}

/** Summed string lengths (UTF-16 code units) across a value's own properties: a payload size estimate that never serializes. */
export function approxStringLength(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (value === null || typeof value !== 'object') return 0;
  let total = 0;
  if (Array.isArray(value)) {
    for (const item of value) total += approxStringLength(item);
  } else {
    for (const key in value) total += approxStringLength((value as Record<string, unknown>)[key]);
  }
  return total;
}
