import { onTestFinished, vi } from 'vitest';
import elBundle from '../../l10n/bundle.l10n.el.json';
import { platform } from '../core/platform-host';

/** Until the test ends, the host's `t()` translates from the shipped Greek bundle and fills `{0}`, `{1}`... as it does. */
export function useGreekLocale(): void {
  const greek = elBundle as Record<string, string>;
  const localization = platform().localization;
  const fill = localization.t.bind(localization);
  const spy = vi.spyOn(localization, 't').mockImplementation((message, ...args) => fill(greek[message] ?? message, ...args));
  onTestFinished(() => spy.mockRestore());
}
