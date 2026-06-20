/**
 * pi event → Damocles hook stdin builders. Each returns the JSON object the runner writes to the child's
 * stdin. This is Damocles' own native contract (snake_case keys, the pi event key in `event`, the uniform
 * tool schema produced by `tool-normalization`). Kept free of pi types so it is unit-testable in isolation;
 * the handler wiring extracts the pi-event fields and passes them in.
 */

/** Fields present on every hook payload. */
export interface HookCommon {
  session_id: string;
  transcript_path: string;
  cwd: string;
}

/** A loosely-typed message (from `AgentEndEvent.messages`) flattened to `{role, content}`. */
interface SimpleMessage {
  role: string;
  content: unknown;
}

/** Flatten a pi `AgentMessage` to `{role, content}`: text blocks are joined; other shapes pass through. */
export function messageToSimple(message: { role?: unknown; content?: unknown }): SimpleMessage {
  const role = typeof message.role === 'string' ? message.role : 'assistant';
  const content = message.content;
  if (typeof content === 'string') return { role, content };
  if (Array.isArray(content)) {
    const text = content
      .map((block) =>
        block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
          ? (block as { text: string }).text
          : '',
      )
      .filter((t) => t.length > 0)
      .join('\n');
    return { role, content: text.length > 0 ? text : content };
  }
  return { role, content: content ?? '' };
}

export function buildToolCallPayload(
  common: HookCommon,
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  return { ...common, event: 'tool_call', tool_name: toolName, input };
}

export function buildToolResultPayload(
  common: HookCommon,
  toolName: string,
  input: Record<string, unknown>,
  result: unknown,
): Record<string, unknown> {
  return { ...common, event: 'tool_result', tool_name: toolName, input, result };
}

export function buildInputPayload(common: HookCommon, prompt: string): Record<string, unknown> {
  return { ...common, event: 'input', prompt };
}

export function buildAgentEndPayload(
  common: HookCommon,
  messages: Array<{ role?: unknown; content?: unknown }>,
  opts?: { subagent?: boolean; parentToolUseId?: string },
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ...common,
    event: opts?.subagent ? 'subagent_end' : 'agent_end',
    messages: messages.map(messageToSimple),
  };
  if (opts?.parentToolUseId) payload['parent_tool_use_id'] = opts.parentToolUseId;
  return payload;
}

export interface NotificationFields {
  message: string;
  tool_name: string;
  input: Record<string, unknown>;
  file_path?: string;
  command?: string;
  parentToolUseId?: string;
}

export function buildPermissionRequiredPayload(common: HookCommon, fields: NotificationFields): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ...common,
    event: 'permission_required',
    message: fields.message,
    tool_name: fields.tool_name,
    input: fields.input,
  };
  if (fields.file_path !== undefined) payload['file_path'] = fields.file_path;
  if (fields.command !== undefined) payload['command'] = fields.command;
  if (fields.parentToolUseId !== undefined) payload['parent_tool_use_id'] = fields.parentToolUseId;
  return payload;
}

export function buildSessionStartPayload(common: HookCommon, reason: string): Record<string, unknown> {
  return { ...common, event: 'session_start', reason };
}

export function buildSessionEndPayload(common: HookCommon, reason: string): Record<string, unknown> {
  return { ...common, event: 'session_shutdown', reason };
}

export function buildPreCompactPayload(common: HookCommon): Record<string, unknown> {
  return { ...common, event: 'session_before_compact' };
}

/** Observe-only events carry only the base keys + the pi event key. */
export function buildGenericPayload(common: HookCommon, eventKey: string): Record<string, unknown> {
  return { ...common, event: eventKey };
}

export interface ForkFields {
  /** The entry the fork branches from (the rewound user message's parent), when known. */
  entryId?: string | undefined;
  /** The source (pre-fork) session id; also the `session_id` common key. */
  parentSessionId: string;
  /** The newly branched session id, when a branch file was created. */
  newSessionId?: string | undefined;
}

/**
 * `session_before_fork` payload (Damocles-synthetic — pi only emits this from its in-place `ctx.fork()`
 * command, which Damocles doesn't use; it branches the session file + opens a new panel, so Damocles
 * emits the event itself at the fork point). Observe-only, like `permission_required` / `subagent_end`.
 */
export function buildForkPayload(common: HookCommon, fields: ForkFields): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ...common,
    event: 'session_before_fork',
    parent_session_id: fields.parentSessionId,
  };
  if (fields.entryId !== undefined) payload['entry_id'] = fields.entryId;
  if (fields.newSessionId !== undefined) payload['new_session_id'] = fields.newSessionId;
  return payload;
}
