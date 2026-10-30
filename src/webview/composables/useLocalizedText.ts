import { useI18n } from 'vue-i18n';
import { coreCatalog, i18n } from '@/i18n';
import { renderLocalizedText, type LocalizedText } from '@shared/localized-text';

/** A key of the view's own messages with its named arguments, which `t` renders. */
export interface ViewMessage {
  readonly key: string;
  readonly named?: Readonly<Record<string, string | number>>;
}

/**
 * Text a ref or store keeps until a template or computed renders it (`vt`): core's LocalizedText, the view's own message,
 * or text that is no one's catalog's, shown as written.
 */
export type ViewText = LocalizedText | ViewMessage | { readonly verbatim: string };

/** Core's text in this view's language (the one `languageChange` set); a key the catalog lacks renders in English. */
export function renderText(text: LocalizedText): string {
  // text is LocalizedText the page's bridge parsed (withParsedText), so it takes no other form
  const locale = i18n.global.locale.value;
  const catalog = coreCatalog(locale);
  return renderLocalizedText(text, (key) => (catalog !== undefined && Object.hasOwn(catalog, key) ? catalog[key] : undefined), locale);
}

/** An error row's text: core's when it sent one, else the row's own `content`. */
export function errorRowText(row: { readonly content: string; readonly error?: LocalizedText | undefined }): string {
  return row.error ? renderText(row.error) : row.content;
}

/**
 * `rt` and `vt` read the view's locale, so a template or computed that calls them renders again on a language change.
 * Stores and refs keep LocalizedText or ViewText and never a rendered string.
 */
export function useLocalizedText(): { rt: (text: LocalizedText) => string; vt: (text: ViewText) => string } {
  const { t } = useI18n();
  const vt = (text: ViewText): string => {
    if ('verbatim' in text) return text.verbatim;
    if ('key' in text) return text.named ? t(text.key, text.named) : t(text.key);
    return renderText(text);
  };
  return { rt: renderText, vt };
}
