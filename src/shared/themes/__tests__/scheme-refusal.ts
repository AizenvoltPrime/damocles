import { SchemeImportError, type SchemeRefusal } from '../schemes/errors';

/** The SchemeImportError `run` throws; any other error is rethrown, and no error fails the test. */
export function refused(run: () => unknown): SchemeImportError {
  try {
    run();
  } catch (err) {
    if (err instanceof SchemeImportError) return err;
    throw err;
  }
  throw new Error('not refused');
}

export const refusal = (run: () => unknown): SchemeRefusal => refused(run).reason;
