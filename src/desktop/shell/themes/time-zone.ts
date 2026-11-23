// The OS's time zone as the page's Intl resolves it (docs/invariants.md "Desktop themes"): Chromium's time-zone monitor keeps a
// renderer's zone current with the OS, while main's Node may keep its start-up zone. Reported on load and, from the tick, each
// time it changes; returns the unsubscribe.
export const TIME_ZONE_TICK_MS = 30_000;

const resolvedZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function watchTimeZone(report: (zone: string) => void, read: () => string = resolvedZone): () => void {
  let last = '';
  const check = (): void => {
    const zone = read();
    if (zone === last) return;
    last = zone;
    report(zone);
  };
  check();
  const tick = setInterval(check, TIME_ZONE_TICK_MS);
  return () => clearInterval(tick);
}
