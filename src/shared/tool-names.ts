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
export const TOOL_FEED_READ = "FeedRead";
export const TOOL_YOUTUBE_TRANSCRIPT = "YouTubeTranscript";
export const TOOL_AGENT = "Agent";
export const TOOL_GET_SUBAGENT_RESULT = "GetSubagentResult";
export const TOOL_STEER_SUBAGENT = "SteerSubagent";
export const TOOL_SKILL = "Skill";
export const TOOL_ENTER_PLAN_MODE = "EnterPlanMode";
export const TOOL_EXIT_PLAN_MODE = "ExitPlanMode";
export const TOOL_ASK_USER_QUESTION = "AskUserQuestion";
export const TOOL_BROWSER_REQUEST_INPUT = "BrowserRequestInput";
export const TOOL_NOTEBOOK_EDIT = "NotebookEdit";
export const TOOL_LSP = "LSP";
export const TOOL_TOOL_SEARCH = "ToolSearch";
export const TOOL_CRON_CREATE = "CronCreate";
export const TOOL_CRON_DELETE = "CronDelete";
export const TOOL_CRON_LIST = "CronList";
export const TOOL_POWERSHELL = "PowerShell";
export const TOOL_STRUCTURED_OUTPUT = "StructuredOutput";
export const TOOL_GENERATE_IMAGE = "GenerateImage";

export const FILE_TOOLS: Set<string> = new Set([TOOL_READ, TOOL_WRITE, TOOL_EDIT, TOOL_GLOB, TOOL_GREP]);
export const WRITE_TOOLS: Set<string> = new Set([TOOL_WRITE, TOOL_EDIT, TOOL_GENERATE_IMAGE]);
export const READ_ONLY_TOOLS: Set<string> = new Set([TOOL_READ, TOOL_GLOB, TOOL_GREP, TOOL_LS, TOOL_WEB_FETCH, TOOL_WEB_SEARCH, TOOL_CODE_SEARCH, TOOL_FEED_READ, TOOL_YOUTUBE_TRANSCRIPT, TOOL_LSP, TOOL_TOOL_SEARCH]);
export const IGNORED_TOOLS: Set<string> = new Set([TOOL_ENTER_PLAN_MODE, TOOL_EXIT_PLAN_MODE, TOOL_ASK_USER_QUESTION]);
export const CRON_TOOLS: Set<string> = new Set([TOOL_CRON_CREATE, TOOL_CRON_DELETE, TOOL_CRON_LIST]);
export const ORCHESTRATION_TOOLS: Set<string> = new Set([TOOL_AGENT]);
/** The three native subagent tools (Phase 5). Excluded from nested subagent allowlists (no recursion). */
export const SUBAGENT_TOOLS: Set<string> = new Set([TOOL_AGENT, TOOL_GET_SUBAGENT_RESULT, TOOL_STEER_SUBAGENT]);
/** Plan-mode entry/exit tools. Plan mode is a top-level panel concern owned by the primary session, so
 *  these are excluded from every subagent allowlist — a nested agent must never enter or exit plan mode. */
export const PLAN_MODE_TOOLS: Set<string> = new Set([TOOL_ENTER_PLAN_MODE, TOOL_EXIT_PLAN_MODE]);
// Read-only: this set decides whether a call needs shell approval, so an importer must not be able to
// widen it with `.add()`.
export const SHELL_TOOLS: ReadonlySet<string> = new Set([TOOL_BASH, TOOL_POWERSHELL]);
// Streaming-capable shell tools. Kept separate from SHELL_TOOLS: a future non-streaming shell tool joins one without the other.
// Also the cancellable set: the card shows Stop, the gate admits a cancel entry and `buildCustomTools` wraps the tool for exactly these.
export const LIVE_OUTPUT_TOOLS: ReadonlySet<string> = new Set([TOOL_BASH, TOOL_POWERSHELL]);

export type ShellToolName = "Bash" | "PowerShell";
export function isShellTool(name: string): name is ShellToolName {
  return SHELL_TOOLS.has(name);
}

export const TEAM_CREATE_TOOL = 'create_team';
export const TEAM_RESUME_TOOL = 'resume_team';
/** The primary agent's team tools besides create_team. A nested agent never gets them (no recursion). */
export const TEAM_MANAGEMENT_TOOLS: Set<string> = new Set([
  'get_team_status',
  'cancel_team',
  TEAM_RESUME_TOOL,
]);
