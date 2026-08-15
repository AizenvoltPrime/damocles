import { describe, it, expect } from 'vitest';
import {
  sanitizeServerName,
  formatMcpToolName,
  buildServerPrefixMap,
  resourceNameToToolName,
  isMcpToolName,
  MCP_TOOL_PREFIX,
  remapMcpToolNamesForRename,
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

  it('assigns the same prefixes whatever order the caller supplies the names in', () => {
    // The de-collision suffix is assigned by iteration order, and the caller's order comes from MCP
    // config merge order — which `damocles.assetSourcePrecedence` can flip. Since `damocles.tools.disabled`
    // stores fully-qualified `mcp__<prefix>__<tool>` names, an order-dependent prefix would silently
    // repoint a user's disabled-tool entries at a different server.
    const forward = buildServerPrefixMap(['my-server', 'my.server', 'other']);
    const reversed = buildServerPrefixMap(['other', 'my.server', 'my-server']);
    expect(Object.fromEntries(reversed)).toEqual(Object.fromEntries(forward));
    expect(reversed.get('my-server')).toBe('my_server');
    expect(reversed.get('my.server')).toBe('my_server_2');
  });

  it('does not mutate the caller-supplied array while sorting', () => {
    const names = ['zeta', 'alpha'];
    buildServerPrefixMap(names);
    expect(names).toEqual(['zeta', 'alpha']);
  });

  it('orders by codepoint rather than locale, so prefixes do not depend on the user locale', () => {
    // All three sanitize to `my_server`, and the two orderings disagree about which gets the bare prefix:
    // by codepoint `-` (0x2D) < `.` (0x2E) < `_` (0x5F), while an ICU collation puts `my_server` first.
    // Only the codepoint order is reproducible across machines and locales.
    const map = buildServerPrefixMap(['my_server', 'my-server', 'my.server']);
    expect(map.get('my-server')).toBe('my_server');
    expect(map.get('my.server')).toBe('my_server_2');
    expect(map.get('my_server')).toBe('my_server_3');
  });

  it('slugs resource names for get_* tools', () => {
    expect(resourceNameToToolName('My Resource')).toBe('my_resource');
    expect(resourceNameToToolName('123abc')).toBe('resource_123abc');
    expect(resourceNameToToolName('!!!')).toBe('resource');
  });
});

describe('buildServerPrefixMap — de-collision never steals a real name', () => {
  it('leaves a server named like a derived prefix holding its own name', () => {
    // One pass hands `my.server` the prefix `my_server_2` before the server ACTUALLY called
    // `my_server_2` is reached, pushing it to `my_server_2_2`. Claiming every base first means a
    // numeric suffix can only land on a prefix no server asked for.
    const map = buildServerPrefixMap(['my.server', 'my-server', 'my_server_2']);

    expect(map.get('my_server_2')).toBe('my_server_2');
    expect(new Set(map.values()).size).toBe(3);
  });

  it('still de-collides when every base is taken', () => {
    const map = buildServerPrefixMap(['a-b', 'a.b', 'a_b']);
    expect(new Set(map.values()).size).toBe(3);
    expect(map.get('a-b')).toBe('a_b');
  });
});

describe('sanitizeServerName — length bound', () => {
  it('bounds an imported name so one server cannot brick every request', () => {
    // Imported names (`~/.claude*`, `.mcp.json`, a TOML table key) are never checked against the
    // 64-char rule the form enforces. Providers cap the whole `mcp__<prefix>__<tool>` name — OpenAI at
    // 64 — by rejecting the entire request, so an over-long one fails every turn with an opaque 400.
    const prefix = sanitizeServerName('x'.repeat(300));

    expect(prefix.length).toBeLessThanOrEqual(48);
    expect(formatMcpToolName(prefix, 'read').length).toBeLessThanOrEqual(64);
  });

  it('does not leave a trailing underscore when the cut lands on one', () => {
    expect(sanitizeServerName(`${'a'.repeat(47)}-b`)).not.toMatch(/_$/);
  });

  it('still de-collides names that only differ past the cut', () => {
    const long = 'y'.repeat(60);
    const map = buildServerPrefixMap([`${long}-one`, `${long}-two`]);
    expect(new Set(map.values()).size).toBe(2);
  });
});

describe('remapMcpToolNamesForRename', () => {
  it('follows the renamed server so individually disabled tools stay disabled', () => {
    const remapped = remapMcpToolNamesForRename(
      ['mcp__docs__search', 'mcp__docs__fetch', 'Bash'],
      ['docs', 'weather'],
      'docs',
      'handbook',
    );

    expect(remapped).toEqual(['mcp__handbook__search', 'mcp__handbook__fetch', 'Bash']);
  });

  it('follows a THIRD server whose prefix the rename moved', () => {
    // De-collision suffixes are handed out over the whole sorted set, so renaming `my-server` away
    // promotes `my.server` from `my_server_2` to `my_server`. A string-replace of only the renamed
    // server's prefix would leave that entry pointing at nothing.
    const remapped = remapMcpToolNamesForRename(
      ['mcp__my_server_2__go'],
      ['my-server', 'my.server'],
      'my-server',
      'zulu',
    );

    expect(remapped).toEqual(['mcp__my_server__go']);
  });

  it('leaves a tool name whose own half contains __ intact', () => {
    expect(remapMcpToolNamesForRename(['mcp__docs__a__b'], ['docs'], 'docs', 'handbook'))
      .toEqual(['mcp__handbook__a__b']);
  });

  it('is a no-op when nothing moved', () => {
    const names = ['mcp__docs__search'];
    expect(remapMcpToolNamesForRename(names, ['docs'], 'docs', 'docs')).toEqual(names);
  });
});
