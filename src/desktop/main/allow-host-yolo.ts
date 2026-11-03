import type { HostColor } from '../../shared/host-colors';
import type { OverlayAnswer, OverlayRect, OverlayRequest } from '../preload/overlay-channels';

export interface AllowHostYoloDeps {
  // the saved host an authority names, from this computer's host store; undefined for an authority with no saved record
  readonly savedHost: (authority: string) => { readonly hostId: string; readonly name: string; readonly color?: HostColor; readonly allowBypass: boolean } | undefined;
  // main's own overlay question; an aborted signal withdraws it, which answers dismissed
  readonly request: (request: Extract<OverlayRequest, { kind: 'allowYolo' }>, signal: AbortSignal | undefined) => Promise<OverlayAnswer>;
  // turns the host's allowBypass on and publishes its policy; throws for a host no longer saved
  readonly allow: (hostId: string) => Promise<void>;
  // logs the failure and tells the user
  readonly failed: (hostName: string, err: unknown) => void;
}

/**
 * Asks to allow YOLO on an authority's saved host, hung from anchor (overlay pixels), and resolves whether the host allows YOLO
 * now. A host without a saved record is never asked; asks for a host already being asked join that question.
 */
export function allowYoloAsker(deps: AllowHostYoloDeps): (authority: string, anchor: OverlayRect, signal?: AbortSignal) => Promise<boolean> {
  const pending = new Map<string, Promise<boolean>>();
  const ask = async (host: NonNullable<ReturnType<AllowHostYoloDeps['savedHost']>>, anchor: OverlayRect, signal: AbortSignal | undefined): Promise<boolean> => {
    try {
      const answer = await deps.request({ kind: 'allowYolo', hostName: host.name, ...(host.color !== undefined ? { hostColor: host.color } : {}), anchor }, signal);
      if (answer.kind !== 'allowYolo' || !answer.allow) return false;
      await deps.allow(host.hostId);
      return true;
    } catch (err) {
      deps.failed(host.name, err);
      throw err;
    }
  };
  return async (authority, anchor, signal) => {
    const host = deps.savedHost(authority);
    if (!host) return false;
    if (host.allowBypass) return true;
    const joined = pending.get(host.hostId);
    if (joined) return joined;
    const asking = ask(host, anchor, signal).finally(() => pending.delete(host.hostId));
    pending.set(host.hostId, asking);
    return asking;
  };
}
