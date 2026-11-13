import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ForgeApprovalAnswer, ForgeTarget, ForgeToolAnswer } from '../../../shared/forge/tools';
import { FORGE_READ_TOOLS, FORGE_WRITE_TOOLS } from '../../../shared/tool-names';
import { FORGE_TOOL_SPECS } from './forge-tool-specs';

// Every call goes through the chat's port, which raises the refused notice for a call that found no account.

/** One call of a chat's agent, named by its tool call id, which the refused notice is shown under. */
export interface ForgeCall {
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly toolCallId: string;
}

/** A chat's GitHub and GitLab tools: its working folder's repository, its notices and its accounts. */
export interface ForgeToolsPort {
  run(call: ForgeCall, signal: AbortSignal): Promise<ForgeToolAnswer>;
  /** The call's target as a settings rule names it ("<server>/<path>"), or the answer it gets instead; run then acts only on it. */
  target(call: ForgeCall, signal: AbortSignal): Promise<{ readonly ok: true; readonly project: string } | { readonly ok: false; readonly answer: ForgeToolAnswer }>;
  /** A write's approval card and option 2's rule (`approvalOf`, `forge/tools/run.ts`), resolved before the prompt shows; run then acts only on its target. */
  approval(call: ForgeCall, signal: AbortSignal): Promise<ForgeApprovalAnswer>;
}

/** Calls the gate decided and that have not run yet; one the gate then blocked never runs, so the oldest are let go. */
const MAX_DECIDED_TARGETS = 256;

/** The target the gate decided for each call, which its run must act on (`ForgeToolRequest.expected`). */
export class DecidedTargets {
  private readonly targets = new Map<string, ForgeTarget>();

  decided(toolCallId: string, target: ForgeTarget): void {
    this.targets.delete(toolCallId);
    this.targets.set(toolCallId, target);
    while (this.targets.size > MAX_DECIDED_TARGETS) this.targets.delete(this.targets.keys().next().value!);
  }

  /** The decided target, let go as it is read. */
  take(toolCallId: string): ForgeTarget | undefined {
    const target = this.targets.get(toolCallId);
    this.targets.delete(toolCallId);
    return target;
  }
}

export function isForgeTool(name: string): boolean {
  return FORGE_READ_TOOLS.has(name) || FORGE_WRITE_TOOLS.has(name);
}

function resultOf(answer: ForgeToolAnswer): AgentToolResult<undefined> {
  return { content: [{ type: 'text', text: answer.text }], details: undefined, ...(answer.isError === true ? { isError: true } : {}) } as AgentToolResult<undefined>;
}

/** The ten tools, each running through the port. */
export function buildForgeTools(port: ForgeToolsPort): ToolDefinition[] {
  return FORGE_TOOL_SPECS.map((spec): ToolDefinition => ({
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    execute: async (toolCallId, input, signal) => resultOf(await port.run({ tool: spec.name, input: input as Record<string, unknown>, toolCallId }, signal ?? new AbortController().signal)),
  }) as ToolDefinition);
}
