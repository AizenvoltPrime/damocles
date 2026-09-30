export type ChildCommand =
  | { cmd: 'openPanel' }
  | { cmd: 'webviewMessage'; message: unknown }
  | { cmd: 'notifications' }
  | { cmd: 'writeAuth'; provider: string; credential: unknown }
  | { cmd: 'dispose' };

export type ChildEvent = { kind: 'ready'; pid: number } | { kind: 'posted'; message: unknown };

export type ChildReply = { kind: 'reply'; id: number; ok: true; result: unknown } | { kind: 'reply'; id: number; ok: false; error: string };
