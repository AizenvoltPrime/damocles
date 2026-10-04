import { computed, ref, type ComputedRef, type Ref } from 'vue';
import type { TeamAgent, TeamAgentStatus, TeamState } from '@shared/types/team';
import { useTeamStore } from '@/stores/useTeamStore';
import { workingAgentCount } from './useTeamFormatting';
import { usePlatformBridge } from './usePlatformBridge';

export interface StopTeam {
  canStop: ComputedRef<boolean>;
  stopping: ComputedRef<boolean>;
  workingCount: ComputedRef<number>;
  /** Whether the confirmation is open. */
  confirming: Ref<boolean>;
  request: () => void;
  confirm: () => void;
  cancel: () => void;
}

/** The user's Stop team behind its confirmation, shared by the team overlay, the lead's Stop and the team card. */
export function useStopTeam(team: () => TeamState | null | undefined): StopTeam {
  const store = useTeamStore();
  const { postMessage } = usePlatformBridge();
  const confirming = ref(false);

  // A `pending-` team is a card the extension has not named yet, so there is no team to stop.
  const canStop = computed(() => {
    const current = team();
    return current?.status === 'running' && !current.teamId.startsWith('pending-');
  });
  const stopping = computed(() => {
    const current = team();
    return current !== null && current !== undefined && store.isCancelPending(current.teamId);
  });
  const workingCount = computed(() => workingAgentCount(team()?.agents ?? []));

  function request(): void {
    if (canStop.value && !stopping.value) confirming.value = true;
  }

  function confirm(): void {
    confirming.value = false;
    const current = team();
    // The team may have finished while the confirmation was open.
    if (!current || !canStop.value || stopping.value) return;
    store.markCancelRequested(current.teamId);
    postMessage({ type: 'cancelTeam', teamId: current.teamId });
  }

  function cancel(): void {
    confirming.value = false;
  }

  return { canStop, stopping, workingCount, confirming, request, confirm, cancel };
}

export interface StopTeamAgent {
  canStop: ComputedRef<boolean>;
  stopping: ComputedRef<boolean>;
  stop: () => void;
}

// The statuses core's `TeamRunner.cancelAgent` accepts.
const STOPPABLE: ReadonlySet<TeamAgentStatus> = new Set(['running', 'pending', 'awaiting-review', 'standby']);

/** The user's Stop of one specialist, shared by its card and its overlay; the lead stops only with its team (`useStopTeam`). */
export function useStopTeamAgent(team: () => TeamState | null | undefined, agent: () => TeamAgent | null | undefined): StopTeamAgent {
  const store = useTeamStore();
  const { postMessage } = usePlatformBridge();

  const canStop = computed(() => {
    const current = team();
    const member = agent();
    if (!current || !member) return false;
    return STOPPABLE.has(member.status) && current.status === 'running' && current.phase !== 'synthesizing';
  });
  const stopping = computed(() => {
    const member = agent();
    return member !== null && member !== undefined && store.isAgentCancelPending(member);
  });

  function stop(): void {
    const current = team();
    const member = agent();
    if (!current || !member || !canStop.value || stopping.value) return;
    store.markAgentCancelRequested(member);
    postMessage({ type: 'cancelTeamAgent', teamId: current.teamId, agentId: member.agentId });
  }

  return { canStop, stopping, stop };
}
