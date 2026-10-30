import type { LocalizedText } from '../shared/localized-text';

export interface NotificationOptions {
  readonly modal?: boolean;
  // withdraws a modal notification, which then answers undefined; VS Code cannot withdraw one and ignores it
  readonly signal?: AbortSignal;
}

/**
 * The host renders the text and the action labels in its own language and answers with the index of the chosen action,
 * undefined when none was chosen, so no localized label is ever compared.
 */
export interface NotificationService {
  info(message: LocalizedText, actions?: readonly LocalizedText[], options?: NotificationOptions): Promise<number | undefined>;
  warn(message: LocalizedText, actions?: readonly LocalizedText[], options?: NotificationOptions): Promise<number | undefined>;
  error(message: LocalizedText, actions?: readonly LocalizedText[], options?: NotificationOptions): Promise<number | undefined>;
}
