// GTK color definitions: each GTK color function against values worked by hand, both spellings of a name, references and
// their cycle and depth refusals, media blocks, the fill-before-text order, and the .gresource refusal. Fixtures are written
// for this test.
import { describe, expect, it } from 'vitest';
import { englishText } from '../../localized-text';
import { gtkRoles, LIBADWAITA_INFO, LIBADWAITA_SEEDS, MAX_GTK_DEPTH } from '../schemes';
import { refusal, refused } from './scheme-refusal';

// the accent a dark file gives when it sets accent_bg_color to `expression`
const accentOf = (expression: string, extra = ''): string | undefined =>
  gtkRoles(`@define-color view_bg_color #101010;\n${extra}\n@define-color accent_bg_color ${expression};\n`, 'gtk.css').palettes.dark?.seeds.accent;
// the warnings a dark file gives when it sets accent_bg_color to `expression`
const warningsOf = (expression: string, extra = ''): string[] =>
  gtkRoles(`@define-color view_bg_color #101010;\n${extra}\n@define-color accent_bg_color ${expression};\n`, 'gtk.css').warnings.map(englishText);
const unread = (value: string): string => `gtk.css sets @accent_bg_color to ${value}, which Damocles cannot read, so that color comes from libadwaita.`;

describe('gtkRoles evaluates', () => {
  it.each([
    ['#abc', '#aabbcc'],
    ['#abcd', '#aabbccdd'],
    ['#123456', '#123456'],
    ['#11223344', '#11223344'],
    ['rebeccapurple', '#663399'],
    ['RED', '#ff0000'],
    ['rgb(10, 20, 30)', '#0a141e'],
    ['rgba(255, 0, 0, 0.5)', '#ff000080'],
    ['rgb(0 0 6 / 80%)', '#000006cc'],
    ['rgb(100%, 50%, 0%)', '#ff8000'],
    ['mix(#000000, #ffffff, 0.25)', '#404040'],
    ['mix(#ff0000, #0000ff, 0.5)', '#800080'],
    ['alpha(#336699, 0.5)', '#33669980'],
    ['alpha(rgba(0, 0, 0, 0.5), 0.5)', '#00000040'],
    // HLS: red is hue 0, saturation 1, lightness 0.5; times 0.5 gives saturation 0.5, lightness 0.25
    ['shade(#ff0000, 0.5)', '#602020'],
    // shade 0.7: saturation 0.7, lightness 0.35
    ['darker(#ff0000)', '#981b1b'],
    // gray keeps saturation 0; lightness 128/255 times 1.3 is 166.4/255
    ['lighter(#808080)', '#a6a6a6'],
    // #204060 is hue 210, saturation 0.5, lightness 64/255; times 1.3 gives 0.65 and 83.2/255
    ['lighter(#204060)', '#1d5389'],
    ['shade(mix(#000000, #ffffff, 0.5), 1)', '#808080'],
  ])('%s as %s', (expression, expected) => {
    expect(accentOf(expression)).toBe(expected);
  });

  it('@name and var(--name) references, both spellings of a libadwaita name, libadwaita\'s colors and a var() fallback', () => {
    expect(accentOf('@brand', '@define-color brand #224466;')).toBe('#224466');
    expect(accentOf('var(--brand)', ':root { --brand: #224466; }')).toBe('#224466');
    // libadwaita's --window-bg-color is @define-color window_bg_color
    expect(accentOf('var(--window-bg-color)', '@define-color window_bg_color #335577;')).toBe('#335577');
    expect(accentOf('@window_bg_color', ':root { --window-bg-color: #335577; }')).toBe('#335577');
    // a name the file does not define reads libadwaita's value of the kind
    expect(accentOf('var(--blue-3)')).toBe('#3584e4');
    expect(accentOf('@window_bg_color')).toBe('#222226');
    expect(accentOf('var(--not-defined, #123456)')).toBe('#123456');
    expect(accentOf('var(--brand, #123456)', ':root { --brand: #654321; }')).toBe('#654321');
  });

  it('keeps @name and --name apart for any name that is not libadwaita\'s, as GTK does', () => {
    expect(accentOf('var(--brand, #123456)', '@define-color brand #654321;')).toBe('#123456');
    expect(warningsOf('@brand', ':root { --brand: #654321; }')).toEqual([unread('@brand')]);
    expect(accentOf('var(--my-brand, #123456)', ':root { --my_brand: #654321; }')).toBe('#123456');
    expect(accentOf('var(--accent_bg_color, #123456)', '@define-color accent_bg_color #654321;')).toBe('#123456');
  });

  it('reads the GTK3 compatibility names through the file\'s own libadwaita colors', () => {
    const roles = gtkRoles('@define-color window_bg_color #303030; @define-color view_bg_color shade(@theme_bg_color, 0.9);', 'gtk.css');
    expect(roles.palettes).toEqual({ dark: expect.objectContaining({ seeds: expect.objectContaining({ background: '#2b2b2b', panel: '#303030' }) }) });
    const selected = gtkRoles('@define-color view_bg_color #101010; :root { --accent-bg-color: #ff8800; } @define-color success_bg_color @theme_selected_bg_color;', 'gtk.css');
    expect(selected.palettes.dark?.seeds.success).toBe('#ff8800');
    expect(refusal(() => gtkRoles('@define-color window_bg_color @theme_bg_color;', 'gtk.css'))).toBe('cycle');
  });

  it('does not read file names as Object.prototype keys', () => {
    expect(warningsOf('mix(constructor, #fff, 0.5)')).toEqual([unread('mix(constructor, #fff, 0.5)')]);
    expect(warningsOf('lighter(__proto__)')).toEqual([unread('lighter(__proto__)')]);
    expect(accentOf('var(--toString, #123456)')).toBe('#123456');
    expect(accentOf('var(--constructor, #123456)')).toBe('#123456');
  });

  it('leaves a value unread that is no finite number, a percentage factor, or rgb() in neither syntax', () => {
    for (const expression of [
      'shade(#000000, 1e999)', 'mix(#000000, #ffffff, 1e999)', 'mix(#000000, #ffffff, 50%)', 'alpha(#000000, 50%)', 'shade(#000000, 50%)',
      'rgb(1,,2,3)', 'rgb(,1 2 3)', 'rgb(1 2, 3)', 'rgba(1 2 3 4)', 'rgb(1, 2, 3,)', 'rgb(1, 2)', 'rgb(1, 2, 3, 4, 5)', 'rgb(1 2 3 / 4 / 5)', 'rgb(1 2 / 3)',
    ]) {
      expect(warningsOf(expression), expression).toEqual([unread(expression)]);
    }
    expect(accentOf('rgb(10 20 30)')).toBe('#0a141e');
    expect(accentOf('rgba(10, 20, 30)')).toBe('#0a141e');
  });

  it('leaves hsl(), currentColor and an unreadable variable unread, without using the var() fallback', () => {
    expect(warningsOf('hsl(0, 100%, 50%)')).toEqual([unread('hsl(0, 100%, 50%)')]);
    expect(warningsOf('currentColor')).toEqual([unread('currentColor')]);
    expect(warningsOf('var(--x, #123456)', ':root { --x: color-mix(in srgb, red, blue); }')).toEqual([unread('var(--x, #123456)')]);
  });

  it('quotes a value in a warning on one line of at most 80 characters, cut by code point', () => {
    expect(warningsOf('color-mix(in srgb,\n  red,\u202Eblue)')).toEqual([unread('color-mix(in srgb, red, blue)')]);
    const long = `color-mix(in srgb, ${'red '.repeat(30)}, blue)`;
    expect(warningsOf(long)).toEqual([unread(`${long.slice(0, 79)}…`)]);
    const emoji = `oklab(${'😀'.repeat(100)})`;
    expect(warningsOf(emoji)).toEqual([unread(`${[...emoji].slice(0, 79).join('')}…`)]);
  });

  it('a value with !important, comments anywhere and other rules around it', () => {
    const css = [
      '/* @define-color accent_bg_color #000000; */',
      'window { background: red; } headerbar:backdrop { color: @nothing; }',
      ':root { --view-bg-color: /* inline */ #101010 !important; --accent-bg-color: "x" , ; --accent-bg-color: #ff8800; }',
    ].join('\n');
    expect(gtkRoles(css, 'gtk.css').palettes.dark?.seeds).toMatchObject({ background: '#101010', accent: '#ff8800' });
  });
});

describe('gtkRoles roles', () => {
  it('prefers each fill to its standalone text color, and the view to the window for text', () => {
    const both = gtkRoles('@define-color view_bg_color #101010; @define-color accent_color #00ff00; @define-color accent_bg_color #ff0000;', 'gtk.css');
    expect(both.palettes.dark?.seeds.accent).toBe('#ff0000');
    const standalone = gtkRoles('@define-color view_bg_color #101010; @define-color accent_color #00ff00;', 'gtk.css');
    expect(standalone.palettes.dark?.seeds.accent).toBe('#00ff00');
    const text = gtkRoles('@define-color view_bg_color #101010; @define-color window_fg_color #aaaaaa; @define-color view_fg_color #eeeeee;', 'gtk.css');
    expect(text.palettes.dark?.seeds.text).toBe('#eeeeee');
    const errors = gtkRoles('@define-color view_bg_color #101010; @define-color destructive_bg_color #aa0000; @define-color error_color #ff0000;', 'gtk.css');
    expect(errors.palettes.dark?.seeds.danger).toBe('#aa0000');
  });

  it('sets info to libadwaita blue, GTK having no info role', () => {
    expect(gtkRoles('@define-color view_bg_color #101010;', 'gtk.css').palettes.dark?.seeds.info).toBe(LIBADWAITA_INFO);
  });

  it('leaves a role it cannot evaluate unset and names its variable in a warning', () => {
    const roles = gtkRoles(':root { --view-bg-color: #101010; --accent-bg-color: color-mix(in srgb, red 50%, blue); }', 'gtk.css');
    expect(roles.palettes.dark?.seeds.accent).toBeUndefined();
    expect(roles.warnings.map(englishText)).toEqual(['gtk.css sets --accent-bg-color to color-mix(in srgb, red 50%, blue), which Damocles cannot read, so that color comes from libadwaita.']);
  });

  it('warns about an @import it does not follow', () => {
    const roles = gtkRoles('@import url("colors.css");\n@define-color view_bg_color #101010;', 'gtk.css');
    expect(roles.warnings.map(englishText)).toEqual(['gtk.css imports url("colors.css"), which Damocles does not follow.']);
  });

  it('warns once about a value both kinds leave unread, and again about another value in a media block', () => {
    const css = [
      '@define-color view_bg_color #101010; @define-color accent_bg_color hsl(0, 0%, 0%);',
      '@media (prefers-color-scheme: light) { @define-color accent_bg_color hsl(1, 0%, 0%); }',
    ].join('\n');
    expect(gtkRoles(css, 'gtk.css', { kinds: ['dark', 'light'] }).warnings.map(englishText)).toEqual([
      'gtk.css sets @accent_bg_color to hsl(0, 0%, 0%), which Damocles cannot read, so that color comes from libadwaita.',
      'gtk.css sets @accent_bg_color to hsl(1, 0%, 0%), which Damocles cannot read, so that color comes from libadwaita.',
    ]);
  });
});

describe('gtkRoles kinds', () => {
  it('reads a look per media block over the top-level colors', () => {
    const css = [
      ':root { --accent-bg-color: #aa0000; }',
      '@media (prefers-color-scheme: dark) { :root { --view-bg-color: #111111; } }',
      '@media ( prefers-color-scheme : light ) { :root { --view-bg-color: #eeeeee; --accent-bg-color: #0000aa; } @define-color window_bg_color #dddddd; }',
      '@media (prefers-contrast: more) { :root { --view-bg-color: #000000; } }',
    ].join('\n');
    const { palettes } = gtkRoles(css, 'gtk.css');
    expect(palettes.dark).toMatchObject({ kind: 'dark', seeds: { background: '#111111', accent: '#aa0000' } });
    expect(palettes.light).toMatchObject({ kind: 'light', seeds: { background: '#eeeeee', accent: '#0000aa', panel: '#dddddd' } });
  });

  it('lets the later definition win, top level or media block', () => {
    const later = gtkRoles('@media (prefers-color-scheme: dark) { @define-color view_bg_color #111111; }\n@define-color view_bg_color #ffffff;', 'gtk.css', { kinds: ['dark'] });
    expect(later.palettes.dark?.seeds.background).toBe('#ffffff');
    const earlier = gtkRoles('@define-color view_bg_color #ffffff;\n@media (prefers-color-scheme: dark) { @define-color view_bg_color #111111; }', 'gtk.css', { kinds: ['dark'] });
    expect(earlier.palettes.dark?.seeds.background).toBe('#111111');
  });

  it('reads one look of its background\'s kind, both looks when it sets no background, and the media kinds alone with no top-level colors', () => {
    expect(Object.keys(gtkRoles('@define-color window_bg_color #f0f0f0;', 'gtk.css').palettes)).toEqual(['light']);
    expect(Object.keys(gtkRoles('@define-color accent_bg_color #f0a000;', 'gtk.css').palettes)).toEqual(['dark', 'light']);
    expect(Object.keys(gtkRoles('@media (prefers-color-scheme: dark) { :root { --accent-bg-color: #f0a000; } }', 'gtk.css').palettes)).toEqual(['dark']);
    expect(Object.keys(gtkRoles('@define-color window_bg_color #f0f0f0;', 'gtk.css', { kinds: ['dark'] }).palettes)).toEqual(['dark']);
  });

  it('counts the top level only when it sets a color Damocles reads, and reads both kinds for a background that follows libadwaita', () => {
    const helperOnly = '@define-color brand #f0a000;\n@media (prefers-color-scheme: dark) { @define-color accent_bg_color @brand; }';
    expect(Object.keys(gtkRoles(helperOnly, 'gtk.css').palettes)).toEqual(['dark']);
    expect(Object.keys(gtkRoles('@define-color view_bg_color @window_bg_color;', 'gtk.css').palettes)).toEqual(['dark', 'light']);
    expect(Object.keys(gtkRoles('@define-color view_bg_color shade(@window_bg_color, 0.5);', 'gtk.css').palettes)).toEqual(['dark', 'light']);
  });
});

describe('gtkRoles refuses', () => {
  it('a reference cycle, naming the color', () => {
    const err = refused(() => accentOf('@a', '@define-color a var(--b); :root { --b: @a; }'));
    expect(err.reason).toBe('cycle');
    expect(englishText(err.text)).toBe('gtk.css defines the color @a through itself.');
    const long = `a${'b'.repeat(200)}`;
    expect(englishText(refused(() => accentOf(`@${long}`, `@define-color ${long} @${long};`)).text)).toBe(`gtk.css defines the color @${long.slice(0, 78)}… through itself.`);
  });

  it(`references more than ${MAX_GTK_DEPTH} in a row, and color functions nested more than ${MAX_GTK_DEPTH} deep`, () => {
    // accent_bg_color and `links` more names, each referring to the next, the last a color
    const chain = (links: number): string => [
      '@define-color view_bg_color #101010;',
      '@define-color accent_bg_color @n1;',
      ...Array.from({ length: links - 1 }, (_, i) => `@define-color n${i + 1} @n${i + 2};`),
      `@define-color n${links} #ffffff;`,
    ].join('\n');
    // accent_bg_color @n1 is the first reference, so `links` names make `links` references
    expect(gtkRoles(chain(MAX_GTK_DEPTH), 'gtk.css').palettes.dark?.seeds.accent).toBe('#ffffff');
    expect(refusal(() => gtkRoles(chain(MAX_GTK_DEPTH + 1), 'gtk.css'))).toBe('depth');
    expect(accentOf(`${'alpha('.repeat(MAX_GTK_DEPTH)}#ffffff${', 1)'.repeat(MAX_GTK_DEPTH)}`)).toBe('#ffffff');
    expect(refusal(() => accentOf(`${'alpha('.repeat(MAX_GTK_DEPTH + 1)}#ffffff${', 1)'.repeat(MAX_GTK_DEPTH + 1)}`))).toBe('depth');
  });

  it('a file that only imports a .gresource theme, with the explanation', () => {
    const err = refused(() => gtkRoles('/* packaged theme */\n@import url("resource:///org/example/theme/gtk.css");\n', 'gtk.css'));
    expect(err.reason).toBe('noColors');
    expect(englishText(err.text)).toMatch(/compiled into a \.gresource file, which Damocles cannot read/);
  });

  it('a file that only imports another file, naming it', () => {
    const err = refused(() => gtkRoles('@import url("resource:///org/example/theme/gtk.css");\n@import \'colors.css\';\n', 'gtk.css'));
    expect(err.reason).toBe('noColors');
    expect(englishText(err.text)).toBe('gtk.css defines none of the GTK colors Damocles reads and imports \'colors.css\', which Damocles does not follow. Import that file instead.');
  });

  it('a file that defines none of the colors it reads, and text that is not CSS', () => {
    expect(refusal(() => gtkRoles('window { background: red; }\n@define-color brand #ff0000;', 'gtk.css'))).toBe('noColors');
    expect(refusal(() => gtkRoles('@define-color view_bg_color #101010; /* never closed', 'gtk.css'))).toBe('syntax');
    for (const end of ['\n', '\r', '\f']) expect(refusal(() => gtkRoles(`@define-color view_bg_color #101010; window { content: 'never closed${end}'; }`, 'gtk.css'))).toBe('syntax');
    expect(refusal(() => gtkRoles(':root { --view-bg-color: #101010;', 'gtk.css'))).toBe('syntax');
    expect(refusal(() => gtkRoles('@define-color view_bg_color #101010; }', 'gtk.css'))).toBe('syntax');
    expect(refusal(() => gtkRoles('just words', 'gtk.css'))).toBe('syntax');
  });
});

describe('LIBADWAITA_SEEDS', () => {
  it('holds the documented fills and the light text flattened over the view', () => {
    expect(LIBADWAITA_SEEDS.light).toEqual({ background: '#ffffff', panel: '#fafafb', text: '#333338', accent: '#3584e4', success: '#2ec27e', warning: '#e5a50a', danger: '#e01b24', info: '#3584e4' });
    expect(LIBADWAITA_SEEDS.dark).toEqual({ background: '#1d1d20', panel: '#222226', text: '#ffffff', accent: '#3584e4', success: '#26a269', warning: '#cd9309', danger: '#c01c28', info: '#3584e4' });
  });
});
