import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { PiCodingAgentModule } from '../pi-loader';
import type { AgentMcpContext } from '../../team/types';
import type { ToolCatalogEntry } from '@shared/types/tools';
import { checkReviewActionPrecondition, checkSynthesisReadGate } from '../../team/review-gate';

/**
 * Native pi tools backing the multi-agent team system. Tool NAMES are snake_case (`create_team`,
 * `team_send_message`, …) so the Team webview cards key off them directly.
 *
 * Two builders: `buildTeamMainPiTools` (the 3 main coordination tools the PRIMARY agent calls) and
 * `buildTeamAgentPiTools` (the 12 `team_*` tools each TEAM AGENT calls). Both classify as auto-allow
 * coordination tools (they touch no fs/shell) via `TEAM_MAIN_PI_TOOL_NAMES`/`TEAM_AGENT_PI_TOOL_NAMES`,
 * added to the gate's `GATEABLE_MODULE_NAMES`. `TEAM_*_SPECS` are the single source of truth for the
 * names + the Tools-panel catalog.
 */

const MIN_TASK_LENGTH = 20;
const MAX_MESSAGE_CONTENT_LENGTH = 32_768;
const MAX_SCRATCHPAD_CONTENT_LENGTH = 65_536;

interface ToolSpec {
  /** snake_case identity = `defineTool` name = active-set name (webview-card key parity). */
  name: string;
  /** Human-friendly Tools-panel label. */
  label: string;
  /** One-line Tools-panel blurb. */
  description: string;
}

const TEAM_MAIN_SPECS: readonly ToolSpec[] = [
  { name: 'create_team', label: 'Create team', description: 'Spin up a collaborative team of specialist agents.' },
  { name: 'get_team_status', label: 'Get team status', description: 'Get the status of a running team.' },
  { name: 'cancel_team', label: 'Cancel team', description: 'Cancel a running team, aborting all agents.' },
] as const;

const TEAM_AGENT_SPECS: readonly ToolSpec[] = [
  { name: 'team_send_message', label: 'Send message', description: 'Send a direct message to a teammate.' },
  { name: 'team_read_messages', label: 'Read messages', description: 'Read messages sent to you from teammates.' },
  { name: 'team_read_scratchpad', label: 'Read scratchpad', description: 'Read the shared scratchpad.' },
  { name: 'team_write_scratchpad', label: 'Write scratchpad', description: 'Write to the shared scratchpad.' },
  { name: 'team_get_status', label: 'Team status', description: 'Get the status of all team members.' },
  { name: 'team_spawn_specialist', label: 'Spawn specialist', description: 'Lead-only: spawn a specialist with a task.' },
  { name: 'team_cancel_specialist', label: 'Cancel specialist', description: 'Lead-only: cancel a running specialist.' },
  { name: 'team_request_revision', label: 'Request revision', description: 'Lead-only: send revision instructions.' },
  { name: 'team_approve_specialist', label: 'Approve specialist', description: 'Lead-only: approve a specialist\'s work.' },
  { name: 'team_standby', label: 'Standby', description: 'Pause until peer content arrives.' },
  { name: 'team_report_complete', label: 'Report complete', description: 'Signal work is done, enter awaiting-review.' },
  { name: 'team_synthesize_result', label: 'Synthesize result', description: 'Lead-only: submit the final team result.' },
] as const;

export const TEAM_MAIN_PI_TOOL_NAMES: readonly string[] = TEAM_MAIN_SPECS.map((s) => s.name);
export const TEAM_AGENT_PI_TOOL_NAMES: readonly string[] = TEAM_AGENT_SPECS.map((s) => s.name);

export const TEAM_TOOL_CATALOG: readonly ToolCatalogEntry[] = [...TEAM_MAIN_SPECS, ...TEAM_AGENT_SPECS].map((s) => ({
  name: s.name,
  label: s.label,
  description: s.description,
  group: 'team',
  toggleable: true,
}));

function textResult(text: string): AgentToolResult<undefined> {
  return { content: [{ type: 'text', text }], details: undefined };
}

/**
 * The SDK team tools returned `{ content, isError: true }` so the model read the error text and the
 * card rendered failed. pi has no result-level `isError` — a tool signals an error by THROWING (the
 * runtime turns the thrown message into the error tool result the model reads). `TeamToolError` carries
 * the same message text; every error/validation branch throws it instead of returning a flagged result.
 */
class TeamToolError extends Error {}

function requireReviewRoundReady(
  ctx: AgentMcpContext,
  action: 'approve' | 'revise',
): void {
  const decision = checkReviewActionPrecondition(
    ctx.getPendingSpecialistNames(),
    ctx.getNonSettledSpecialistDetails(),
    ctx.isReviewRoundReady(),
    action,
  );
  if (!decision.ok) throw new TeamToolError(decision.error);
}

/** The TeamService surface the 3 main tools drive (blocking: `createTeam` returns the synthesis). */
export interface TeamServiceRef {
  createTeam: (config: {
    title: string;
    agents: Array<{ name: string; role: 'lead' | 'specialist'; model: string | undefined }>;
  }) => Promise<string>;
  getTeamStatus: (teamId: string) => Record<string, unknown> | null;
  cancelTeam: (teamId: string) => void;
  /** Record the spawning `create_team` tool-call id so team transcripts correlate to it. */
  setPendingToolUseId: (toolUseId: string) => void;
  /** Abort the active team (ESC during a team → the `create_team` tool returns an aborted result). */
  cancelActiveTeam: () => void;
}

const createTeamSchema = Type.Object(
  {
    title: Type.String({ description: 'Team mission/objective' }),
    agents: Type.Array(
      Type.Union([
        Type.Object(
          {
            name: Type.String({ description: 'Agent name (e.g., "architect")' }),
            role: Type.Literal('lead', { description: 'Lead role — model is auto-selected by panel backend; omit the model field' }),
          },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            name: Type.String({ description: 'Agent name (e.g., "frontend-dev")' }),
            role: Type.Literal('specialist'),
            model: Type.Optional(Type.String({ description: 'Model for this specialist. Must be one of the panel-backend-aligned models; defaults to the current session model.' })),
          },
          { additionalProperties: false },
        ),
      ]),
      { minItems: 2, maxItems: 5, description: 'Team roster — 2-5 agents, exactly one lead' },
    ),
  },
  { additionalProperties: false },
);

const getTeamStatusSchema = Type.Object(
  { team_id: Type.String({ description: 'Team ID' }) },
  { additionalProperties: false },
);

const cancelTeamSchema = Type.Object(
  { team_id: Type.String({ description: 'Team ID to cancel' }) },
  { additionalProperties: false },
);

type CreateTeamAgent =
  | { name: string; role: 'lead' }
  | { name: string; role: 'specialist'; model?: string };

/** Build the 3 main team coordination tools the PRIMARY agent calls (blocking `create_team`). */
export function buildTeamMainPiTools(pi: PiCodingAgentModule, teamService: TeamServiceRef): ToolDefinition[] {
  return [
    pi.defineTool<typeof createTeamSchema, undefined>({
      name: 'create_team',
      label: 'create_team',
      description:
        'Create a collaborative team of specialist agents that work together on complex tasks — they message each other and share a scratchpad while the lead orchestrates and synthesizes the result. Use when a task benefits from multiple perspectives or an independent set of eyes, whether or not the work can run in parallel. The lead model is auto-selected as the strongest authed model of the panel backend (Anthropic or OpenAI). Specialists default to the current session model. Blocks until team completes.',
      parameters: createTeamSchema,
      execute: async (toolCallId, input, signal) => {
        const agents = input.agents as CreateTeamAgent[];
        const leads = agents.filter((a) => a.role === 'lead');
        if (leads.length !== 1) {
          throw new TeamToolError(`Team must have exactly 1 lead agent, got ${leads.length}`);
        }
        // Correlate the team's transcripts to this `create_team` tool-call id, and wire ESC: aborting
        // the tool aborts the whole team (the team then synthesizes partial results and returns them).
        teamService.setPendingToolUseId(toolCallId);
        const onAbort = (): void => teamService.cancelActiveTeam();
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
          const result = await teamService.createTeam({
            title: input.title,
            agents: agents.map((a) =>
              a.role === 'lead'
                ? { name: a.name, role: 'lead', model: undefined }
                : { name: a.name, role: 'specialist', model: a.model },
            ),
          });
          return textResult(result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new TeamToolError(`Team failed: ${msg}`);
        } finally {
          signal?.removeEventListener('abort', onAbort);
        }
      },
    }),

    pi.defineTool<typeof getTeamStatusSchema, undefined>({
      name: 'get_team_status',
      label: 'get_team_status',
      description: 'Get the current status of a running team.',
      parameters: getTeamStatusSchema,
      execute: async (_id, input) => {
        const status = teamService.getTeamStatus(input.team_id);
        if (!status) throw new TeamToolError(`Team "${input.team_id}" not found`);
        return textResult(JSON.stringify(status, null, 2));
      },
    }),

    pi.defineTool<typeof cancelTeamSchema, undefined>({
      name: 'cancel_team',
      label: 'cancel_team',
      description: 'Cancel a running team, aborting all agents.',
      parameters: cancelTeamSchema,
      execute: async (_id, input) => {
        teamService.cancelTeam(input.team_id);
        return textResult(`Team "${input.team_id}" cancelled.`);
      },
    }),
  ];
}

const teamSendMessageSchema = Type.Object(
  {
    to: Type.String({ description: 'Recipient agent name' }),
    content: Type.String({ maxLength: MAX_MESSAGE_CONTENT_LENGTH, description: 'Message content' }),
  },
  { additionalProperties: false },
);

const teamReadMessagesSchema = Type.Object(
  { since: Type.Optional(Type.Number({ description: 'Timestamp — only return messages after this time' })) },
  { additionalProperties: false },
);

const teamReadScratchpadSchema = Type.Object(
  { section: Type.Optional(Type.String({ description: 'Section name to read (omit for all sections)' })) },
  { additionalProperties: false },
);

const teamWriteScratchpadSchema = Type.Object(
  {
    section: Type.String({ minLength: 1, maxLength: 128, description: 'Section name (key)' }),
    content: Type.String({ minLength: 1, maxLength: MAX_SCRATCHPAD_CONTENT_LENGTH, description: 'Content to write' }),
  },
  { additionalProperties: false },
);

const teamGetStatusSchema = Type.Object({}, { additionalProperties: false });

const teamSpawnSpecialistSchema = Type.Object(
  {
    name: Type.String({ description: 'Specialist name from the team roster' }),
    task: Type.String({ minLength: MIN_TASK_LENGTH, description: 'Self-contained task assignment with file paths, what to change, and done criteria' }),
    // REQUIRED (not optional): the lead must consciously classify every specialist. An omitted `kind`
    // fails schema validation so the model self-corrects on retry. The resolver defaults to 'implementor'
    // only as an internal safety net for non-tool call paths — do NOT relax this to optional.
    kind: Type.Union(
      [Type.Literal('implementor'), Type.Literal('reviewer')],
      { description: 'implementor = writes or changes code; reviewer = code review / QA / audit / devil\'s-advocate. Controls reasoning depth.' },
    ),
    model: Type.Optional(Type.String({ description: 'Model for this specialist — must be an authed model. Defaults to the current session model. Ignored on Anthropic (the model is auto-pinned to Opus 4.8 — omit it).' })),
    profile: Type.Optional(Type.String({ description: 'Optional agent profile ID for domain expertise (e.g., "engineering-backend-architect"). See the profile catalog in your system prompt for available IDs.' })),
  },
  { additionalProperties: false },
);

const teamCancelSpecialistSchema = Type.Object(
  { name: Type.String({ description: 'Name of the specialist to cancel' }) },
  { additionalProperties: false },
);

const teamRequestRevisionSchema = Type.Object(
  {
    name: Type.String({ description: 'Specialist name' }),
    feedback: Type.String({ minLength: 10, maxLength: MAX_MESSAGE_CONTENT_LENGTH, description: 'Specific corrections: what to fix, why, and done criteria' }),
  },
  { additionalProperties: false },
);

const teamApproveSpecialistSchema = Type.Object(
  { name: Type.String({ description: 'Specialist name to approve' }) },
  { additionalProperties: false },
);

const teamStandbySchema = Type.Object({}, { additionalProperties: false });

const teamReportCompleteSchema = Type.Object({}, { additionalProperties: false });

const teamSynthesizeResultSchema = Type.Object(
  {
    result: Type.String({ description: 'Comprehensive summary: what was accomplished, files changed, decisions made, verification results, remaining work' }),
  },
  { additionalProperties: false },
);

/** Build the 12 `team_*` tools each team agent calls, closing over its `AgentMcpContext`. */
export function buildTeamAgentPiTools(pi: PiCodingAgentModule, ctx: AgentMcpContext): ToolDefinition[] {
  return [
    pi.defineTool<typeof teamSendMessageSchema, undefined>({
      name: 'team_send_message',
      label: 'team_send_message',
      description: 'Send a direct message to a teammate by name. Use to report results, ask questions, or send corrections.',
      parameters: teamSendMessageSchema,
      execute: async (_id, input) => {
        if (input.to === ctx.agentName) {
          throw new TeamToolError('Cannot send a message to yourself');
        }
        const names = ctx.getAgentNames();
        if (!names.includes(input.to)) {
          throw new TeamToolError(`Unknown agent "${input.to}". Team members: ${names.join(', ')}`);
        }
        const msg = ctx.messageBus.send(ctx.agentName, input.to, input.content);
        return textResult(`Message sent (id: ${msg.messageId})`);
      },
    }),

    pi.defineTool<typeof teamReadMessagesSchema, undefined>({
      name: 'team_read_messages',
      label: 'team_read_messages',
      description: 'Read messages sent to you from teammates.',
      parameters: teamReadMessagesSchema,
      execute: async (_id, input) => {
        const messages = ctx.messageBus.getInbox(ctx.agentName, input.since);
        if (messages.length === 0) return textResult('No new messages.');
        const formatted = messages.map((m) => ({
          from: m.from,
          content: m.content,
          timestamp: m.timestamp,
          id: m.messageId,
        }));
        return textResult(JSON.stringify(formatted));
      },
    }),

    pi.defineTool<typeof teamReadScratchpadSchema, undefined>({
      name: 'team_read_scratchpad',
      label: 'team_read_scratchpad',
      description: 'Read the shared scratchpad. Optionally read a specific section.',
      parameters: teamReadScratchpadSchema,
      execute: async (_id, input) => {
        if (input.section) {
          const entry = ctx.scratchpad.get(input.section);
          if (!entry) return textResult(`Section "${input.section}" not found.`);
          ctx.scratchpad.markRead(ctx.agentName, input.section);
          return textResult(JSON.stringify({ section: entry.section, content: entry.content, author: entry.author, version: entry.version }));
        }
        const all = ctx.scratchpad.getAll();
        if (all.length === 0) return textResult('Scratchpad is empty.');
        ctx.scratchpad.markAllRead(ctx.agentName);
        return textResult(JSON.stringify(all.map((e) => ({ section: e.section, content: e.content, author: e.author, version: e.version }))));
      },
    }),

    pi.defineTool<typeof teamWriteScratchpadSchema, undefined>({
      name: 'team_write_scratchpad',
      label: 'team_write_scratchpad',
      description: 'Write to the shared scratchpad. Use for API contracts, file ownership, architecture decisions, and shared findings that other agents need.',
      parameters: teamWriteScratchpadSchema,
      execute: async (_id, input) => {
        const { version } = ctx.scratchpad.set(input.section, input.content, ctx.agentName);
        return textResult(`Written to '${input.section}' (version ${version})`);
      },
    }),

    pi.defineTool<typeof teamGetStatusSchema, undefined>({
      name: 'team_get_status',
      label: 'team_get_status',
      description: 'Get the current status of all team members.',
      parameters: teamGetStatusSchema,
      execute: async () => {
        const status = ctx.getTeamStatus();
        return textResult(JSON.stringify(status, null, 2));
      },
    }),

    pi.defineTool<typeof teamSpawnSpecialistSchema, undefined>({
      name: 'team_spawn_specialist',
      label: 'team_spawn_specialist',
      description: `Spawn a specialist with a self-contained task assignment. Lead-only. The task must include file paths, what to change, and done criteria — specialists cannot see your context. Set \`kind\`: 'implementor' for a specialist that writes or changes code, 'reviewer' for one whose job is review / QA / audit / devil's-advocate (it reads and judges, writes no code); kind only sets reasoning depth. On Anthropic the specialist model is auto-pinned to Opus 4.8 — the \`model\` arg is ignored, so omit it. Allowed models: ${ctx.allowedSpecialistModels.join(', ')}.`,
      parameters: teamSpawnSpecialistSchema,
      execute: async (_id, input) => {
        if (ctx.role !== 'lead') {
          throw new TeamToolError('Only the lead agent can use this tool');
        }
        if (!ctx.specialistModelForced && input.model !== undefined && !ctx.allowedSpecialistModels.includes(input.model)) {
          throw new TeamToolError(`Model "${input.model}" is not allowed for this team. Allowed: ${ctx.allowedSpecialistModels.join(', ')}`);
        }
        const agentId = ctx.startSpecialist(input.name, input.task, input.model, input.profile, input.kind);
        return textResult(`Specialist '${input.name}' spawned (id: ${agentId})${input.profile ? ` with profile '${input.profile}'` : ''}`);
      },
    }),

    pi.defineTool<typeof teamCancelSpecialistSchema, undefined>({
      name: 'team_cancel_specialist',
      label: 'team_cancel_specialist',
      description: 'Cancel a running specialist that is stuck or no longer needed. Lead-only. The specialist will be terminated and marked as cancelled.',
      parameters: teamCancelSpecialistSchema,
      execute: async (_id, input) => {
        if (ctx.role !== 'lead') {
          throw new TeamToolError('Only the lead agent can use this tool');
        }
        const status = ctx.getTeamStatus();
        const agents = status['agents'] as Array<{ name: string; toolCallCount: number; status: string }>;
        const target = agents.find((a) => a.name === input.name);
        if (target && target.status === 'running' && target.toolCallCount > 0) {
          const lastCancelAttempt = ctx.getCancelAttemptTimestamp?.(input.name);
          if (!lastCancelAttempt || Date.now() - lastCancelAttempt > 30_000) {
            ctx.recordCancelAttempt?.(input.name);
            throw new TeamToolError(
              `Specialist "${input.name}" is actively working (${target.toolCallCount} tool calls). ` +
                `Call team_cancel_specialist again within 30 seconds to confirm cancellation. ` +
                `Consider checking their scratchpad first — they may be about to post findings.`,
            );
          }
        }
        ctx.cancelSpecialist(input.name);
        return textResult(`Specialist '${input.name}' cancelled.`);
      },
    }),

    pi.defineTool<typeof teamRequestRevisionSchema, undefined>({
      name: 'team_request_revision',
      label: 'team_request_revision',
      description: 'Send revision instructions to a specialist in awaiting-review status. Lead-only. Max 2 rounds per specialist.',
      parameters: teamRequestRevisionSchema,
      execute: async (_id, input) => {
        if (ctx.role !== 'lead') throw new TeamToolError('Only the lead agent can use this tool');
        requireReviewRoundReady(ctx, 'revise');
        ctx.requestRevision(input.name, input.feedback);
        return textResult(`Revision request sent to "${input.name}". They will resume and apply corrections.`);
      },
    }),

    pi.defineTool<typeof teamApproveSpecialistSchema, undefined>({
      name: 'team_approve_specialist',
      label: 'team_approve_specialist',
      description: 'Approve a specialist\'s work after reviewing their scratchpad section. Lead-only. Moves the specialist to completed status. You MUST call this or team_request_revision for every specialist in awaiting-review before you can synthesize.',
      parameters: teamApproveSpecialistSchema,
      execute: async (_id, input) => {
        if (ctx.role !== 'lead') throw new TeamToolError('Only the lead agent can use this tool');
        requireReviewRoundReady(ctx, 'approve');
        ctx.approveSpecialist(input.name);
        const remaining = ctx.getUnreviewedSpecialistNames();
        const pending = ctx.getPendingSpecialistNames();
        let suffix: string;
        if (remaining.length > 0) {
          suffix = ` Still awaiting review: ${remaining.join(', ')}.`;
        } else if (pending.length > 0) {
          suffix = ` All dispatched specialists reviewed. Pending (never dispatched): ${pending.join(', ')}. ` +
            `Either spawn them with team_spawn_specialist or cancel them with team_cancel_specialist before synthesizing.`;
        } else {
          suffix = ' All specialists reviewed — you may now call team_synthesize_result.';
        }
        return textResult(`Specialist '${input.name}' approved and completed.${suffix}`);
      },
    }),

    pi.defineTool<typeof teamStandbySchema, undefined>({
      name: 'team_standby',
      label: 'team_standby',
      description: 'Enter standby mode while waiting for peer scratchpad sections or messages. Your session pauses and automatically resumes when any teammate writes to the scratchpad or sends you a message. Use this instead of polling team_read_scratchpad or team_read_messages in a loop. End your response immediately after calling this tool.',
      parameters: teamStandbySchema,
      execute: async () => {
        if (ctx.role === 'lead') throw new TeamToolError('Lead agents do not use standby');
        ctx.enterStandby(ctx.agentName);
        return textResult('Entering standby. You will be resumed when new peer content arrives. End your response now.');
      },
    }),

    pi.defineTool<typeof teamReportCompleteSchema, undefined>({
      name: 'team_report_complete',
      label: 'team_report_complete',
      description: 'Signal that your work is done and enter awaiting-review state. The lead will review your scratchpad section and either approve your work (auto-released on synthesis) or send a revision request. You MUST call this after sending your final report to the lead. End your response immediately after calling this tool.',
      parameters: teamReportCompleteSchema,
      execute: async () => {
        if (ctx.role === 'lead') throw new TeamToolError('Lead agents do not report complete');
        ctx.reportComplete(ctx.agentName);
        return textResult('Entering awaiting-review. The lead will review your work. End your response now.');
      },
    }),

    pi.defineTool<typeof teamSynthesizeResultSchema, undefined>({
      name: 'team_synthesize_result',
      label: 'team_synthesize_result',
      description: 'Submit the final team result. Lead-only. Never-dispatched (pending) specialists block synthesis — spawn with team_spawn_specialist or cancel with team_cancel_specialist. Running specialists block synthesis — wait for completion or cancel them. Unreviewed awaiting-review specialists block synthesis — approve or revise them first. Standby specialists are auto-released. Failed specialists (runner crash) pass through — read their scratchpad section if any and document the failure in your result. Include: summary, files changed, decisions made, test results, remaining work.',
      parameters: teamSynthesizeResultSchema,
      execute: async (_id, input) => {
        if (ctx.role !== 'lead') {
          throw new TeamToolError('Only the lead agent can use this tool');
        }
        const pending = ctx.getPendingSpecialistNames();
        if (pending.length > 0) {
          throw new TeamToolError(
            `Cannot synthesize — these specialists were never dispatched: ${pending.join(', ')}. ` +
              `Either spawn them with team_spawn_specialist or remove them with team_cancel_specialist before synthesizing.`,
          );
        }
        const active = ctx.getActiveSpecialistNames();
        if (active.length > 0) {
          throw new TeamToolError(
            `Cannot synthesize while specialists are still active: ${active.join(', ')}. ` +
              `Wait for them to complete or cancel them with team_cancel_specialist.`,
          );
        }
        const unreviewed = ctx.getUnreviewedSpecialistNames();
        if (unreviewed.length > 0) {
          throw new TeamToolError(
            `Cannot synthesize — these specialists have not been reviewed: ${unreviewed.join(', ')}. ` +
              `Use team_approve_specialist (if work is satisfactory) or team_request_revision (if changes needed) for each.`,
          );
        }
        const recentlyCancelled = ctx.getRecentlyCancelledNames?.() ?? [];
        if (recentlyCancelled.length > 0) {
          throw new TeamToolError(
            `Cannot synthesize yet — specialists were recently cancelled: ${recentlyCancelled.join(', ')}. ` +
              `Wait at least 30 seconds after cancellation or verify their scratchpad sections have findings before synthesizing.`,
          );
        }
        const specialists = ctx.getAllAgents().filter((a) => a.role === 'specialist');
        const participated = specialists.some((a) =>
          a.status === 'completed'
          || a.status === 'awaiting-review'
          || ctx.scratchpad.getSectionsAuthoredBy(a.name).length > 0,
        );
        if (specialists.length > 0 && !participated) {
          throw new TeamToolError(
            `Cannot synthesize — no specialist contributed findings or reached review. ` +
              `Every dispatched specialist was cancelled before authoring a scratchpad section. ` +
              `Spawn fresh specialists with team_spawn_specialist or abort the team.`,
          );
        }
        const synthesisGate = checkSynthesisReadGate(
          specialists.map((a) => a.name),
          ctx.scratchpad,
          ctx.agentName,
        );
        if (!synthesisGate.ok) {
          throw new TeamToolError(synthesisGate.error ?? 'Synthesis read gate failed');
        }
        ctx.synthesizeResult(input.result);
        return textResult('Team completed');
      },
    }),
  ];
}
