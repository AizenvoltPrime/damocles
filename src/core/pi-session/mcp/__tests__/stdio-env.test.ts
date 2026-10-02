import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_INHERITED_ENV_VARS as SDK_VARS, getDefaultEnvironment as sdkDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DEFAULT_INHERITED_ENV_VARS, getDefaultEnvironment, stdioEnvironment } from '../stdio-env';
import { loadMcpClient } from '../mcp-client-loader';

afterEach(() => vi.unstubAllEnvs());

describe('stdio env allowlist (port of the MCP SDK getDefaultEnvironment)', () => {
  it('lists exactly the variables the SDK lets a stdio server inherit', () => {
    expect([...DEFAULT_INHERITED_ENV_VARS]).toEqual([...SDK_VARS]);
  });

  it('builds the same environment the SDK builds, provider keys excluded', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-must-not-leak');
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-must-not-leak');
    expect(getDefaultEnvironment()).toEqual(sdkDefaultEnvironment());
    expect(Object.values(getDefaultEnvironment())).not.toContain('sk-ant-must-not-leak');
  });

  it('lets a server env key that differs only in case replace the default on Windows', () => {
    vi.stubEnv('PATH', 'host-path');
    const env = stdioEnvironment({ Path: 'server-path' }, 'win32');
    expect(Object.keys(env).filter((key) => key.toUpperCase() === 'PATH')).toEqual(['Path']);
    expect(env['Path']).toBe('server-path');
  });

  it('keeps both keys where variable names are case-sensitive', () => {
    vi.stubEnv('PATH', 'host-path');
    const env = stdioEnvironment({ Path: 'server-path' }, 'linux');
    expect(env).toMatchObject({ PATH: 'host-path', Path: 'server-path' });
  });

  it('skips an allowlisted variable holding an exported shell function', () => {
    const name = DEFAULT_INHERITED_ENV_VARS[0]!;
    vi.stubEnv(name, '() { echo pwned; }');
    expect(getDefaultEnvironment()).not.toHaveProperty(name);
  });
});

describe('mcp-client-loader', () => {
  it('loads pi-mcp and its oauth entry once and shares the bundle', async () => {
    const [first, second] = await Promise.all([loadMcpClient(), loadMcpClient()]);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(typeof first?.mcp.McpClient).toBe('function');
    expect(typeof first?.mcp.StdioTransport).toBe('function');
    expect(typeof first?.mcp.StreamableHttpTransport).toBe('function');
    expect(typeof first?.oauth.authorizeMcp).toBe('function');
    expect(typeof first?.oauth.adaptOAuthProvider).toBe('function');
  });
});
