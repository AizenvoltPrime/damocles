// The theme editor's contrast warnings on a look's 8 colors and their lightness fixes. Pure.
import { formatHex, fromOklab, parseHex, quantize, toOklab } from '@shared/themes/color';
import { AA, backdropLabel, backdropTokens, contrast, contrastPairs, NON_TEXT, type ContrastIssue } from '@shared/themes/contrast';
import type { LookColors } from '@shared/themes/schema';
import { ANSI_TOKENS, fillToken, onToken, SEED_TONES, SHADOW_TOKEN, SURFACE_TOKENS, SYNTAX_TOKENS, TONES, toneTextToken, toneToken, type LookKind, type TokenName } from '@shared/themes/tokens';

export type Seed = keyof LookColors;
export type Surface = 'background' | 'panel';

// Text needs 4.5:1 and each tone's fill 3:1, on Background and on Panel.
const NEEDS: ReadonlyArray<readonly [Seed, number]> = [['text', AA], ...SEED_TONES.map((tone): readonly [Seed, number] => [tone, NON_TEXT])];
const L_STEP = 0.002;

export interface ColorWarning {
  readonly seed: Seed;
  readonly need: number;
  readonly ratio: number;
  // the surface it fails worst on
  readonly on: Surface;
  // the seed with its lightness moved to the nearest value that passes on both surfaces; absent when no lightness does
  readonly fixed?: string;
  readonly fixedRatio?: number;
}

/** A ratio to one decimal, rounded down so a value shown as passing passes: 4.46 is 4.4. */
export const floorRatio = (ratio: number): number => Math.floor(ratio * 10) / 10;

const opaque = (hex: string): string | undefined => (parseHex(hex)?.[3] === 1 ? hex : undefined);

/** `hex` with only its OKLab lightness moved, to the nearest value meeting `need` on every surface; undefined when none does. */
export function lightnessFix(hex: string, surfaces: readonly string[], need: number): string | undefined {
  const seed = parseHex(hex);
  if (!seed) return undefined;
  const passes = (candidate: string): boolean => surfaces.every((surface) => contrast(candidate, surface) >= need);
  if (passes(formatHex(quantize(seed)))) return formatHex(quantize(seed));
  const lab = toOklab(seed);
  for (let step = 1; step * L_STEP <= 1; step++) {
    for (const l of [lab.l + step * L_STEP, lab.l - step * L_STEP]) {
      if (l < 0 || l > 1) continue;
      const candidate = formatHex(quantize(fromOklab({ ...lab, l })));
      if (passes(candidate)) return candidate;
    }
  }
  return undefined;
}

export function colorWarnings(colors: LookColors): ColorWarning[] {
  const background = opaque(colors.background);
  const panel = opaque(colors.panel);
  if (!background || !panel) return [];
  return NEEDS.flatMap(([seed, need]): ColorWarning[] => {
    const value = opaque(colors[seed]);
    if (!value) return [];
    const ratios: Array<[Surface, number, string]> = [['background', contrast(value, background), background], ['panel', contrast(value, panel), panel]];
    const [on, ratio, surface] = ratios.reduce((worst, next) => (next[1] < worst[1] ? next : worst));
    if (ratio >= need) return [];
    const fixed = lightnessFix(value, [background, panel], need);
    return [{ seed, need, ratio, on, ...(fixed !== undefined ? { fixed, fixedRatio: contrast(fixed, surface) } : {}) }];
  });
}

const pairKey = (rule: string, fg: TokenName, label: string): string => `${rule}\n${fg}\n${label}`;
const BACKDROPS = new Map<LookKind, ReadonlyMap<string, readonly TokenName[]>>();

/** The tokens behind the text of a failing pair, which an override of any of them can cause. */
export function issueBackdrop(issue: ContrastIssue, kind: LookKind): readonly TokenName[] {
  let pairs = BACKDROPS.get(kind);
  if (!pairs) {
    pairs = new Map(contrastPairs(kind).map((pair) => [pairKey(pair.rule, pair.fg, backdropLabel(pair.bg)), backdropTokens(pair.bg)]));
    BACKDROPS.set(kind, pairs);
  }
  return pairs.get(pairKey(issue.rule, issue.fg, issue.bg)) ?? [];
}

export type TokenGroup = 'surfaces' | 'text' | 'tones' | 'tints' | 'syntax' | 'ansi';

/** Every overridable token of a look, in the Advanced table's six groups. */
export const TOKEN_GROUPS: ReadonlyArray<readonly [TokenGroup, readonly TokenName[]]> = [
  ['surfaces', SURFACE_TOKENS],
  ['text', ['--d-text', '--d-muted', '--d-faint', '--d-faint-text']],
  ['tones', TONES.flatMap((tone) => [fillToken(tone), toneToken(tone), onToken(tone), toneTextToken(tone)])],
  ['tints', ['--d-accent-soft', '--d-add', '--d-del', '--d-scrim', SHADOW_TOKEN]],
  ['syntax', SYNTAX_TOKENS],
  ['ansi', ANSI_TOKENS],
];
