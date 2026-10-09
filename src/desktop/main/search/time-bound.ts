import * as vm from 'node:vm';

const context = vm.createContext({});
const script = new vm.Script('task()');

/**
 * Runs task on the main thread and interrupts it after timeoutMs. A JavaScript RegExp built from user input (a replace
 * pattern, a glob compiled by picomatch) can backtrack for minutes where ripgrep's engine is linear; V8 interrupts it.
 */
export function runWithin<T>(timeoutMs: number, task: () => T): { readonly ok: true; readonly value: T } | { readonly ok: false } {
  context['task'] = task;
  try {
    return { ok: true, value: script.runInContext(context, { timeout: timeoutMs }) as T };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return { ok: false };
    throw err;
  } finally {
    context['task'] = undefined;
  }
}
