import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { RemoteHost } from '../../../platform/remote-host';
import type { PanelHost } from '../../../platform/window-service';
import { TOOL_BROWSER_REQUEST_INPUT } from '../../../shared/tool-names';

/**
 * A daemon's core's browser tools: the same names, schemas and descriptions, each call run by the client showing the chat, in
 * that chat's browser scope on the client (user.browser.tool). Request input fills a page on the client from a form in the
 * chat, which no relay carries, so it answers that it is unavailable here.
 */
export function relayedBrowserTools(definitions: readonly ToolDefinition[], remote: RemoteHost, chat: PanelHost | undefined, scope: string): ToolDefinition[] {
  return definitions.map((definition): ToolDefinition => ({
    ...definition,
    execute: async (_toolCallId, input, signal) => {
      if (definition.name === TOOL_BROWSER_REQUEST_INPUT) return failed('BrowserRequestInput is not available in a chat on a remote host.');
      if (!chat) return failed('The browser runs beside a chat, and this agent has none.');
      const answer = await remote.browserTool(chat, scope, definition.name, input, signal);
      return { content: answer.content.map((block) => ({ ...block })), details: undefined, ...(answer.isError === true ? { isError: true } : {}) } as AgentToolResult<undefined>;
    },
  }) as ToolDefinition);
}

function failed(text: string): AgentToolResult<undefined> {
  return { content: [{ type: 'text', text }], details: undefined, isError: true } as AgentToolResult<undefined>;
}
