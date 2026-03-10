import * as vm from 'vm';
import { log } from '../logger';
import { BLOCK_TIMEOUT_MS, ASYNC_TIMEOUT_MS, STDOUT_TRUNCATION_LIMIT } from './types';
import type { StructuredTurn, SubcallRecord } from './types';

export type LlmQueryFn = (prompt: string, model?: string) => Promise<string>;
export type LlmQueryBatchedFn = (prompts: string[], model?: string) => Promise<string[]>;

interface ExecutionResult {
  stdout: string;
  error: string | null;
  subcalls: SubcallRecord[];
}

const HARDENING_SCRIPT = new vm.Script(`
  'use strict';
  (function() {
    var fnProto = Object.getPrototypeOf(function(){});
    var genProto = Object.getPrototypeOf(function*(){});
    var asyncProto = Object.getPrototypeOf(async function(){});
    var asyncGenProto = Object.getPrototypeOf(async function*(){});
    [fnProto, genProto, asyncProto, asyncGenProto].forEach(function(proto) {
      if (proto) {
        Object.defineProperty(proto, 'constructor', {
          value: undefined,
          writable: false,
          configurable: false,
        });
      }
    });
  })();
`, { filename: 'sandbox-hardening.js' });

export class JsRepl {
  private context: vm.Context | null;
  private stdoutBuffer: string[] = [];
  private subcallBuffer: SubcallRecord[] = [];
  private llmQueryFn: LlmQueryFn;
  private llmQueryBatchedFn: LlmQueryBatchedFn;
  private disposed = false;

  constructor(history: StructuredTurn[], llmQueryFn: LlmQueryFn, llmQueryBatchedFn: LlmQueryBatchedFn) {
    this.llmQueryFn = llmQueryFn;
    this.llmQueryBatchedFn = llmQueryBatchedFn;
    this.context = this.createSandbox(history);
  }

  private createSandbox(history: StructuredTurn[]): vm.Context {
    const self = this;

    const llm_query = async (prompt: string, model?: string): Promise<string> => {
      if (self.disposed) return '[REPL disposed]';
      const start = Date.now();
      const response = await self.llmQueryFn(prompt, model);
      self.subcallBuffer.push({
        prompt: prompt.slice(0, 500),
        model: model ?? 'default',
        response: response.slice(0, 1000),
        durationMs: Date.now() - start,
      });
      return response;
    };

    const llm_query_batched = async (prompts: string[], model?: string): Promise<string[]> => {
      if (self.disposed) return prompts.map(() => '[REPL disposed]');
      const start = Date.now();
      const responses = await self.llmQueryBatchedFn(prompts, model);
      const elapsed = Date.now() - start;
      for (let i = 0; i < prompts.length; i++) {
        self.subcallBuffer.push({
          prompt: (prompts[i] ?? '').slice(0, 500),
          model: model ?? 'default',
          response: (responses[i] ?? '').slice(0, 1000),
          durationMs: elapsed,
        });
      }
      return responses;
    };

    const consoleMock = {
      log: (...args: unknown[]) => {
        const line = args.map(a => {
          if (typeof a === 'string') return a;
          try { return JSON.stringify(a, null, 2); } catch { return String(a); }
        }).join(' ');
        self.stdoutBuffer.push(line);
      },
      error: (...args: unknown[]) => {
        const line = args.map(a => typeof a === 'string' ? a : String(a)).join(' ');
        self.stdoutBuffer.push(`[ERROR] ${line}`);
      },
      warn: (...args: unknown[]) => {
        const line = args.map(a => typeof a === 'string' ? a : String(a)).join(' ');
        self.stdoutBuffer.push(`[WARN] ${line}`);
      },
    };

    const FINAL = (value: unknown): string => {
      const result = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
      self.stdoutBuffer.push(`FINAL(${result})`);
      return result;
    };

    const FINAL_VAR = (varName: string): string => {
      self.stdoutBuffer.push(`FINAL_VAR("${varName}")`);
      return varName;
    };

    const SHOW_VARS = (): string => {
      const userVars: string[] = [];
      const builtins = new Set([
        'context', 'llm_query', 'llm_query_batched', 'console',
        'FINAL', 'FINAL_VAR', 'SHOW_VARS',
        'parseInt', 'parseFloat', 'isNaN', 'isFinite',
        'encodeURIComponent', 'decodeURIComponent',
        'undefined', 'NaN', 'Infinity',
        'Object', 'Function', 'Array', 'Number', 'Boolean', 'String',
        'Symbol', 'Date', 'Promise', 'RegExp', 'Error', 'AggregateError',
        'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError',
        'TypeError', 'URIError', 'JSON', 'Math', 'Intl', 'ArrayBuffer',
        'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array',
        'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array',
        'Uint8ClampedArray', 'BigInt64Array', 'BigUint64Array',
        'DataView', 'Map', 'BigInt', 'Set', 'WeakMap', 'WeakSet',
        'Proxy', 'Reflect', 'WeakRef', 'FinalizationRegistry',
        'SharedArrayBuffer', 'Atomics', 'globalThis',
      ]);
      if (!self.context) return 'REPL disposed.';
      const keys = Object.getOwnPropertyNames(self.context);
      for (const key of keys) {
        if (builtins.has(key)) continue;
        const val = self.context[key];
        const type = Array.isArray(val) ? `Array(${val.length})` : typeof val;
        userVars.push(`  ${key}: ${type}`);
      }
      const listing = userVars.length > 0
        ? `User variables:\n${userVars.join('\n')}`
        : 'No user variables defined.';
      self.stdoutBuffer.push(listing);
      return listing;
    };

    const sandbox: Record<string, unknown> = {
      context: structuredClone(history),
      llm_query,
      llm_query_batched,
      console: consoleMock,
      FINAL,
      FINAL_VAR,
      SHOW_VARS,

      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      encodeURIComponent,
      decodeURIComponent,
      undefined,
      NaN,
      Infinity,
    };

    const ctx = vm.createContext(sandbox, {
      name: 'recall-repl',
      codeGeneration: { strings: false, wasm: false },
    });

    HARDENING_SCRIPT.runInContext(ctx, { timeout: 1000 });

    return ctx;
  }

  async execute(code: string): Promise<ExecutionResult> {
    if (this.disposed || !this.context) {
      return { stdout: '', error: 'REPL disposed', subcalls: [] };
    }

    this.stdoutBuffer = [];
    this.subcallBuffer = [];

    const wrappedCode = `(async () => {\n${code}\n})()`;

    try {
      const script = new vm.Script(wrappedCode, {
        filename: 'recall-repl.js',
      });

      const resultPromise = script.runInContext(this.context, {
        timeout: BLOCK_TIMEOUT_MS,
      }) as Promise<unknown>;

      let asyncTimeoutHandle: ReturnType<typeof setTimeout>;
      const asyncTimeout = new Promise<never>((_, reject) => {
        asyncTimeoutHandle = setTimeout(() => {
          reject(new Error('Async execution timed out'));
        }, ASYNC_TIMEOUT_MS);
      });

      let result: unknown;
      try {
        result = await Promise.race([resultPromise, asyncTimeout]);
      } finally {
        clearTimeout(asyncTimeoutHandle!);
      }

      if (result !== undefined && this.stdoutBuffer.length === 0) {
        const display = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        if (display) this.stdoutBuffer.push(display);
      }

      let stdout = this.stdoutBuffer.join('\n');
      if (stdout.length > STDOUT_TRUNCATION_LIMIT) {
        stdout = stdout.slice(0, STDOUT_TRUNCATION_LIMIT) + '\n... [truncated]';
      }

      return { stdout, error: null, subcalls: [...this.subcallBuffer] };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log('[JsRepl] Execution error: %s', errorMsg);

      let stdout = this.stdoutBuffer.join('\n');
      if (stdout.length > STDOUT_TRUNCATION_LIMIT) {
        stdout = stdout.slice(0, STDOUT_TRUNCATION_LIMIT) + '\n... [truncated]';
      }

      return { stdout, error: errorMsg, subcalls: [...this.subcallBuffer] };
    }
  }

  resolveVariable(varName: string): string | null {
    if (this.disposed || !this.context) return null;
    try {
      const val = this.context[varName];
      if (val === undefined) return null;
      return typeof val === 'string' ? val : JSON.stringify(val, null, 2);
    } catch {
      return null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.context = null;
    this.stdoutBuffer = [];
    this.subcallBuffer = [];
  }
}
