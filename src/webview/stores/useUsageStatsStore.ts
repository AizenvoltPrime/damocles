import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { useVSCode } from '@/composables/useVSCode';
import {
  presetSpec,
  resolveStatsRange,
  stepStatsRange,
  type ResolvedStatsRange,
  type StatsPreset,
  type StatsRangeSpec,
} from '@/composables/useStatsRange';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import type { UsageStatsReport } from '@shared/types/usage-stats';

export type UsageStatsStatus = 'indexing' | 'loading' | 'ready' | 'error';

type UsageStatsMessage = Extract<ExtensionToWebviewMessage, { type: 'usageStats' }>;
type UsageStatsProgressMessage = Extract<ExtensionToWebviewMessage, { type: 'usageStatsProgress' }>;

let requestSeq = 0;

/** Global rather than per session: a session switch leaves the overlay, its filters and its report alone. */
export const useUsageStatsStore = defineStore('usageStats', () => {
  const { postMessage } = useVSCode();

  const isOverlayOpen = ref(false);
  const rangeSpec = ref<StatsRangeSpec>(presetSpec('last30'));
  const compare = ref(true);
  const modelKeys = ref<string[]>([]);
  const projectKeys = ref<string[]>([]);

  const status = ref<UsageStatsStatus>('loading');
  const progress = ref<{ filesDone: number; filesTotal: number } | null>(null);
  const report = ref<UsageStatsReport | null>(null);
  const error = ref<string | null>(null);
  /** The range the latest request asked for, resolved at the moment it was sent. */
  const activeRange = ref<ResolvedStatsRange | null>(null);

  // Only the latest request's replies are applied; anything else answers a query the user has moved past.
  let latestRequestId: string | null = null;
  let latestScan = false;
  // A filter change during a scan joins it (the worker never starts a second), or its reply would read a half-built index as final.
  let scanInFlight = false;

  const updatedAtMs = computed(() => report.value?.indexedAtMs ?? null);
  const preset = computed<StatsPreset>(() => rangeSpec.value.preset);

  function request(wantsScan: boolean): void {
    const scan = wantsScan || scanInFlight;
    const range = resolveStatsRange(rangeSpec.value, Date.now());
    const requestId = `stats-${Date.now().toString(36)}-${++requestSeq}`;
    activeRange.value = range;
    latestRequestId = requestId;
    latestScan = scan;
    scanInFlight = scan;
    status.value = 'loading';
    progress.value = null;
    error.value = null;
    postMessage({
      type: 'requestUsageStats',
      requestId,
      query: {
        startMs: range.startMs,
        endMs: range.endMs,
        previous: compare.value ? range.previous : null,
        modelKeys: [...modelKeys.value],
        projectKeys: [...projectKeys.value],
        bucket: range.bucket,
        timeZone: dateTimeZone(),
        scan,
      },
    });
  }

  /** The zone `Date` reads, because `useStatsRange` and the chart keys are computed in it. An undetected
   *  OS zone reports `Etc/Unknown`, which no formatter accepts and which `Date` treats as UTC. */
  function dateTimeZone(): string {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone === 'Etc/Unknown' ? 'UTC' : zone;
  }

  function openOverlay(): void {
    isOverlayOpen.value = true;
    request(true);
  }

  function closeOverlay(): void {
    isOverlayOpen.value = false;
    latestRequestId = null;
    scanInFlight = false;
    progress.value = null;
  }

  function refresh(): void {
    request(true);
  }

  function retry(): void {
    request(latestScan);
  }

  function setRange(spec: StatsRangeSpec): void {
    rangeSpec.value = spec;
    request(false);
  }

  function step(direction: -1 | 1): void {
    const range = activeRange.value;
    if (!range || !(direction === 1 ? range.canStepNext : range.canStepPrev)) return;
    setRange(stepStatsRange(rangeSpec.value, direction));
  }

  function setCompare(on: boolean): void {
    compare.value = on;
    request(false);
  }

  function setModelKeys(keys: string[]): void {
    modelKeys.value = keys;
    request(false);
  }

  function setProjectKeys(keys: string[]): void {
    projectKeys.value = keys;
    request(false);
  }

  function handleProgress(msg: UsageStatsProgressMessage): void {
    if (msg.requestId !== latestRequestId) return;
    progress.value = { filesDone: msg.filesDone, filesTotal: msg.filesTotal };
    if (msg.filesTotal > 0) status.value = 'indexing';
  }

  function handleResult(msg: UsageStatsMessage): void {
    if (msg.requestId !== latestRequestId) return;
    if (msg.report) report.value = msg.report;
    if (!msg.final) return;
    scanInFlight = false;
    progress.value = null;
    // The host sends a final reply with no report only alongside an error.
    if (msg.report === null || msg.error !== undefined) {
      status.value = 'error';
      error.value = msg.error ?? null;
      return;
    }
    status.value = 'ready';
  }

  return {
    isOverlayOpen,
    rangeSpec,
    preset,
    compare,
    modelKeys,
    projectKeys,
    status,
    progress,
    report,
    error,
    activeRange,
    updatedAtMs,
    openOverlay,
    closeOverlay,
    refresh,
    retry,
    setRange,
    step,
    setCompare,
    setModelKeys,
    setProjectKeys,
    handleProgress,
    handleResult,
  };
});
