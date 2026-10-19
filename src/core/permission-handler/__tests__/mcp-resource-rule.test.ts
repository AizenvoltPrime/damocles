import { describe, it, expect } from 'vitest';
import { disabledResourceMatcher, parseMcpResourceUriRule, uriRuleCovers } from '../mcp-resource-rule';
import { matchesToolPattern } from '../../pi-session/mcp/exposure';
import { createMcpToolName } from '../../pi-session/mcp/naming';

describe('parseMcpResourceUriRule', () => {
  it('splits at the first ( and the final ), so a URI holding parentheses round-trips', () => {
    expect(parseMcpResourceUriRule('mcp__secret__read_mcp_resource(secret://passwords)')).toEqual({ toolName: 'mcp__secret__read_mcp_resource', uriPattern: 'secret://passwords' });
    expect(parseMcpResourceUriRule('mcp__secret__read_mcp_resource(file:///a (copy)/b))')).toEqual({ toolName: 'mcp__secret__read_mcp_resource', uriPattern: 'file:///a (copy)/b)' });
    expect(parseMcpResourceUriRule('mcp__secret__read_mcp_resource(()')).toEqual({ toolName: 'mcp__secret__read_mcp_resource', uriPattern: '(' });
    expect(parseMcpResourceUriRule('mcp__secret__read_mcp_resource(logs/* x)')).toEqual({ toolName: 'mcp__secret__read_mcp_resource', uriPattern: 'logs/* x' });
  });

  it('returns the URI exactly for every rule the migration writes, a hashed long server name included', () => {
    for (const [server, uri] of [['secret', 'secret://passwords'], ['s'.repeat(60), 'x://a(b)c*d e'], ['my.server', 'repo://)(']] as const) {
      const toolName = createMcpToolName(server, 'read_mcp_resource');
      expect(parseMcpResourceUriRule(`${toolName}(${uri})`)).toEqual({ toolName, uriPattern: uri });
    }
  });

  it('returns null for a rule without the form or with an empty pattern', () => {
    for (const rule of ['mcp__secret__read_mcp_resource', 'mcp__secret__read_mcp_resource()', 'mcp__(x)', 'Read(x)', 'mcp__secret__read_mcp_resource(x', 'mcp__secret)']) {
      expect(parseMcpResourceUriRule(rule), rule).toBeNull();
    }
  });
});

describe('matchesToolPattern on a URI pattern', () => {
  it('matches the whole URI, with * as the only wildcard', () => {
    expect(matchesToolPattern('secret://passwords', 'secret://passwords')).toBe(true);
    expect(matchesToolPattern('secret://passwords', 'secret://passwords2')).toBe(false);
    expect(matchesToolPattern('secret://logs/*', 'secret://logs/a/b')).toBe(true);
    expect(matchesToolPattern('secret://logs/*', 'secret://logs')).toBe(false);
    expect(matchesToolPattern('*://x?.[a]', 'f://x?.[a]')).toBe(true);
    expect(matchesToolPattern('*://x?.[a]', 'f://xy.a')).toBe(false);
    expect(matchesToolPattern('a*b*c', 'abc')).toBe(true);
    expect(matchesToolPattern('a*b*c', 'acb')).toBe(false);
    expect(matchesToolPattern('ab*ba', 'aba')).toBe(false);
  });

  it('matches a literal * in a URI through the wildcard', () => {
    expect(matchesToolPattern('x://a*', 'x://a*b')).toBe(true);
    expect(matchesToolPattern('x://a*b', 'x://a*b')).toBe(true);
  });

  it('runs in linear time on an adversarial pattern and URI', () => {
    const uri = 'a'.repeat(200_000);
    const pattern = `${'*a'.repeat(20_000)}*`;
    const backtrackingPattern = `${'*aa'.repeat(2_000)}*ab*`;
    const started = performance.now();
    expect(matchesToolPattern(pattern, uri)).toBe(true);
    expect(matchesToolPattern(backtrackingPattern, uri)).toBe(false);
    expect(matchesToolPattern(`*${'a'.repeat(1_000)}b*`, uri)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('uriRuleCovers', () => {
  it('names a read of a matching URI on the server, spelled as its pi name, as written or as Claude Code spells it', () => {
    for (const rule of ['mcp__my_srv__read_mcp_resource(x://a/*)', 'mcp__my.srv__read_mcp_resource(x://a/*)', `${createMcpToolName('my.srv', 'read_mcp_resource')}(x://a/*)`]) {
      expect(uriRuleCovers(rule, 'my.srv', 'x://a/b'), rule).toBe(true);
    }
    expect(uriRuleCovers('mcp__my_srv__read_mcp_resource(x://a/*)', 'my.srv', 'x://b')).toBe(false);
    expect(uriRuleCovers('mcp__other__read_mcp_resource(x://a/*)', 'my.srv', 'x://a/b')).toBe(false);
  });

  it('names nothing for a rule that is not the URI-scoped form or names another tool', () => {
    for (const rule of ['mcp__srv__read_mcp_resource', 'mcp__srv__*', 'mcp__srv__list_mcp_resources(x://a)', 'Read(x://a)']) {
      expect(uriRuleCovers(rule, 'srv', 'x://a'), rule).toBe(false);
    }
  });
});

describe('disabledResourceMatcher', () => {
  it('turns off what the URI-scoped entries name and ignores entries that name tools', () => {
    const turnedOff = disabledResourceMatcher(['read_mcp_resource', 'mcp__git__status', 'mcp__docs__read_mcp_resource(docs://secret/*)']);
    expect(turnedOff('docs', 'docs://secret/key')).toBe(true);
    expect(turnedOff('docs', 'docs://public')).toBe(false);
    expect(turnedOff('git', 'docs://secret/key')).toBe(false);
  });

  it('turns nothing off for a list without URI-scoped entries', () => {
    expect(disabledResourceMatcher(['mcp__docs__search'])('docs', 'docs://a')).toBe(false);
    expect(disabledResourceMatcher([])('docs', 'docs://a')).toBe(false);
  });
});
