import type { McpServerConfig, McpToolExposureScope, McpToolExposureSetting } from '@shared/types/mcp';
import type { WebviewToExtensionMessage } from '@shared/types/messages';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { usePlatformBridge } from './usePlatformBridge';

/** The MCP panel's edits of server definitions and settings, sent the same way from a chat page and the settings overlay. */
export function useMcpPanelWrites() {
  const { postMessage } = usePlatformBridge();
  const settingsStore = useSettingsStore();

  // Every write carries a requestId and is registered as in-flight before it is sent, so the form stays open holding what
  // the user typed until core acknowledges it.
  function sendWrite(build: (requestId: string) => WebviewToExtensionMessage): void {
    const requestId = crypto.randomUUID();
    settingsStore.beginMcpWrite(requestId);
    postMessage(build(requestId));
  }

  return {
    toggle: (serverName: string, enabled: boolean) => postMessage({ type: 'toggleMcpServer', serverName, enabled }),
    setEnabled: (enabled: boolean) => postMessage({ type: 'setMcpEnabled', enabled }),
    setToolExposure: (serverName: string, toolName: string, exposure: McpToolExposureSetting, scope: McpToolExposureScope) =>
      postMessage({ type: 'mcpSetToolExposure', serverName, toolName, exposure, scope }),
    setResourceExposure: (serverName: string, exposure: McpToolExposureSetting, scope: McpToolExposureScope) =>
      postMessage({ type: 'mcpSetResourceExposure', serverName, exposure, scope }),
    reloadConfig: () => postMessage({ type: 'mcpReloadConfig' }),
    addServer: (serverName: string, config: McpServerConfig) => sendWrite((requestId) => ({ type: 'mcpAddServer', requestId, serverName, config })),
    // `serverName` is the pre-rename name; `newServerName` is omitted entirely for an in-place edit.
    updateServer: (serverName: string, newServerName: string | undefined, config: McpServerConfig) =>
      sendWrite((requestId) =>
        newServerName === undefined
          ? { type: 'mcpUpdateServer', requestId, serverName, config }
          : { type: 'mcpUpdateServer', requestId, serverName, newServerName, config },
      ),
    deleteServer: (serverName: string) => sendWrite((requestId) => ({ type: 'mcpDeleteServer', requestId, serverName })),
  };
}
