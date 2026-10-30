import { parseLocalizedText } from './localized-text';

// A path to a LocalizedText inside a value: `.field`, `[]` for each item of an array, and `[key="value"]` for the union
// member whose key holds that value. localized-text-contract.test.ts derives every table of them from the types.
type Step = { readonly field: string } | { readonly each: true } | { readonly key: string; readonly value: string };

const STEP = /\.([A-Za-z_$][\w$]*)|(\[\])|\[(\w+)="([^"]*)"\]/y;
const compiled = new Map<string, readonly Step[]>();

function stepsOf(path: string): readonly Step[] {
  const known = compiled.get(path);
  if (known) return known;
  const steps: Step[] = [];
  STEP.lastIndex = 0;
  while (STEP.lastIndex < path.length) {
    const match = STEP.exec(path);
    if (!match) throw new Error(`Not a LocalizedText path: ${path}`);
    steps.push(match[1] !== undefined ? { field: match[1] } : match[2] !== undefined ? { each: true } : { key: match[3]!, value: match[4]! });
  }
  compiled.set(path, steps);
  return steps;
}

// Only the text is checked: a path through a value of another shape (another member of a union) does not apply.
function holds(value: unknown, steps: readonly Step[], at: number, maxChars: number): boolean {
  if (at === steps.length) return value === undefined || parseLocalizedText(value, maxChars) !== undefined;
  if (typeof value !== 'object' || value === null) return true;
  const step = steps[at]!;
  if ('each' in step) return !Array.isArray(value) || value.every((item) => holds(item, steps, at + 1, maxChars));
  const fields = value as Record<string, unknown>;
  if ('key' in step) return fields[step.key] !== step.value || holds(value, steps, at + 1, maxChars);
  return holds(Object.hasOwn(fields, step.field) ? fields[step.field] : undefined, steps, at + 1, maxChars);
}

/** The first of `paths` at which `value` holds something other than LocalizedText (parseLocalizedText), else undefined. */
export function malformedLocalizedText(value: unknown, paths: readonly string[], maxChars: number): string | undefined {
  return paths.find((path) => !holds(value, stepsOf(path), 0, maxChars));
}

/** Where each ExtensionToWebviewMessage carries LocalizedText, by its type. */
export const WEBVIEW_LOCALIZED_TEXT: Readonly<Record<string, readonly string[]>> = {
  assistantReplay: ['.tools[].agentMessages[].error'],
  btwError: ['.message'],
  claudeAuthError: ['.error'],
  clearOpenAIApiKeyAck: ['.error'],
  clearProviderApiKeyAck: ['.error'],
  editorShowDiff: ['.title'],
  error: ['.message'],
  errorReplay: ['.content'],
  mcpConfigUpdate: ['.servers[].error'],
  mcpRenamedToolRules: ['.notices[].displayPath'],
  mcpResourceAttached: ['.refused'],
  mcpResourceChildren: ['.error'],
  mcpResources: ['.error'],
  mcpResourceTemplates: ['.error'],
  mcpServerStatus: ['.servers[].error'],
  memoryError: ['.message'],
  notification: ['.message'],
  openaiChatGPTAuthFailed: ['.error'],
  profileSectionError: ['.message'],
  promptReturned: ['.detail'],
  providerSignInState: ['.state[phase="idle"].error.message'],
  rewindError: ['.message'],
  setOpenAIApiKeyAck: ['.error', '.warning'],
  setOpenAIPreferApiKeyAck: ['.error'],
  setProviderApiKeyAck: ['.error'],
  setProviderPreferApiKeyAck: ['.error'],
  settingWriteResult: ['.error'],
  subagentMessagesUpdate: ['.messages[].error'],
  subscriptionUsage: ['.data.claude.error', '.data.claude.profileError', '.data.gpt.error', '.data.gpt.profileError'],
  teamAgentDataLoaded: ['.messages[].error'],
  transcriptionError: ['.message'],
  usageStats: ['.error'],
  voiceModelDownloadProgress: ['.message'],
  voiceRuntimeStatus: ['.status[kind="failed"].message', '.status[kind="needs-install"].message', '.status[kind="unsupported"].message'],
  voiceSidecarStatus: ['.message'],
  worktreeState: ['.error'],
};

/** The first path at which a message core posts to a view holds something other than LocalizedText, else undefined. */
export function malformedWebviewText(message: unknown): string | undefined {
  const type = typeof message === 'object' && message !== null ? (message as { readonly type?: unknown }).type : undefined;
  if (typeof type !== 'string' || !Object.hasOwn(WEBVIEW_LOCALIZED_TEXT, type)) return undefined;
  // a view's post has no bound of its own below the relay's, so only the shape is checked
  return malformedLocalizedText(message, WEBVIEW_LOCALIZED_TEXT[type]!, Number.POSITIVE_INFINITY);
}
