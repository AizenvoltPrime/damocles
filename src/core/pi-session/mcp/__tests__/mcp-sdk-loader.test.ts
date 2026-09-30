import { describe, it, expect } from 'vitest';
import { loadMcpSdk, getMcpSdk, isMcpSdkLoaded } from '../mcp-sdk-loader';

describe('mcp-sdk-loader', () => {
  it('dynamically imports the MCP SDK and all required subpaths', async () => {
    const bundle = await loadMcpSdk();
    expect(bundle).not.toBeNull();
    if (!bundle) return;

    expect(typeof bundle.client.Client).toBe('function');
    expect(typeof bundle.stdio.StdioClientTransport).toBe('function');
    expect(typeof bundle.http.StreamableHTTPClientTransport).toBe('function');
    expect(typeof bundle.sse.SSEClientTransport).toBe('function');
    expect(typeof bundle.auth.UnauthorizedError).toBe('function');
    expect(bundle.types.CallToolResultSchema).toBeDefined();
    expect(bundle.types.ListToolsResultSchema).toBeDefined();
  });

  it('caches the bundle across calls', async () => {
    const first = await loadMcpSdk();
    const second = await loadMcpSdk();
    expect(first).toBe(second);
    expect(isMcpSdkLoaded()).toBe(true);
    expect(getMcpSdk()).toBe(first);
  });
});
