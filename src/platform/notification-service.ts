export interface NotificationOptions {
  readonly modal?: boolean;
}

export interface NotificationService {
  info(message: string, options: NotificationOptions, ...actions: string[]): Promise<string | undefined>;
  info(message: string, ...actions: string[]): Promise<string | undefined>;
  warn(message: string, options: NotificationOptions, ...actions: string[]): Promise<string | undefined>;
  warn(message: string, ...actions: string[]): Promise<string | undefined>;
  error(message: string, options: NotificationOptions, ...actions: string[]): Promise<string | undefined>;
  error(message: string, ...actions: string[]): Promise<string | undefined>;
}
