import type { ToolCatalogEntry } from '@shared/types/tools';
import {
  TOOL_READ,
  TOOL_WRITE,
  TOOL_EDIT,
  TOOL_BASH,
  TOOL_POWERSHELL,
  TOOL_GREP,
  TOOL_GLOB,
  TOOL_LS,
  TOOL_TASK_CREATE,
  TOOL_TASK_UPDATE,
  TOOL_TASK_LIST,
  TOOL_TASK_GET,
  TOOL_ASK_USER_QUESTION,
  TOOL_ENTER_PLAN_MODE,
  TOOL_EXIT_PLAN_MODE,
} from '../../../shared/tool-names';
import { WEB_TOOLS } from '../pi-models';
import { MEMORY_TOOL_CATALOG, MEMORY_PI_TOOL_NAMES } from './memory-tools';
import { COMPASS_TOOL_CATALOG, COMPASS_PI_TOOL_NAMES } from './compass-tools';
import { BROWSER_TOOL_CATALOG, BROWSER_PI_TOOL_NAMES } from './browser-tools';

/**
 * The aggregated Tools-panel catalog. Each subsystem owns its own ordered catalog (`*_TOOL_CATALOG`);
 * this module unions them with the always-on Core built-ins and the opt-in Web tools, and derives the
 * set of names the permission gate auto-allows as in-process module tools. Single source of truth for
 * the panel (`ChatSession.getToolStatus`) and the gate (`runPermissionGate`).
 */

/** Native pi + Damocles custom built-ins. Always on (`toggleable: false`) — shown locked in the panel. */
const CORE_TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  { name: TOOL_READ, label: 'Read', description: 'Read a file.', group: 'core', toggleable: false },
  { name: TOOL_WRITE, label: 'Write', description: 'Write a file.', group: 'core', toggleable: false },
  { name: TOOL_EDIT, label: 'Edit', description: 'Edit a file.', group: 'core', toggleable: false },
  { name: TOOL_BASH, label: 'Bash', description: 'Run a shell command.', group: 'core', toggleable: false },
  { name: TOOL_POWERSHELL, label: 'PowerShell', description: 'Run a PowerShell command.', group: 'core', toggleable: false },
  { name: TOOL_GREP, label: 'Grep', description: 'Search file contents.', group: 'core', toggleable: false },
  { name: TOOL_GLOB, label: 'Glob', description: 'Find files by pattern.', group: 'core', toggleable: false },
  { name: TOOL_LS, label: 'Ls', description: 'List a directory.', group: 'core', toggleable: false },
  { name: TOOL_TASK_CREATE, label: 'TaskCreate', description: 'Create a task.', group: 'core', toggleable: false },
  { name: TOOL_TASK_UPDATE, label: 'TaskUpdate', description: 'Update a task.', group: 'core', toggleable: false },
  { name: TOOL_TASK_LIST, label: 'TaskList', description: 'List tasks.', group: 'core', toggleable: false },
  { name: TOOL_TASK_GET, label: 'TaskGet', description: 'Get a task.', group: 'core', toggleable: false },
  { name: TOOL_ASK_USER_QUESTION, label: 'AskUserQuestion', description: 'Ask the user a question.', group: 'core', toggleable: false },
  { name: TOOL_ENTER_PLAN_MODE, label: 'EnterPlanMode', description: 'Enter plan mode.', group: 'core', toggleable: false },
  { name: TOOL_EXIT_PLAN_MODE, label: 'ExitPlanMode', description: 'Exit plan mode.', group: 'core', toggleable: false },
];

/** Friendly labels + blurbs for the `pi-web-access` runtime tool names. */
const WEB_TOOL_META: Record<string, { label: string; description: string }> = {
  web_search: { label: 'WebSearch', description: 'Search the web.' },
  fetch_content: { label: 'WebFetch', description: 'Fetch and read a web page.' },
  code_search: { label: 'CodeSearch', description: 'Search public source code.' },
};

/** One entry per `pi-web-access` runtime tool name; the active-set/disabled-set keys off the runtime name. */
const WEB_TOOL_CATALOG: readonly ToolCatalogEntry[] = WEB_TOOLS.map((name) => ({
  name,
  label: WEB_TOOL_META[name]?.label ?? name,
  description: WEB_TOOL_META[name]?.description ?? '',
  group: 'web',
  toggleable: true,
}));

/** The full ordered catalog: Core, then the three module subsystems, then Web. */
export const FULL_TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  ...CORE_TOOL_CATALOG,
  ...MEMORY_TOOL_CATALOG,
  ...COMPASS_TOOL_CATALOG,
  ...BROWSER_TOOL_CATALOG,
  ...WEB_TOOL_CATALOG,
];

/**
 * The in-process MCP module tool names (memory + compass + browser) the gate auto-allows as reads.
 * Web tools are excluded — they hit the existing extension-read branch (`EXTENSION_READ_TOOLS`).
 */
export const GATEABLE_MODULE_NAMES: ReadonlySet<string> = new Set<string>([
  ...MEMORY_PI_TOOL_NAMES,
  ...COMPASS_PI_TOOL_NAMES,
  ...BROWSER_PI_TOOL_NAMES,
]);
