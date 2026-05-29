import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type {
  WorkflowRun,
  WorkflowStatus,
  WorkflowUsage,
  WorkflowPhase,
  WorkflowAgentTranscript,
} from '@shared/types/workflows';

/** Cap on retained completed/failed/stopped runs. Running and selected runs are always kept. */
const MAX_RETAINED_TERMINAL_RUNS = 50;

export const useWorkflowStore = defineStore('workflows', () => {
  const runs = ref<Record<string, WorkflowRun>>({});
  const transcripts = ref<Record<string, WorkflowAgentTranscript[]>>({});
  const transcriptsLoading = ref<Record<string, boolean>>({});
  const transcriptsError = ref<Record<string, string>>({});
  const transcriptSeq = ref<Record<string, number>>({});
  const isOverlayOpen = ref(false);
  const selectedToolUseId = ref<string | null>(null);
  const selectedAgentId = ref<string | null>(null);

  let orderCounter = 0;

  const workflowList = computed(() =>
    Object.values(runs.value).sort((a, b) => b.startTime - a.startTime),
  );
  const activeWorkflowCount = computed(() =>
    workflowList.value.filter(run => run.status === 'running').length,
  );
  const selectedWorkflow = computed(() =>
    selectedToolUseId.value ? runs.value[selectedToolUseId.value] ?? null : null,
  );
  const selectedAgent = computed(() => {
    const toolUseId = selectedToolUseId.value;
    const agentId = selectedAgentId.value;
    if (!toolUseId || !agentId) return null;
    return (transcripts.value[toolUseId] ?? []).find(agent => agent.agentId === agentId) ?? null;
  });

  function ensure(toolUseId: string): WorkflowRun {
    let run = runs.value[toolUseId];
    if (!run) {
      run = {
        toolUseId,
        taskId: null,
        name: '',
        description: '',
        phases: [],
        status: 'running',
        summary: '',
        result: '',
        usage: null,
        outputFile: null,
        transcriptDir: null,
        startTime: orderCounter++,
      };
      runs.value[toolUseId] = run;
      pruneTerminalRuns();
    }
    return run;
  }

  /**
   * Evict the oldest terminal runs (and their transcripts) once they exceed the cap, so a
   * long session doesn't retain every run's full transcript blocks indefinitely. Running
   * and currently-selected runs are never evicted. Triggered on new-run insertion — the
   * only moment the run count grows.
   */
  function pruneTerminalRuns(): void {
    const terminal = Object.values(runs.value)
      .filter(run => run.status !== 'running')
      .sort((a, b) => b.startTime - a.startTime);
    if (terminal.length <= MAX_RETAINED_TERMINAL_RUNS) return;

    for (const run of terminal.slice(MAX_RETAINED_TERMINAL_RUNS)) {
      if (run.toolUseId === selectedToolUseId.value) continue;
      delete runs.value[run.toolUseId];
      delete transcripts.value[run.toolUseId];
      delete transcriptsLoading.value[run.toolUseId];
      delete transcriptsError.value[run.toolUseId];
      delete transcriptSeq.value[run.toolUseId];
    }
  }

  function upsertMeta(
    toolUseId: string,
    meta: { name: string; description: string; phases: WorkflowPhase[]; transcriptDir: string | null; taskId: string | null },
  ): void {
    const run = ensure(toolUseId);
    if (meta.name) run.name = meta.name;
    if (meta.description) run.description = meta.description;
    if (meta.phases.length) run.phases = meta.phases;
    if (meta.transcriptDir) run.transcriptDir = meta.transcriptDir;
    if (meta.taskId && !run.taskId) run.taskId = meta.taskId;
  }

  function applyResult(
    toolUseId: string,
    data: { taskId: string; status: WorkflowStatus; summary: string; result: string; outputFile: string | null; transcriptDir?: string | null; usage?: WorkflowUsage },
  ): void {
    const run = ensure(toolUseId);
    if (data.taskId) run.taskId = data.taskId;
    // Seed the transcript dir so a history-loaded run (or one whose card never mounted) can still
    // fetch its agent transcripts — otherwise the Agents tab is empty until the card mounts.
    if (data.transcriptDir && !run.transcriptDir) run.transcriptDir = data.transcriptDir;
    // A terminal status is final: the first one wins. This blocks a late `running` notification
    // from reverting a settled run, and also stops a second, conflicting terminal signal (e.g. a
    // `task_notification` arriving after a `task_updated` already marked the run failed) from
    // flipping the displayed status. Result/summary/usage still merge below, so a same-status
    // enrichment pass (the success path's output-file read) is unaffected.
    if (run.status === 'running') run.status = data.status;
    if (data.summary) run.summary = data.summary;
    // A workflow's result is immutable once it completes, but it arrives via multiple channels,
    // possibly out of order: the lean live notification (empty), the complete task output file,
    // and the SDK-truncated persisted notification. Keep the longest — i.e. the un-truncated one —
    // so a truncated result can never clobber the complete one.
    if (data.result && data.result.length >= run.result.length) run.result = data.result;
    if (data.outputFile) run.outputFile = data.outputFile;
    if (data.usage && (!run.usage || data.usage.agentCount >= run.usage.agentCount)) {
      run.usage = data.usage;
    }
  }

  function setTranscripts(toolUseId: string, agents: WorkflowAgentTranscript[], seq?: number, error?: string): void {
    // Transcript snapshots are produced by overlapping async disk reads (throttled live
    // pushes + the on-open fetch). Each carries a monotonic dispatch seq; drop any that
    // resolved out of order so a stale "running" snapshot can't overwrite a newer one.
    if (seq !== undefined) {
      if (seq <= (transcriptSeq.value[toolUseId] ?? 0)) return;
      transcriptSeq.value[toolUseId] = seq;
    }
    // Seed a run shell so a workflow whose card never mounted (scrolled out / prior turn)
    // still surfaces in the indicator and panel while its transcripts stream.
    ensure(toolUseId);
    transcripts.value[toolUseId] = agents;
    transcriptsLoading.value[toolUseId] = false;
    if (error) transcriptsError.value[toolUseId] = error;
    else delete transcriptsError.value[toolUseId];
  }

  function markTranscriptsLoading(toolUseId: string): void {
    transcriptsLoading.value[toolUseId] = true;
  }

  function openOverlay(toolUseId: string): void {
    selectedToolUseId.value = toolUseId;
    selectedAgentId.value = null;
    isOverlayOpen.value = true;
  }

  function openListOverlay(): void {
    selectedToolUseId.value = null;
    selectedAgentId.value = null;
    isOverlayOpen.value = true;
  }

  function closeOverlay(): void {
    isOverlayOpen.value = false;
  }

  function selectWorkflow(toolUseId: string | null): void {
    selectedToolUseId.value = toolUseId;
    selectedAgentId.value = null;
  }

  function openAgent(agentId: string): void {
    selectedAgentId.value = agentId;
  }

  function closeAgent(): void {
    selectedAgentId.value = null;
  }

  function $reset(): void {
    runs.value = {};
    transcripts.value = {};
    transcriptsLoading.value = {};
    transcriptsError.value = {};
    transcriptSeq.value = {};
    isOverlayOpen.value = false;
    selectedToolUseId.value = null;
    selectedAgentId.value = null;
    orderCounter = 0;
  }

  return {
    runs,
    transcripts,
    transcriptsLoading,
    transcriptsError,
    isOverlayOpen,
    selectedToolUseId,
    selectedAgentId,
    workflowList,
    activeWorkflowCount,
    selectedWorkflow,
    selectedAgent,
    upsertMeta,
    applyResult,
    setTranscripts,
    markTranscriptsLoading,
    openOverlay,
    openListOverlay,
    closeOverlay,
    selectWorkflow,
    openAgent,
    closeAgent,
    $reset,
  };
});
