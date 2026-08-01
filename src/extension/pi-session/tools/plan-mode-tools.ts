import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../pi-loader';
import type { PermissionHandler } from '../../permission-handler';
import { buildCanUseToolContext, formatDenyReason } from '../permission-gate';
import { buildPlanModeGuidance } from '../plan-mode-guidance';
import { isWebSearchEnabled } from '../web-access';
import { TOOL_ENTER_PLAN_MODE, TOOL_EXIT_PLAN_MODE } from '../../../shared/tool-names';

const enterPlanSchema = Type.Object({}, { additionalProperties: false });
const exitPlanSchema = Type.Object({}, { additionalProperties: false });

/**
 * Build the `EnterPlanMode`/`ExitPlanMode` tools. Per the tool-interaction ownership split (US-004),
 * these drive the managers directly from `execute()` — the central gate allows them without prompting.
 * `EnterPlanMode` activates plan mode (which restricts the active tool set via the panel callback);
 * `ExitPlanMode` routes through `canUseTool` → `PlanManager.handleExitPlanMode` for plan approval.
 *
 * `getPlanFilePath` is read at EXECUTE time so the EnterPlanMode result names the concrete plan path. This
 * matters when the model enters plan mode mid-turn on its own: the current turn's system prompt was built
 * (at `before_agent_start`) while plan mode was still off, so it does NOT yet carry the plan path — the
 * tool result is then the only place the model learns where to write its plan.
 */
export function createPlanModeTools(
  pi: PiCodingAgentModule,
  permissionHandler: PermissionHandler,
  getPlanFilePath?: () => string,
  isTeamEnabled?: () => boolean,
): [ToolDefinition, ToolDefinition] {
  const enterPlan = pi.defineTool<typeof enterPlanSchema, undefined>({
    name: TOOL_ENTER_PLAN_MODE,
    label: 'EnterPlanMode',
    description: 'Enter plan mode: research and design a plan with read-only tools and read-only shell commands (plus writing your plan file) before making any changes.',
    parameters: enterPlanSchema,
    execute: async () => {
      await permissionHandler.activatePlanMode();
      return {
        content: [
          {
            type: 'text',
            text: buildPlanModeGuidance(getPlanFilePath?.(), {
              teamEnabled: isTeamEnabled?.() ?? false,
              // Read at EXECUTE time for the same reason `getPlanFilePath` is: the setting is live
              // (`PiRuntime.refreshWebSearch` re-reads it on change), so a user who enabled the web
              // tools after this tool was wrapped still gets guidance matching the tools they have.
              webSearchEnabled: isWebSearchEnabled(),
            }),
          },
        ],
        details: undefined,
      };
    },
  });

  const exitPlan = pi.defineTool<typeof exitPlanSchema, undefined>({
    name: TOOL_EXIT_PLAN_MODE,
    label: 'ExitPlanMode',
    description: 'Present the finished plan and request approval before taking any action.',
    parameters: exitPlanSchema,
    execute: async (toolCallId, _params, signal) => {
      if (permissionHandler.getPermissionMode() !== 'plan') {
        return { content: [{ type: 'text', text: 'Not in plan mode; proceeding.' }], details: undefined };
      }
      const result = await permissionHandler.canUseTool(
        TOOL_EXIT_PLAN_MODE,
        {},
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
