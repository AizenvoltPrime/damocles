import { computed, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import { useVSCode } from '@/composables/useVSCode';
import {
  MEMORY_AUDIT_BANNER_MIN_ELIGIBLE,
  type MemoryAuditCancelResult,
  type MemoryAuditErrorCode,
  type MemoryAuditProgress,
  type MemoryAuditResult,
  type MemoryAuditStatePayload,
  type MemoryAuditSummary,
} from '@shared/types/memory-audit';

export type MemoryAuditPendingAction = 'start' | 'cancel' | 'apply' | 'revert';

/** Codes that report how this window's run ended rather than answer a request. */
const RUN_OUTCOME_CODES: ReadonlySet<MemoryAuditErrorCode> = new Set(['lease-lost', 'all-failed', 'run-failed']);

/** Key in the webview's persisted state (`vscode.setState`), which other features may share. */
const BANNER_DISMISSED_KEY = 'memoryAuditBannerDismissed';

type PersistedState = Record<string, unknown>;

/**
 * The memory panel's banner summary, and the review overlay's full state, which is held only while the
 * overlay is open and re-requested each time it opens.
 */
export const useMemoryAuditStore = defineStore('memoryAudit', () => {
  const { postMessage, getState, setState } = useVSCode();

  const isOverlayOpen = ref(false);
  const state = shallowRef<MemoryAuditStatePayload | null>(null);
  const summary = shallowRef<MemoryAuditSummary | null>(null);
  const progress = ref<MemoryAuditProgress | null>(null);
  const error = ref<MemoryAuditErrorCode | null>(null);
  const lastResult = shallowRef<MemoryAuditResult | null>(null);
  const cancelResult = ref<MemoryAuditCancelResult | null>(null);
  /** The request awaiting its definite answer: a start's running state or progress, a cancel's cancel result, an apply's or revert's result, or any audit error. */
  const pendingAction = ref<MemoryAuditPendingAction | null>(null);
  const bannerDismissed = ref(getState<PersistedState>()?.[BANNER_DISMISSED_KEY] === true);

  const run = computed(() => state.value?.run ?? null);
  const proposals = computed(() => state.value?.proposals ?? []);
  const showBanner = computed(() => {
    const s = summary.value;
    return s !== null && !s.hasAnyRun && s.eligibleCount >= MEMORY_AUDIT_BANNER_MIN_ELIGIBLE && !bannerDismissed.value;
  });
  const heldElsewhere = computed(() => run.value !== null && run.value.leaseActive && !run.value.ownedByThisWindow);

  /** Live counts of the run this window is running, from progress when it matches the run. */
  const liveRun = computed<MemoryAuditProgress | null>(() => {
    const p = progress.value;
    if (p && p.status === 'running') return p;
    const r = run.value;
    if (r && r.status === 'running' && r.ownedByThisWindow) {
      return { runId: r.id, graded: r.graded, total: r.total, failedBatches: r.failedBatches, status: r.status };
    }
    return null;
  });

  function clearFeedback(): void {
    error.value = null;
    lastResult.value = null;
    cancelResult.value = null;
  }

  function requestState(): void {
    postMessage({ type: 'requestMemoryAudit' });
  }

  function requestSummary(): void {
    postMessage({ type: 'requestMemoryAuditSummary' });
  }

  function openOverlay(): void {
    isOverlayOpen.value = true;
    clearFeedback();
    requestState();
  }

  function closeOverlay(): void {
    isOverlayOpen.value = false;
    state.value = null;
    clearFeedback();
  }

  function dismissBanner(): void {
    bannerDismissed.value = true;
    setState<PersistedState>({ ...(getState<PersistedState>() ?? {}), [BANNER_DISMISSED_KEY]: true });
  }

  function begin(action: MemoryAuditPendingAction): void {
    clearFeedback();
    pendingAction.value = action;
  }

  function start(): void {
    begin('start');
    postMessage({ type: 'startMemoryAudit' });
  }

  function cancel(): void {
    begin('cancel');
    postMessage({ type: 'cancelMemoryAudit' });
  }

  function apply(runId: string, accept: string[], reject: string[]): void {
    begin('apply');
    postMessage({ type: 'applyMemoryAudit', runId, accept, reject });
  }

  function revert(runId: string): void {
    begin('revert');
    postMessage({ type: 'revertMemoryAudit', runId });
  }

  function handleState(next: MemoryAuditStatePayload): void {
    if (isOverlayOpen.value) state.value = next;
    if (pendingAction.value === 'start') pendingAction.value = null;
    if (next.run?.status !== 'running' || progress.value?.runId !== next.run.id) progress.value = null;
  }

  function handleSummary(next: MemoryAuditSummary | null): void {
    summary.value = next;
  }

  function handleProgress(next: MemoryAuditProgress): void {
    progress.value = next;
    if (pendingAction.value === 'start') pendingAction.value = null;
  }

  function handleResult(result: MemoryAuditResult): void {
    lastResult.value = result;
    if (pendingAction.value === 'apply' || pendingAction.value === 'revert') pendingAction.value = null;
  }

  function handleCancelResult(result: MemoryAuditCancelResult): void {
    cancelResult.value = result;
    if (pendingAction.value === 'cancel') pendingAction.value = null;
  }

  /** Whether the error answers something this panel is waiting on; a passive read's error is not surfaced. */
  function handleError(code: MemoryAuditErrorCode): boolean {
    const answersRequest = pendingAction.value !== null || RUN_OUTCOME_CODES.has(code);
    pendingAction.value = null;
    if (isOverlayOpen.value || answersRequest) error.value = code;
    return answersRequest;
  }

  return {
    isOverlayOpen,
    state,
    summary,
    progress,
    error,
    lastResult,
    cancelResult,
    pendingAction,
    bannerDismissed,
    run,
    proposals,
    showBanner,
    heldElsewhere,
    liveRun,
    requestState,
    requestSummary,
    openOverlay,
    closeOverlay,
    dismissBanner,
    start,
    cancel,
    apply,
    revert,
    handleState,
    handleSummary,
    handleProgress,
    handleResult,
    handleCancelResult,
    handleError,
  };
});
