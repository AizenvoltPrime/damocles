import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../pi-loader';
import type { PermissionHandler } from '../../permission-handler';
import { buildCanUseToolContext, formatDenyReason, formatPolicyBlockReason } from '../permission-gate';
import { buildPlanModeGuidance } from '../plan-mode-guidance';
import { isWebSearchEnabled } from '../web-access';
import { TOOL_ENTER_PLAN_MODE, TOOL_EXIT_PLAN_MODE } from '../../../shared/tool-names';
import { PLAN_VERSION_DETAIL_KEY } from '../../../shared/types/session';
import { DESIGN_VERSION_DETAIL_KEY, type DesignVersionStamp } from '../../../shared/types/design';
import { planVersionOnBranch } from '../plan-version';
import { designVersionStamp, planApprovalDesignLink } from '../../design/design-entries';

const enterPlanSchema = Type.Object({}, { additionalProperties: false });
const exitPlanSchema = Type.Object({}, { additionalProperties: false });

// Plan version null: the call showed the user no plan. Design version null: the chat has no own link with a delivered version.
type ExitPlanModeDetails = { [PLAN_VERSION_DETAIL_KEY]: number | null; [DESIGN_VERSION_DETAIL_KEY]: DesignVersionStamp | null };

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
    description: 'Enter plan mode: research and design a plan with read tools and shell commands that gather information (plus writing your plan file) before making any changes.',
    parameters: enterPlanSchema,
    // Plan mode's checks apply to the calls batched after it, which pi gates only once this call has run.
    executionMode: 'sequential',
    execute: async () => {
      await permissionHandler.activatePlanMode();
      return {
        content: [
          {
            type: 'text',
            text: buildPlanModeGuidance(getPlanFilePath?.(), {
              teamEnabled: isTeamEnabled?.() ?? false,
              // Read at EXECUTE time for the same reason `getPlanFilePath` is: the setting is live
              // (`ChatPanelProvider.toolSettingsChanged` re-applies it on change), so a user who enabled the web
              // tools after this tool was wrapped still gets guidance matching the tools they have.
              webSearchEnabled: isWebSearchEnabled(),
            }),
          },
        ],
        details: undefined,
      };
    },
  });

  const exitPlan = pi.defineTool<typeof exitPlanSchema, ExitPlanModeDetails>({
    name: TOOL_EXIT_PLAN_MODE,
    label: 'ExitPlanMode',
    description: 'Present the finished plan and request approval before taking any action.',
    parameters: exitPlanSchema,
    // The plan file a call batched before it writes must exist when it reads the plan.
    executionMode: 'sequential',
    execute: async (toolCallId, _params, signal, _onUpdate, ctx) => {
      const branch = ctx.sessionManager.getBranch();
      const sessionId = ctx.sessionManager.getSessionId();
      const planVersion = planVersionOnBranch(branch, toolCallId);
      // Both recorded on every outcome, so a reload shows what the call was stamped with; the design version is what an approval records (PD-16).
      const designVersion = designVersionStamp(branch, sessionId);
      const details: ExitPlanModeDetails = { [PLAN_VERSION_DETAIL_KEY]: planVersion, [DESIGN_VERSION_DETAIL_KEY]: designVersion };
      const notShown: ExitPlanModeDetails = { ...details, [PLAN_VERSION_DETAIL_KEY]: null };
      if (permissionHandler.turnPermissionMode() !== 'plan') {
        return { content: [{ type: 'text', text: 'Not in plan mode; proceeding.' }], details: notShown };
      }
      const designLink = planApprovalDesignLink(branch, sessionId);
      const result = await permissionHandler.canUseTool(
        TOOL_EXIT_PLAN_MODE,
        {},
        { ...buildCanUseToolContext(toolCallId, signal), planVersion, ...(designLink ? { designLink } : {}) },
      );
      if (result.behavior === 'deny') {
        // A rejected plan is an error result, which the webview renders as the "denied" card instead of a
        // green "completed" over the optimistic denied state; the marker keeps it "denied", not "failed".
        // Returned rather than thrown, because a thrown error's result drops `details`.
        const text = result.policy ? formatPolicyBlockReason(result.message) : formatDenyReason(result.message);
        return { content: [{ type: 'text', text }], details: result.planShown ? details : notShown, isError: true };
      }
      const text = result.editedPlan === undefined
        ? 'Plan approved. Proceeding with implementation.'
        : `Plan approved. The user edited the plan file before approving it. Implement this version, not the one you wrote:\n\n${result.editedPlan}`;
      return { content: [{ type: 'text', text }], details };
    },
  });

  return [enterPlan, exitPlan];
}
