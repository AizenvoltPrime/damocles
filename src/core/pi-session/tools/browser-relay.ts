import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { RemoteHost } from '../../../platform/remote-host';
import type { PanelHost } from '../../../platform/window-service';
import { CLIENT_FEATURE_MISSING } from '../../../shared/remote-user';
import type { RelayedServedFile } from '../../../shared/served-file-url';
import { TOOL_BROWSER_REQUEST_INPUT } from '../../../shared/tool-names';
import { SERVED_FILES_CLIENT_TOO_OLD, type ChatServedFiles } from '../../browser/served-files';

// the tools whose file:// address names a root file the client serves
const SERVED_TOOLS: ReadonlySet<string> = new Set(['BrowserOpen', 'BrowserNavigate']);

/**
 * A daemon's core's browser tools: the same names, schemas and descriptions, each call run by the client showing the chat, in
 * that chat's browser scope on the client (user.browser.tool). Request input fills a page on the client from a form in the
 * chat, which no relay carries, so it answers that it is unavailable here. A file:// address of BrowserOpen or
 * BrowserNavigate is resolved against the chat's roots here, before anything is relayed.
 */
export function relayedBrowserTools(definitions: readonly ToolDefinition[], remote: RemoteHost, chat: PanelHost | undefined, scope: string, roots?: ChatServedFiles): ToolDefinition[] {
  return definitions.map((definition): ToolDefinition => ({
    ...definition,
    execute: async (_toolCallId, input, signal) => {
      if (definition.name === TOOL_BROWSER_REQUEST_INPUT) return failed('BrowserRequestInput is not available in a chat on a remote host.');
      if (!chat) return failed('The browser runs beside a chat, and this agent has none.');
      let served: RelayedServedFile | undefined;
      const url = SERVED_TOOLS.has(definition.name) ? (input as { url?: unknown }).url : undefined;
      if (typeof url === 'string') {
        const resolved = roots?.relayed(url);
        if (resolved && 'refused' in resolved) return failed(resolved.refused);
        served = resolved;
      }
      let answer;
      try {
        answer = await (served ? remote.browserTool(chat, scope, definition.name, input, signal, served) : remote.browserTool(chat, scope, definition.name, input, signal));
      } catch (err) {
        if (served && err instanceof Error && err.message === CLIENT_FEATURE_MISSING) return failed(SERVED_FILES_CLIENT_TOO_OLD);
        throw err;
      }
      return { content: answer.content.map((block) => ({ ...block })), details: undefined, ...(answer.isError === true ? { isError: true } : {}) } as AgentToolResult<undefined>;
    },
  }) as ToolDefinition);
}

function failed(text: string): AgentToolResult<undefined> {
  return { content: [{ type: 'text', text }], details: undefined, isError: true } as AgentToolResult<undefined>;
}
