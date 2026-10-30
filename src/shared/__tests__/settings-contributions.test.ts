import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ASSET_SOURCE_PRECEDENCES,
  DEFAULT_SUBAGENT_CONCURRENCY,
  SUBAGENT_CONCURRENCY_MAX,
  SUBAGENT_CONCURRENCY_MIN,
  clampSubagentConcurrency,
  parseAssetSourcePrecedence,
} from '../types/constants';

// package.json cannot import the constants, so each copy it holds is checked against them here.
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8')) as {
  contributes: { configuration: { properties: Record<string, { default?: unknown; enum?: string[]; minimum?: number; maximum?: number; scope?: string }> } };
};
const contribution = (key: string) => pkg.contributes.configuration.properties[key];

describe('damocles.subagents.maxConcurrent contribution', () => {
  it('declares the range and default of the shared constants', () => {
    expect(contribution('damocles.subagents.maxConcurrent')).toMatchObject({
      minimum: SUBAGENT_CONCURRENCY_MIN,
      maximum: SUBAGENT_CONCURRENCY_MAX,
      default: DEFAULT_SUBAGENT_CONCURRENCY,
    });
  });
});

describe('clampSubagentConcurrency', () => {
  it.each([
    [9, 9],
    [2.5, 2],
    [0, SUBAGENT_CONCURRENCY_MIN],
    [32, SUBAGENT_CONCURRENCY_MAX],
    ['8', DEFAULT_SUBAGENT_CONCURRENCY],
    [Number.NaN, DEFAULT_SUBAGENT_CONCURRENCY],
    [undefined, DEFAULT_SUBAGENT_CONCURRENCY],
  ])('runs a stored %j as %d', (stored, limit) => {
    expect(clampSubagentConcurrency(stored)).toBe(limit);
  });
});

describe('damocles.assetSourcePrecedence contribution', () => {
  it('declares the values of ASSET_SOURCE_PRECEDENCES, and its default is what an unset value parses to', () => {
    const setting = contribution('damocles.assetSourcePrecedence');
    expect(setting?.enum).toEqual([...ASSET_SOURCE_PRECEDENCES]);
    expect(setting?.default).toBe(parseAssetSourcePrecedence(undefined));
  });
});

// A project file must not reorder the user's own .claude and .codex assets, or set the sweep that covers every project.
// The precedence is machine scoped because skill and command loading runs on the remote host, which then owns it.
describe.each([
  ['damocles.assetSourcePrecedence', 'machine'],
  ['damocles.checkpoints.retentionDays', 'application'],
])('%s contribution', (key, scope) => {
  it(`is ${scope}-scoped, not settable per project`, () => {
    expect(contribution(key)?.scope).toBe(scope);
  });
});
