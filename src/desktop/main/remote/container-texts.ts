// Why main refused a container action, in the user's language: each fills the {0} of a toast that names the action.
import type { NameCheck } from '../../preload/overlay-channels';

type Translate = (message: string, ...args: string[]) => string;

/** A container action named a project that is no saved container's (forgotten, or removed since the shell asked). */
export function notContainerProjectText(t: Translate): string {
  return t('The project is not in a container any more.');
}

/** The devcontainer record could not be made under the name prefilled from the folder. */
export function containerNameRefusedText(check: NameCheck, t: Translate): string {
  if (!check.ok && check.reason === 'taken') return t('Another host is already named {0}.', check.clashWith ?? '');
  return t('The folder\'s name cannot name a host.');
}
