export const TOOL_READ = "Read";
export const TOOL_WRITE = "Write";
export const TOOL_EDIT = "Edit";
export const TOOL_BASH = "Bash";
export const TOOL_GLOB = "Glob";
export const TOOL_GREP = "Grep";
export const TOOL_LS = "Ls";
export const TOOL_WEB_SEARCH = "WebSearch";
export const TOOL_WEB_FETCH = "WebFetch";
export const TOOL_CODE_SEARCH = "CodeSearch";
export const TOOL_AGENT = "Agent";
export const TOOL_GET_SUBAGENT_RESULT = "GetSubagentResult";
export const TOOL_STEER_SUBAGENT = "SteerSubagent";
export const TOOL_SKILL = "Skill";
export const TOOL_TASK_CREATE = "TaskCreate";
export const TOOL_TASK_UPDATE = "TaskUpdate";
export const TOOL_TASK_LIST = "TaskList";
export const TOOL_TASK_GET = "TaskGet";
export const TOOL_TASK_STOP = "TaskStop";
export const TOOL_TASK_OUTPUT = "TaskOutput";
export const TOOL_ENTER_PLAN_MODE = "EnterPlanMode";
export const TOOL_EXIT_PLAN_MODE = "ExitPlanMode";
export const TOOL_ASK_USER_QUESTION = "AskUserQuestion";
export const TOOL_TODO_READ = "TodoRead";
export const TOOL_TODO_WRITE = "TodoWrite";
export const TOOL_NOTEBOOK_EDIT = "NotebookEdit";
export const TOOL_LSP = "LSP";
export const TOOL_TOOL_SEARCH = "ToolSearch";
export const TOOL_CRON_CREATE = "CronCreate";
export const TOOL_CRON_DELETE = "CronDelete";
export const TOOL_CRON_LIST = "CronList";
export const TOOL_ENTER_WORKTREE = "EnterWorktree";
export const TOOL_EXIT_WORKTREE = "ExitWorktree";
export const TOOL_MONITOR = "Monitor";
export const TOOL_POWERSHELL = "PowerShell";
export const TOOL_STRUCTURED_OUTPUT = "StructuredOutput";

export const FILE_TOOLS: Set<string> = new Set([TOOL_READ, TOOL_WRITE, TOOL_EDIT, TOOL_GLOB, TOOL_GREP]);
export const WRITE_TOOLS: Set<string> = new Set([TOOL_WRITE, TOOL_EDIT]);
export const READ_ONLY_TOOLS: Set<string> = new Set([TOOL_READ, TOOL_GLOB, TOOL_GREP, TOOL_LS, TOOL_WEB_FETCH, TOOL_WEB_SEARCH, TOOL_CODE_SEARCH, TOOL_LSP, TOOL_TOOL_SEARCH, TOOL_TASK_GET, TOOL_TASK_LIST, TOOL_TASK_OUTPUT]);
export const IGNORED_TOOLS: Set<string> = new Set([TOOL_ENTER_PLAN_MODE, TOOL_EXIT_PLAN_MODE, TOOL_ASK_USER_QUESTION, TOOL_TODO_READ, TOOL_TODO_WRITE]);
export const TASK_MANAGEMENT_TOOLS: Set<string> = new Set([TOOL_TASK_CREATE, TOOL_TASK_UPDATE, TOOL_TASK_LIST, TOOL_TASK_GET]);
export const BACKGROUND_TASK_TOOLS: Set<string> = new Set([TOOL_TASK_STOP, TOOL_TASK_OUTPUT]);
export const CRON_TOOLS: Set<string> = new Set([TOOL_CRON_CREATE, TOOL_CRON_DELETE, TOOL_CRON_LIST]);
export const ORCHESTRATION_TOOLS: Set<string> = new Set([TOOL_AGENT, TOOL_ENTER_WORKTREE, TOOL_EXIT_WORKTREE, TOOL_TASK_CREATE, TOOL_TASK_UPDATE, TOOL_TASK_STOP]);
/** The three native subagent tools (Phase 5). Excluded from nested subagent allowlists (no recursion). */
export const SUBAGENT_TOOLS: Set<string> = new Set([TOOL_AGENT, TOOL_GET_SUBAGENT_RESULT, TOOL_STEER_SUBAGENT]);
export const SHELL_TOOLS: Set<string> = new Set([TOOL_BASH, TOOL_POWERSHELL, TOOL_MONITOR]);

export type ShellToolName = "Bash" | "PowerShell" | "Monitor";
export function isShellTool(name: string): name is ShellToolName {
  return SHELL_TOOLS.has(name);
}

export const TEAM_CREATE_TOOL = 'create_team';
export const TEAM_MANAGEMENT_TOOLS: Set<string> = new Set([
  'get_team_status',
  'cancel_team',
]);
