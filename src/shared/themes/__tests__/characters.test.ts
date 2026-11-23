import { describe, expect, it } from 'vitest';
import { englishText } from '../../localized-text';
import { frameView, MAX_SPRITE_FPS, parseProjectsFile, SAFE_STRIP_FPS, spriteFrame, spriteStrip, svgHeader, type FrameSources } from '../characters';
import { validateTheme, type AssetMeta } from '../schema';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';
const svg = (body: string, attributes = 'width="8" height="8"'): string => `<svg ${SVG_NS} ${attributes}>${body}</svg>`;
const refusal = (text: string): string | undefined => {
  const header = svgHeader(encode(text));
  return 'refused' in header ? englishText(header.refused) : undefined;
};

describe('svgHeader', () => {
  it.each([
    ['its width and height', svg('<path d="M0 0h8v8z"/>', 'width="12" height="6px"'), { width: 12, height: 6 }],
    ['its viewBox when it names no size', svg('', 'viewBox="0 0 20.4 10"'), { width: 20, height: 10 }],
    ['a declaration and comments before the root', `\n<?xml version="1.0" encoding="UTF-8"?>\n<!-- one --><!-- <script> -->\n${svg('')}`, { width: 8, height: 8 }],
    ['a prefixed root', '<s:svg xmlns:s="http://www.w3.org/2000/svg" width="4" height="4"><s:rect width="4" height="4"/></s:svg>', { width: 4, height: 4 }],
    ['shapes, groups, gradients and references inside the file', svg('<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient><clipPath id="c"><rect width="4" height="4"/></clipPath></defs>'
      + '<g clip-path="url(#c)" style="fill:url(#g);opacity:.5"><circle r="2"/><use href="#g"/><use xlink:href=" #g"/><text x="1">a &lt;script&gt; &amp; more</text></g><title>on a &gt; b</title><![CDATA[<script>]]>'), { width: 8, height: 8 }],
    ['an attribute value that holds an angle bracket', svg('<path d="M0 0" aria-label="a > b"/>', 'aria-label="1 > 0" width="8" height="8"'), { width: 8, height: 8 }],
  ])('reads %s', (_label, text, size) => {
    expect(svgHeader(encode(text))).toEqual(size);
  });

  it.each([
    ['a DOCTYPE', `<!DOCTYPE svg [<!ENTITY x "y">]>${svg('')}`, 'The SVG holds a DOCTYPE or ENTITY.'],
    ['an ENTITY', svg('<!ENTITY x "y">'), 'The SVG holds a DOCTYPE or ENTITY.'],
    ['a script', svg('<script>alert(1)</script>'), 'The SVG holds a script.'],
    ['a prefixed script', svg('<svg:script/>'), 'The SVG holds a script.'],
    ['a script in another case', svg('<SCRIPT/>'), 'The SVG holds a script.'],
    ['an event handler on the root', svg('', 'onload="x()" width="8" height="8"'), 'The SVG holds an event handler.'],
    ['an event handler in another case', svg('<path ONCLICK = "x()"/>'), 'The SVG holds an event handler.'],
    ['a foreignObject', svg('<foreignObject/>'), 'The SVG holds an embedded resource or style.'],
    ['an image', svg('<image href="#a"/>'), 'The SVG holds an embedded resource or style.'],
    ['an iframe', svg('<iframe/>'), 'The SVG holds an embedded resource or style.'],
    ['an embed', svg('<embed/>'), 'The SVG holds an embedded resource or style.'],
    ['an object', svg('<object/>'), 'The SVG holds an embedded resource or style.'],
    ['an audio', svg('<audio/>'), 'The SVG holds an embedded resource or style.'],
    ['a video', svg('<video/>'), 'The SVG holds an embedded resource or style.'],
    ['a style', svg('<style>path { fill: red }</style>'), 'The SVG holds an embedded resource or style.'],
    ['a link element', svg('<link rel="stylesheet"/>'), 'The SVG holds an embedded resource or style.'],
    ['a style under a dotted prefix', svg('<a.b:style/>'), 'The SVG holds an embedded resource or style.'],
    ['an image under a dotted prefix', svg('<a.b:image href="#x"/>'), 'The SVG holds an embedded resource or style.'],
    ['an animate', svg('<animate attributeName="x"/>'), 'The SVG holds an animation.'],
    ['an animateMotion', svg('<animateMotion/>'), 'The SVG holds an animation.'],
    ['an animateTransform', svg('<animateTransform/>'), 'The SVG holds an animation.'],
    ['an animateColor', svg('<animateColor/>'), 'The SVG holds an animation.'],
    ['a set', svg('<set attributeName="x" to="1"/>'), 'The SVG holds an animation.'],
    ['a discard', svg('<discard/>'), 'The SVG holds an animation.'],
    ['an animate under a dotted prefix', svg('<a.b:animate attributeName="x"/>', 'xmlns:a.b="http://www.w3.org/2000/svg" width="8" height="8"'), 'The SVG holds an animation.'],
    ['an animate under a prefix of other letters', svg('<é:animate/>'), 'The SVG holds an animation.'],
    ['an animate in another case', svg('<Animate/>'), 'The SVG holds an animation.'],
    ['an element that is no plain shape', svg('<metadata/>'), 'The SVG holds an element a sprite may not hold (metadata).'],
    ['an element named with a space no XML parser takes as one', svg('<path\u00A0d="M0 0"/>'), 'The SVG holds an element a sprite may not hold.'],
    ['a link out of the file', svg('<use href="https://example.com/x.svg#a"/>'), 'The SVG holds a link.'],
    ['an xlink out of the file', svg('<use xlink:href="data:image/svg+xml,x"/>'), 'The SVG holds a link.'],
    ['a link in another case', svg('<use HREF="//example.com"/>'), 'The SVG holds a link.'],
    ['a url out of the file in an attribute', svg('<path fill="url(https://example.com/x)"/>'), 'The SVG holds a link.'],
    ['a url out of the file in a style', svg('<path style="fill: URL( \'https://example.com/x\')"/>'), 'The SVG holds a link.'],
    ['a url spelled with a character reference', svg('<path style="fill:&#117;rl(https://example.com/x)"/>'), 'The SVG holds an escaped character in an attribute.'],
    ['a url spelled with a CSS escape', svg('<path style="fill:u\\72l(https://example.com/x)"/>'), 'The SVG holds an escaped character in an attribute.'],
    ['a link spelled with a character reference', svg('<use href="&#35;a"/>'), 'The SVG holds an escaped character in an attribute.'],
    ['an animation in a style', svg('<path style="animation: x 1s"/>'), 'The SVG holds a style rule.'],
    ['an animation property behind a comment', svg('<path style="animation-name/**/:x"/>'), 'The SVG holds a style rule.'],
    ['an animation spelled with a character reference', svg('<path style="&#97;nimation: x 1s"/>'), 'The SVG holds an escaped character in an attribute.'],
    ['a style sheet instruction before the root', `<?xml-stylesheet href="data:text/css,x"?>${svg('')}`, 'The SVG holds a processing instruction.'],
    ['a processing instruction inside', svg('<?php x ?>'), 'The SVG holds a processing instruction.'],
    ['a declared encoding other than UTF-8', `<?xml version="1.0" encoding="ISO-2022-JP"?>${svg('')}`, 'The SVG declares an encoding other than UTF-8.'],
    ['a root that is no svg', '<x><svg width="8" height="8"/></x>', 'The SVG does not start with an <svg> element.'],
    ['text before the root', `x${svg('')}`, 'The SVG does not start with an <svg> element.'],
    ['a comment that never ends', `<!-- ${svg('')}`, 'The SVG does not start with an <svg> element.'],
    ['a declaration that never ends', '<?xml version="1.0"', 'The SVG does not start with an <svg> element.'],
    ['nothing', '', 'The SVG does not start with an <svg> element.'],
    ['a tag that never ends', `<svg ${SVG_NS} width="8" height="8"><path d="M0 0"`, 'The SVG is not well-formed XML.'],
    ['an attribute with no quotes', svg('<path d=M0/>'), 'The SVG is not well-formed XML.'],
    ['a name of two prefixes', svg('<a:b:path/>'), 'The SVG is not well-formed XML.'],
    ['a comment inside that never ends', svg('<!-- <path/>').replace('</svg>', ''), 'The SVG is not well-formed XML.'],
    ['no size', svg('', ''), 'The SVG names no size in px.'],
    ['a size in another unit', svg('', 'width="2em" height="2em"'), 'The SVG names no size in px.'],
    ['a size named in another case', svg('', 'WIDTH="8" HEIGHT="8"'), 'The SVG names no size in px.'],
  ])('refuses %s', (_label, text, why) => {
    expect(refusal(text)).toBe(why);
  });

  it('refuses bytes that are not UTF-8', () => {
    expect(svgHeader(new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0xff, 0xfe, 0x3e]))).toEqual({ refused: { message: 'The SVG is not UTF-8 text.' } });
  });

  // Each input is far past the sprite cap in length; a reader that backtracks does not come back from the first within a lifetime.
  it.each([
    ['comments with no root after them', `${'<!---->'.repeat(50_000)}<x>`, 'The SVG does not start with an <svg> element.'],
    ['comments and spaces with no root after them', `${'<!-- a -->\n '.repeat(50_000)}`, 'The SVG does not start with an <svg> element.'],
    ['spaces in a tag that never ends', `<svg${' '.repeat(400_000)}`, 'The SVG is not well-formed XML.'],
    ['attributes whose last value never ends', `<svg${' a="b"'.repeat(60_000)} c="`, 'The SVG is not well-formed XML.'],
    ['open tags with no end', svg('<g>'.repeat(100_000)), undefined],
    ['open angle brackets', svg('<'.repeat(400_000)), 'The SVG is not well-formed XML.'],
  ])('reads %s in time linear in their length', (_label, text, why) => {
    const started = performance.now();
    expect(refusal(text)).toBe(why);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

const SHA = 'a'.repeat(64);
const COLORS = { background: '#0b0f14', panel: '#0f141a', text: '#e6edf3', accent: '#4cc2ff', success: '#3fcf8e', warning: '#f0b429', danger: '#f2555a', info: '#8ab4ff' };
const stripAsset = (frames: number, fps: number): AssetMeta => ({ kind: 'sprite', mime: 'image/png', bytes: 100, width: frames * 16, height: 16, frames, durationMs: Math.round((frames * 1000) / fps), license: {} });

describe('spriteStrip', () => {
  it('rebuilds a rate the validator accepts for every strip core stores', () => {
    const rates = [...Array.from({ length: MAX_SPRITE_FPS }, (_, i) => i + 1), 1.01, 2.356, 7.77, 33.3, 59.99];
    for (let frames = 2; frames <= 12; frames++) {
      for (const fps of rates) {
        const asset = stripAsset(frames, fps);
        const strip = spriteStrip(asset);
        expect(strip).toBeDefined();
        expect(strip!.fps).toBeLessThanOrEqual(MAX_SPRITE_FPS);
        const result = validateTheme({
          schemaVersion: 1, id: '3f1c2a4e-9b7d-4c1e-8a2f-5d6e7f809a1b', name: 'Night', looks: { dark: { colors: COLORS } },
          characters: { name: 'Crew', characters: [{ name: 'Pip', states: { idle: spriteFrame({ sha256: SHA, strip: strip! }) } }] },
          assets: { [SHA]: asset },
        });
        expect(result.ok ? [] : [`${frames} frames at ${fps} fps`, ...result.errors]).toEqual([]);
      }
    }
  });
});

describe('frameView', () => {
  const sources = (flash?: { readonly flagged: boolean; readonly allowed?: boolean }): FrameSources => ({ url: (sha) => `blob:${sha}`, flash: () => flash });
  const strip = (frames: number, fps: number) => ({ strip: { asset: SHA, frameWidth: 16, frameHeight: 16, frames, fps } });
  const view = (frame: ReturnType<typeof strip>, asset: AssetMeta, flash?: { readonly flagged: boolean; readonly allowed?: boolean }) => frameView(frame, { [SHA]: asset }, sources(flash));

  it('draws a strip over the still sprite cut it names', () => {
    expect(view(strip(4, 12), stripAsset(4, 12), { flagged: false })).toEqual({ url: `blob:${SHA}`, strip: { frameWidth: 16, frameHeight: 16, frames: 4, fps: 12 }, moves: true, playable: true });
    expect(view(strip(1, 1), { kind: 'sprite', mime: 'image/png', bytes: 100, width: 16, height: 16, license: {} })).toMatchObject({ moves: false, playable: false });
  });

  it.each([
    ['an animated wallpaper', { kind: 'animated', mime: 'image/gif', bytes: 100, width: 16, height: 16, frames: 20, license: {} }],
    ['an animated sprite', { kind: 'sprite', mime: 'image/gif', bytes: 100, width: 16, height: 16, frames: 20, license: {} }],
    ['a still image that is no sprite', { kind: 'image', mime: 'image/png', bytes: 100, width: 16, height: 16, license: {} }],
  ] as const)('draws nothing for a strip over %s, of one frame or more', (_label, asset) => {
    expect(view(strip(1, 1), asset, { flagged: false })).toBeUndefined();
    expect(view(strip(2, 6), asset, { flagged: false })).toBeUndefined();
    expect(view(strip(20, 6), asset, { flagged: false })).toBeUndefined();
  });

  it('draws nothing for a strip cut into other frames than its image\'s flash check ran on', () => {
    expect(view(strip(4, 24), { ...stripAsset(2, 12), width: 64 }, { flagged: false })).toBeUndefined();
  });

  it('lets a strip move on its flash check only at the cut and rate the check ran at', () => {
    const fast = SAFE_STRIP_FPS * 2;
    expect(view(strip(4, fast), stripAsset(4, fast), { flagged: false })?.playable).toBe(true);
    expect(view(strip(4, fast), stripAsset(4, fast), { flagged: true })?.playable).toBe(false);
    expect(view(strip(4, fast), stripAsset(4, fast), { flagged: true, allowed: true })?.playable).toBe(true);
    expect(view(strip(4, fast), stripAsset(4, fast))?.playable).toBe(false);
    // faster than the check, and an image with no record of its cut
    expect(view(strip(4, fast * 2), stripAsset(4, fast), { flagged: false })?.playable).toBe(false);
    expect(view(strip(4, fast), { kind: 'sprite', mime: 'image/png', bytes: 100, width: 64, height: 16, license: {} }, { flagged: false })?.playable).toBe(false);
    // slow enough to need no check
    expect(view(strip(4, SAFE_STRIP_FPS), { kind: 'sprite', mime: 'image/png', bytes: 100, width: 64, height: 16, license: {} })?.playable).toBe(true);
  });
});

describe('parseProjectsFile', () => {
  it('skips a __proto__ key, which would set the record\'s prototype', () => {
    const file = parseProjectsFile(JSON.parse('{"version":1,"pins":{"__proto__":{"byTheme":{"x":"y"}},"p":{"byTheme":{"x":"Pip"}}}}'));
    expect(Object.getPrototypeOf(file.pins)).toBe(Object.prototype);
    expect(Object.keys(file.pins)).toEqual(['p']);
    expect((file.pins as Record<string, unknown>)['byTheme']).toBeUndefined();
  });
});
