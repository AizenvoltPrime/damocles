import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../pi-loader';
import type { PermissionHandler } from '../../permission-handler';
import { buildCanUseToolContext, formatDenyReason } from '../permission-gate';
import { TOOL_ENTER_PLAN_MODE, TOOL_EXIT_PLAN_MODE } from '../../../shared/tool-names';

const enterPlanSchema = Type.Object({}, { additionalProperties: false });
const exitPlanSchema = Type.Object(
  { plan: Type.String({ description: 'The plan (markdown) to present to the user for approval' }) },
  { additionalProperties: false },
);

/**
 * Build the `EnterPlanMode`/`ExitPlanMode` tools. Per the tool-interaction ownership split (US-004),
 * these drive the managers directly from `execute()` — the central gate allows them without prompting.
 * `EnterPlanMode` activates plan mode (which restricts the active tool set via the panel callback);
 * `ExitPlanMode` routes through `canUseTool` → `PlanManager.handleExitPlanMode` for plan approval.
 */
export function createPlanModeTools(pi: PiCodingAgentModule, permissionHandler: PermissionHandler): [ToolDefinition, ToolDefinition] {
  const enterPlan = pi.defineTool<typeof enterPlanSchema, undefined>({
    name: TOOL_ENTER_PLAN_MODE,
    label: 'EnterPlanMode',
    description: 'Enter plan mode: restrict to read-only actions while you research and design a plan.',
    parameters: enterPlanSchema,
    execute: async () => {
      await permissionHandler.activatePlanMode();
      return {
        content: [{ type: 'text', text: 'Entered plan mode. Only read-only tools are available until you exit the plan.' }],
        details: undefined,
      };
    },
  });

  const exitPlan = pi.defineTool<typeof exitPlanSchema, undefined>({
    name: TOOL_EXIT_PLAN_MODE,
    label: 'ExitPlanMode',
    description: 'Present the finished plan and request approval before taking any action.',
    parameters: exitPlanSchema,
    execute: async (toolCallId, params, signal) => {
      if (permissionHandler.getPermissionMode() !== 'plan') {
        return { content: [{ type: 'text', text: 'Not in plan mode; proceeding.' }], details: undefined };
      }
      const result = await permissionHandler.canUseTool(
        TOOL_EXIT_PLAN_MODE,
        params as Record<string, unknown>,
        buildCanUseToolContext(toolCallId, signal),
      );
      if (result.behavior === 'deny') {
        // Represent a rejected plan as an error tool result, exactly as the SDK does: pi turns a
        // thrown error into an `isError` result, which the webview renders as the "denied" card
        // (red, with the feedback) instead of a green "completed" that would override the optimistic
        // denied state the overlay already set. The marker keeps it "denied" rather than "failed".
        throw new Error(formatDenyReason(result.message));
      }
      return { content: [{ type: 'text', text: 'Plan approved. Proceeding with implementation.' }], details: undefined };
    },
  });

  return [enterPlan, exitPlan];
}
