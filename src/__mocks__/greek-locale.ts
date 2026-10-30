import elBundle from '../../l10n/bundle.l10n.el.json';
import { renderLocalizedText, type LocalizedText } from '../shared/localized-text';

/** `text` as a view whose language is Greek renders it, from the shipped Greek bundle. */
export function inGreek(text: LocalizedText): string {
  const greek = elBundle as Record<string, string>;
  return renderLocalizedText(text, (key) => (Object.hasOwn(greek, key) ? greek[key] : undefined), 'el');
}
