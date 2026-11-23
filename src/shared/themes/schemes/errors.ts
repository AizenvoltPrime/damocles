import { LocalizedError, type LocalizedText } from '../../localized-text';

export type SchemeRefusal = 'syntax' | 'noColors' | 'badColor' | 'system' | 'noName' | 'cycle' | 'depth';

/** A color scheme file (base16, GTK, KDE, Qt) Damocles cannot read; the text names the problem. */
export class SchemeImportError extends LocalizedError {
  readonly reason: SchemeRefusal;

  constructor(reason: SchemeRefusal, text: LocalizedText) {
    super(text);
    this.name = 'SchemeImportError';
    this.reason = reason;
  }
}
