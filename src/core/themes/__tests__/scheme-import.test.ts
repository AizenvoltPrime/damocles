// KDE, Qt and GTK schemes as themes: names, the defaults each format falls back to, the one missing-roles warning in the
// reader's language, flattening, and a GTK file with two looks. Fixtures are written for this test.
import { describe, expect, it } from 'vitest';
import elBundle from '../../../../l10n/bundle.l10n.el.json' with { type: 'json' };
import { englishText, renderLocalizedText } from '../../../shared/localized-text';
import { refused } from '../../../shared/themes/__tests__/scheme-refusal';
import { BUILTIN_THEME } from '../../../shared/themes/builtin';
import type { Look } from '../../../shared/themes/schema';
import { LIBADWAITA_SEEDS } from '../../../shared/themes/schemes';
import { importGtkText, importKdeText, importQtText } from '../scheme-import';

const greek = (key: string): string | undefined => (elBundle as Record<string, string>)[key];

const looksOf = (theme: Readonly<Record<string, unknown>>): Record<string, Look> => theme['looks'] as Record<string, Look>;

const KDE = [
  '[Colors:View]', 'BackgroundNormal=250,250,250', 'ForegroundNormal=30,30,30,204', 'ForegroundInactive=100,100,100',
  'ForegroundPositive=0,128,0', 'ForegroundNeutral=200,120,0', 'ForegroundNegative=200,0,0', 'ForegroundActive=0,90,200',
  '', '[Colors:Window]', 'BackgroundNormal=235,235,235', '', '[Colors:Selection]', 'BackgroundNormal=20,100,220',
  '', '[General]', 'Name=  Fixture\tDay  ',
].join('\n');

const qtList = (base: string): string => Array.from({ length: 21 }, (_, i) => (i === 9 ? base : i === 10 ? '#ff2a2a2a' : i === 6 ? '#ffe0e0e0' : i === 12 ? '#ff3060c0' : i === 14 ? '#ff40a0ff' : i === 20 ? '#80e0e0e0' : '#ff000000')).join(', ');

describe('importKdeText', () => {
  it('makes one look from the scheme, its translucent text painted over the background, named by [General] Name as one line', () => {
    const { theme, warnings } = importKdeText(KDE, 'FixtureDay.colors');
    expect(theme['name']).toBe('Fixture Day');
    const looks = looksOf(theme);
    expect(Object.keys(looks)).toEqual(['light']);
    expect(looks['light']).toEqual({
      colors: { background: '#fafafa', panel: '#ebebeb', text: '#4a4a4a', accent: '#1464dc', success: '#008000', warning: '#c87800', danger: '#c80000', info: '#005ac8' },
      tokens: { '--d-muted': '#646464' },
    });
    expect(warnings).toEqual([]);
  });

  it('fills what the scheme leaves out from Damocles\' look of its kind, in one warning, and names it by its file', () => {
    const { theme, warnings } = importKdeText('[Colors:View]\nBackgroundNormal=10,10,10\nForegroundNormal=240,240,240\n', 'night.colors');
    expect(theme['name']).toBe('night');
    const dark = BUILTIN_THEME.looks.dark!.colors;
    expect(looksOf(theme)['dark']!.colors).toEqual({ ...dark, background: '#0a0a0a', text: '#f0f0f0' });
    expect(warnings.map(englishText)).toEqual(['night.colors sets no color for panel, accent, success, warning, danger and info, so Damocles\' own colors of that kind stand in.']);
    expect(renderLocalizedText(warnings[0]!, greek, 'el')).toBe('Το night.colors δεν ορίζει χρώμα για: πάνελ, χρώμα έμφασης, επιτυχία, προειδοποίηση, κίνδυνος και πληροφορία. Όπου λείπει, μπαίνει το αντίστοιχο χρώμα του Damocles.');
  });

  it('refuses a scheme with no name and no file stem', () => {
    const error = refused(() => importKdeText('[Colors:View]\nBackgroundNormal=10,10,10\n', '.colors'));
    expect(error.reason).toBe('noName');
    expect(englishText(error.text)).toBe('This KDE color scheme has no name.');
  });
});

describe('importQtText', () => {
  it('maps the palette, taking success, warning and danger from Damocles without a warning, since the card\'s note says so', () => {
    const { theme, warnings } = importQtText(`[ColorScheme]\nactive_colors=${qtList('#ff1a1a1a')}\n`, 'graphite.conf');
    expect(theme['name']).toBe('graphite');
    const dark = BUILTIN_THEME.looks.dark!.colors;
    expect(looksOf(theme)['dark']).toEqual({
      colors: { background: '#1a1a1a', panel: '#2a2a2a', text: '#e0e0e0', accent: '#3060c0', success: dark.success, warning: dark.warning, danger: dark.danger, info: '#40a0ff' },
      tokens: { '--d-muted': '#7d7d7d' },
    });
    expect(warnings).toEqual([]);
  });
});

describe('importGtkText', () => {
  it('fills a role it cannot read from libadwaita, naming the variable once and never as a color the file leaves out', () => {
    const { theme, warnings } = importGtkText(':root {\n  --window-bg-color: #242424;\n  --view-bg-color: #1e1e1e;\n  --view-fg-color: #ffffff;\n  --accent-bg-color: oklab(from var(--blue-3) l a b);\n}\n', 'gtk.css');
    expect(theme['name']).toBe('gtk');
    const dark = looksOf(theme)['dark']!;
    expect(dark.colors).toEqual({ ...LIBADWAITA_SEEDS.dark, background: '#1e1e1e', panel: '#242424', text: '#ffffff' });
    expect(warnings.map(englishText)).toEqual([
      'gtk.css sets --accent-bg-color to oklab(from var(--blue-3) l a b), which Damocles cannot read, so that color comes from libadwaita.',
      'gtk.css sets no color for success, warning and danger, so libadwaita\'s defaults stand in.',
    ]);
  });

  it('says nothing is left out when the only color it fills is one it could not read, in either look', () => {
    const seeds = '--window-bg-color: #242424; --view-bg-color: #1e1e1e; --view-fg-color: #ffffff; --accent-bg-color: #3584e4; --success-color: #26a269; --warning-color: #cd9309;';
    const css = `:root { ${seeds} --error-color: color-mix(in srgb, red 80%, white); }\n@media (prefers-color-scheme: light) { :root { --view-bg-color: #ffffff; } }\n`;
    const { theme, warnings } = importGtkText(css, 'gtk.css');
    expect(Object.keys(looksOf(theme))).toEqual(['dark', 'light']);
    expect(warnings.map(englishText)).toEqual(['gtk.css sets --error-color to color-mix(in srgb, red 80%, white), which Damocles cannot read, so that color comes from libadwaita.']);
  });

  it('makes a dark and a light look from media blocks, each over libadwaita of its kind', () => {
    const css = '@media (prefers-color-scheme: dark) { :root { --accent-bg-color: #c061cb; } }\n@media (prefers-color-scheme: light) { :root { --accent-bg-color: #813d9c; } }\n';
    const looks = looksOf(importGtkText(css, 'purple.css').theme);
    expect(looks['dark']!.colors).toEqual({ ...LIBADWAITA_SEEDS.dark, accent: '#c061cb' });
    expect(looks['light']!.colors).toEqual({ ...LIBADWAITA_SEEDS.light, accent: '#813d9c' });
  });
});
