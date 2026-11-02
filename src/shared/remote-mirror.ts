// Files at the root of a host's session mirror (<userData>/remote/<hostId>/mirror/), beside its project folders, whose
// names are 32 hex digits, so neither name can be a project's.

// the target's sub-call usage ledger (~/.damocles/usage/subcalls.jsonl on the target)
export const MIRROR_SUBCALLS_FILE = 'subcalls.jsonl';
// MirrorClock as JSON; a sync over a connection that measured the skew records it before it brings any bytes
export const MIRROR_CLOCK_FILE = 'clock.json';

/** skewMs: the host's clock minus this computer's, an integer, as the handshake measured it for the connection that synced. */
export interface MirrorClock {
  readonly skewMs: number;
}

/** The skew a mirror's clock file holds, or undefined when its text is not a MirrorClock. */
export function parseMirrorClock(text: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { skewMs } = parsed as Record<string, unknown>;
    return typeof skewMs === 'number' && Number.isSafeInteger(skewMs) ? skewMs : undefined;
  } catch {
    return undefined;
  }
}
