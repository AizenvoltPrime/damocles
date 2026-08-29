import { describe, it, expect } from 'vitest';
import { ownEntry } from '../ownEntry';
import { subagentTypeLabelKey } from '../subagentTypeLabel';

/**
 * Every table these guard is indexed by text the model chose: a tool name or a `subagent_type`. A bare
 * index returns an inherited `Object.prototype` member, which is truthy and not undefined, so both
 * `||` and `??` fallbacks pass it straight through to a caller expecting a miss.
 */

const PROTOTYPE_KEYS = ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__'];

describe('ownEntry', () => {
  const table: Record<string, string> = { real: 'hit' };

  it('returns the value for a key the table declares', () => {
    expect(ownEntry(table, 'real')).toBe('hit');
  });

  it.each(PROTOTYPE_KEYS)('returns undefined for the inherited member %s', (key) => {
    expect(ownEntry(table, key)).toBeUndefined();
  });

  it.each(PROTOTYPE_KEYS)('is not merely checking that %s is undefined', (key) => {
    // Pins the gate to own-property membership: `__proto__` indexes to an object, and the rest to
    // functions, so a `!== undefined` check would let every one of these through.
    expect((table as Record<string, unknown>)[key]).toBeDefined();
  });

  it('returns undefined for an ordinary missing key', () => {
    expect(ownEntry(table, 'absent')).toBeUndefined();
  });
});

describe('subagentTypeLabelKey', () => {
  it('maps a real subagent type to its translation key', () => {
    expect(subagentTypeLabelKey('code-reviewer')).toBe('subagentTypes.codeReviewer');
  });

  it.each(PROTOTYPE_KEYS)('returns null for a subagent type named %s', (key) => {
    // `agentType` is `input.subagent_type` off the Agent tool, so the model picks this string, and the
    // caller feeds the result straight to `t()`.
    expect(subagentTypeLabelKey(key)).toBeNull();
  });

  it('returns null for an unknown type, so the caller shows the raw id', () => {
    expect(subagentTypeLabelKey('something-invented')).toBeNull();
  });
});
