import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkWallpaper } from '../../../core/themes/assets';
import { checkSprite } from '../../../core/themes/characters';
import { SAFE_STRIP_FPS } from '../../../shared/themes/characters';

import { BUILTIN_EXAMPLE_IDS, BUILTIN_THEME } from '../../../shared/themes/builtin';
import { validateTheme } from '../../../shared/themes/schema';
import { AA, checkPalette, colorMix, contrast, contrastPairs, describeIssue, luminance, over, parse, TRANSPARENT } from '../../../shared/themes/contrast';
import { deriveLook } from '../../../shared/themes/derive';
import { LOOK_KINDS } from '../../../shared/themes/tokens';
import { THEME_PALETTES } from '../../theme-palettes';

const REPO = path.resolve(__dirname, '..', '..', '..', '..');

// The rules live in checkPalette (src/shared/themes/contrast.ts); docs/invariants.md "Design tokens" lists every value adjusted to reach them.
describe('desktop palette contrast', () => {
  it('computes WCAG ratios', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('mixes and paints like CSS color-mix(in srgb) over an opaque surface', () => {
    const tint = colorMix(parse('#ff0000'), 0.25, TRANSPARENT);
    expect(tint).toEqual([1, 0, 0, 0.25]);
    expect(over(tint, parse('#ffffff')).map((c) => Math.round(c * 255))).toEqual([255, 191, 191, 255]);
    expect(colorMix(parse('#000000'), 0.5, parse('#ffffff')).map((c) => Math.round(c * 255))).toEqual([128, 128, 128, 255]);
  });

  // tokens.css picks VS Code's --d-on-danger, --d-on-warning, --d-on-success and --d-on-info the same way: white below luminance 0.179, else black.
  it.each(['#f85149', '#f48771', '#a1260d', '#b5200d', '#cca700', '#bf8803', '#ffd370', '#895503'])('the VS Code foreground on a solid status fill reaches AA on %s', (fill) => {
    const on = luminance(parse(fill)) < 0.179 ? '#ffffff' : '#000000';
    expect(contrast(on, fill)).toBeGreaterThanOrEqual(AA);
  });

  describe.each(LOOK_KINDS)('the built-in %s look', (kind) => {
    const palette = THEME_PALETTES[kind];

    it('is the built-in theme derived with its overrides', () => {
      const look = BUILTIN_THEME.looks[kind]!;
      expect(palette).toEqual(deriveLook(look.colors, kind, look.tokens));
    });

    it('passes every contrast rule, warnings included', () => {
      expect(checkPalette(palette, kind).map(describeIssue)).toEqual([]);
    });

    // Guards the rule set itself: an emptied pair list would pass every palette.
    it.each(['text', 'on-fill', 'tint-text', 'row-text', 'hover-text', 'menu-hint', 'design-strip', 'switch-knob', 'ansi', 'safety', 'fill'] as const)('checks the %s rule', (rule) => {
      expect(contrastPairs(kind).some((pair) => pair.rule === rule)).toBe(true);
    });
  });

  // The built-in examples ship as packed files; each look derives from its colors alone and passes every rule.
  describe.each(BUILTIN_EXAMPLE_IDS)('the built-in example %s', (id) => {
    const json: unknown = JSON.parse(fs.readFileSync(path.join(REPO, 'resources', 'themes', id, 'theme.json'), 'utf8'));
    const result = validateTheme(json, { builtin: true, folder: id });

    it('is a valid built-in theme', () => {
      expect(result.ok ? [] : result.errors).toEqual([]);
    });

    it.each(LOOK_KINDS)('passes every contrast rule in its %s look, warnings included, when it has one', (kind) => {
      const look = result.ok ? result.theme.looks[kind] : undefined;
      if (!look) return;
      expect(checkPalette(deriveLook(look.colors, kind, look.tokens), kind).map(describeIssue)).toEqual([]);
    });
  });

  // Its wallpapers are packed files named by their sha256, which the generator writes (scripts/generate-theme-art.ts).
  it('ships Aurora as a dark and a light look, each with one image across every panel, packed under its sha256 and within the caps', () => {
    const dir = path.join(REPO, 'resources', 'themes', 'damocles-aurora');
    const aurora = validateTheme(JSON.parse(fs.readFileSync(path.join(dir, 'theme.json'), 'utf8')), { builtin: true, folder: 'damocles-aurora' });
    if (!aurora.ok) throw new Error(aurora.errors.join('\n'));
    for (const kind of LOOK_KINDS) {
      const set = aurora.theme.looks[kind]?.wallpapers?.[0];
      expect(set?.span?.panels).toEqual(['titlebar', 'sidebar', 'chat', 'editor', 'terminal']);
      const bytes = fs.readFileSync(path.join(dir, `${set!.span!.asset}.png`));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(set!.span!.asset);
      expect(bytes.length).toBeLessThan(512 * 1024);
      expect(checkWallpaper(bytes, 'aurora.png')).toMatchObject({ width: aurora.theme.assets![set!.span!.asset]!.width, height: aurora.theme.assets![set!.span!.asset]!.height });
    }
  });

  // Its sprites are pixel grids the generator makes into strips (scripts/generate-theme-art.ts), packed under their sha256.
  it('ships Arcade as a dark look with characters in every state, each a sprite strip within the caps that steps too slowly to flash', () => {
    const dir = path.join(REPO, 'resources', 'themes', 'damocles-arcade');
    const arcade = validateTheme(JSON.parse(fs.readFileSync(path.join(dir, 'theme.json'), 'utf8')), { builtin: true, folder: 'damocles-arcade' });
    if (!arcade.ok) throw new Error(arcade.errors.join('\n'));
    expect(arcade.theme.looks.light).toBeUndefined();
    expect(arcade.theme.characters?.characters.length).toBeGreaterThanOrEqual(4);
    for (const character of arcade.theme.characters!.characters) {
      for (const state of ['idle', 'running', 'waiting'] as const) {
        const frame = character.states[state];
        if (!frame || !('strip' in frame)) throw new Error(`${character.name} has no ${state} strip`);
        expect(frame.strip.fps).toBeLessThanOrEqual(SAFE_STRIP_FPS);
        const bytes = fs.readFileSync(path.join(dir, `${frame.strip.asset}.svg`));
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(frame.strip.asset);
        expect(checkSprite(bytes, 'sprite.svg', { frames: frame.strip.frames, fps: frame.strip.fps })).toMatchObject({ width: frame.strip.frameWidth * frame.strip.frames, height: frame.strip.frameHeight });
        expect(bytes.toString('utf8')).toContain('shape-rendering="crispEdges"');
      }
    }
  });

  it('ships Paper as a light look with square corners, density 0.9, a 40rem chat column and Damocles\' fonts', () => {
    const paper = validateTheme(JSON.parse(fs.readFileSync(path.join(REPO, 'resources', 'themes', 'damocles-paper', 'theme.json'), 'utf8')), { builtin: true, folder: 'damocles-paper' });
    expect(paper.ok && paper.theme.looks.dark).toBeUndefined();
    expect(paper.ok && paper.theme.looks.light).toBeDefined();
    expect(paper.ok && paper.theme.style).toEqual({ radius: 0, density: 0.9, chatColumn: 40 });
  });
});
