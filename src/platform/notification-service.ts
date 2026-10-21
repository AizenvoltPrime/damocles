export interface NotificationOptions {
  readonly modal?: boolean;
  // withdraws a modal notification, which then answers undefined; VS Code cannot withdraw one and ignores it
  readonly signal?: AbortSignal;
}

export interface NotificationService {
  info(message: string, options: NotificationOptions, ...actions: string[]): Promise<string | undefined>;
  info(message: string, ...actions: string[]): Promise<string | undefined>;
  warn(message: string, options: NotificationOptions, ...actions: string[]): Promise<string | undefined>;
  warn(message: string, ...actions: string[]): Promise<string | undefined>;
  error(message: string, options: NotificationOptions, ...actions: string[]): Promise<string | undefined>;
  error(message: string, ...actions: string[]): Promise<string | undefined>;
}
