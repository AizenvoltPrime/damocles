import { describe, it, expect } from 'vitest';
import {
  assignServerToolNames,
  createMcpToolName,
  isMcpToolName,
  legacyMcpToolName,
  legacyServerPrefixMap,
  MCP_TOOL_PREFIX,
  parseLegacyMcpToolName,
  resourceNameToToolName,
} from '../naming';

describe('createMcpToolName (pi port)', () => {
  it('keeps names that are already [A-Za-z0-9_] and within 64 characters', () => {
    expect(createMcpToolName('git', 'status')).toBe('mcp__git__status');
    expect(createMcpToolName('docs', 'a__b')).toBe('mcp__docs__a__b');
  });

  it('replaces every other character with _ across the whole name, server and tool alike', () => {
    expect(createMcpToolName('context7', 'resolve-library-id')).toBe('mcp__context7__resolve_library_id');
    expect(createMcpToolName('my.server', 'search')).toBe('mcp__my_server__search');
    expect(createMcpToolName('@scope/pkg', 'a.b c')).toBe('mcp___scope_pkg__a_b_c');
  });

  it('cuts a name over 64 characters and appends the 8-character hash pi computes', () => {
    const name = createMcpToolName('github', 'a'.repeat(80));
    expect(name).toBe('mcp__github__aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_16bc6b69');
    expect(name).toHaveLength(64);
  });

  it('gives a taken name the hash suffix, distinct per raw tool name', () => {
    const taken = () => true;
    expect(createMcpToolName('docs', 'a-b', taken)).toBe('mcp__docs__a_b_4f33a9a2');
    expect(createMcpToolName('docs', 'a_b', taken)).toBe('mcp__docs__a_b_63617bb9');
  });

  it('marks MCP names by prefix', () => {
    expect(isMcpToolName('mcp__git__status')).toBe(true);
    expect(isMcpToolName('Edit')).toBe(false);
    expect(MCP_TOOL_PREFIX).toBe('mcp__');
  });
});

describe('assignServerToolNames', () => {
  it('suffixes every tool whose plain name collides, whatever the list order', () => {
    const forward = assignServerToolNames('docs', ['a-b', 'a_b', 'c'], new Set());
    const reversed = assignServerToolNames('docs', ['c', 'a_b', 'a-b'], new Set());

    expect(Object.fromEntries(forward)).toEqual({
      'a-b': 'mcp__docs__a_b_4f33a9a2',
      a_b: 'mcp__docs__a_b_63617bb9',
      c: 'mcp__docs__c',
    });
    expect(Object.fromEntries(reversed)).toEqual(Object.fromEntries(forward));
  });

  it('suffixes a name another server already holds', () => {
    const names = assignServerToolNames('docs', ['x'], new Set(['mcp__docs__x']));
    expect(names.get('x')).toMatch(/^mcp__docs__x_[0-9a-f]{8}$/);
  });

  it('names a tool listed twice once', () => {
    expect([...assignServerToolNames('docs', ['x', 'x'], new Set()).entries()]).toEqual([['x', 'mcp__docs__x']]);
  });
});

describe('resourceNameToToolName', () => {
  it('slugs resource names for get_* tools', () => {
    expect(resourceNameToToolName('My Resource')).toBe('my_resource');
    expect(resourceNameToToolName('123abc')).toBe('resource_123abc');
    expect(resourceNameToToolName('!!!')).toBe('resource');
  });
});

describe('legacyServerPrefixMap (migration only)', () => {
  it('reproduces the old prefixes: collapsed punctuation, sorted numeric suffixes', () => {
    const map = legacyServerPrefixMap(['my-server', 'my.server', 'other']);
    expect(Object.fromEntries(map)).toEqual({ 'my-server': 'my_server', 'my.server': 'my_server_2', other: 'other' });
    expect(Object.fromEntries(legacyServerPrefixMap(['other', 'my.server', 'my-server']))).toEqual(Object.fromEntries(map));
  });

  it('orders by code unit, not locale', () => {
    const map = legacyServerPrefixMap(['my_server', 'my-server', 'my.server']);
    expect(map.get('my-server')).toBe('my_server');
    expect(map.get('my.server')).toBe('my_server_2');
    expect(map.get('my_server')).toBe('my_server_3');
  });

  it('never lets a derived prefix take a real server\u2019s name', () => {
    const map = legacyServerPrefixMap(['my.server', 'my-server', 'my_server_2']);
    expect(map.get('my_server_2')).toBe('my_server_2');
    expect(new Set(map.values()).size).toBe(3);
  });

  it('cuts long names to 48 characters without a trailing underscore', () => {
    expect(legacyServerPrefixMap(['x'.repeat(300)]).get('x'.repeat(300))).toBe('x'.repeat(48));
    expect(legacyServerPrefixMap([`${'a'.repeat(47)}-b`]).get(`${'a'.repeat(47)}-b`)).not.toMatch(/_$/);
    expect(legacyServerPrefixMap(['___']).get('___')).toBe('server');
  });

  it('suffixes around prefixes another manager reserved, as folder servers did around user servers', () => {
    const map = legacyServerPrefixMap(['a-b', 'a_b_3'], new Set(['a_b', 'a_b_2']));
    expect(map.get('a-b')).toBe('a_b_4');
    expect(map.get('a_b_3')).toBe('a_b_3');
  });

  it('round-trips a legacy tool name through parse and format', () => {
    expect(parseLegacyMcpToolName('mcp__my_server_2__resolve-library-id')).toEqual({ prefix: 'my_server_2', tool: 'resolve-library-id' });
    expect(parseLegacyMcpToolName('mcp__docs__a__b')).toEqual({ prefix: 'docs', tool: 'a__b' });
    expect(parseLegacyMcpToolName('Bash')).toBeNull();
    expect(legacyMcpToolName('context7', 'resolve-library-id')).toBe('mcp__context7__resolve-library-id');
  });
});
