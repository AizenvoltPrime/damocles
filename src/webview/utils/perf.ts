import { nextTick } from 'vue';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { formatPerfLine, type PerfFields } from '@shared/perf-line';

/** Logs to the host output channel through the existing `log` message, and to the devtools console. */
export function logPerf(label: string, ms: number, fields?: PerfFields): void {
  const message = formatPerfLine(label, ms, fields);
  console.debug(message);
  usePlatformBridge().postMessage({ type: 'log', message });
}

export function perfSpan(label: string): { end(fields?: PerfFields): void } {
  const start = performance.now();
  return { end: (fields) => logPerf(label, performance.now() - start, fields) };
}

/** `performance.now()` counts from navigation start, so this is time since the webview began loading. */
export function logSinceNavigation(label: string, fields?: PerfFields): void {
  logPerf(label, performance.now(), fields);
}

const BOOT_RESOURCES = ['index.js', 'vendor.js', 'shiki-core.js'] as const;

/** One line for the boot chunks: the ms is when the last of them finished, from navigation start. */
/** Fetch duration and decoded size per named asset chunk (0KB means the size was not exposed), and when the last one finished. */
export function resourceFields(names: readonly string[]): { fields: PerfFields; lastEnd: number } {
  const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
  const fields: PerfFields = {};
  let lastEnd = 0;
  for (const name of names) {
    const entry = entries.find((e) => e.name.split('?')[0]!.endsWith(`/${name}`));
    if (!entry) continue;
    lastEnd = Math.max(lastEnd, entry.responseEnd);
    fields[name] = `${Math.round(entry.duration)}ms/${Math.round(entry.decodedBodySize / 1024)}KB`;
  }
  return { fields, lastEnd };
}

export function logBootResources(): void {
  const { fields, lastEnd } = resourceFields(BOOT_RESOURCES);
  logPerf('boot.resources', lastEnd, fields);
}

/** A replay runs from `sessionCleared` to the next `done`; `items` stays 0 when that `done` ends a live turn instead. */
let replay: { start: number; items: number } | null = null;

export function beginReplayIngest(): void {
  replay = { start: performance.now(), items: 0 };
}

export function countReplayItem(): void {
  if (replay) replay.items++;
}

export function endReplayIngest(): void {
  const ended = replay;
  replay = null;
  if (!ended || ended.items === 0) return;
  logPerf('replay.ingest', performance.now() - ended.start, { items: ended.items });
  void nextTick(() => {
    // A rAF callback runs before that frame's layout and paint; the task after it runs once they are done.
    requestAnimationFrame(() => setTimeout(() => logPerf('replay.painted', performance.now() - ended.start, { items: ended.items }), 0));
  });
}
