import { realpathSync } from 'node:fs';
import { isBuiltin, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isInsideRealRoot } from '../main/documents/confine';

export const OUTSIDE_ROOT_CODE = 'ERR_DAMOCLES_OUTSIDE_ROOT';

/** The real path of a resolved module outside realRoot, or the URL itself when it is no file; undefined for a builtin. */
export function moduleOutsideRoot(realRoot: string, url: string): string | undefined {
  if (url.startsWith('node:') || isBuiltin(url)) return undefined;
  if (!url.startsWith('file:')) return url;
  const file = fileURLToPath(url);
  let real: string;
  try {
    real = realpathSync.native(file);
  } catch {
    real = file;
  }
  return isInsideRealRoot(realRoot, real) ? undefined : real;
}

/**
 * Refuses every module, required or imported, whose real path lies outside realRoot, so a plugin or shared config that
 * resolves to a parent folder, a global folder or NODE_PATH never runs. One synchronous hook serves both loaders, in this
 * thread. Resolves the refused paths, in order, as they happen.
 */
export function confineModules(realRoot: string): readonly string[] {
  const refused: string[] = [];
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      const outside = moduleOutsideRoot(realRoot, resolved.url);
      if (outside === undefined) return resolved;
      refused.push(outside);
      throw Object.assign(new Error(`${outside} is outside the project folder ${realRoot}, so it was not loaded`), { code: OUTSIDE_ROOT_CODE, path: outside });
    },
  });
  return refused;
}
