import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../pi-loader';
import type { PermissionHandler } from '../../permission-handler';
import {
  TOOL_EDIT,
  TOOL_POWERSHELL,
  TOOL_TASK_CREATE,
  TOOL_TASK_UPDATE,
  TOOL_TASK_LIST,
  TOOL_TASK_GET,
  TOOL_ENTER_PLAN_MODE,
  TOOL_EXIT_PLAN_MODE,
  TOOL_ASK_USER_QUESTION,
} from '../../../shared/tool-names';
import { createEditTool } from './edit-tool';
import { createPowerShellTool } from './powershell-tool';
import { createTaskTools } from './task-tools';
import { createPlanModeTools } from './plan-mode-tools';
import { createAskUserQuestionTool } from './ask-user-question-tool';

export interface CustomToolDeps {
  pi: PiCodingAgentModule;
  cwd: string;
  permissionHandler: PermissionHandler;
}

/**
 * Names of the Damocles custom tools, in active-set order. Every name MUST also be passed in the
 * session's `tools` list to be callable (US-003).
 */
export const CUSTOM_TOOL_NAMES: readonly string[] = [
  TOOL_EDIT,
  TOOL_POWERSHELL,
  TOOL_TASK_CREATE,
  TOOL_TASK_UPDATE,
  TOOL_TASK_LIST,
  TOOL_TASK_GET,
  TOOL_ENTER_PLAN_MODE,
  TOOL_EXIT_PLAN_MODE,
  TOOL_ASK_USER_QUESTION,
];

/**
 * Build the per-session Damocles custom tool definitions, each closing over this panel's `cwd` and
 * `permissionHandler`. Replaces the CC tools pi lacks (Edit, PowerShell, the Task list tools, plan,
 * question). The native `read/bash/write/grep/find/ls` come from pi directly.
 */
export function buildCustomTools(deps: CustomToolDeps): ToolDefinition[] {
  const { pi, cwd, permissionHandler } = deps;
  const [taskCreate, taskUpdate, taskList, taskGet] = createTaskTools(pi);
  const [enterPlan, exitPlan] = createPlanModeTools(pi, permissionHandler);
  return [
    createEditTool(pi, cwd),
    createPowerShellTool(pi, cwd),
    taskCreate,
    taskUpdate,
    taskList,
    taskGet,
    enterPlan,
    exitPlan,
    createAskUserQuestionTool(pi, permissionHandler),
  ];
}
