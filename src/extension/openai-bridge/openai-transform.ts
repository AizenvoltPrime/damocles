import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

export type CodexEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';
export type CodexVerbosity = 'low' | 'medium' | 'high';

export interface CodexTool {
  type: 'function';
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export type CodexToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; name: string };

export interface CodexInputTextPart {
  type: 'input_text' | 'output_text';
  text: string;
}

export interface CodexInputImagePart {
  type: 'input_image';
  image_url: string;
}

export type CodexInputContentPart = CodexInputTextPart | CodexInputImagePart;

export interface CodexInputMessage {
  type: 'message';
  role: 'user' | 'assistant' | 'developer';
  content: string | CodexInputContentPart[];
}

export interface CodexFunctionCallInput {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

export interface CodexFunctionCallOutput {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

export type CodexInputItem =
  | CodexInputMessage
  | CodexFunctionCallInput
  | CodexFunctionCallOutput;

export interface CodexRequest {
  model: string;
  instructions: string;
  input: CodexInputItem[];
  stream: boolean;
  store: false;
  reasoning: { effort: CodexEffort; summary: 'auto' };
  text: { verbosity: CodexVerbosity };
  tools?: CodexTool[];
  tool_choice?: CodexToolChoice;
  parallel_tool_calls?: boolean;
  prompt_cache_key?: string;
}

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
  cache_control?: unknown;
}

export interface AnthropicImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
  cache_control?: unknown;
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
  cache_control?: unknown;
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | AnthropicContentBlock[];
  is_error?: boolean;
  cache_control?: unknown;
}

export interface AnthropicThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
  cache_control?: unknown;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock;

export interface AnthropicMessage {
  /**
   * Anthropic only documents `user`/`assistant`, but the Claude Code CLI emits `system`/`developer`
   * messages in `messages[]` (e.g. trailing system reminders). The Codex backend rejects a
   * `system`-role input item, so the translator normalizes those to `developer`.
   */
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export type AnthropicToolChoice =
  | { type: 'auto' | 'any' | 'none' }
  | { type: 'tool'; name: string };

export interface AnthropicRequest {
  model: string;
  max_tokens?: number;
  messages: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  parallel_tool_calls?: boolean;
}

export interface TranslateRequestOptions {
  codexModel: string;
  effort?: CodexEffort;
  verbosity?: CodexVerbosity;
  promptCacheKey?: string;
}

export interface TranslatedRequest {
  body: CodexRequest;
  toolNameMap: Map<string, string>;
}

export class MessagesOverLimitError extends Error {
  readonly received: number;
  readonly limit: number;
  constructor(received: number, limit: number) {
    super(
      `Anthropic request has ${received} messages, exceeding the Codex limit of ${limit}.`,
    );
    this.name = 'MessagesOverLimitError';
    this.received = received;
    this.limit = limit;
  }
}

export class ToolsOverLimitError extends Error {
  readonly received: number;
  readonly limit: number;
  constructor(received: number, limit: number) {
    super(
      `Anthropic request has ${received} tools, exceeding the Codex limit of ${limit}.`,
    );
    this.name = 'ToolsOverLimitError';
    this.received = received;
    this.limit = limit;
  }
}

export const MESSAGES_LIMIT = 100;
export const TOOLS_LIMIT = 50;

const BILLING_HEADER_LINE_PATTERN = /^[ \t]*x-anthropic-[a-z0-9-]+:.*$/gim;

const MUTATING_TOOL_NAME_PATTERNS: RegExp[] = [
  /(^|[_-])edit($|[_-])/i,
  /(^|[_-])update($|[_-])/i,
  /(^|[_-])write($|[_-])/i,
  /(^|[_-])replace($|[_-])/i,
  /(^|[_-])delete($|[_-])/i,
  /(^|[_-])create($|[_-])/i,
  /(^|[_-])insert($|[_-])/i,
  /(^|[_-])move($|[_-])/i,
  /(^|[_-])rename($|[_-])/i,
];

const TOOL_PRIORITY: Record<string, number> = {
  Agent: 1,
  Bash: 1,
  Read: 1,
  Edit: 1,
  Write: 1,
  Glob: 1,
  Grep: 1,
  WebSearch: 1,
  WebFetch: 1,
  ExitPlanMode: 2,
  EnterPlanMode: 2,
  Skill: 2,
  TaskCreate: 2,
  TaskUpdate: 2,
  TaskList: 2,
  AskUserQuestion: 2,
  TaskOutput: 3,
  TaskStop: 3,
  TaskGet: 3,
  EnterWorktree: 3,
  NotebookEdit: 3,
  SendMessage: 3,
};

const CODEX_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Forces GPT-5.x to execute after plan approval instead of acknowledging conversationally. */
const EXIT_PLAN_MODE_TOOL_NAME = 'ExitPlanMode';
const PLAN_APPROVAL_DIRECTIVE =
  '\n\n---\nCRITICAL EXECUTION DIRECTIVE: Your next response MUST begin with a tool call (Edit, Write, Bash, or another mutating tool) that implements the approved plan. Do NOT respond with narration, a summary of next steps, or a confirmation message. Do NOT say "Plan approved" or "Next step is to". Take the first concrete implementation action immediately. If the plan involves multiple files, start with the first one now.';

/**
 * Walk inbound messages to collect tool_use ids whose name is ExitPlanMode. Used to scope
 * the post-plan-approval execution directive to genuine plan-approval results — appending
 * by tool_use_id defeats a prompt-injection vector where any MCP tool whose output begins
 * with "User has approved your plan" would otherwise inherit the directive.
 */
function collectExitPlanToolUseIds(messages: AnthropicMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const msg of messages) {
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.name === EXIT_PLAN_MODE_TOOL_NAME) {
        ids.add(block.id);
      }
    }
  }
  return ids;
}

function appendPlanApprovalDirective(output: string, isExitPlanResult: boolean): string {
  if (!isExitPlanResult || typeof output !== 'string') return output;
  return output + PLAN_APPROVAL_DIRECTIVE;
}

/** Drops top-level empty-string keys; defeats GPT-5.x quirk of filling optional string args with `""`. */
function stripEmptyStringArgs(argsJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return argsJson;
  }
  if (!isPlainObject(parsed)) return argsJson;
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'string' && v === '') continue;
    cleaned[k] = v;
  }
  return JSON.stringify(cleaned);
}

function stripBillingHeaderLines(text: string): string {
  return text.replace(BILLING_HEADER_LINE_PATTERN, '').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
}

function extractSystemPrompt(system: string | AnthropicContentBlock[] | undefined): string {
  if (!system) return '';
  if (typeof system === 'string') return stripBillingHeaderLines(system);

  const parts: string[] = [];
  for (const block of system) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      parts.push(stripBillingHeaderLines(block.text));
    }
  }
  return parts.filter(Boolean).join('\n');
}

function resolveEffortStrict(codexModel: string, override: CodexEffort | undefined): CodexEffort {
  if (override) return override;
  throw new Error(
    `translateAnthropicToCodex requires an explicit reasoning.effort for model "${codexModel}". ` +
    `Callers must supply TranslateRequestOptions.effort sourced from ModelInfo.openaiReasoningEffort or a user override.`,
  );
}

function isMutatingToolName(name: string): boolean {
  return MUTATING_TOOL_NAME_PATTERNS.some(p => p.test(name));
}

function shouldDisableParallelToolCalls(req: AnthropicRequest): boolean {
  if (!req.parallel_tool_calls) return false;
  const mutatingTools = (req.tools ?? []).filter(t => isMutatingToolName(t.name));
  if (mutatingTools.length > 0) return true;
  if (req.tool_choice?.type === 'tool') return isMutatingToolName(req.tool_choice.name);
  return false;
}

function normalizeToolParameters(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const normalized: Record<string, unknown> = isPlainObject(schema) ? { ...schema } : {};
  if (typeof normalized['type'] !== 'string') normalized['type'] = 'object';
  if (normalized['type'] === 'object') {
    if (!isPlainObject(normalized['properties'])) normalized['properties'] = {};
    if (!Array.isArray(normalized['required'])) delete normalized['required'];
    if (typeof normalized['additionalProperties'] === 'undefined') {
      normalized['additionalProperties'] = true;
    }
  }
  return normalized;
}

function safeToolName(originalName: string): string {
  const hash = createHash('sha1').update(originalName).digest('hex').slice(0, 8);
  return `mcp_${hash}`;
}

function mapToolChoice(
  choice: AnthropicToolChoice | undefined,
  hasTools: boolean,
  toolNameForward: Map<string, string>,
): CodexToolChoice | undefined {
  if (!choice) return hasTools ? 'auto' : undefined;
  if (choice.type === 'auto') return 'auto';
  if (choice.type === 'none') return 'none';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'tool') {
    const mapped = toolNameForward.get(choice.name) ?? choice.name;
    return { type: 'function', name: mapped };
  }
  return 'auto';
}

function flattenToolResultContent(
  content: string | AnthropicContentBlock[] | undefined,
  isError: boolean,
): string {
  if (typeof content === 'undefined') return isError ? 'Tool execution failed' : '';
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

function serializeUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * The Responses API `input` accepts only `user`/`assistant`/`developer` message roles; a `system`
 * role is rejected by the Codex backend ("System messages are not allowed"). Map any non-assistant,
 * non-user role (`system`, `developer`, anything unexpected) to `developer` — GPT-5.x's system-role
 * replacement — preserving the content instead of dropping it.
 */
function normalizeInputRole(role: string): 'user' | 'assistant' | 'developer' {
  if (role === 'assistant') return 'assistant';
  if (role === 'user') return 'user';
  return 'developer';
}

function contentToInputItems(
  rawRole: string,
  content: string | AnthropicContentBlock[],
  toolNameForward: Map<string, string>,
  exitPlanToolUseIds: Set<string>,
): CodexInputItem[] {
  const role = normalizeInputRole(rawRole);
  const textPartType: CodexInputTextPart['type'] = role === 'assistant' ? 'output_text' : 'input_text';

  if (typeof content === 'string') {
    const scrubbed = stripBillingHeaderLines(content).trim();
    if (scrubbed.length === 0) return [];
    return [{ type: 'message', role, content: [{ type: textPartType, text: scrubbed }] }];
  }

  const items: CodexInputItem[] = [];
  const messageParts: CodexInputContentPart[] = [];

  const flushMessageParts = () => {
    if (messageParts.length === 0) return;
    items.push({ type: 'message', role, content: [...messageParts] });
    messageParts.length = 0;
  };

  for (const block of content) {
    if (block.type === 'thinking') continue;

    if (block.type === 'text') {
      const text = stripBillingHeaderLines(block.text ?? '').trim();
      if (!text) continue;
      messageParts.push({ type: textPartType, text });
      continue;
    }

    if (block.type === 'image') {
      const mediaType = block.source?.media_type?.trim();
      const data = block.source?.data?.trim();
      if (mediaType && data) {
        messageParts.push({
          type: 'input_image',
          image_url: `data:${mediaType};base64,${data}`,
        });
      }
      continue;
    }

    if (block.type === 'tool_use') {
      flushMessageParts();
      const name = toolNameForward.get(block.name) ?? block.name;
      items.push({
        type: 'function_call',
        call_id: block.id,
        name,
        arguments: serializeUnknown(block.input ?? {}),
      });
      continue;
    }

    if (block.type === 'tool_result') {
      flushMessageParts();
      items.push({
        type: 'function_call_output',
        call_id: block.tool_use_id,
        output: appendPlanApprovalDirective(
          flattenToolResultContent(block.content, Boolean(block.is_error)),
          exitPlanToolUseIds.has(block.tool_use_id),
        ),
      });
      continue;
    }
  }

  flushMessageParts();
  return items;
}

function buildToolNameMaps(tools: AnthropicTool[]): {
  forward: Map<string, string>;
  reverse: Map<string, string>;
} {
  const forward = new Map<string, string>();
  const reverse = new Map<string, string>();
  for (const tool of tools) {
    if (CODEX_NAME_PATTERN.test(tool.name)) continue;
    let safe = safeToolName(tool.name);
    /** Disambiguate SHA1-32-bit collisions with _<counter> suffix; preserves reverse-map fidelity. */
    if (reverse.has(safe) && reverse.get(safe) !== tool.name) {
      let counter = 1;
      let candidate = `${safe}_${counter}`;
      while (reverse.has(candidate) && reverse.get(candidate) !== tool.name) {
        counter++;
        candidate = `${safe}_${counter}`;
      }
      safe = candidate;
    }
    forward.set(tool.name, safe);
    reverse.set(safe, tool.name);
  }
  return { forward, reverse };
}

function mapAnthropicToolsToCodex(tools: AnthropicTool[], forward: Map<string, string>): CodexTool[] {
  return tools.map(tool => {
    const name = forward.get(tool.name) ?? tool.name;
    const codexTool: CodexTool = {
      type: 'function',
      name,
      parameters: normalizeToolParameters(tool.input_schema),
    };
    if (typeof tool.description === 'string' && tool.description.length > 0) {
      codexTool.description = tool.description;
    }
    return codexTool;
  });
}

function filterToolsByPriority(tools: CodexTool[], reverse: Map<string, string>, maxCount: number): CodexTool[] {
  const sorted = [...tools].sort((a, b) => {
    const aOriginal = reverse.get(a.name) ?? a.name;
    const bOriginal = reverse.get(b.name) ?? b.name;
    const aPriority = TOOL_PRIORITY[aOriginal] ?? 999;
    const bPriority = TOOL_PRIORITY[bOriginal] ?? 999;
    if (aPriority !== bPriority) return aPriority - bPriority;
    return tools.indexOf(a) - tools.indexOf(b);
  });
  return sorted.slice(0, maxCount);
}

function truncatePromptCacheKey(key: string): string {
  if (key.length <= 64) return key;
  return key.slice(0, 64);
}

export function translateAnthropicToCodex(
  req: AnthropicRequest,
  options: TranslateRequestOptions,
): TranslatedRequest {
  const messages = req.messages ?? [];
  if (messages.length > MESSAGES_LIMIT) {
    throw new MessagesOverLimitError(messages.length, MESSAGES_LIMIT);
  }

  const requestedTools = req.tools ?? [];
  if (requestedTools.length > TOOLS_LIMIT) {
    throw new ToolsOverLimitError(requestedTools.length, TOOLS_LIMIT);
  }

  const { forward, reverse } = buildToolNameMaps(requestedTools);

  let codexTools: CodexTool[] | undefined;
  if (requestedTools.length > 0) {
    const mapped = mapAnthropicToolsToCodex(requestedTools, forward);
    codexTools = mapped.length > TOOLS_LIMIT ? filterToolsByPriority(mapped, reverse, TOOLS_LIMIT) : mapped;
  }

  const hasTools = !!(codexTools && codexTools.length > 0);
  const toolChoice = mapToolChoice(req.tool_choice, hasTools, forward);

  const disableParallel = shouldDisableParallelToolCalls(req);
  const parallelToolCalls = disableParallel
    ? false
    : typeof req.parallel_tool_calls === 'boolean'
      ? req.parallel_tool_calls
      : undefined;

  const exitPlanToolUseIds = collectExitPlanToolUseIds(messages);
  const input: CodexInputItem[] = [];
  for (const msg of messages) {
    input.push(...contentToInputItems(msg.role, msg.content, forward, exitPlanToolUseIds));
  }

  const effort = resolveEffortStrict(options.codexModel, options.effort);
  const verbosity: CodexVerbosity = options.verbosity ?? 'medium';

  const body: CodexRequest = {
    model: options.codexModel,
    instructions: extractSystemPrompt(req.system),
    input,
    stream: Boolean(req.stream),
    store: false,
    reasoning: { effort, summary: 'auto' },
    text: { verbosity },
  };

  if (hasTools && codexTools) body.tools = codexTools;
  if (typeof toolChoice !== 'undefined') body.tool_choice = toolChoice;
  if (typeof parallelToolCalls === 'boolean') body.parallel_tool_calls = parallelToolCalls;
  if (options.promptCacheKey) body.prompt_cache_key = truncatePromptCacheKey(options.promptCacheKey);

  return { body, toolNameMap: reverse };
}

interface CodexUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

interface CodexOutputItem {
  id?: string;
  type?: string;
  role?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string }>;
}

interface CodexCompletedResponse {
  id?: string;
  model?: string;
  output?: CodexOutputItem[];
  usage?: CodexUsage;
  stop_reason?: string;
  status?: string;
}

interface OpenSseLine {
  event: string | null;
  data: string;
}

function parseSseEvent(raw: string): OpenSseLine | null {
  const lines = raw.split(/\r?\n/);
  let event: string | null = null;
  const dataParts: string[] = [];
  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataParts.push(line.slice(5).trim());
    }
  }
  if (dataParts.length === 0) return null;
  return { event, data: dataParts.join('\n') };
}

interface OpenBlockState {
  kind: 'text' | 'tool_use' | 'thinking';
  index: number;
  codexItemId: string;
}

type SseEmit = string;

function sseFrame(event: string, data: Record<string, unknown>): SseEmit {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function translateStopReason(
  hasToolUse: boolean,
  usage: CodexUsage | undefined,
  codexStopReason: string | undefined,
): 'end_turn' | 'tool_use' | 'max_tokens' {
  if (hasToolUse) return 'tool_use';
  if (codexStopReason === 'max_output_tokens' || codexStopReason === 'length') return 'max_tokens';
  const out = usage?.output_tokens;
  const total = usage?.total_tokens;
  if (typeof out === 'number' && typeof total === 'number' && total > 0 && out >= total) {
    return 'max_tokens';
  }
  return 'end_turn';
}

function translateUsage(usage: CodexUsage | undefined): Record<string, unknown> {
  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;
  const cachedInputTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const reasoningTokens = usage?.output_tokens_details?.reasoning_tokens ?? 0;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cachedInputTokens,
    _openai_cached_input_tokens: cachedInputTokens,
    _openai_reasoning_tokens: reasoningTokens,
  };
}

export interface CodexToAnthropicStreamOptions {
  anthropicModel: string;
  toolNameMap: Map<string, string>;
}

export class CodexToAnthropicStream {
  private readonly anthropicModel: string;
  private readonly toolNameMap: Map<string, string>;
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private nextBlockIndex = 0;
  private openBlocks = new Map<string, OpenBlockState>();
  private toolUseIdsByOutputIndex = new Map<number, string>();
  /** Buffers function_call args until `done` so empty-string keys can be stripped before SDK sees them. */
  private toolArgsByItemId = new Map<string, string>();
  private started = false;
  private finished = false;
  private hasToolUse = false;
  private inputTokens = 0;
  private messageId = '';
  private finalUsage: CodexUsage | undefined;
  private finalStopReason: string | undefined;
  /** Codex usage only arrives at response.completed; estimate from delta chars and emit incremental message_delta, reconciled in finalize(). */
  private estimatedOutputChars = 0;
  private estimatedTokensEmitted = 0;
  private lastEstimateAtMs = 0;
  private static readonly ESTIMATE_THROTTLE_MS = 250;
  private static readonly CHARS_PER_TOKEN = 4;

  constructor(options: CodexToAnthropicStreamOptions) {
    this.anthropicModel = options.anthropicModel;
    this.toolNameMap = options.toolNameMap;
  }

  /** Throttled token-count delta as message_delta SSE so the SDK accumulator reaches the running estimate; finalize() reconciles to upstream total. */
  private emitOutputTokenEstimate(deltaChars: number, force: boolean): SseEmit[] {
    this.estimatedOutputChars += deltaChars;
    const now = Date.now();
    if (!force && now - this.lastEstimateAtMs < CodexToAnthropicStream.ESTIMATE_THROTTLE_MS) {
      return [];
    }
    const estimatedTotal = Math.ceil(this.estimatedOutputChars / CodexToAnthropicStream.CHARS_PER_TOKEN);
    const tokenDelta = estimatedTotal - this.estimatedTokensEmitted;
    if (tokenDelta <= 0) return [];
    this.estimatedTokensEmitted = estimatedTotal;
    this.lastEstimateAtMs = now;
    return [
      sseFrame('message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: null,
          stop_sequence: null,
          container: null,
          stop_details: null,
        },
        usage: {
          input_tokens: 0,
          output_tokens: tokenDelta,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
    ];
  }

  write(chunk: Buffer | Uint8Array): SseEmit[] {
    if (this.finished) return [];
    this.buffer += this.decoder.write(Buffer.from(chunk));
    return this.drainBuffer();
  }

  end(): SseEmit[] {
    if (this.finished) return [];
    this.buffer += this.decoder.end();
    const events = this.drainBuffer();
    if (!this.finished) {
      events.push(...this.finalize());
    }
    return events;
  }

  private drainBuffer(): SseEmit[] {
    const emits: SseEmit[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const parsed = parseSseEvent(raw);
      if (!parsed) continue;
      emits.push(...this.handleEvent(parsed));
      if (this.finished) break;
    }
    return emits;
  }

  private handleEvent(line: OpenSseLine): SseEmit[] {
    if (line.data === '[DONE]') {
      return this.finalize();
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line.data);
    } catch {
      return [];
    }

    const type = parsed['type'] as string | undefined;
    if (!type) return [];

    switch (type) {
      case 'response.created':
        return this.onResponseCreated(parsed);
      case 'response.output_item.added':
        return this.onOutputItemAdded(parsed);
      case 'response.output_text.delta':
        return this.onOutputTextDelta(parsed);
      case 'response.function_call_arguments.delta':
        return this.onFunctionCallArgumentsDelta(parsed);
      case 'response.function_call_arguments.done':
        return this.onFunctionCallArgumentsDone(parsed);
      case 'response.reasoning_summary_text.delta':
        return this.onReasoningSummaryDelta(parsed);
      case 'response.output_item.done':
        return this.onOutputItemDone(parsed);
      case 'response.completed':
      case 'response.done':
        return this.onResponseCompleted(parsed);
      case 'error':
      case 'response.error':
      case 'response.failed':
        return this.onError(parsed);
      default:
        return [];
    }
  }

  private onResponseCreated(parsed: Record<string, unknown>): SseEmit[] {
    if (this.started) return [];
    this.started = true;
    const response = (parsed['response'] as Record<string, unknown> | undefined) ?? {};
    if (typeof response['id'] === 'string') this.messageId = response['id'] as string;
    const usage = response['usage'] as CodexUsage | undefined;
    if (usage?.input_tokens) this.inputTokens = usage.input_tokens;
    return [
      sseFrame('message_start', {
        type: 'message_start',
        message: {
          id: this.messageId || `msg_${Date.now()}`,
          type: 'message',
          role: 'assistant',
          model: this.anthropicModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: this.inputTokens,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      }),
    ];
  }

  private ensureStarted(): SseEmit[] {
    if (this.started) return [];
    return this.onResponseCreated({});
  }

  private onOutputItemAdded(parsed: Record<string, unknown>): SseEmit[] {
    const item = parsed['item'] as Record<string, unknown> | undefined;
    if (!item) return [];
    const itemType = item['type'] as string | undefined;
    const outputIndex = typeof parsed['output_index'] === 'number'
      ? (parsed['output_index'] as number)
      : -1;
    const itemId = (item['id'] as string | undefined) ?? `out_${outputIndex}`;
    const emits = this.ensureStarted();

    if (itemType === 'message') {
      return emits;
    }

    if (itemType === 'reasoning') {
      const blockIndex = this.nextBlockIndex++;
      this.openBlocks.set(itemId, { kind: 'thinking', index: blockIndex, codexItemId: itemId });
      emits.push(
        sseFrame('content_block_start', {
          type: 'content_block_start',
          index: blockIndex,
          content_block: { type: 'thinking', thinking: '' },
        }),
      );
      return emits;
    }

    if (itemType === 'function_call') {
      const callId = (item['call_id'] as string | undefined) ?? itemId;
      const codexName = (item['name'] as string | undefined) ?? 'tool';
      const anthropicName = this.toolNameMap.get(codexName) ?? codexName;
      const blockIndex = this.nextBlockIndex++;
      this.openBlocks.set(itemId, { kind: 'tool_use', index: blockIndex, codexItemId: itemId });
      this.toolUseIdsByOutputIndex.set(outputIndex, itemId);
      this.hasToolUse = true;
      emits.push(
        sseFrame('content_block_start', {
          type: 'content_block_start',
          index: blockIndex,
          content_block: { type: 'tool_use', id: callId, name: anthropicName, input: {} },
        }),
      );
      return emits;
    }

    return emits;
  }

  private onOutputTextDelta(parsed: Record<string, unknown>): SseEmit[] {
    const delta = parsed['delta'];
    if (typeof delta !== 'string' || delta.length === 0) return [];
    const outputIndex = typeof parsed['output_index'] === 'number'
      ? (parsed['output_index'] as number)
      : -1;
    const itemId = (parsed['item_id'] as string | undefined) ?? `out_${outputIndex}`;

    const emits = this.ensureStarted();

    let state = this.openBlocks.get(itemId);
    if (!state || state.kind !== 'text') {
      const blockIndex = this.nextBlockIndex++;
      state = { kind: 'text', index: blockIndex, codexItemId: itemId };
      this.openBlocks.set(itemId, state);
      emits.push(
        sseFrame('content_block_start', {
          type: 'content_block_start',
          index: blockIndex,
          content_block: { type: 'text', text: '' },
        }),
      );
    }

    emits.push(
      sseFrame('content_block_delta', {
        type: 'content_block_delta',
        index: state.index,
        delta: { type: 'text_delta', text: delta },
      }),
    );
    emits.push(...this.emitOutputTokenEstimate(delta.length, false));
    return emits;
  }

  private onFunctionCallArgumentsDelta(parsed: Record<string, unknown>): SseEmit[] {
    const delta = parsed['delta'];
    if (typeof delta !== 'string' || delta.length === 0) return [];
    const outputIndex = typeof parsed['output_index'] === 'number'
      ? (parsed['output_index'] as number)
      : -1;
    const itemId =
      (parsed['item_id'] as string | undefined) ??
      this.toolUseIdsByOutputIndex.get(outputIndex) ??
      `out_${outputIndex}`;
    const state = this.openBlocks.get(itemId);
    if (!state || state.kind !== 'tool_use') return [];
    const existing = this.toolArgsByItemId.get(itemId) ?? '';
    this.toolArgsByItemId.set(itemId, existing + delta);
    return this.emitOutputTokenEstimate(delta.length, false);
  }

  private onFunctionCallArgumentsDone(parsed: Record<string, unknown>): SseEmit[] {
    const outputIndex = typeof parsed['output_index'] === 'number'
      ? (parsed['output_index'] as number)
      : -1;
    const itemId =
      (parsed['item_id'] as string | undefined) ??
      this.toolUseIdsByOutputIndex.get(outputIndex) ??
      `out_${outputIndex}`;
    const state = this.openBlocks.get(itemId);
    if (!state || state.kind !== 'tool_use') return [];
    const buffered = this.toolArgsByItemId.get(itemId) ?? '';
    this.toolArgsByItemId.delete(itemId);
    const argsString = typeof parsed['arguments'] === 'string' && parsed['arguments']
      ? (parsed['arguments'] as string)
      : buffered;
    if (!argsString) return [];
    const cleaned = stripEmptyStringArgs(argsString);
    return [
      sseFrame('content_block_delta', {
        type: 'content_block_delta',
        index: state.index,
        delta: { type: 'input_json_delta', partial_json: cleaned },
      }),
    ];
  }

  private onReasoningSummaryDelta(parsed: Record<string, unknown>): SseEmit[] {
    const delta = parsed['delta'];
    if (typeof delta !== 'string' || delta.length === 0) return [];
    const itemId = (parsed['item_id'] as string | undefined);
    if (!itemId) return [];
    const state = this.openBlocks.get(itemId);
    if (!state || state.kind !== 'thinking') return [];
    const emits: SseEmit[] = [
      sseFrame('content_block_delta', {
        type: 'content_block_delta',
        index: state.index,
        delta: { type: 'thinking_delta', thinking: delta },
      }),
    ];
    emits.push(...this.emitOutputTokenEstimate(delta.length, false));
    return emits;
  }

  private onOutputItemDone(parsed: Record<string, unknown>): SseEmit[] {
    const item = parsed['item'] as Record<string, unknown> | undefined;
    if (!item) return [];
    const itemId = item['id'] as string | undefined;
    if (!itemId) return [];
    const state = this.openBlocks.get(itemId);
    if (!state) return [];
    this.openBlocks.delete(itemId);
    const emits: SseEmit[] = [];
    if (state.kind === 'tool_use' && this.toolArgsByItemId.has(itemId)) {
      const buffered = this.toolArgsByItemId.get(itemId) ?? '';
      this.toolArgsByItemId.delete(itemId);
      if (buffered) {
        emits.push(
          sseFrame('content_block_delta', {
            type: 'content_block_delta',
            index: state.index,
            delta: { type: 'input_json_delta', partial_json: stripEmptyStringArgs(buffered) },
          }),
        );
      }
    }
    emits.push(
      sseFrame('content_block_stop', {
        type: 'content_block_stop',
        index: state.index,
      }),
    );
    /** Drain pending chars so the counter ticks the instant the block closes (bypassing the throttle window). */
    emits.push(...this.emitOutputTokenEstimate(0, true));
    return emits;
  }

  private onResponseCompleted(parsed: Record<string, unknown>): SseEmit[] {
    const response = parsed['response'] as CodexCompletedResponse | undefined;
    if (response) {
      this.finalUsage = response.usage;
      this.finalStopReason = response.stop_reason ?? response.status;
    }
    return this.finalize();
  }

  private onError(parsed: Record<string, unknown>): SseEmit[] {
    const errorObj = (parsed['error'] as Record<string, unknown> | undefined) ?? parsed;
    const message =
      (errorObj['message'] as string | undefined) ??
      (parsed['message'] as string | undefined) ??
      'OpenAI backend error';
    const emits: SseEmit[] = [];
    if (!this.started) {
      emits.push(...this.ensureStarted());
    }
    for (const state of this.openBlocks.values()) {
      emits.push(
        sseFrame('content_block_stop', {
          type: 'content_block_stop',
          index: state.index,
        }),
      );
    }
    this.openBlocks.clear();
    emits.push(
      sseFrame('error', {
        type: 'error',
        error: { type: 'api_error', message },
      }),
    );
    this.finished = true;
    return emits;
  }

  private finalize(): SseEmit[] {
    if (this.finished) return [];
    const emits: SseEmit[] = [];
    if (!this.started) emits.push(...this.ensureStarted());
    for (const state of this.openBlocks.values()) {
      emits.push(
        sseFrame('content_block_stop', {
          type: 'content_block_stop',
          index: state.index,
        }),
      );
    }
    this.openBlocks.clear();
    const stopReason = translateStopReason(this.hasToolUse, this.finalUsage, this.finalStopReason);
    /** Reconcile to real total: emit diff so SDK's accumulator (already absorbed estimates) lands on the upstream value. */
    const reconciledUsage = translateUsage(this.finalUsage);
    const realOutputTokens = (reconciledUsage['output_tokens'] as number | undefined) ?? this.estimatedTokensEmitted;
    const reconciliationDelta = realOutputTokens - this.estimatedTokensEmitted;
    reconciledUsage['output_tokens'] = reconciliationDelta;
    emits.push(
      sseFrame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: reconciledUsage,
      }),
    );
    emits.push(sseFrame('message_stop', { type: 'message_stop' }));
    this.finished = true;
    return emits;
  }
}

export function buildAnthropicErrorEvent(error: unknown): string {
  const isOver = error instanceof MessagesOverLimitError || error instanceof ToolsOverLimitError;
  const type = isOver ? 'invalid_request_error' : 'api_error';
  const message = error instanceof Error ? error.message : String(error);
  return sseFrame('error', {
    type: 'error',
    error: { type, message },
  });
}
