import type { ChatMessage, ToolCall } from './session';
import type { TeamAgentStatus } from './team';
import type { AgentUsageTotals } from '../usage-accounting';
import type { EffortBadgeLevel } from '../effort-badge';

export interface SubagentResult {
  content: string;
  totalDurationMs?: number;
  totalTokens?: number;
  totalToolUseCount?: number;
  sdkAgentId?: string;
}

export interface SubagentState {
  id: string;
  /** Unset while unknown: a resume call's arguments name only the agent id. */
  agentType?: string;
  description: string;
  prompt: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startTime: number;
  endTime?: number;
  messages: ChatMessage[];
  toolCalls: ToolCall[];
  result?: SubagentResult;
  model?: string;
  /** This card's run only: a resume can run at a different level. */
  effort?: EffortBadgeLevel;
  /** Absolute path to the agent's markdown template file, when it ran from one (clickable in the UI). */
  templatePath?: string;
  sdkAgentId?: string;
  messagesSealed: boolean;
  lastAssistantMessage?: string;
  progressSummary?: string;
  isBackground?: boolean;
  /** Set on a resume call's card. `loaded` turns true once the agent's own details replace the id. */
  resume?: { agentId: string; loaded: boolean };
  /** This card's run only: a resumed agent's earlier runs belong to earlier cards. */
  usage?: AgentUsageTotals;
  /** Whether the agent's model bills real dollars; unset falls back to the panel's flag. */
  dollarBilled?: boolean;
}

/** A live agent the `/steer` second-stage picker can target: an Agent-tool subagent or a team member. */
export type SteerTargetInfo =
  | {
      kind: 'subagent';
      id: string;
      agentType: string;
      description: string;
      status: 'running' | 'queued';
      isBackground: boolean;
    }
  | {
      kind: 'team-member';
      id: string;
      teamId: string;
      teamTitle: string;
      memberName: string;
      role: 'lead' | 'specialist';
      status: TeamAgentStatus;
    };
