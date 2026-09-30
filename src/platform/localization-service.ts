// Only the positional-argument form of vscode.l10n.t is in use; {0}, {1}, ... in message are replaced by args.
export interface LocalizationService {
  t(message: string, ...args: Array<string | number | boolean>): string;
  // BCP 47 display language of the host, e.g. 'en' or 'el'
  readonly language: string;
}
