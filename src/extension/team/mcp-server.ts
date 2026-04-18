import type { AgentMcpContext } from './types';

type SdkCreateServer = typeof import('@anthropic-ai/claude-agent-sdk').createSdkMcpServer;
type SdkTool = typeof import('@anthropic-ai/claude-agent-sdk').tool;
type ZodZ = typeof import('zod').z;

const MIN_TASK_LENGTH = 20;
const MAX_MESSAGE_CONTENT_LENGTH = 32_768;
const MAX_SCRATCHPAD_CONTENT_LENGTH = 65_536;

const TEAM_ALLOWED_MODELS = ['claude-opus-4-7[1m]', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'] as const;

function requireReviewRoundReady(ctx: AgentMcpContext): ReturnType<typeof errorResult> | null {
  if (ctx.isReviewRoundReady()) return null;
  const nonSettled = ctx.getNonSettledSpecialistDetails();
  if (nonSettled.length > 0) {
    const list = nonSettled.map(d => `${d.name} (${d.status}, ${d.toolCallCount} tools)`).join(', ');
    return errorResult(
      `Review round not ready — specialists still working: ${list}. ` +
      `Wait for the [REVIEW ROUND READY] system notification.`
    );
  }
  return errorResult('No specialists are awaiting review.');
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

interface TeamServiceRef {
  createTeam: (config: {
    title: string;
    agents: Array<{ name: string; role: 'lead' | 'specialist'; model: string | undefined }>;
  }) => Promise<string>;
  getTeamStatus: (teamId: string) => Record<string, unknown> | null;
  cancelTeam: (teamId: string) => void;
}

export function createTeamMainMcpServer(
  teamService: TeamServiceRef,
  createSdkMcpServer: SdkCreateServer,
  tool: SdkTool,
  z: ZodZ,
): ReturnType<SdkCreateServer> {
  return createSdkMcpServer({
    name: 'damocles-team',
    version: '1.0.0',
    tools: [
      tool(
        'create_team',
        'Create a collaborative team of specialist agents to work together on complex tasks. Use when a task benefits from multiple perspectives (e.g., planning needing architect + frontend + backend, or parallelizable implementation). The lead orchestrates, specialists execute, lead synthesizes the final result. The lead always runs on Opus — do not specify a model for the lead. Blocks until team completes.',
        {
          title: z.string().describe('Team mission/objective'),
          agents: z.array(z.discriminatedUnion('role', [
            z.object({
              name: z.string().describe('Agent name (e.g., "architect")'),
              role: z.literal('lead').describe('Lead role — always runs on Opus, omit the model field'),
            }),
            z.object({
              name: z.string().describe('Agent name (e.g., "frontend-dev")'),
              role: z.literal('specialist'),
              model: z.enum(TEAM_ALLOWED_MODELS).optional().describe('Model for this specialist. Defaults to the current session model'),
            }),
          ])).min(2).max(5).describe('Team roster — 2-5 agents, exactly one lead'),
        },
        async (input) => {
          const leads = input.agents.filter(a => a.role === 'lead');
          if (leads.length !== 1) {
            return errorResult(`Team must have exactly 1 lead agent, got ${leads.length}`);
          }

          try {
            const result = await teamService.createTeam({
              title: input.title,
              agents: input.agents.map(a => a.role === 'lead'
                ? { name: a.name, role: 'lead', model: undefined }
                : { name: a.name, role: 'specialist', model: a.model }),
            });
            return textResult(result);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return errorResult(`Team failed: ${msg}`);
          }
        }
      ),

      tool(
        'get_team_status',
        'Get the current status of a running team.',
        {
          team_id: z.string().describe('Team ID'),
        },
        async (input) => {
          const status = teamService.getTeamStatus(input.team_id);
          if (!status) return errorResult(`Team "${input.team_id}" not found`);
          return textResult(JSON.stringify(status, null, 2));
        },
        { annotations: { readOnlyHint: true } }
      ),

      tool(
        'cancel_team',
        'Cancel a running team, aborting all agents.',
        {
          team_id: z.string().describe('Team ID to cancel'),
        },
        async (input) => {
          try {
            teamService.cancelTeam(input.team_id);
            return textResult(`Team "${input.team_id}" cancelled.`);
          } catch (err) {
            return errorResult(err instanceof Error ? err.message : String(err));
          }
        }
      ),
    ],
  });
}

export function createTeamAgentMcpServer(
  ctx: AgentMcpContext,
  createSdkMcpServer: SdkCreateServer,
  tool: SdkTool,
  z: ZodZ,
): ReturnType<SdkCreateServer> {
  return createSdkMcpServer({
    name: 'damocles-team',
    version: '1.0.0',
    tools: [
      tool(
        'team_send_message',
        'Send a direct message to a teammate by name. Use to report results, ask questions, or send corrections.',
        {
          to: z.string().describe('Recipient agent name'),
          content: z.string().max(MAX_MESSAGE_CONTENT_LENGTH).describe('Message content'),
        },
        async (input) => {
          if (input.to === ctx.agentName) {
            return errorResult('Cannot send a message to yourself');
          }
          const names = ctx.getAgentNames();
          if (!names.includes(input.to)) {
            return errorResult(`Unknown agent "${input.to}". Team members: ${names.join(', ')}`);
          }
          const msg = ctx.messageBus.send(ctx.agentName, input.to, input.content);
          return textResult(`Message sent (id: ${msg.messageId})`);
        }
      ),

      tool(
        'team_read_messages',
        'Read messages sent to you from teammates.',
        {
          since: z.number().optional().describe('Timestamp — only return messages after this time'),
        },
        async (input) => {
          const messages = ctx.messageBus.getInbox(ctx.agentName, input.since);
          if (messages.length === 0) return textResult('No new messages.');
          const formatted = messages.map(m => ({
            from: m.from,
            content: m.content,
            timestamp: m.timestamp,
            id: m.messageId,
          }));
          return textResult(JSON.stringify(formatted));
        },
        { annotations: { readOnlyHint: true } }
      ),

      tool(
        'team_read_scratchpad',
        'Read the shared scratchpad. Optionally read a specific section.',
        {
          section: z.string().optional().describe('Section name to read (omit for all sections)'),
        },
        async (input) => {
          if (input.section) {
            const entry = ctx.scratchpad.get(input.section);
            if (!entry) return textResult(`Section "${input.section}" not found.`);
            return textResult(JSON.stringify({ section: entry.section, content: entry.content, author: entry.author, version: entry.version }));
          }
          const all = ctx.scratchpad.getAll();
          if (all.length === 0) return textResult('Scratchpad is empty.');
          return textResult(JSON.stringify(all.map(e => ({ section: e.section, content: e.content, author: e.author, version: e.version }))));
        },
        { annotations: { readOnlyHint: true } }
      ),

      tool(
        'team_write_scratchpad',
        'Write to the shared scratchpad. Use for API contracts, file ownership, architecture decisions, and shared findings that other agents need.',
        {
          section: z.string().min(1).max(128).describe('Section name (key)'),
          content: z.string().min(1).max(MAX_SCRATCHPAD_CONTENT_LENGTH).describe('Content to write'),
        },
        async (input) => {
          const { version } = ctx.scratchpad.set(input.section, input.content, ctx.agentName);
          return textResult(`Written to '${input.section}' (version ${version})`);
        }
      ),

      tool(
        'team_get_status',
        'Get the current status of all team members.',
        {},
        async () => {
          const status = ctx.getTeamStatus();
          return textResult(JSON.stringify(status, null, 2));
        },
        { annotations: { readOnlyHint: true } }
      ),

      tool(
        'team_spawn_specialist',
        'Spawn a specialist with a self-contained task assignment. Lead-only. The task must include file paths, what to change, and done criteria — specialists cannot see your context.',
        {
          name: z.string().describe('Specialist name from the team roster'),
          task: z.string().min(MIN_TASK_LENGTH).describe('Self-contained task assignment with file paths, what to change, and done criteria'),
          model: z.enum(TEAM_ALLOWED_MODELS).optional().describe('Model for this specialist — defaults to the current session model'),
          profile: z.string().optional().describe('Optional agent profile ID for domain expertise (e.g., "engineering-backend-architect"). See the profile catalog in your system prompt for available IDs.'),
        },
        async (input) => {
          if (ctx.role !== 'lead') {
            return errorResult('Only the lead agent can use this tool');
          }
          try {
            const agentId = ctx.startSpecialist(input.name, input.task, input.model, input.profile);
            return textResult(`Specialist '${input.name}' spawned (id: ${agentId})${input.profile ? ` with profile '${input.profile}'` : ''}`);
          } catch (err) {
            return errorResult(err instanceof Error ? err.message : String(err));
          }
        }
      ),

      tool(
        'team_cancel_specialist',
        'Cancel a running specialist that is stuck or no longer needed. Lead-only. The specialist will be terminated and marked as cancelled.',
        {
          name: z.string().describe('Name of the specialist to cancel'),
        },
        async (input) => {
          if (ctx.role !== 'lead') {
            return errorResult('Only the lead agent can use this tool');
          }
          try {
            const status = ctx.getTeamStatus();
            const agents = status['agents'] as Array<{ name: string; toolCallCount: number; status: string }>;
            const target = agents.find(a => a.name === input.name);
            if (target && target.status === 'running' && target.toolCallCount > 0) {
              const lastCancelAttempt = ctx.getCancelAttemptTimestamp?.(input.name);
              if (!lastCancelAttempt || Date.now() - lastCancelAttempt > 30_000) {
                ctx.recordCancelAttempt?.(input.name);
                return errorResult(
                  `Specialist "${input.name}" is actively working (${target.toolCallCount} tool calls). ` +
                  `Call team_cancel_specialist again within 30 seconds to confirm cancellation. ` +
                  `Consider checking their scratchpad first — they may be about to post findings.`
                );
              }
            }
            ctx.cancelSpecialist(input.name);
            return textResult(`Specialist '${input.name}' cancelled.`);
          } catch (err) {
            return errorResult(err instanceof Error ? err.message : String(err));
          }
        }
      ),

      tool(
        'team_request_revision',
        'Send revision instructions to a specialist in awaiting-review status. Lead-only. Max 2 rounds per specialist.',
        {
          name: z.string().describe('Specialist name'),
          feedback: z.string().min(10).max(MAX_MESSAGE_CONTENT_LENGTH)
            .describe('Specific corrections: what to fix, why, and done criteria'),
        },
        async (input) => {
          if (ctx.role !== 'lead') return errorResult('Only the lead agent can use this tool');
          const gateError = requireReviewRoundReady(ctx);
          if (gateError) return gateError;
          try {
            ctx.requestRevision(input.name, input.feedback);
            return textResult(`Revision request sent to "${input.name}". They will resume and apply corrections.`);
          } catch (err) {
            return errorResult(err instanceof Error ? err.message : String(err));
          }
        }
      ),

      tool(
        'team_approve_specialist',
        'Approve a specialist\'s work after reviewing their scratchpad section. Lead-only. Moves the specialist to completed status. You MUST call this or team_request_revision for every specialist in awaiting-review before you can synthesize.',
        {
          name: z.string().describe('Specialist name to approve'),
        },
        async (input) => {
          if (ctx.role !== 'lead') return errorResult('Only the lead agent can use this tool');
          const gateError = requireReviewRoundReady(ctx);
          if (gateError) return gateError;
          try {
            ctx.approveSpecialist(input.name);
            const remaining = ctx.getUnreviewedSpecialistNames();
            const suffix = remaining.length > 0
              ? ` Still awaiting review: ${remaining.join(', ')}.`
              : ' All specialists reviewed — you may now call team_synthesize_result.';
            return textResult(`Specialist '${input.name}' approved and completed.${suffix}`);
          } catch (err) {
            return errorResult(err instanceof Error ? err.message : String(err));
          }
        }
      ),

      tool(
        'team_standby',
        'Enter standby mode while waiting for peer scratchpad sections or messages. Your session pauses and automatically resumes when any teammate writes to the scratchpad or sends you a message. Use this instead of polling team_read_scratchpad or team_read_messages in a loop. End your response immediately after calling this tool.',
        {},
        async () => {
          if (ctx.role === 'lead') return errorResult('Lead agents do not use standby');
          try {
            ctx.enterStandby(ctx.agentName);
            return textResult('Entering standby. You will be resumed when new peer content arrives. End your response now.');
          } catch (err) {
            return errorResult(err instanceof Error ? err.message : String(err));
          }
        }
      ),

      tool(
        'team_report_complete',
        'Signal that your work is done and enter awaiting-review state. The lead will review your scratchpad section and either approve your work (auto-released on synthesis) or send a revision request. You MUST call this after sending your final report to the lead. End your response immediately after calling this tool.',
        {},
        async () => {
          if (ctx.role === 'lead') return errorResult('Lead agents do not report complete');
          try {
            ctx.reportComplete(ctx.agentName);
            return textResult('Entering awaiting-review. The lead will review your work. End your response now.');
          } catch (err) {
            return errorResult(err instanceof Error ? err.message : String(err));
          }
        }
      ),

      tool(
        'team_synthesize_result',
        'Submit the final team result. Lead-only. Running/pending specialists block synthesis — wait or cancel them. Unreviewed awaiting-review specialists block synthesis — approve or revise them first. Standby specialists are auto-released. Include: summary, files changed, decisions made, test results, remaining work.',
        {
          result: z.string().describe('Comprehensive summary: what was accomplished, files changed, decisions made, verification results, remaining work'),
        },
        async (input) => {
          if (ctx.role !== 'lead') {
            return errorResult('Only the lead agent can use this tool');
          }
          const active = ctx.getActiveSpecialistNames();
          if (active.length > 0) {
            return errorResult(
              `Cannot synthesize while specialists are still active: ${active.join(', ')}. ` +
              `Wait for them to complete or cancel them with team_cancel_specialist.`
            );
          }
          const unreviewed = ctx.getUnreviewedSpecialistNames();
          if (unreviewed.length > 0) {
            return errorResult(
              `Cannot synthesize — these specialists have not been reviewed: ${unreviewed.join(', ')}. ` +
              `Use team_approve_specialist (if work is satisfactory) or team_request_revision (if changes needed) for each.`
            );
          }
          const recentlyCancelled = ctx.getRecentlyCancelledNames?.() ?? [];
          if (recentlyCancelled.length > 0) {
            return errorResult(
              `Cannot synthesize yet — specialists were recently cancelled: ${recentlyCancelled.join(', ')}. ` +
              `Wait at least 30 seconds after cancellation or verify their scratchpad sections have findings before synthesizing.`
            );
          }
          try {
            ctx.synthesizeResult(input.result);
            return textResult('Team completed');
          } catch (err) {
            return errorResult(err instanceof Error ? err.message : String(err));
          }
        }
      ),
    ],
  });
}
