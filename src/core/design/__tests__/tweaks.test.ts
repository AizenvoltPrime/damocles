import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PiCodingAgentModule } from '../../pi-session/pi-loader';
import { DESIGN_DECISIONS_DETAIL_KEY, type DeclareTweaksDetails } from '../../../shared/types/design';
import { isTweakColor, tweakCss } from '../../../shared/design-tweaks';
import { recordDecision } from '../decisions';
import { createDeclareTweaksTool } from '../tools/declare-tweaks';
import type { DesignChatToolDeps } from '../tools/design-chat-tools';
import { declareTweaks, keepPromptText, keepTweak, tweakLocks, tweaksOnBranch, TweaksRefusedError, type DeclareTweaksInput } from '../tweaks';

const TOKENS = new Map([
  ['--radius', '8px'],
  ['--radius-sm', '4px'],
  ['--radius-md', '8px'],
  ['--radius-lg', '12px'],
  ['--accent', '#7c5cff'],
  ['--accent-blue', '#2563eb'],
  ['--accent-green', 'oklch(0.7 0.15 150)'],
  ['--accent-brand', 'var(--brand)'],
]);

const RADIUS = { id: 'radius', label: 'Corner radius', property: '--radius', stops: ['--radius-sm', '--radius-md', '--radius-lg'] };
const ACCENT = { id: 'accent', label: 'Accent', property: '--accent', stops: ['--accent-blue', '--accent-green'] };
const INPUT: DeclareTweaksInput = { controls: [RADIUS, ACCENT] };

let n = 0;
const entry = (fields: Record<string, unknown>) => ({ id: `e${++n}`, parentId: null, timestamp: '2026-01-01T00:00:00.000Z', ...fields });
const declared = (details: DeclareTweaksDetails, toolCallId = `call-${n}`, isError = false) => entry({ type: 'message', message: { role: 'toolResult', toolCallId, toolName: 'DeclareTweaks', content: [], details, isError } });
const kept = (tweakId: string, property: string, value: string) => entry({ type: 'custom', customType: 'damocles-design-tweak-kept', data: { userEntryId: 'u1', toolCallId: 'call-1', tweakId, label: 'Corner radius', property, value } });
const decision = (id: string, ref: string, chosen: string) => entry({ type: 'message', message: { role: 'toolResult', toolCallId: `d${n}`, toolName: 'RecordDecision', content: [], details: { [DESIGN_DECISIONS_DETAIL_KEY]: [{ v: 1, id, title: 'Corner radius', chosen, rejected: [], source: { kind: 'tweak', ref }, files: [] }] } } });

describe('DeclareTweaks', () => {
  it('declares controls with their stop values, a swatch only over literal colors (acceptance)', () => {
    const details = declareTweaks(INPUT, TOKENS, []);
    expect(details.controls).toEqual([
      { id: 'radius', label: 'Corner radius', property: '--radius', kind: 'segment', stops: [{ token: '--radius-sm', value: '4px' }, { token: '--radius-md', value: '8px' }, { token: '--radius-lg', value: '12px' }], locked: null },
      { id: 'accent', label: 'Accent', property: '--accent', kind: 'swatch', stops: [{ token: '--accent-blue', value: '#2563eb' }, { token: '--accent-green', value: 'oklch(0.7 0.15 150)' }], locked: null },
    ]);
    const viaVar = declareTweaks({ controls: [RADIUS, { ...ACCENT, stops: ['--accent-blue', '--accent-brand'] }] }, TOKENS, []);
    expect(viaVar.controls[1]!.kind).toBe('segment');
  });

  it('refuses a stop that is not a token in tokens.css, naming it (acceptance)', () => {
    expect(() => declareTweaks({ controls: [RADIUS, { ...ACCENT, stops: ['--accent-blue', '#ff0000'] }] }, TOKENS, [])).toThrow(/the stop "#ff0000" is not a token in tokens\.css/);
    expect(() => declareTweaks({ controls: [RADIUS, { ...ACCENT, stops: ['--accent-blue', '--accent-pink'] }] }, TOKENS, [])).toThrow(/--accent-pink/);
    expect(() => declareTweaks({ controls: [RADIUS, { ...ACCENT, stops: ['--accent-blue', '--x;}body{color:red'] }] }, TOKENS, [])).toThrow(TweaksRefusedError);
  });

  it('refuses a property that is no token, a control count outside 2 to 5, repeats, a stop of itself and no tokens.css', () => {
    expect(() => declareTweaks({ controls: [RADIUS, { ...ACCENT, property: '--nope' }] }, TOKENS, [])).toThrow(/--nope is not a token/);
    expect(() => declareTweaks({ controls: [RADIUS] }, TOKENS, [])).toThrow(/Declare 2 to 5 controls/);
    expect(() => declareTweaks({ controls: [RADIUS, { ...RADIUS, id: 'r2' }] }, TOKENS, [])).toThrow(/Two controls set --radius/);
    expect(() => declareTweaks({ controls: [RADIUS, { ...ACCENT, id: 'radius' }] }, TOKENS, [])).toThrow(/Two controls are named "radius"/);
    expect(() => declareTweaks({ controls: [RADIUS, { ...ACCENT, stops: ['--accent', '--accent-blue'] }] }, TOKENS, [])).toThrow(/cannot be a stop of itself/);
    expect(() => declareTweaks({ controls: [RADIUS, { ...ACCENT, label: 'two\nlines' }] }, TOKENS, [])).toThrow(/label/);
    expect(() => declareTweaks(INPUT, new Map(), [])).toThrow(/run ExtractTokens first/);
  });

  it('locks a control whose property a tweak decision settled, with its decision id (acceptance)', () => {
    const branch = [kept('radius', '--radius', '--radius-lg'), decision('D1', 'radius', '--radius-lg')];
    expect(tweakLocks(branch).get('--radius')).toEqual({ decisionId: 'D1', value: '--radius-lg' });
    const details = declareTweaks(INPUT, TOKENS, branch);
    expect(details.controls.map((control) => control.locked)).toEqual([{ decisionId: 'D1', value: '--radius-lg' }, null]);
    expect(tweakLocks([decision('D1', 'radius', '--radius-lg')]).size).toBe(0);
  });

  it('serves the latest declaration on the branch with its locks read now; an error result or none is no declaration', () => {
    const first = declareTweaks(INPUT, TOKENS, []);
    expect(tweaksOnBranch([])).toBeNull();
    const branch: unknown[] = [declared(first, 'call-a')];
    expect(tweaksOnBranch(branch)?.toolCallId).toBe('call-a');
    branch.push(declared({ controls: [] }, 'call-b', true));
    expect(tweaksOnBranch(branch)?.toolCallId).toBe('call-a');
    branch.push(kept('radius', '--radius', '--radius-md'), decision('D1', 'radius', '--radius-md'));
    expect(tweaksOnBranch(branch)?.controls[0]!.locked).toEqual({ decisionId: 'D1', value: '--radius-md' });
  });

  it('keeps only a stop of an unlocked control of the latest declaration', () => {
    const branch: unknown[] = [declared(declareTweaks(INPUT, TOKENS, []), 'call-a')];
    const outcome = keepTweak(branch, 'radius', '--radius-lg');
    expect(outcome).toEqual({ kept: { toolCallId: 'call-a', tweakId: 'radius', label: 'Corner radius', property: '--radius', value: '--radius-lg' } });
    if ('kept' in outcome) expect(keepPromptText(outcome.kept)).toBe('Keep: Corner radius → --radius-lg');
    expect(keepTweak(branch, 'radius', '--accent-blue')).toEqual({ refused: 'notAStop' });
    expect(keepTweak(branch, 'shadow', '--radius-lg')).toEqual({ refused: 'noControl' });
    branch.push(kept('radius', '--radius', '--radius-lg'), decision('D1', 'radius', '--radius-lg'));
    expect(keepTweak(branch, 'radius', '--radius-sm')).toEqual({ refused: 'locked' });
  });

  it('makes a Keep a decision only through RecordDecision with the kept value (acceptance)', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'design-tweaks-'));
    try {
      const branch = [kept('radius', '--radius', '--radius-lg')];
      expect(tweakLocks(branch).size).toBe(0);
      await expect(recordDecision(branch, { title: 'Corner radius', chosen: '--radius-md', source: { kind: 'tweak', ref: 'radius' } }, [], folder)).rejects.toThrow(/kept --radius-lg/);
      expect((await recordDecision(branch, { title: 'Corner radius', chosen: '--radius-lg', source: { kind: 'tweak', ref: 'radius' } }, [], folder)).chosen).toBe('--radius-lg');
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe('the tweak sheet main inserts', () => {
  it('is built only from token names', () => {
    expect(tweakCss('--radius', '--radius-lg')).toBe(':root { --radius: var(--radius-lg) !important; }');
    for (const [property, token] of [['--radius', '--x);}body{display:none'], ['radius', '--radius-lg'], ['--radius', 'var(--x)'], ['--a b', '--radius-lg'], ['--radius', '--']]) {
      expect(() => tweakCss(property!, token!)).toThrow(/only tokens/);
    }
  });

  it('reads a swatch color only as hex or a color function of numbers', () => {
    for (const color of ['#fff', '#7c5cffcc', 'rgb(1 2 3)', 'oklch(0.7 0.15 150 / 50%)', 'hsl(210, 40%, 50%)']) expect(isTweakColor(color)).toBe(true);
    for (const value of ['red', 'var(--brand)', 'url(x.png)', '12px', 'rgb(var(--x))', '#ggg']) expect(isTweakColor(value)).toBe(false);
  });
});

describe('the DeclareTweaks tool', () => {
  const pi = { defineTool: (definition: unknown) => definition } as unknown as PiCodingAgentModule;
  type Tool = { name: string; execute: (id: string, params: unknown) => Promise<{ content: { text: string }[]; details: DeclareTweaksDetails }> };
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
  });
  const deps = (ruleSet: 'full' | 'reduced', folder: string): DesignChatToolDeps => ({
    role: () => ({ designId: 'd', folder, parentSessionId: null, ruleSet, title: 't' }),
    enabled: () => true,
    branch: () => [],
  }) as unknown as DesignChatToolDeps;

  it('reads tokens.css, writes nothing, and runs only where the preview is (FULL)', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'design-tweaks-'));
    folders.push(folder);
    fs.writeFileSync(path.join(folder, 'tokens.css'), `:root {\n${[...TOKENS].map(([name, value]) => `  ${name}: ${value};`).join('\n')}\n}\n`);
    const before = fs.readdirSync(folder);
    const tool = createDeclareTweaksTool(pi, deps('full', folder)) as unknown as Tool;
    const result = await tool.execute('call-1', INPUT);
    expect(result.details.controls.map((control) => control.id)).toEqual(['radius', 'accent']);
    expect(result.content[0]!.text).toContain('radius (Corner radius) sets --radius');
    expect(fs.readdirSync(folder)).toEqual(before);
    await expect((createDeclareTweaksTool(pi, deps('reduced', folder)) as unknown as Tool).execute('call-2', INPUT)).rejects.toThrow(/only in the Damocles app/);
    await expect(tool.execute('call-3', { controls: [RADIUS, { ...ACCENT, stops: ['--accent-blue', 'blue'] }] })).rejects.toThrow(/DeclareTweaks declared nothing:\n.*"blue" is not a token/);
  });
});
