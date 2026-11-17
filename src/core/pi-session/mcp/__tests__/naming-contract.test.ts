import { describe, expect, it } from 'vitest';
import * as mcp from '@earendil-works/pi-mcp';
import { assignServerToolNames, createMcpToolName } from '../naming';

// Damocles persists these names in session files, permission rules and hook matchers, so they must stay pi-mcp's.
const CASES: ReadonlyArray<readonly [string, string]> = [
  ['git', 'status'],
  ['context7', 'resolve-library-id'],
  ['@scope/pkg', 'a.b c'],
  ['github', 'a'.repeat(80)],
  ['s'.repeat(70), 'tool'],
  ['x'.repeat(28), 'y'.repeat(28)],
  ['x'.repeat(28), 'y'.repeat(29)],
  ['docs', 'a-b'],
  ['docs', 'a_b'],
  ['ドキュメント', '検索'],
  ['café', 'naïve-tool'],
  ['emoji', '\u{1F600}'],
  ['', 'tool'],
  ['server', ''],
  ['', ''],
];

describe('createMcpToolName matches pi-mcp', () => {
  it.each(CASES)('names (%j, %j) as pi-mcp does', (server, tool) => {
    expect(createMcpToolName(server, tool)).toBe(mcp.createMcpToolName(server, tool));
  });

  it.each(CASES)('names a taken (%j, %j) as pi-mcp does', (server, tool) => {
    const taken = (): boolean => true;
    expect(createMcpToolName(server, tool, taken)).toBe(mcp.createMcpToolName(server, tool, taken));
  });

  it('gives a-b and a_b of one server the distinct names pi-mcp gives them', () => {
    const names = assignServerToolNames('docs', ['a-b', 'a_b'], new Set());
    const plain = [mcp.createMcpToolName('docs', 'a-b'), mcp.createMcpToolName('docs', 'a_b')];
    const collides = (candidate: string): boolean => plain.indexOf(candidate) !== plain.lastIndexOf(candidate);
    expect(names.get('a-b')).toBe(mcp.createMcpToolName('docs', 'a-b', collides));
    expect(names.get('a_b')).toBe(mcp.createMcpToolName('docs', 'a_b', collides));
    expect(names.get('a-b')).not.toBe(names.get('a_b'));
  });
});
