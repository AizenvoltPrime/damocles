import { describe, it, expect } from 'vitest';
import {
  sanitizeServerName,
  formatMcpToolName,
  buildServerPrefixMap,
  resourceNameToToolName,
  isMcpToolName,
  MCP_TOOL_PREFIX,
} from '../naming';

describe('mcp naming', () => {
  it('sanitizes server names to alphanumeric/underscore', () => {
    expect(sanitizeServerName('my-server')).toBe('my_server');
    expect(sanitizeServerName('my.server')).toBe('my_server');
    expect(sanitizeServerName('@scope/pkg')).toBe('scope_pkg');
    expect(sanitizeServerName('___')).toBe('server');
  });

  it('formats the mcp__ double-underscore scheme', () => {
    expect(formatMcpToolName('git', 'status')).toBe('mcp__git__status');
    expect(isMcpToolName('mcp__git__status')).toBe(true);
    expect(isMcpToolName('Edit')).toBe(false);
    expect(MCP_TOOL_PREFIX).toBe('mcp__');
  });

  it('de-duplicates distinct servers that sanitize to the same prefix', () => {
    const map = buildServerPrefixMap(['my-server', 'my.server', 'other']);
    expect(map.get('my-server')).toBe('my_server');
    expect(map.get('my.server')).toBe('my_server_2');
    expect(map.get('other')).toBe('other');
    // The two distinct servers never collide on the final tool name.
    expect(formatMcpToolName(map.get('my-server') as string, 't')).not.toBe(
      formatMcpToolName(map.get('my.server') as string, 't'),
    );
  });

  it('slugs resource names for get_* tools', () => {
    expect(resourceNameToToolName('My Resource')).toBe('my_resource');
    expect(resourceNameToToolName('123abc')).toBe('resource_123abc');
    expect(resourceNameToToolName('!!!')).toBe('resource');
  });
});
