// Core renders no user-facing text (core/l10n.ts l()); it reads only the host's display language.
export interface LocalizationService {
  // BCP 47 display language of the host, e.g. 'en' or 'el'
  readonly language: string;
}
