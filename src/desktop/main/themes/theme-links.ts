// A theme install link on the app's command line, judged by the shared link rules (src/shared/themes/theme-links.ts).
import { isThemeLinkArg, parseThemeLink, type ThemeLinkParse } from '../../../shared/themes/theme-links';
import { operandArgs } from '../cli';

export type ArgvThemeLink = { readonly kind: 'none' } | ({ readonly kind: 'link' } & ThemeLinkParse);

/**
 * The theme link on a command line (a Windows or Linux launch through the registered scheme, a first launch's or a second
 * instance's). It is read only after `--`, which the Windows registration puts before the link; a Linux desktop entry passes
 * the link bare, so there a command line without `--` is read whole. Chromium may reorder and append switches, so the link is
 * found by its scheme; more than one opens nothing.
 */
export function themeLinkInArgv(argv: readonly string[], platform: NodeJS.Platform = process.platform): ArgvThemeLink {
  const operands = operandArgs(argv);
  if (operands === undefined && platform === 'win32') return { kind: 'none' };
  const links = (operands ?? argv).filter(isThemeLinkArg);
  if (links.length === 0) return { kind: 'none' };
  if (links.length > 1) return { kind: 'link', ok: false, reason: `${links.length} links on one command line` };
  return { kind: 'link', ...parseThemeLink(links[0]) };
}
