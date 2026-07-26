import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { PiCodingAgentModule } from '../pi-loader';
import type { AgentMcpContext } from '../../team/types';
import type { ToolCatalogEntry } from '@shared/types/tools';
import { checkReviewActionPrecondition, checkSynthesisReadGate } from '../../team/review-gate';
import { execSafe } from '../checkpoints/exec';

/**
 * Native pi tools backing the multi-agent team system. Tool NAMES are snake_case (`create_team`,
 * `team_send_message`, …) so the Team webview cards key off them directly.
 *
 * Two builders: `buildTeamMainPiTools` (the main coordination tools the PRIMARY agent calls) and
 * `buildTeamAgentPiTools` (the `team_*` tools each TEAM AGENT calls). Both classify as auto-allow
 * coordination tools — they perform no writes and no arbitrary shell; `team_record_verification` is the
 * one exception and is limited to read-only `git rev-parse`/`git status` plus file reads for
 * fingerprinting — via `TEAM_MAIN_PI_TOOL_NAMES`/`TEAM_AGENT_PI_TOOL_NAMES`,
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

export const TEAM_AGENT_SPECS: readonly ToolSpec[] = [
  { name: 'team_send_message', label: 'Send message', description: 'Send a direct message to a teammate.' },
  { name: 'team_read_messages', label: 'Read messages', description: 'Read messages sent to you from teammates.' },
  { name: 'team_read_scratchpad', label: 'Read scratchpad', description: 'Read the shared scratchpad.' },
  { name: 'team_write_scratchpad', label: 'Write scratchpad', description: 'Write to the shared scratchpad.' },
  { name: 'team_get_status', label: 'Team status', description: 'Get the status of all team members.' },
  { name: 'team_spawn_specialist', label: 'Spawn specialist', description: 'Lead-only: spawn a specialist with a task.' },
  { name: 'team_redispatch_specialist', label: 'Redispatch specialist', description: 'Lead-only: re-run a failed or cancelled specialist as a fresh attempt.' },
  { name: 'team_cancel_specialist', label: 'Cancel specialist', description: 'Lead-only: cancel a running specialist.' },
  { name: 'team_request_revision', label: 'Request revision', description: 'Lead-only: send revision instructions.' },
  { name: 'team_approve_specialist', label: 'Approve specialist', description: 'Lead-only: approve a specialist\'s work.' },
  { name: 'team_standby', label: 'Standby', description: 'Pause until peer content arrives.' },
  { name: 'team_report_complete', label: 'Report complete', description: 'Signal work is done, enter awaiting-review.' },
  { name: 'team_flag_brief_conflict', label: 'Flag brief conflict', description: 'Specialist-only: flag a hard conflict with the mission-brief.' },
  { name: 'team_resolve_brief_conflict', label: 'Resolve brief conflict', description: 'Lead-only: reconcile or dismiss a brief-conflict flag.' },
  { name: 'team_record_verification', label: 'Record verification', description: 'Record a verification run (full-suite or scoped) against the current tree fingerprint.' },
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
    brief: string;
    agents: Array<{ name: string; role: 'lead' | 'specialist' }>;
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
    title: Type.String({ minLength: 1, maxLength: 200, description: 'Short team label (≤200 chars). Detailed intent goes in `brief`, not here.' }),
    brief: Type.String({ minLength: 1, maxLength: MAX_SCRATCHPAD_CONTENT_LENGTH, description: 'Authoritative specification for the team — the single source of truth (spec / acceptance criteria / architecture). Put ALL detailed intent HERE, never in title.' }),
    agents: Type.Array(
      Type.Object(
        {
          name: Type.String({ description: 'Agent name (e.g., "architect")' }),
          role: Type.Union(
            [Type.Literal('lead'), Type.Literal('specialist')],
            { description: 'lead orchestrates + synthesizes; specialist does the work' },
          ),
        },
        { additionalProperties: false },
      ),
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

type CreateTeamAgent = { name: string; role: 'lead' | 'specialist' };

/** Build the 3 main team coordination tools the PRIMARY agent calls (blocking `create_team`). */
export function buildTeamMainPiTools(pi: PiCodingAgentModule, teamService: TeamServiceRef): ToolDefinition[] {
  return [
    pi.defineTool<typeof createTeamSchema, undefined>({
      name: 'create_team',
      label: 'create_team',
      description:
        'Create a collaborative team of specialist agents that work together on complex tasks — they message each other and share a scratchpad while the lead orchestrates and synthesizes the result. Use when a task benefits from multiple perspectives or an independent set of eyes, whether or not the work can run in parallel. Put the authoritative spec / acceptance criteria / architecture in `brief` (the team\'s single source of truth) — keep `title` a short label, never a place to smuggle detailed intent. Team agent models and reasoning effort are user-configured in settings (per role: lead, implementor, reviewer); you do not choose them. Blocks until team completes.',
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
            brief: input.brief,
            agents: agents.map((a) => ({ name: a.name, role: a.role })),
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
      { description: 'implementor = writes or changes code; reviewer = code review / QA / audit / devil\'s-advocate. Selects which role slot\'s configured model and reasoning effort the specialist runs under.' },
    ),
    profile: Type.Optional(Type.String({ description: 'Optional agent profile ID for domain expertise (e.g., "engineering-backend-architect"). See the profile catalog in your system prompt for available IDs.' })),
  },
  { additionalProperties: false },
);

const teamRedispatchSpecialistSchema = Type.Object(
  {
    name: Type.String({ description: 'Specialist name from the team roster' }),
    task: Type.String({ minLength: MIN_TASK_LENGTH, description: 'Self-contained task assignment with file paths, what to change, and done criteria' }),
    // REQUIRED (not optional): re-dispatch is a conscious re-classification of the specialist. An omitted
    // `kind` fails schema validation so the model self-corrects on retry — mirrors team_spawn_specialist.
    kind: Type.Union(
      [Type.Literal('implementor'), Type.Literal('reviewer')],
      { description: 'implementor = writes or changes code; reviewer = code review / QA / audit / devil\'s-advocate. Selects which role slot\'s configured model and reasoning effort the specialist runs under.' },
    ),
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

const teamFlagBriefConflictSchema = Type.Object(
  {
    detail: Type.String({ minLength: 10, maxLength: MAX_MESSAGE_CONTENT_LENGTH, description: 'What conflicts with the authoritative mission-brief: the brief requirement, the conflicting task/contract/peer work, and why they are incompatible' }),
  },
  { additionalProperties: false },
);

const teamResolveBriefConflictSchema = Type.Object(
  {
    name: Type.String({ description: 'Specialist whose brief-conflict flag you are resolving' }),
    resolution: Type.String({ minLength: 10, maxLength: MAX_MESSAGE_CONTENT_LENGTH, description: 'Written rationale: how the conflict is reconciled, or why it is dismissed' }),
  },
  { additionalProperties: false },
);

const teamRecordVerificationSchema = Type.Object(
  {
    command: Type.String({ minLength: 1, maxLength: 500, description: 'The exact verification command you ran (e.g. "npx vitest run")' }),
    result: Type.Union(
      [Type.Literal('pass'), Type.Literal('fail')],
      { description: 'Whether the run passed' },
    ),
    // NO fingerprint field, deliberately: the tool computes the tree fingerprint itself from git state.
    // A self-reported fingerprint can be wrong or stale, and a wrong fingerprint makes a reused result
    // unsound — turning the evidence back into the bare claim this ledger exists to replace.
    failures: Type.Optional(Type.String({ maxLength: MAX_MESSAGE_CONTENT_LENGTH, description: 'Summary of failing tests when result is "fail" (names + assertion, not full output)' })),
  },
  { additionalProperties: false },
);

/** Marks a ledger entry whose tree state could not be established (non-git cwd, or a git failure). */
const UNVERIFIABLE_FINGERPRINT = 'unverifiable';
export const MAX_FINGERPRINTED_FILES = 2_000;

/**
 * A fingerprint of the working tree: the HEAD commit plus a hash over every dirty path reported by
 * `git status` and the current content of each one. Any edit — tracked or untracked, staged
 * or not — changes it, which is what makes reusing a peer's recorded result safe rather than a
 * correctness bandaid: a pass recorded before an edit can never satisfy a check after it.
 *
 * Every git flag here is load-bearing, and each one guards against the SAME failure: a path the code
 * cannot open, whose read error is swallowed, leaving the hash covering only status lines and therefore
 * byte-identical across a real edit. That degrades silently into a permanently reusable stale pass.
 *  - `-uall`: git otherwise COLLAPSES an untracked directory to a single `?? dir/` line, hiding every
 *    file inside it.
 *  - `-z`: git otherwise C-quotes any path with non-ASCII, spaces or control chars (`"sm\303\266ke.txt"`),
 *    so the raw bytes do not name a real file. NUL-separated records are unambiguous and unquoted.
 *  - paths resolved against `--show-toplevel`, NOT `cwd`: porcelain paths are always relative to the
 *    repository root, so any workspace opened at a subdirectory would resolve every path to a
 *    nonexistent file.
 * Directories are skipped explicitly rather than left to a swallowed read error, so a genuinely
 * unreadable file is not silently indistinguishable from a directory entry.
 *
 * Fail-soft by contract: a non-git cwd or any git error yields `UNVERIFIABLE_FINGERPRINT` rather than
 * throwing, so recording never breaks an agent's turn. Fail-soft means VISIBLY degraded — exceeding
 * `MAX_FINGERPRINTED_FILES` also yields `UNVERIFIABLE_FINGERPRINT`, because a hash that silently
 * ignores everything past the cap looks exactly as authoritative as a complete one.
 */
async function computeTreeFingerprint(cwd: string): Promise<string> {
  const top = await execSafe('git', ['rev-parse', '--show-toplevel'], undefined, cwd);
  const head = await execSafe('git', ['rev-parse', 'HEAD'], undefined, cwd);
  const status = await execSafe('git', ['status', '--porcelain', '-uall', '-z'], undefined, cwd);
  if (!top.ok || !head.ok || !status.ok) return UNVERIFIABLE_FINGERPRINT;
  const root = top.value.stdout.trim();

  const records = status.value.stdout.split('\0').filter(Boolean);
  const hash = crypto.createHash('sha256');
  hash.update(head.value.stdout.trim());
  let fingerprinted = 0;
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    // Porcelain v1 -z: 2 status chars, a space, then the unquoted path. A rename/copy emits the ORIGIN
    // path as the next record; consume it here so it is never mistaken for a status record of its own.
    const rel = record.slice(3);
    if (record.startsWith('R') || record.startsWith('C')) i++;
    if (++fingerprinted > MAX_FINGERPRINTED_FILES) return UNVERIFIABLE_FINGERPRINT;
    hash.update(record);
    const filePath = path.resolve(root, rel);
    try {
      if ((await fsp.stat(filePath)).isDirectory()) continue;
      hash.update(await fsp.readFile(filePath));
    } catch {
      // Deleted or unreadable: the status record itself already registers the change.
    }
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * How many ledger entries a record call echoes back. The whole ledger goes into the tool result, so an
 * uncapped echo re-injects the full history into context on every single record. The recent entries are
 * what a redundancy check keys on; older ones are stale by fingerprint anyway.
 */
const LEDGER_ECHO_ENTRIES = 25;

function renderLedgerTail(ledger: string): string {
  const lines = ledger.split('\n').filter(Boolean);
  if (lines.length <= LEDGER_ECHO_ENTRIES) return ledger;
  const hidden = lines.length - LEDGER_ECHO_ENTRIES;
  return `…and ${hidden} earlier ${hidden === 1 ? 'entry' : 'entries'} (read the \`verification\` scratchpad section for the full ledger)\n${lines.slice(-LEDGER_ECHO_ENTRIES).join('\n')}`;
}

/** Leading tokens that make up a bare runner invocation (`npx vitest run`, `npm test`, `pnpm jest`). */
const RUNNER_TOKENS = new Set(['npx', 'npm', 'pnpm', 'yarn', 'bun', 'run', 'test', 'exec', '--', 'vitest', 'jest', 'mocha', 'ava']);

/**
 * Flags whose FOLLOWING argument narrows a run to a subset of tests. `-t "storm"` carries no path
 * separator, so a path-shaped heuristic alone would wave it through as full-suite.
 */
const SCOPING_FLAGS = new Set(['-t', '--testNamePattern', '--project', '--dir', '--shard', '--related']);

/**
 * Whether a verification command covers the whole suite.
 *
 * Deliberately conservative: `scope` is the field a peer keys "this run is provably redundant, skip it"
 * on, so mislabelling a filtered run as full-suite lets the next agent skip the real suite on the
 * strength of ten tests — the ledger asserting something false. Only a BARE runner invocation counts as
 * full-suite; the leading runner tokens are consumed, and any positional left over is treated as a
 * filter regardless of shape, because a Vitest positional is a name pattern and need not look like a
 * path. A named script (`npm run test:unit`) is scoped too: its contents are unknowable from here.
 */
function isFullSuiteCommand(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length && RUNNER_TOKENS.has(tokens[i]!)) i++;
  const args = tokens.slice(i);
  return !args.some((a, n) => !a.startsWith('-') || SCOPING_FLAGS.has(a) || SCOPING_FLAGS.has(args[n - 1] ?? ''));
}

const teamSynthesizeResultSchema = Type.Object(
  {
    result: Type.String({ description: 'Comprehensive summary: what was accomplished, files changed, decisions made, verification results, remaining work' }),
  },
  { additionalProperties: false },
);

/**
 * Build the `team_*` tools each team agent calls, closing over its `AgentMcpContext`. `cwd` is passed
 * in (the `createEditTool(pi, cwd)` pattern) because `team_record_verification` computes its own tree
 * fingerprint from git state — the one team tool that needs to see the filesystem.
 */
export function buildTeamAgentPiTools(pi: PiCodingAgentModule, ctx: AgentMcpContext, cwd: string): ToolDefinition[] {
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
        const deliverable = ctx.checkMessageDeliverable(input.to);
        if (!deliverable.ok) {
          throw new TeamToolError(deliverable.error ?? `Cannot message '${input.to}'`);
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
      description: `Spawn a specialist with a self-contained task assignment. Lead-only. The task must include file paths, what to change, and done criteria — specialists cannot see your context. Set \`kind\`: 'implementor' for a specialist that writes or changes code, 'reviewer' for one whose job is review / QA / audit / devil's-advocate (it reads and judges, writes no code). \`kind\` selects which role settings (implementor vs reviewer) apply; the model and reasoning effort for each role are user-configured in settings, not chosen by you. Each roster name can only be spawned once — to re-run a specialist that failed or was cancelled, use team_redispatch_specialist instead.`,
      parameters: teamSpawnSpecialistSchema,
      execute: async (_id, input) => {
        if (ctx.role !== 'lead') {
          throw new TeamToolError('Only the lead agent can use this tool');
        }
        const briefGate = ctx.checkBriefReadGate();
        if (!briefGate.ok) {
          throw new TeamToolError(briefGate.error ?? 'Read the mission-brief section before spawning.');
        }
        const agentId = ctx.startSpecialist(input.name, input.task, input.profile, input.kind);
        return textResult(`Specialist '${input.name}' spawned (id: ${agentId})${input.profile ? ` with profile '${input.profile}'` : ''}`);
      },
    }),

    pi.defineTool<typeof teamRedispatchSpecialistSchema, undefined>({
      name: 'team_redispatch_specialist',
      label: 'team_redispatch_specialist',
      description: `Re-run a \`failed\` or \`cancelled\` specialist as a fresh attempt. Lead-only. Reuses the same agentId and preserves the prior transcript, while per-attempt bookkeeping (review rounds, standby/nudge state) is reset so a full fresh review round can complete. Provide a self-contained task (it can differ from the original) and set \`kind\` as on team_spawn_specialist. A \`completed\` specialist is terminal — cover any gap with team_request_revision or a new task assignment, not a redispatch. The MAX_AGENTS concurrent-agent cap applies.`,
      parameters: teamRedispatchSpecialistSchema,
      execute: async (_id, input) => {
        if (ctx.role !== 'lead') {
          throw new TeamToolError('Only the lead agent can use this tool');
        }
        const briefGate = ctx.checkBriefReadGate();
        if (!briefGate.ok) {
          throw new TeamToolError(briefGate.error ?? 'Read the mission-brief section before spawning.');
        }
        const agentId = ctx.redispatchSpecialist(input.name, input.task, input.profile, input.kind);
        return textResult(`Specialist '${input.name}' re-dispatched (id: ${agentId})${input.profile ? ` with profile '${input.profile}'` : ''}`);
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
      description: 'Enter standby mode ONLY while waiting for specific peer scratchpad sections or messages you are actively waiting on. Your session pauses and automatically resumes when any teammate writes to the scratchpad or sends you a message — standby is the ONLY state in which scratchpad update notifications wake you; while you are working you read shared state with team_read_scratchpad when you need it. This is NOT a terminal "my work is done" state — when your work is complete and verified, call team_report_complete instead, never team_standby. Use this instead of polling team_read_scratchpad or team_read_messages in a loop. End your response immediately after calling this tool.',
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
      description: 'Signal that your work is done and enter awaiting-review state. This is the MANDATED terminal action once your deliverable is complete and verified — it must be your final call, never team_standby. The lead will review your scratchpad section and either approve your work (auto-released on synthesis) or send a revision request. You MUST call this after sending your final report to the lead. End your response immediately after calling this tool.',
      parameters: teamReportCompleteSchema,
      execute: async () => {
        if (ctx.role === 'lead') throw new TeamToolError('Lead agents do not report complete');
        ctx.reportComplete(ctx.agentName);
        return textResult('Entering awaiting-review. The lead will review your work. End your response now.');
      },
    }),

    pi.defineTool<typeof teamFlagBriefConflictSchema, undefined>({
      name: 'team_flag_brief_conflict',
      label: 'team_flag_brief_conflict',
      description: 'Specialist-only HARD STOP: raise a conflict between the authoritative `mission-brief` and the lead\'s contract, your task, or a peer\'s work. Records an open conflict that BLOCKS the lead from synthesizing until it is reconciled, and messages the lead. After calling this, message the lead and enter team_standby — do not proceed on the conflicting work and never bury the conflict in a report footnote.',
      parameters: teamFlagBriefConflictSchema,
      execute: async (_id, input) => {
        if (ctx.role !== 'specialist') {
          throw new TeamToolError('Only a specialist can flag a brief conflict');
        }
        ctx.flagBriefConflict(ctx.agentName, input.detail);
        return textResult('Brief conflict flagged. The lead has been notified and cannot synthesize until it is reconciled. Message the lead and enter team_standby now.');
      },
    }),

    pi.defineTool<typeof teamResolveBriefConflictSchema, undefined>({
      name: 'team_resolve_brief_conflict',
      label: 'team_resolve_brief_conflict',
      description: 'Lead-only: dismiss a specialist\'s brief-conflict flag with a written rationale (accountable record). Use this when the flag is a misunderstanding or an intentional deviation you are accepting. To reconcile by CHANGING the work instead, use team_request_revision — that also clears the flag. Independent of the specialist\'s current status.',
      parameters: teamResolveBriefConflictSchema,
      execute: async (_id, input) => {
        if (ctx.role !== 'lead') {
          throw new TeamToolError('Only the lead agent can use this tool');
        }
        ctx.resolveBriefConflict(input.name, input.resolution);
        return textResult(`Brief conflict flagged by "${input.name}" resolved.`);
      },
    }),

    pi.defineTool<typeof teamRecordVerificationSchema, undefined>({
      name: 'team_record_verification',
      label: 'team_record_verification',
      description:
        'Record a verification run in the shared `verification` ledger, and read back every entry recorded so far. ' +
        'Call it AFTER any verification run, full-suite or scoped; the tool classifies which it was. The tool stamps each entry with a tree fingerprint it computes itself from git state — ' +
        'you do not supply one, and cannot. Before starting a full-suite run, call this tool (or read the `verification` scratchpad section): ' +
        'if a peer already recorded a FULL-SUITE result for the CURRENT fingerprint, that run is provably redundant — reuse their result instead of re-running. ' +
        'The fingerprint changes the moment anyone edits a file, so a result recorded before an edit can never satisfy a check after it.',
      parameters: teamRecordVerificationSchema,
      execute: async (_id, input) => {
        if (input.result === 'pass' && input.failures) {
          throw new TeamToolError('`failures` is only valid when `result` is "fail" — a passing run has none. Drop the field, or record the run as "fail".');
        }
        const fingerprint = await computeTreeFingerprint(cwd);
        const scope = isFullSuiteCommand(input.command) ? 'full-suite' : 'scoped';
        const failures = input.failures ? ` | failures: ${input.failures}` : '';
        const entry =
          `- [${new Date().toISOString()}] ${ctx.agentName} | tree ${fingerprint} | ${scope} | ` +
          `\`${input.command}\` → ${input.result.toUpperCase()}${failures}`;
        const { version } = ctx.recordVerification(entry);
        return textResult(
          `Recorded (verification v${version}, tree ${fingerprint}).\n\nLedger:\n${renderLedgerTail(ctx.readVerificationLedger())}`,
        );
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
        const openConflicts = ctx.getOpenBriefConflicts();
        if (openConflicts.length > 0) {
          const list = openConflicts.map((c) => `${c.name} (${c.detail})`).join('; ');
          throw new TeamToolError(
            `Cannot synthesize — unresolved brief conflicts: ${list}. ` +
              `Reconcile each via team_request_revision (fix the task/contract) or ` +
              `team_resolve_brief_conflict (dismiss with a written rationale) first.`,
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
