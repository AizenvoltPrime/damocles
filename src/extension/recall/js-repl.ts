import * as vm from 'vm';
import { log } from '../logger';
import { BLOCK_TIMEOUT_MS, ASYNC_TIMEOUT_MS, STDOUT_TRUNCATION_LIMIT } from './types';
import type { StructuredTurn, SubcallRecord } from './types';

export type LlmQueryFn = (prompt: string, model?: string) => Promise<string>;
export type LlmQueryBatchedFn = (prompts: string[], model?: string) => Promise<string[]>;

export interface ExecutionResult {
  stdout: string;
  error: string | null;
  subcalls: SubcallRecord[];
  finalValue: string | null;
  finalVarName: string | null;
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

const SCAFFOLD_NAMES = new Set([
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

export class JsRepl {
  private context: vm.Context | null;
  private stdoutBuffer: string[] = [];
  private subcallBuffer: SubcallRecord[] = [];
  private llmQueryFn: LlmQueryFn;
  private llmQueryBatchedFn: LlmQueryBatchedFn;
  private disposed = false;
  private scaffoldRefs: Record<string, unknown> = {};
  private _finalValue: string | null = null;
  private _finalVarName: string | null = null;

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
      self._finalValue = result;
      self.stdoutBuffer.push(`FINAL(${result.length > 200 ? result.slice(0, 200) + '...' : result})`);
      return result;
    };

    const FINAL_VAR = (varName: string): string => {
      self._finalVarName = varName;
      self.stdoutBuffer.push(`FINAL_VAR("${varName}")`);
      return varName;
    };

    const SHOW_VARS = (): string => {
      const userVars: string[] = [];
      if (!self.context) return 'REPL disposed.';
      const keys = Object.getOwnPropertyNames(self.context);
      for (const key of keys) {
        if (SCAFFOLD_NAMES.has(key)) continue;
        try {
          const val = self.context[key];
          const type = Array.isArray(val) ? `Array(${val.length})`
            : typeof val === 'string' ? `string (${val.length} chars)`
            : typeof val;
          userVars.push(`  ${key}: ${type}`);
        } catch {
          userVars.push(`  ${key}: <inaccessible>`);
        }
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

    this.scaffoldRefs = {
      context: sandbox['context'],
      llm_query: sandbox['llm_query'],
      llm_query_batched: sandbox['llm_query_batched'],
      console: sandbox['console'],
      FINAL: sandbox['FINAL'],
      FINAL_VAR: sandbox['FINAL_VAR'],
      SHOW_VARS: sandbox['SHOW_VARS'],
    };

    return ctx;
  }

  private hoistDeclarations(code: string): string {
    const varNames = new Set<string>();
    const pattern = /^\s*(?:const|let|var)\s+(\w+)\s*=/gm;
    let match;
    while ((match = pattern.exec(code)) !== null) {
      const name = match[1]!;
      if (!SCAFFOLD_NAMES.has(name)) {
        varNames.add(name);
      }
    }
    if (varNames.size === 0) return code;
    const persist = [...varNames]
      .map(n => `try { globalThis[${JSON.stringify(n)}] = ${n}; } catch {}`)
      .join('\n');
    return `${code}\n${persist}`;
  }

  private restoreScaffold(): void {
    if (!this.context) return;
    for (const [key, value] of Object.entries(this.scaffoldRefs)) {
      this.context[key] = value;
    }
  }

  async execute(code: string): Promise<ExecutionResult> {
    if (this.disposed || !this.context) {
      return { stdout: '', error: 'REPL disposed', subcalls: [], finalValue: null, finalVarName: null };
    }

    this.stdoutBuffer = [];
    this.subcallBuffer = [];
    this._finalValue = null;
    this._finalVarName = null;

    const hoisted = this.hoistDeclarations(code);
    const wrappedCode = `(async () => {\n${hoisted}\n})()`;

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

      this.restoreScaffold();
      return { stdout, error: null, subcalls: [...this.subcallBuffer], finalValue: this._finalValue, finalVarName: this._finalVarName };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log('[JsRepl] Execution error: %s', errorMsg);

      let stdout = this.stdoutBuffer.join('\n');
      if (stdout.length > STDOUT_TRUNCATION_LIMIT) {
        stdout = stdout.slice(0, STDOUT_TRUNCATION_LIMIT) + '\n... [truncated]';
      }

      this.restoreScaffold();
      return { stdout, error: errorMsg, subcalls: [...this.subcallBuffer], finalValue: this._finalValue, finalVarName: this._finalVarName };
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

  getVariableSummary(): string {
    if (!this.context) return '';
    const lines: string[] = [];
    for (const key of Object.getOwnPropertyNames(this.context)) {
      if (SCAFFOLD_NAMES.has(key)) continue;
      try {
        const val = this.context[key];
        const type = Array.isArray(val) ? `Array(${val.length})`
          : typeof val === 'string' ? `string (${val.length} chars)`
          : typeof val;
        lines.push(`  ${key}: ${type}`);
      } catch {
        lines.push(`  ${key}: <inaccessible>`);
      }
    }
    return lines.join('\n');
  }

  dispose(): void {
    this.disposed = true;
    this.context = null;
    this.scaffoldRefs = {};
    this.stdoutBuffer = [];
    this.subcallBuffer = [];
  }
}
