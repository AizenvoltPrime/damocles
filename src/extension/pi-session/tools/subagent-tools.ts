/**
 * subagent-tools.ts — The three native subagent tools (Phase 5, US-018.3).
 *
 * `Agent` spawns a nested agent (sync → returns the final result; `run_in_background` → returns an
 * agent_id); `GetSubagentResult` polls/awaits a background agent; `SteerSubagent` injects a message into
 * a running agent. Built per session via `pi.defineTool`. The central permission gate auto-allows the
 * spawn itself (GATE_ALLOW_ALWAYS) — the subagent's OWN tool calls are gated through the per-subagent
 * extension factory at the panel's current mode.
 */

import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../pi-loader';
import { TOOL_AGENT, TOOL_GET_SUBAGENT_RESULT, TOOL_STEER_SUBAGENT } from '../../../shared/tool-names';
import { formatUserSteerPrefix } from '../../../shared/steer';
import { getStatusNote } from '../subagents/status-note';
import { getLifetimeTotal } from '../subagents/usage';
import { buildAgentResultJson } from '../subagents/subagent-stream-bridge';
import type { AgentManager } from '../subagents/agent-manager';
import type { AgentRecord, ThinkingLevel } from '../subagents/types';

const THINKING_VALUES = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;

/** Build the `Agent` parameter schema, advertising the currently-available `subagent_type` values. */
function buildAgentSchema(agents: { name: string; description: string }[]) {
  const typeList = agents.length > 0 ? agents.map((a) => a.name).join(', ') : 'general-purpose';
  return Type.Object(
    {
      description: Type.String({ description: 'A short (3-5 word) description of the task' }),
      prompt: Type.String({ description: 'The task for the agent to perform' }),
      subagent_type: Type.String({ description: `The agent type to use. One of: ${typeList}.` }),
      model: Type.Optional(Type.String({ description: 'Optional model id override for this agent (provider/modelId or a curated value).' })),
      thinking: Type.Optional(Type.Union(THINKING_VALUES.map((v) => Type.Literal(v)), { description: 'Optional thinking level override.' })),
      run_in_background: Type.Optional(Type.Boolean({ description: 'Run asynchronously and return an agent_id to poll with GetSubagentResult.' })),
    },
    { additionalProperties: false },
  );
}

/** The `Agent` tool description, enumerating the available subagent types so the model knows what exists. */
function buildAgentDescription(agents: { name: string; description: string }[]): string {
  const base =
    'Launch a nested in-process agent to handle a focused task. Set run_in_background:true to run asynchronously and poll with GetSubagentResult; otherwise the call blocks and returns the agent\'s final result. Nested agents cannot spawn further agents.';
  if (agents.length === 0) return base;
  const list = agents.map((a) => `- ${a.name}: ${a.description}`).join('\n');
  return `${base}\n\nAvailable subagent_type values:\n${list}`;
}

const getResultSchema = Type.Object(
  {
    agent_id: Type.String({ description: 'The id returned by a background Agent call.' }),
    wait: Type.Optional(Type.Boolean({ description: 'Block until the agent finishes (default: false).' })),
    verbose: Type.Optional(Type.Boolean({ description: 'Return the full conversation transcript instead of just the final result.' })),
  },
  { additionalProperties: false },
);

const steerSchema = Type.Object(
  {
    agent_id: Type.String({ description: 'The id of a running background agent.' }),
    message: Type.String({ description: 'The steering message to inject into the running agent.' }),
  },
  { additionalProperties: false },
);

/** The final-result string the LLM sees, with a status note for non-clean terminal outcomes. */
export function recordResultText(record: AgentRecord): string {
  const base = record.status === 'error' ? record.error ?? 'Subagent failed' : record.result ?? '';
  return formatUserSteerPrefix(record.userSteers) + base + getStatusNote(record.status);
}

/** Build the JSON the webview's Agent-completion path parses, for a finished record. */
function recordResultJson(record: AgentRecord): string {
  return buildAgentResultJson({
    responseText: recordResultText(record),
    agentId: record.id,
    totalDurationMs: (record.completedAt ?? Date.now()) - record.startedAt,
    totalTokens: getLifetimeTotal(record.lifetimeUsage),
    totalToolUseCount: record.toolUses,
  });
}

function textResult(text: string): { content: { type: 'text'; text: string }[]; details: undefined } {
  return { content: [{ type: 'text', text }], details: undefined };
}

type SteerDetails = {
  steerStatus: Awaited<ReturnType<AgentManager['steer']>>;
  agentType?: AgentRecord['type'];
  description?: AgentRecord['description'];
};

function steerResult(text: string, details: SteerDetails): { content: { type: 'text'; text: string }[]; details: SteerDetails } {
  return { content: [{ type: 'text', text }], details };
}

/** Build the three subagent tools for a session whose subagents are run by `manager`. */
export function buildSubagentTools(pi: PiCodingAgentModule, manager: AgentManager): ToolDefinition[] {
  const agents = manager.getSpawnableAgents();
  const agentSchema = buildAgentSchema(agents);
  const agentTool = pi.defineTool<typeof agentSchema, undefined>({
    name: TOOL_AGENT,
    label: 'Agent',
    description: buildAgentDescription(agents),
    parameters: agentSchema,
    executionMode: 'parallel',
    execute: async (toolCallId, params, signal) => {
      const spec = {
        type: params.subagent_type,
        prompt: params.prompt,
        description: params.description,
        toolCallId,
        ...(params.model ? { modelParam: params.model } : {}),
        ...(params.thinking ? { thinking: params.thinking as ThinkingLevel } : {}),
        runInBackground: manager.resolveRunInBackground(params.subagent_type, params.run_in_background),
      };
      if (spec.runInBackground) {
        const id = manager.spawn(spec);
        return textResult(JSON.stringify({ status: 'async_launched', agentId: id }));
      }
      const record = await manager.spawnAndWait({ ...spec, ...(signal ? { signal } : {}) });
      return textResult(recordResultJson(record));
    },
  });

  const getResultTool = pi.defineTool<typeof getResultSchema, undefined>({
    name: TOOL_GET_SUBAGENT_RESULT,
    label: 'Get subagent result',
    description: 'Read (and optionally wait for) the result of a background agent spawned with Agent(run_in_background:true).',
    parameters: getResultSchema,
    execute: async (_toolCallId, params) => {
      const record = manager.getRecord(params.agent_id);
      if (!record) return textResult(`No subagent found with id "${params.agent_id}".`);
      if (params.wait && (record.status === 'running' || record.status === 'queued')) {
        await record.promise;
      }
      if (record.status === 'running' || record.status === 'queued') {
        return textResult(`Subagent "${params.agent_id}" is still ${record.status}. Call again with wait:true to block until it finishes.`);
      }
      record.resultConsumed = true;
      if (params.verbose) {
        const convo = manager.getConversation(params.agent_id);
        return textResult(convo || recordResultText(record));
      }
      return textResult(recordResultText(record));
    },
  });

  const steerTool = pi.defineTool<typeof steerSchema, SteerDetails>({
    name: TOOL_STEER_SUBAGENT,
    label: 'Steer subagent',
    description: 'Inject a message into a running background agent to redirect it mid-task.',
    parameters: steerSchema,
    execute: async (_toolCallId, params) => {
      const status = await manager.steer(params.agent_id, params.message);
      const record = manager.getRecord(params.agent_id);
      const details: SteerDetails = { steerStatus: status, ...(record ? { agentType: record.type, description: record.description } : {}) };
      switch (status) {
        case 'steered':
          return steerResult(`Steering message delivered to subagent "${params.agent_id}".`, details);
        case 'queued':
          return steerResult(`Subagent "${params.agent_id}" is not ready yet; the message was queued and will be delivered when it starts.`, details);
        case 'finished':
          return steerResult(`Subagent "${params.agent_id}" has already finished — nothing to steer.`, details);
        case 'failed':
          return steerResult(`Steering message could NOT be delivered to subagent "${params.agent_id}" (it may be mid-shutdown). Try again or read its result with GetSubagentResult.`, details);
        case 'not-found':
        default:
          return steerResult(`No subagent found with id "${params.agent_id}".`, details);
      }
    },
  });

  return [agentTool, getResultTool, steerTool];
}
