import { describe, expect, it } from 'vitest';
import { CSS_REGIONS, type CssRegion } from '../schema';
import {
  ALLOWED_CSS_PROPERTIES, ALLOWED_CSS_PSEUDO_CLASSES, CSS_MAX_DATA_URL_CHARS, CSS_MAX_DROPPED, CSS_MAX_LAYERS, CSS_MAX_NESTING, CSS_MAX_RULES, CSS_REGION_LIMIT_BYTES, CSS_TOTAL_LIMIT_BYTES,
  decodeCssEscapes, sanitizeThemeCss, themeCssFamilies,
  type CssDropReason, type SanitizedThemeCss,
} from '../css-sanitizer';
import { avif, gif, jpeg, png, webpExtended, webpLossy } from '../testing/image-fixtures';

const FAMILIES = ['My Font', 'dt-0123abcd-Fira Code'];
const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const dataUrl = (type: string, bytes: Uint8Array): string => `data:image/${type};base64,${base64(bytes)}`;
const PNG = dataUrl('png', png(1, 1));
const SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='4' height='4'><text>x</text></svg>";
const WRAP_START = '@layer damocles-user { @scope ([data-theme-scope~="transcript"]) to ([data-trusted], [data-trusted-mark], .monaco-editor, .xterm) { ';
const WRAP_END = ' } }';
const SCOPED = ':where(:scope) ';

// Every result must hold the properties main relies on: sanitizing what core kept drops nothing and paints the same, and the
// painted text can never close its style element.
function checked(result: SanitizedThemeCss, families: readonly string[] = FAMILIES): SanitizedThemeCss {
  const again = sanitizeThemeCss(result.kept, { families });
  expect(again.dropped).toEqual([]);
  expect(again.droppedMore).toBe(0);
  expect(again.kept).toEqual(result.kept);
  expect(again.scoped).toEqual(result.scoped);
  for (const css of Object.values(result.scoped)) {
    expect(css).not.toContain('</');
    expect(css).toMatch(/^@layer damocles-user \{ @scope \(\[data-theme-scope~="[a-zA-Z]+"\]\) to \(\[data-trusted\], \[data-trusted-mark\], \.monaco-editor, \.xterm\) \{ /);
  }
  return result;
}

function clean(css: string, families: readonly string[] = FAMILIES): { kept: string | undefined; inner: string | undefined; drops: Array<[CssDropReason, string]> } {
  const result = checked(sanitizeThemeCss({ transcript: css }, { families }), families);
  const scoped = result.scoped.transcript;
  if (scoped !== undefined) {
    expect(scoped.startsWith(WRAP_START) && scoped.endsWith(WRAP_END)).toBe(true);
  }
  return {
    kept: result.kept.transcript,
    // every selector carries the descendant prefix (its own test below); the cases read without it
    inner: scoped?.slice(WRAP_START.length, scoped.length - WRAP_END.length).replaceAll(SCOPED, ''),
    drops: result.dropped.map((part) => {
      expect(part.region).toBe('transcript');
      return [part.reason, part.text];
    }),
  };
}

const reasons = (css: string): CssDropReason[] => clean(css).drops.map(([reason]) => reason);
// A declaration on its own: undefined when kept, else the reason it was dropped.
const verdict = (declaration: string): CssDropReason | undefined => {
  const { drops, inner } = clean(`p { ${declaration} }`);
  if (drops.length === 0) {
    expect(inner).not.toBe('p{}');
    return undefined;
  }
  expect(inner).toBe('p{}');
  expect(drops).toHaveLength(1);
  return drops[0]![0];
};
const selectorVerdict = (selector: string): CssDropReason | undefined => {
  const { drops } = clean(`${selector} { color: red }`);
  return drops[0]?.[0];
};

describe('sanitizeThemeCss: harmless CSS survives unchanged', () => {
  const THEME = [
    '/* Bubbles */',
    '[data-tool-card][data-tool-status="error"] [data-part="header"] {',
    '  background: linear-gradient(90deg, var(--d-danger-fill), transparent 70%);',
    '  border-left: 0.25rem solid var(--d-danger-fill) !important;',
    '  border-radius: 0.5rem 1rem;',
    '  box-shadow: 0 0.125rem 0.5rem rgb(0 0 0 / 30%), inset 0 0 0 1px #ffffff22;',
    '  padding: 0.5rem 1rem; margin: 0 auto; gap: 0.75rem;',
    '  color: var(--d-text); font-weight: 600; font-style: italic; letter-spacing: 0.02em; line-height: 1.6;',
    "  font-family: 'My Font', 'dt-0123abcd-Fira Code', var(--d-mono), ui-monospace, monospace;",
    "  font-feature-settings: 'liga' 0, 'ss01'; font-variant-numeric: tabular-nums;",
    '  text-decoration: underline dotted var(--d-accent-fill) 2px; text-transform: uppercase; text-align: start;',
    '  cursor: pointer; caret-color: var(--d-accent); accent-color: #ff8800;',
    '  outline: 2px solid var(--d-accent-fill); outline-offset: 2px;',
    '  transition: color 150ms ease-out, background-color 0.3s cubic-bezier(0.2, 0, 0, 1);',
    '  scrollbar-color: var(--d-border) transparent; scrollbar-width: thin;',
    '}',
    '.markdown li::marker { color: hsl(30 80% 60%); }',
    'p::selection { background-color: color-mix(in oklab, var(--d-accent-fill) 40%, transparent); color: oklch(0.9 0.05 80 / 0.9); }',
    'input::placeholder { color: rgba(200, 200, 200, 0.5); }',
    '@media (prefers-reduced-motion: reduce) { p { transition: none; } }',
    '@media screen and (hover: hover) and (pointer: fine) { a:hover { text-decoration-line: underline; } }',
    '@supports (color: oklch(0 0 0)) { @container (min-width: 20rem) { p:is(.a, .b):not(:first-child) > em { color: oklch(0.7 0.1 200); } } }',
    `ul { list-style-type: square; } li:nth-child(2n + 1 of .x) { background-image: url(${PNG}); }`,
  ].join('\n');

  it('keeps every allowed declaration, selector and at-rule, and the source exactly as written', () => {
    const { kept, inner, drops } = clean(THEME);
    expect(drops).toEqual([]);
    expect(kept).toBe(THEME);
    expect(inner).toContain('font-family:"My Font","dt-0123abcd-Fira Code",var(--d-mono),ui-monospace,monospace');
    expect(inner).toContain('@media (prefers-reduced-motion:reduce){p{transition:none}}');
    expect(inner).toContain('border-left:0.25rem solid var(--d-danger-fill)!important');
  });

  it('wraps each region in the user layer and a scope that stops at trusted UI, Monaco and xterm', () => {
    const result = checked(sanitizeThemeCss(Object.fromEntries(CSS_REGIONS.map((region) => [region, 'a { color: red }'])), { families: [] }));
    for (const region of CSS_REGIONS) {
      expect(result.scoped[region]).toBe(`@layer damocles-user { @scope ([data-theme-scope~="${region}"]) to ([data-trusted], [data-trusted-mark], .monaco-editor, .xterm) { :where(:scope) a{color:red} } }`);
      expect(result.kept[region]).toBe('a { color: red }');
    }
  });

  it('matches only strict descendants of a scope root: every selector, nested ones too, takes :where(:scope) and a space', () => {
    const result = checked(sanitizeThemeCss({ sidebar: 'a, b:hover > i { color: red } @media (hover: hover) { @supports (color: red) { ::selection, li::marker { color: red } } }' }, { families: [] }));
    expect(result.scoped.sidebar).toBe('@layer damocles-user { @scope ([data-theme-scope~="sidebar"]) to ([data-trusted], [data-trusted-mark], .monaco-editor, .xterm) { '
      + ':where(:scope) a,:where(:scope) b:hover>i{color:red}@media (hover:hover){@supports (color:red){:where(:scope) ::selection,:where(:scope) li::marker{color:red}}} } }');
  });

  it('skips empty, blank and null regions and ignores keys that are not regions', () => {
    const result = sanitizeThemeCss({ transcript: '', sidebar: '  \n', titlebar: null, ...({ shell: 'body { display: none }' } as Partial<Record<CssRegion, string>>) }, { families: [] });
    expect(result).toEqual({ kept: {}, scoped: {}, dropped: [], droppedMore: 0 });
  });

  it('keeps comments and stray semicolons in the source but paints neither', () => {
    const { kept, inner, drops } = clean('/* </style><script>alert(1)</script> */ p { color: red;; } /*! note */');
    expect(drops).toEqual([]);
    expect(kept).toBe('/* </style><script>alert(1)</script> */ p { color: red;; } /*! note */');
    expect(inner).toBe('p{color:red}');
  });

  it('cuts only the dropped parts, keeping the rest of the formatting', () => {
    const { kept, drops } = clean('a,\n:root,\nb {\n  color: red;\n  display: none;\n  margin: 0;\n  position: fixed\n}\n');
    expect(kept).toBe('a,b {\n  color: red;\n  margin: 0;\n  }\n');
    expect(drops).toEqual([['selector', ':root'], ['property', 'display: none'], ['property', 'position: fixed']]);
  });

  it('leaves a comment that follows a dropped part', () => {
    expect(clean('@import x; /* keep me */ p{color:red}').kept).toBe('/* keep me */ p{color:red}');
    expect(clean('p{display:none; /* keep me */ color:red}').kept).toBe('p{/* keep me */ color:red}');
    expect(clean('p{color:red; display:none /* keep me */}').kept).toBe('p{color:red; }');
    expect(clean('p{color:red; display:none; /* keep me */}').kept).toBe('p{color:red; /* keep me */}');
  });

  it('lists the line each dropped part starts on', () => {
    const result = sanitizeThemeCss({ sidebar: 'a { color: red }\n\nb {\n  display: none;\n}' }, { families: [] });
    expect(result.dropped).toEqual([{ region: 'sidebar', reason: 'property', text: 'display: none', line: 4 }]);
  });

  it('collapses whitespace in the dropped text and bounds it to 120 characters', () => {
    const { drops } = clean(`p { content: '${'x'.repeat(300)}'; }\n@import\n\n  url(x);`);
    expect(drops[0]![1]).toHaveLength(120);
    expect(drops[0]![1].endsWith('…')).toBe(true);
    expect(drops[1]).toEqual(['atRule', '@import url(x);']);
  });
});

describe('sanitizeThemeCss: limits', () => {
  it('drops a region over 32 KB whole', () => {
    const big = `p { color: red }\n${'/*'.padEnd(CSS_REGION_LIMIT_BYTES, 'x')}*/`;
    const result = checked(sanitizeThemeCss({ transcript: big, sidebar: 'a { color: red }' }, { families: [] }));
    expect(result.dropped.map((part) => [part.region, part.reason])).toEqual([['transcript', 'regionTooLarge']]);
    expect(result.kept).toEqual({ sidebar: 'a { color: red }' });
  });

  it('counts bytes, not characters', () => {
    const greek = `p { color: red } /* ${'α'.repeat(CSS_REGION_LIMIT_BYTES / 2)} */`;
    expect(sanitizeThemeCss({ transcript: greek }, { families: [] }).dropped[0]?.reason).toBe('regionTooLarge');
  });

  it('drops the regions that would take the total over 64 KB, in region order', () => {
    const near = `p { color: red } /*${'x'.repeat(CSS_REGION_LIMIT_BYTES - 40)}*/`;
    const result = checked(sanitizeThemeCss({ transcript: near, sidebar: near, editorChrome: near, titlebar: 'a { color: red }' }, { families: [] }));
    expect(result.dropped.map((part) => [part.region, part.reason])).toEqual([['editorChrome', 'totalTooLarge']]);
    expect(Object.keys(result.kept)).toEqual(['transcript', 'sidebar', 'titlebar']);
    expect(CSS_TOTAL_LIMIT_BYTES).toBe(2 * CSS_REGION_LIMIT_BYTES);
  });

  it('measures what it keeps: a region that shrinks leaves its room to the next ones', () => {
    const filler = `/*${'x'.repeat(CSS_REGION_LIMIT_BYTES - 100)}*/`;
    const result = checked(sanitizeThemeCss({ transcript: `p { color: red }${'@import x;'.repeat(2500)}`, sidebar: filler, editorChrome: filler }, { families: [] }));
    expect(result.kept.transcript).toBe('p { color: red }');
    expect(Object.keys(result.kept)).toEqual(['transcript', 'sidebar', 'editorChrome']);
    expect(result.dropped.every((part) => part.reason === 'atRule')).toBe(true);
  });

  it('keeps a source no longer than it was when it cuts selectors from a list', () => {
    const source = `${'a,'.repeat((CSS_REGION_LIMIT_BYTES - 4) / 2)}&{}`;
    expect(source).toHaveLength(CSS_REGION_LIMIT_BYTES - 1);
    const result = checked(sanitizeThemeCss({ transcript: source }, { families: [] }));
    expect(result.dropped.map((part) => part.reason)).toEqual(['selector']);
    expect(result.kept.transcript!.length).toBeLessThan(source.length);
  });

  it('lists at most 100 dropped parts and counts the rest', () => {
    const rules = sanitizeThemeCss({ transcript: 'a{}'.repeat(10_900) }, { families: [] });
    expect(rules.dropped).toHaveLength(CSS_MAX_DROPPED);
    expect(rules.droppedMore).toBe(10_900 - CSS_MAX_RULES - CSS_MAX_DROPPED);
    const declarations = `p{${'a:b;'.repeat(8190)}}`;
    const both = sanitizeThemeCss({ transcript: declarations, sidebar: declarations }, { families: [] });
    expect(both.dropped).toHaveLength(CSS_MAX_DROPPED);
    expect(both.droppedMore).toBe(2 * 8190 - CSS_MAX_DROPPED);
    expect(sanitizeThemeCss({ transcript: 'p { display: none }' }, { families: [] }).droppedMore).toBe(0);
  });

  describe('nesting', () => {
    const nested = (depth: number): string => `${'@media all{'.repeat(depth)}p{color:red}${'}'.repeat(depth)}`;
    const deep = <T>(frames: number, run: () => T): T => (frames === 0 ? run() : deep(frames - 1, run));
    const WHOLE = { kept: {}, scoped: {}, dropped: [{ region: 'transcript', reason: 'parseError', text: expect.any(String) }], droppedMore: 0 };

    it.each([
      ['selector functions', `p${':is('.repeat(1000)}a${')'.repeat(1000)}{color:red}`],
      ['parentheses in a condition', `@supports ${'('.repeat(3000)}a:b${')'.repeat(3000)}{p{color:red}}`],
      ['blocks that never close', '@media all{'.repeat(2978)],
      ['blocks', nested(2000)],
      ['color functions', `p{background:${'rgb(from '.repeat(1500)}red${' r g b)'.repeat(1500)}}`],
      ['brackets that close nothing', `p{color:red}${'(]'.repeat(5000)}`],
    ])('drops a region whole for %s nested past the bound, and never throws', (_what, source) => {
      expect(sanitizeThemeCss({ transcript: source }, { families: [] })).toEqual(WHOLE);
    });

    it('keeps 32 open levels and drops 33', () => {
      expect(CSS_MAX_NESTING).toBe(32);
      expect(checked(sanitizeThemeCss({ transcript: nested(31) }, { families: [] })).dropped).toEqual([]);
      expect(sanitizeThemeCss({ transcript: nested(32) }, { families: [] }).dropped.map((part) => part.reason)).toEqual(['parseError']);
    });

    it('gives one answer for one input: cold, warm and from deep in the stack', () => {
      for (const source of [nested(2000), nested(31), 'p:is(.a, :not(.b)) { color: rgb(from red r g b / 50%); display: none }']) {
        const cold = sanitizeThemeCss({ transcript: source }, { families: [] });
        for (let i = 0; i < 300; i += 1) sanitizeThemeCss({ transcript: source }, { families: [] });
        expect(sanitizeThemeCss({ transcript: source }, { families: [] })).toEqual(cold);
        expect(deep(3000, () => sanitizeThemeCss({ transcript: source }, { families: [] }))).toEqual(cold);
      }
    });
  });

  it('keeps the first 400 rules across all regions', () => {
    const rules = (count: number): string => Array.from({ length: count }, (_, i) => `.r${i} { color: red }`).join('\n');
    const result = checked(sanitizeThemeCss({ transcript: rules(CSS_MAX_RULES - 1), sidebar: '@media (hover: hover) { .a { color: red } .b { color: red } }' }, { families: [] }));
    expect(result.dropped).toEqual([{ region: 'sidebar', reason: 'tooManyRules', text: '.b', line: 1 }]);
    expect(result.scoped.sidebar).toContain('.a{color:red}');
  });

  it('drops a selector over 512 characters and keeps its shorter siblings', () => {
    const long = `.${'a'.repeat(512)}`;
    const { inner, drops } = clean(`${long}, p { color: red }`);
    expect(drops).toEqual([['selectorTooLong', long.slice(0, 119) + '…']]);
    expect(inner).toBe('p{color:red}');
  });

  it('drops nested rules, nested at-rules and the declarations css-tree cannot separate from them', () => {
    expect(clean('a { b { color: red } color: blue; }').drops).toEqual([['nestedRule', 'b { color: red } color: blue;']]);
    expect(clean('a { color: red; @media (hover: hover) { color: blue } margin: 0 }')).toMatchObject({ inner: 'a{color:red;margin:0}', drops: [['nestedRule', '@media (hover: hover) { color: blue }']] });
    expect(reasons('a { color: red; &:hover { color: blue } }')).toEqual(['nestedRule']);
  });
});

describe('sanitizeThemeCss: at-rules', () => {
  it.each([
    '@import url(https://evil.example/x.css);',
    "@import 'x.css' layer(damocles-protected);",
    "@font-face { font-family: 'Geist Variable'; src: url(https://evil.example/f.woff2); }",
    '@layer damocles-protected { [data-trusted] { display: none } }',
    '@layer damocles-protected;',
    '@scope (body) { * { display: none } }',
    '@property --d-accent { syntax: "<color>"; inherits: true; initial-value: red; }',
    '@keyframes spin { to { transform: rotate(1turn) } }',
    '@-webkit-keyframes spin { to { opacity: 0 } }',
    '@namespace svg url(http://www.w3.org/2000/svg);',
    '@counter-style x { system: cyclic; symbols: "*"; }',
    '@starting-style { p { opacity: 0 } }',
    '@position-try --x { top: 0 }',
    '@view-transition { navigation: auto; }',
    '@page { margin: 0 }',
    '@charset "utf-8";',
    '@font-feature-values Font { @styleset { x: 1 } }',
    '@\\69 mport url(https://evil.example/x.css);',
    '@IMPORT url(https://evil.example/x.css);',
    '@f\\6f nt-face { font-family: x; src: url(https://evil.example/f) }',
  ])('drops %s', (css) => {
    const { drops, inner } = clean(`${css}\np { color: red }`);
    expect(drops.map(([reason]) => reason)).toEqual(['atRule']);
    expect(inner).toBe('p{color:red}');
  });

  it('drops @layer and @scope injected inside @media, @supports and @container, keeping their siblings', () => {
    const { inner, drops } = clean([
      '@media (hover: hover) { @layer damocles-protected { [data-trusted] { opacity: 0 } } a { color: red } }',
      '@supports (display: grid) { @scope (html) { body { display: none } } @import url(x); b { color: red } }',
      '@container (min-width: 1px) { @font-face { font-family: x } c { color: red } }',
    ].join('\n'));
    expect(drops.map(([reason]) => reason)).toEqual(['atRule', 'atRule', 'atRule', 'atRule']);
    expect(inner).toBe('@media (hover:hover){a{color:red}}@supports (display:grid){b{color:red}}@container (min-width:1px){c{color:red}}');
  });

  it.each([
    ['(prefers-reduced-motion: reduce)', undefined],
    ['(prefers-reduced-motion)', undefined],
    ['(prefers-contrast: more)', undefined],
    ['(forced-colors: active)', undefined],
    ['not all and (hover: none)', undefined],
    ['only screen and (pointer: coarse)', undefined],
    ['print', undefined],
    ['(HOVER: hover)', undefined],
    ['(\\68 over: hover)', undefined],
    ['(min-width: 40rem)', 'mediaFeature'],
    ['(width > 3px)', 'mediaFeature'],
    ['(any-hover: hover)', 'mediaFeature'],
    ['(prefers-color-scheme: dark)', 'mediaFeature'],
    ['speech', 'mediaFeature'],
    ['(hover: hover), (monochrome)', 'mediaFeature'],
    ['(resolution: 2dppx)', 'mediaFeature'],
  ] as const)('@media %s: %s', (query, expected) => {
    expect(reasons(`@media ${query} { p { color: red } }`)[0]).toBe(expected);
  });

  it('drops at-rules without a block and @media blocks holding bare declarations', () => {
    expect(reasons('@media (hover: hover);')).toEqual(['atRule']);
    expect(clean('@media (hover: hover) { color: red } p { color: red }')).toMatchObject({ drops: [['parseError', 'color: red']], inner: '@media (hover:hover){}p{color:red}' });
  });

  it.each([
    '@supports (background: url(https://evil.example/x.png))',
    '@supports (background: url("https://evil.example/x.png"))',
    '@supports (background: u\\72l("https://evil.example/x.png"))',
    '@supports (background: src("https://evil.example/x.png"))',
    '@supports (color: red) and (not (background: url(x.png)))',
  ])('drops %s, whose condition would carry a URL into the page', (head) => {
    const { drops, inner } = clean(`${head} { p { color: red } }\nq { color: red }`);
    expect(drops).toEqual([['url', head]]);
    expect(inner).toBe('q{color:red}');
  });

  it('writes a condition from its decoded names', () => {
    expect(clean('@supports (c\\6f lor: r\\65 d) { p { color: red } } @media (h\\6f ver: h\\6f ver) { p { color: red } }').inner)
      .toBe('@supports (color:red){p{color:red}}@media (hover:hover){p{color:red}}');
    expect(clean('@supports (width: calc((1px + 2px) * 2)) { p { color: red } }').drops).toEqual([]);
  });
});

describe('sanitizeThemeCss: selectors', () => {
  it.each([
    [':root', 'selector'],
    [':ROOT', 'selector'],
    [':\\72 oot', 'selector'],
    ['html', 'selector'],
    ['HTML p', 'selector'],
    ['*|html', 'selector'],
    ['|body', 'selector'],
    ['b\\6f dy', 'selector'],
    [':host', 'selector'],
    [':host(.a)', 'selector'],
    [':host-context(.a)', 'selector'],
    ['::part(x)', 'pseudoElement'],
    ['::slotted(p)', 'pseudoElement'],
    [':scope', 'selector'],
    [':scope > p', 'selector'],
    ['& p', 'selector'],
    ['p:has(+ [data-trusted])', 'selector'],
    ['p:HAS(a)', 'selector'],
    [':\\68 as(a)', 'selector'],
    ['p:not(:has(a))', 'selector'],
    ['p:is(:root, a)', 'selector'],
    ['p:where(html *)', 'selector'],
    ['p:nth-child(2n of :root)', 'selector'],
    ['[data-trusted]', 'selector'],
    ['[data-trusted-mark]', 'selector'],
    ['[DATA-TRUSTED]', 'selector'],
    ['[data-\\74 rusted]', 'selector'],
    ['[ data-trusted = "" i ]', 'selector'],
    ["[data-trusted='x']", 'selector'],
    ['[*|data-trusted]', 'selector'],
    ['[data-theme-scope~=transcript] p', 'selector'],
    ['[data-theme-scope]', 'selector'],
    ['p:not([data-trusted])', 'selector'],
    ['.monaco-editor', 'selector'],
    ['.MONACO-editor .view-lines', 'selector'],
    ['.mtk1', 'selector'],
    ['.view-line', 'selector'],
    ['.xterm', 'selector'],
    ['.xterm-viewport', 'selector'],
    ['.\\78 term-rows', 'selector'],
    ['p:is(.xterm)', 'selector'],
    ['[class*=onaco]', 'selector'],
    ['[class~="xterm"]', 'selector'],
    ['[CLASS]', 'selector'],
    ['p::after', 'pseudoElement'],
    ['p::AFTER', 'pseudoElement'],
    ['p:after', 'pseudoElement'],
    ['p:before', 'pseudoElement'],
    ['p:first-line', 'pseudoElement'],
    ['p:FIRST-LETTER', 'pseudoElement'],
    ['p::before', 'pseudoElement'],
    ['p::backdrop', 'pseudoElement'],
    ['dialog::backdrop', 'pseudoElement'],
    ['p::-webkit-scrollbar', 'pseudoElement'],
    ['p::first-line', 'pseudoElement'],
    ['p::highlight(x)', 'pseudoElement'],
    ['::view-transition', 'pseudoElement'],
    ['p::selection(x)', 'pseudoElement'],
    ['p::selection', undefined],
    ['p::SELECTION', undefined],
    ['input::placeholder', undefined],
    ['li::marker', undefined],
    ['p:hover:focus-visible', undefined],
    ['p:is(.a, .b) > em ~ span + b', undefined],
    ['[data-tool-card][data-tool-status=error] [data-part=header]', undefined],
    ['[data-tool="Bash"]', undefined],
    ['#id.class', undefined],
    ['*', undefined],
    ['u+a', undefined],
    ['.terminal-like', undefined],
    ['.view-lin', undefined],
  ] as const)('%s: %s', (selector, expected) => {
    expect(selectorVerdict(selector)).toBe(expected);
  });

  // Chromium ignores a whole rule for one selector it does not read, so a pseudo-class or a pseudo-element shape it refuses
  // must be dropped here, or `kept` would list a rule that paints nothing. Each row is Chromium's own verdict.
  it.each([
    ['p:foo', 'selector'],
    ['p:FOO', 'selector'],
    ['p:is', 'selector'],
    ['p:not', 'selector'],
    ['p:nth-child', 'selector'],
    ['p:lang', 'selector'],
    ['p:is()', 'selector'],
    ['p:where()', 'selector'],
    ['p:not()', 'selector'],
    ['p:not(a:foo)', 'selector'],
    ['p:is(a:foo, b)', 'selector'],
    ['p:where(a:foo)', 'selector'],
    ['p:nth-child()', 'selector'],
    ['p:nth-child(2 of a:foo)', 'selector'],
    ['p:nth-of-type(2 of .a)', 'selector'],
    ['p:nth-last-of-type(2 of .a)', 'selector'],
    ['p:dir()', 'selector'],
    ['p:lang()', 'selector'],
    ['p:lang("en")', 'selector'],
    ['p:lang(en fr)', 'selector'],
    ['p:target-within', 'selector'],
    ['p:local-link', 'selector'],
    ['p:playing', 'selector'],
    ['p:paused', 'selector'],
    ['p:muted', 'selector'],
    ['p:unchecked', 'selector'],
    ['p:blank', 'selector'],
    ['p:current', 'selector'],
    ['p:-webkit-any-link', 'selector'],
    ['p:window-inactive', 'selector'],
    ['p::selection:hover', 'selector'],
    ['p::selection:window-inactive', 'selector'],
    ['p::placeholder:focus', 'selector'],
    ['p::marker:first-child', 'selector'],
    ['p::selection.x', 'selector'],
    ['p::selection a', 'selector'],
    ['p::selection > a', 'selector'],
    ['p::selection::marker', 'selector'],
    ['p::selection:not(a)', 'selector'],
    ['p:is(::selection)', 'selector'],
    ['p:where(::placeholder)', 'selector'],
    ['p:not(::marker)', 'selector'],
    ['p:nth-child(2 of ::marker)', 'selector'],
  ] as const)('%s, which Chromium refuses or reads less of: %s', (selector, expected) => {
    const { inner, drops } = clean(`${selector}, q { color: red }`);
    expect(drops).toEqual([[expected, selector]]);
    expect(inner).toBe('q{color:red}');
  });

  it('keeps every pseudo-class it lists, alone and inside the functions that take selectors', () => {
    const forms = [
      ...ALLOWED_CSS_PSEUDO_CLASSES.map((name) => `:${name}`),
      ':is(a, .b)', ':where(a > b)', ':not(a, .b)', ':nth-child(2n+1)', ':nth-child(odd of .a, b)', ':nth-last-child(-n+3 of .a)', ':nth-of-type(even)', ':nth-last-of-type(2)',
      ':dir(rtl)', ':lang(en-US)',
    ];
    for (const form of forms) expect([form, selectorVerdict(`p${form}`)]).toEqual([form, undefined]);
    // eight at a time, within the selector length cap
    for (let at = 0; at < forms.length; at += 8) {
      expect(selectorVerdict(`p:is(${forms.slice(at, at + 8).map((form) => `a${form}`).join(', ')})`)).toBeUndefined();
    }
    expect(ALLOWED_CSS_PSEUDO_CLASSES).toEqual([...ALLOWED_CSS_PSEUDO_CLASSES].sort());
    for (const banned of ['root', 'scope', 'host', 'has']) expect(ALLOWED_CSS_PSEUDO_CLASSES).not.toContain(banned);
  });

  it('drops only the banned items of a selector list', () => {
    const { inner, drops } = clean(':root, p, html body, .xterm, em::after, li { color: red }');
    expect(inner).toBe('p,li{color:red}');
    expect(drops.map(([reason]) => reason)).toEqual(['selector', 'selector', 'selector', 'pseudoElement']);
  });

  it('drops a selector that starts with a combinator, which @scope would read relative to the scope root', () => {
    expect(reasons('> p { color: red } + p { color: red } ~ p { color: red }')).toEqual(['selector', 'selector', 'selector']);
  });

  it('drops a rule whose selector css-tree cannot read', () => {
    expect(reasons('p:is( { color: red }')).toEqual(['parseError']);
  });

  // css-tree reads a comment after a hex escape as the end of one name and the start of another, and its generator would
  // write the two a space apart, which a hex escape swallows: Chromium would read the banned name the check never saw
  it.each([
    ['.xt\\65/**/rm', 'selector'],
    ['ht\\6d/**/l', 'selector'],
    ['p:befo\\72/**/e', 'selector'],
    [':sc\\6f/**/pe > p', 'selector'],
    ['[data-t\\72/**/usted]', 'selector'],
    ['[data-tool i]', 'selector'],
    ['[data-tool="x" q]', 'selector'],
    ['.a/**/b', 'selector'],
    ['#a/**/b', 'selector'],
    ['p:hover/**/a', 'selector'],
    ['p > > a', 'selector'],
    ['p >', 'selector'],
    ['svg|a', 'selector'],
    ['[svg|href]', 'selector'],
    ['a\\|b|c', 'selector'],
  ] as const)('%s: %s, and nothing of it is painted', (selector, expected) => {
    const { inner, drops } = clean(`${selector}, q { color: red }`);
    expect(drops).toEqual([[expected, selector]]);
    expect(inner).toBe('q{color:red}');
  });

  it.each([
    ['.\\31 23', '.\\31 23'],
    ['.a\\62 c', '.abc'],
    ['.a\\.b', '.a\\.b'],
    ['#\\66oo', '#foo'],
    ['d\\69v > \\70', 'div>p'],
    ['p:h\\6fver', 'p:hover'],
    ['p::s\\65lection', 'p::selection'],
    ['[d\\61ta-tool="a\\62"  S]', '[data-tool="ab"s]'],
    ['[data-tool="</style>"]', '[data-tool="<\\/style>"]'],
    ['*|a', '*|a'],
    ['[*|title]', '[*|title]'],
    ['a\\|b', 'a\\|b'],
    ['.a/**/.b', '.a.b'],
  ] as const)('paints %s as %s, each name written from its decoded value', (selector, painted) => {
    const { inner, drops } = clean(`${selector} { color: red }`);
    expect(drops).toEqual([]);
    expect(inner).toBe(`${painted}{color:red}`);
  });
});

describe('sanitizeThemeCss: properties', () => {
  it.each([
    'content: "Approved"', 'display: none', 'DISPLAY: none', '\\64 isplay: none', 'd\\69 splay: none', 'visibility: hidden', 'position: fixed',
    'inset: 0', 'top: 0', 'z-index: 2147483647', 'transform: scale(100)', 'translate: 0 -100vh', 'scale: 0', 'rotate: 1turn',
    'filter: opacity(0)', 'backdrop-filter: blur(1rem)', 'mask: none', '-webkit-mask: none', 'clip-path: inset(50%)', 'overflow: visible',
    'width: 100vw', 'height: 0', 'max-height: 0', 'min-width: 100vw', 'font-size: 0', 'font: 0/0 a', 'zoom: 10', 'pointer-events: none',
    'user-select: none', 'animation: x 1s', 'content-visibility: hidden', '--d-accent: red', '--x: url(https://evil.example)',
    '-webkit-text-fill-color: transparent', '-webkit-box-reflect: below', 'mix-blend-mode: difference', 'unicode-range: U+0-7F',
    'contain: none', 'isolation: auto', 'overflow-clip-margin: 0', 'will-change: transform', 'text-indent: -9999px', 'columns: 2',
    'border-image: url(data:image/png;base64,AA) 30', 'list-style-image: url(data:image/png;base64,AA)', 'fill: red', 'all: unset',
  ])('drops %s', (declaration) => {
    expect(verdict(declaration)).toBe('property');
  });

  it('writes an allowed property under its plain name', () => {
    expect(clean('p { \\63 olor: red; COLOR: blue; Margin-Top: 1px }').inner).toBe('p{color:red;color:blue;margin-top:1px}');
  });

  it.each([
    // opacity would make a stacking context that paints over a safety mark and would dim a mark inside it
    ['opacity: 0.9', 'property'], ['opacity: 1', 'property'], ['OPACITY: 0', 'property'],
    ['border: 4px solid red', undefined], ['border: 0.25rem dashed var(--d-border)', undefined], ['border: thick solid red', 'valueOutOfRange'],
    ['border: 5px solid red', 'valueOutOfRange'], ['border: 1em solid', 'valueOutOfRange'], ['border-width: thin medium', undefined],
    ['border-width: 5px', 'valueOutOfRange'], ['border-top: 1px solid', undefined], ['border-inline-start-width: 0.3rem', 'valueOutOfRange'],
    ['border-width: 1vw', 'valueOutOfRange'], ['border-width: calc(4px)', 'function'],
    ['border-radius: 2rem', undefined], ['border-radius: 32px / 50%', undefined], ['border-radius: 2.1rem', 'valueOutOfRange'], ['border-radius: 60%', 'valueOutOfRange'],
    ['outline: 2px solid red', undefined], ['outline: thick solid', 'valueOutOfRange'], ['outline-offset: -4px', undefined], ['outline-offset: 2rem', 'valueOutOfRange'],
    ['box-shadow: 0 0 1.5rem 0 red', undefined], ['box-shadow: inset 0 0 0 24px red', undefined], ['box-shadow: 0 0 0 100vmax red', 'valueOutOfRange'],
    ['box-shadow: 0 0 0 25px red', 'valueOutOfRange'], ['box-shadow: none', undefined], ['text-shadow: 1px 1px 2px #000', undefined], ['text-shadow: 0 0 2rem red', 'valueOutOfRange'],
    ['padding: 4rem', undefined], ['padding: 64px 0', undefined], ['padding: 4.1rem', 'valueOutOfRange'], ['padding: -1px', 'valueOutOfRange'],
    ['padding: 10%', 'valueOutOfRange'], ['padding: 1cqw', 'valueOutOfRange'], ['padding-inline: 1in', 'valueOutOfRange'],
    ['margin: 0 auto', undefined], ['margin: -1px', 'valueOutOfRange'], ['margin-top: -4rem', 'valueOutOfRange'], ['margin: calc(-100vh)', 'function'],
    ['gap: 1rem', undefined], ['row-gap: normal', undefined], ['gap: 5rem', 'valueOutOfRange'],
    ['letter-spacing: 0.2em', undefined], ['letter-spacing: -0.2em', undefined], ['letter-spacing: normal', undefined], ['letter-spacing: 0.21em', 'valueOutOfRange'],
    ['letter-spacing: -1rem', 'valueOutOfRange'],
    ['line-height: 1', undefined], ['line-height: 2.5', undefined], ['line-height: normal', undefined], ['line-height: 0.9', 'valueOutOfRange'],
    ['line-height: 2.6', 'valueOutOfRange'], ['line-height: 20px', 'valueOutOfRange'], ['line-height: 150%', 'valueOutOfRange'],
    ['font-weight: 650', undefined], ['font-weight: bold', undefined], ['font-weight: 1001', 'valueOutOfRange'],
    ['font-style: oblique 10deg', undefined], ['font-style: oblique 100deg', 'valueOutOfRange'],
    ['font-feature-settings: "liga" off, "tnum"', undefined], ['font-feature-settings: "toolong"', 'valueOutOfRange'],
    ['font-variant-ligatures: no-common-ligatures', undefined], ['font-variant-alternates: stylistic(x)', 'function'],
    ['text-decoration-thickness: 4px', undefined], ['text-decoration-thickness: 5px', 'valueOutOfRange'], ['text-decoration: underline 1em', 'valueOutOfRange'],
    ['text-align: center', undefined], ['text-align: -webkit-center', 'valueOutOfRange'],
    ['list-style-type: lower-greek', undefined], ['list-style-type: "Approved "', 'valueOutOfRange'], ['list-style-type: symbols(cyclic "*")', 'function'],
    ['cursor: pointer', undefined], ['cursor: none', 'valueOutOfRange'], ['cursor: \\6e one', 'valueOutOfRange'], ['cursor: NONE', 'valueOutOfRange'],
    ['cursor: url(data:image/png;base64,AA), auto', 'url'],
    ['scrollbar-width: none', undefined], ['scrollbar-color: red blue', undefined],
    ['transition: color 300ms', undefined], ['transition: border-top-color 0.1s linear 0.2s', undefined], ['transition: none', undefined],
    ['transition: color 301ms', 'valueOutOfRange'], ['transition: color 1s', 'valueOutOfRange'], ['transition: color 100ms 1s', 'valueOutOfRange'],
    ['transition: all 100ms', 'valueOutOfRange'], ['transition: 100ms', 'valueOutOfRange'], ['transition: opacity 100ms', 'valueOutOfRange'],
    ['transition: width 100ms', 'valueOutOfRange'], ['transition: color 100ms allow-discrete', 'valueOutOfRange'], ['transition: color 100ms steps(2, jump-end)', undefined],
    // a longhand alone leaves the property at `all`, and the longhands of two rules combine in the cascade
    ['transition-property: color, background-color', 'property'], ['transition-property: initial', 'property'], ['transition-property: unset', 'property'],
    ['transition-duration: 300ms', 'property'], ['transition-delay: 300ms', 'property'], ['transition-timing-function: cubic-bezier(0, 0, 1, 1)', 'property'],
    ['transition: initial', undefined], ['transition: unset', undefined],
    ['transition: inherit', 'valueOutOfRange'], ['transition: revert', 'valueOutOfRange'], ['transition: revert-layer', 'valueOutOfRange'],
    ['color: inherit', undefined], ['margin: revert-layer', undefined], ['padding: initial', undefined],
    // a var() is typed by its token: a length token would pass every length bound
    ['outline: var(--d-chat-column) solid red', 'function'], ['border-left: var(--d-chat-column) solid', 'function'], ['box-shadow: 0 0 0 var(--d-chat-column) red', 'function'],
    ['text-shadow: var(--d-chat-column) 0 red', 'function'], ['text-decoration: underline var(--d-chat-column)', 'function'], ['color: var(--d-chat-column)', 'function'],
    ['border-color: var(--d-font-size)', 'function'], ['background: var(--d-shadow)', 'function'], ['background: var(--d-surface-alpha)', 'function'],
    ['border: 1px solid var(--d-border)', undefined], ['box-shadow: 0 0 4px var(--d-accent)', undefined], ['outline-color: var(--d-safety-danger)', undefined],
    ['box-shadow: inset 0 0 0 1px red, 0 0 2px blue', undefined], ['box-shadow: banana 0 0 red', undefined],
    [`box-shadow: ${Array.from({ length: CSS_MAX_LAYERS }, () => '0 0 9px red').join(',')}`, undefined],
    [`box-shadow: ${Array.from({ length: CSS_MAX_LAYERS + 1 }, () => '0 0 9px red').join(',')}`, 'valueOutOfRange'],
    [`text-shadow: ${Array.from({ length: CSS_MAX_LAYERS + 1 }, () => '0 0 9px red').join(',')}`, 'valueOutOfRange'],
    [`background: ${Array.from({ length: CSS_MAX_LAYERS }, () => 'linear-gradient(red, blue)').join(',')}`, undefined],
    [`background-image: ${Array.from({ length: CSS_MAX_LAYERS + 1 }, () => 'linear-gradient(red, blue)').join(',')}`, 'valueOutOfRange'],
    ['padding: 1\\70x', undefined], ['background-position: 1\\65 1', 'parseError'],
  ] as const)('%s: %s', (declaration, expected) => {
    expect(verdict(declaration)).toBe(expected);
  });

  it('keeps !important, which still loses to the protected layer', () => {
    expect(clean('p { color: red !important; margin: 0 ! IMPORTANT; padding: 0 !\\69 mportant }').inner).toBe('p{color:red!important;margin:0!important;padding:0!important}');
    expect(reasons('p { color: red !ie }')).toEqual(['parseError']);
  });

  it('drops a value css-tree cannot read', () => {
    expect(reasons('p { color red; } q { col/**/or: red }')).toEqual(['parseError', 'parseError']);
  });

  it('drops a declaration with no value, which Chromium discards', () => {
    expect(clean('p{padding:;margin: ;border:}')).toMatchObject({ inner: 'p{}', drops: [['parseError', 'padding:'], ['parseError', 'margin:'], ['parseError', 'border:']] });
  });

  // two names in the source stay two names in the painted text: `n\6f ne` there would be `none`
  it.each([
    ['cursor: n\\6f/**/ne', 'cursor:no ne'],
    ['border: thi\\63/**/k solid red', 'border:thic k solid red'],
    ['cursor: p\\6f inter', 'cursor:pointer'],
    ['color: r\\65 d', 'color:red'],
    ['color: \\72gb(0 0 0)', 'color:rgb(0 0 0)'],
    ['background: var(--\\64 -accent)', 'background:var(--d-accent)'],
    ['padding: 1\\70x 2P\\58', 'padding:1px 2PX'],
    ['font-family: \\4d y  F\\6f nt', 'font-family:My Font'],
    ['font-family: "My \\46ont"', 'font-family:"My Font"'],
  ] as const)('paints %s as %s', (declaration, painted) => {
    expect(clean(`p { ${declaration} }`)).toMatchObject({ inner: `p{${painted}}`, drops: [] });
  });

  it('drops a region whose painted text would not read back as the nodes that were checked', () => {
    // css-tree reads an identifier, a slash and an identifier; written out, `<` and `/` would meet
    const result = sanitizeThemeCss({ transcript: 'p { background: a\\</b }', sidebar: 'p { color: red }' }, { families: [] });
    expect(result.dropped).toEqual([{ region: 'transcript', reason: 'parseError', text: 'p { background: a\\</b }' }]);
    expect(Object.keys(result.scoped)).toEqual(['sidebar']);
  });
});

describe('sanitizeThemeCss: functions and urls', () => {
  it.each([
    ['background: url(https://evil.example/x.png)', 'url'],
    ['background: URL(https://evil.example/x.png)', 'url'],
    ['background-image: url("https://evil.example/x.png")', 'url'],
    ["background-image: url('//evil.example/x.png')", 'url'],
    ['background: url(x.png)', 'url'],
    ['background: url(app://damocles/theme-blob/x)', 'url'],
    ['background: url(#grad)', 'url'],
    ['background: url()', 'url'],
    ['background: url(data:text/html;base64,PHNjcmlwdD4=)', 'url'],
    ['background: url(data:image/avif;base64,AA)', 'url'],
    ['background: url(data:image/svg+xml)', 'url'],
    // css-tree reads an escaped url( as a function and cannot parse an unquoted url inside it: the declaration is dropped either way
    ['background: u\\72 l(https://evil.example/x.png)', 'parseError'],
    ['background: u\\72 l("https://evil.example/x.png")', 'url'],
    ['background: \\75 rl(https://evil.example/x.png)', 'parseError'],
    ['background: u\\rl(https://evil.example/x.png)', 'parseError'],
    ['background-image: src("https://evil.example/x.png")', 'url'],
    ['background: image-set("https://evil.example/x.png" 1x)', 'function'],
    ['background: -webkit-image-set(url(https://evil.example/x.png) 1x)', 'function'],
    ['background: image-s\\65 t("x.png" 1x)', 'function'],
    ['background: cross-fade(url(a), url(b), 50%)', 'function'],
    ['background: element(#x)', 'function'],
    ['background: paint(x)', 'function'],
    ['background: -webkit-gradient(linear, 0 0, 0 100%, from(red), to(blue))', 'function'],
    ['background: -webkit-linear-gradient(red, blue)', 'function'],
    ['background-color: attr(data-color)', 'function'],
    ['background-color: attr(data-color type(<color>))', 'parseError'],
    ['background-color: env(safe-area-inset-top)', 'function'],
    ['background: linear-gradient(red, url(https://evil.example/x.png))', 'url'],
    ['background: linear-gradient(red, image-set("x.png" 1x))', 'function'],
    ['background: rgb(from url(https://evil.example/x.png) r g b)', 'url'],
    ['background: color-mix(in srgb, red, env(x))', 'function'],
    ['background-color: var(--x)', 'function'],
    ['background-color: var(--d-accent, url(https://evil.example/x.png))', 'function'],
    ['background-color: var(--d-accent, red)', 'function'],
    ['background: var(--d-accent,)', 'function'],
    ['background: linear-gradient(var(--d-bg), var(--tw-ring-color))', 'function'],
    ['background-color: v\\61 r(--x)', 'function'],
    ['background-color: var(--D-accent)', 'function'],
    ['padding: var(--d-chat-column)', 'function'],
    ['padding: calc(1px + 1px)', 'function'],
    ['padding: max(4rem, 100vh)', 'function'],
    ['border-color: light-dark(red, var(--x))', 'function'],
    ['background: var(--s-keyword)', 'function'],
    ['background: var(--d-accent-fill)', undefined],
    ['background: var(--s-kw)', undefined],
    ['background: var(--\\64 -accent)', undefined],
    ['background: repeating-conic-gradient(from 45deg at 10% 50%, red 0 25%, oklch(0.5 0.1 200 / 0.2) 0 50%)', undefined],
    ['background: radial-gradient(circle at top left, light-dark(#fff, #000), transparent 60%)', undefined],
  ] as const)('%s: %s', (declaration, expected) => {
    expect(verdict(declaration)).toBe(expected);
  });

  it('keeps an SVG data url, painted with the slash of each closing tag escaped', () => {
    const { inner, drops } = clean(`p { background: url("data:image/svg+xml,${SVG}")}`);
    expect(drops).toEqual([]);
    expect(inner).not.toContain('</');
    expect(inner).toBe(`p{background:url("data:image/svg+xml,${SVG.replaceAll('</', '<\\/')}")}`);
  });

  describe('data: images are still images, decided from their bytes', () => {
    // a PNG of exactly `chars` base64 characters: its header, then zero bytes
    const paddedPng = (chars: number): string => {
      const bytes = new Uint8Array(Math.floor((chars * 3) / 4));
      bytes.set(png(1, 1));
      return base64(bytes).replace(/=+$/, '');
    };
    const room = CSS_MAX_DATA_URL_CHARS - 'data:image/png;base64,'.length;

    it.each([
      ['a PNG', `url(${PNG})`],
      ['a JPEG, a one-frame GIF and a WebP', `url( "${dataUrl('jpeg', jpeg(1, 1))}" ), url(${dataUrl('gif', gif(1, 1, 1))}), url(${dataUrl('webp', webpLossy(1, 1))})`],
      ['an upper-case scheme and type', `url(${PNG.replace('data:image/png', 'DATA:IMAGE/PNG')}) no-repeat center / cover`],
      ['a still GIF declared a PNG', `url(${dataUrl('png', gif(1, 1, 1))})`],
      ['a PNG with a charset', `url(${PNG.replace(';base64', ';charset=utf-8;base64')})`],
      ['base64 broken by line breaks', `url("${PNG.slice(0, 40)}\\a ${PNG.slice(40)}")`],
      ['a percent-encoded PNG', `url(data:image/png,${[...png(1, 1)].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join('')})`],
      ['a PNG of 16 KB', `url(data:image/png;base64,${paddedPng(room)})`],
      ['an SVG', `url("data:image/svg+xml,${SVG}")`],
      ['a base64 SVG', `url(data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')})`],
      ['a percent-encoded SVG', `url("data:image/svg+xml;utf8,${encodeURIComponent(SVG)}")`],
    ])('keeps %s', (_what, image) => {
      expect(verdict(`background: ${image}`)).toBeUndefined();
    });

    it.each([
      ['an animated GIF', `url(${dataUrl('gif', gif(1, 1, 2))})`],
      ['an animated GIF declared a PNG', `url(${dataUrl('png', gif(1, 1, 2))})`],
      ['an animated PNG', `url(${dataUrl('png', png(1, 1, { animated: true }))})`],
      ['an animated WebP', `url(${dataUrl('webp', webpExtended(1, 1, true))})`],
      ['an AVIF declared a PNG', `url(${dataUrl('png', avif([[1, 1]]))})`],
      ['bytes that are no image', 'url(data:image/png;base64,AA)'],
      ['a PNG cut before its image data', 'url(data:image/png;base64,iVBORw0KGgo=)'],
      ['base64 that does not decode', `url(${PNG.slice(0, -1)}*)`],
      ['a URL past 16 KB', `url(data:image/png;base64,${paddedPng(room + 1)})`],
      ['a URL with a fragment, where Chromium cuts the data', `url("${PNG}#x")`],
      ['an unknown parameter', `url(${PNG.replace(';base64', ';charset=utf-16;base64')})`],
      ['SVG text declared a PNG', `url("data:image/png,${SVG}")`],
      ['a PNG declared an SVG', `url(${PNG.replace('image/png', 'image/svg+xml')})`],
      ['an SVG with an animation', `url("data:image/svg+xml,${SVG.replace('<text>', "<animate attributeName='opacity' values='0;1' dur='0.1s' repeatCount='indefinite'/><text>")}")`],
      ['an SVG with a prefixed animation', `url("data:image/svg+xml,${SVG.replace('<text>', "<a:set attributeName='x' to='1'/><text>")}")`],
      ['an SVG with a style element', `url("data:image/svg+xml,${SVG.replace('<text>', '<style>text{fill:red}</style><text>')}")`],
      ['an SVG with keyframes in a style attribute', `url("data:image/svg+xml,${SVG.replace('<text>', "<text style='animation: x 0.1s infinite'>")}")`],
      ['a base64 SVG with an animation', `url(data:image/svg+xml;base64,${Buffer.from(SVG.replace('<text>', '<animate/><text>')).toString('base64')})`],
      ['a percent-encoded SVG with a script', `url("data:image/svg+xml,${encodeURIComponent(SVG.replace('<text>', '<script>1</script><text>'))}")`],
      ['an SVG that loads an image', `url("data:image/svg+xml,${SVG.replace('<text>', "<image href='https://evil.example/x.png'/><text>")}")`],
      ['an SVG in UTF-16', `url(data:image/svg+xml;base64,${Buffer.from(`\ufeff${SVG}`, 'utf16le').toString('base64')})`],
    ])('drops %s', (_what, image) => {
      expect(verdict(`background: ${image}`)).toBe('url');
    });
  });

  it('keeps a range comparison in @container as written, so the query still matches', () => {
    expect(clean('@container (width < 30rem) { p { color: red } } @container (30rem <= width) { p { color: blue } }').inner)
      .toBe('@container (width<30rem){p{color:red}}@container (30rem<=width){p{color:blue}}');
  });

  it('drops a family named in a string that would end the style element', () => {
    expect(clean('p { font-family: "</style><script>alert(1)</script>" }').drops).toEqual([['fontFamily', 'font-family: "</style><script>alert(1)</script>"']]);
  });
});

describe('sanitizeThemeCss: text color and families', () => {
  it.each([
    ['color: red', undefined], ['color: currentColor', undefined], ['color: CanvasText', undefined], ['color: #abc', undefined], ['color: #aabbcc66', undefined],
    ['color: rgb(0 0 0 / 0.4)', undefined], ['color: rgba(0, 0, 0, 0.4)', undefined], ['color: hsl(0 0% 0% / 40%)', undefined], ['color: color(srgb 1 0 0 / 0.5)', undefined],
    ['color: var(--d-text)', undefined], ['color: var(--s-str)', undefined], ['color: var(--s-string)', 'function'], ['color: \\72gb(0 0 0)', undefined],
    ['color: light-dark(#000, #fff)', undefined], ['color: color-mix(in srgb, red 60%, transparent)', undefined],
    ['color: color-mix(in oklab, var(--d-text) 70%, var(--d-accent))', undefined], ['color: rgb(from var(--d-text) r g b)', undefined],
    ['color: rgb(from red r g b / alpha)', undefined],
    ['color: transparent', 'colorAlpha'], ['color: TRANSPARENT', 'colorAlpha'], ['color: tr\\61 nsparent', 'colorAlpha'], ['color: #0000', 'colorAlpha'],
    ['color: #00000065', 'colorAlpha'], ['color: rgb(0 0 0 / 0.39)', 'colorAlpha'], ['color: rgba(0, 0, 0, 0.1)', 'colorAlpha'], ['color: hsla(0, 0%, 0%, 10%)', 'colorAlpha'],
    ['color: rgb(0 0 0 / none)', 'colorAlpha'], ['color: oklch(0.5 0.1 200 / 0)', 'colorAlpha'], ['color: color-mix(in srgb, red 30%, transparent)', 'colorAlpha'],
    ['color: color-mix(in srgb, red 20%, blue 20%)', undefined], ['color: color-mix(in srgb, red 10%, blue 10%)', 'colorAlpha'], ['color: light-dark(red, transparent)', 'colorAlpha'],
    ['color: rgb(from transparent r g b)', 'colorAlpha'], ['color: rgb(from red r g b / 0)', 'colorAlpha'], ['color: rgb(var(--d-text) / 0.1)', 'colorAlpha'],
    ['color: rgb(0 0 0 / var(--d-alpha))', 'function'], ['color: rgb(0 0 0 / var(--d-opacity-disabled))', 'function'], ['color: rgb(0 0 0 / calc(1))', 'function'], ['color: var(--d-text, transparent)', 'function'],
    ['color: red blue', 'valueOutOfRange'], ['color: 0', 'valueOutOfRange'],
    // a pane token is alpha 00 under a wallpaper, and the tints, scrims and shadows are translucent in every palette
    ['color: var(--d-pane-chat)', 'colorAlpha'], ['color: var(--d-accent-soft)', 'colorAlpha'], ['color: var(--d-scrim)', 'colorAlpha'],
    ['color: color-mix(in srgb, var(--d-add) 90%, red)', 'colorAlpha'], ['background-color: var(--d-pane-chat)', undefined],
    ['-webkit-text-stroke: 1px transparent', 'property'], ['border-image-outset: 4rem', 'property'],
  ] as const)('%s: %s', (declaration, expected) => {
    expect(verdict(declaration)).toBe(expected);
  });

  it.each([
    ["font-family: 'My Font'", undefined], ['font-family: my font, serif', undefined], ['font-family: "MY FONT"', undefined],
    ['font-family: "dt-0123abcd-Fira Code", var(--d-font)', undefined], ['font-family: var(--d-mono), system-ui, ui-rounded, emoji', undefined],
    ["font-family: 'Geist Variable'", 'fontFamily'], ['font-family: Geist Variable', 'fontFamily'], ['font-family: \\47 eist Variable', 'fontFamily'],
    ['font-family: Arial', 'fontFamily'], ['font-family: var(--d-accent)', 'fontFamily'], ['font-family: var(--d-font, Arial)', 'fontFamily'],
    ['font-family: "Fira Code"', 'fontFamily'], ['font-family: u+0-7f', 'fontFamily'], ['font-family: My Font, Comic Sans MS', 'fontFamily'],
  ] as const)('%s: %s', (declaration, expected) => {
    expect(verdict(declaration)).toBe(expected);
  });

  it('reads the families a theme declares: installed by name, bundled under their renamed family', () => {
    expect(themeCssFamilies({ style: { fonts: { ui: { installed: 'My Font' }, mono: { asset: '0123abcd'.padEnd(64, 'e'), family: 'Fira Code' } } } })).toEqual(['My Font', 'dt-0123abcd-Fira Code']);
    expect(themeCssFamilies({})).toEqual([]);
  });
});

describe('sanitizeThemeCss: the adversarial theme', () => {
  const ADVERSARIAL = [
    '[data-trusted], [data-trusted] * { display: none !important; }',
    'p { display: none; position: fixed; inset: 0; z-index: 2147483647; }',
    'p::after { content: "Approved"; }',
    "p { background: url(https://evil.example/leak.png); }",
    '@import url(https://evil.example/x.css);',
    "@font-face { font-family: 'Geist Variable'; src: url(https://evil.example/geist.woff2); }",
    ':root { --d-accent: transparent; --d-text: transparent; } p { --d-text: transparent; }',
    'body:has([data-trusted]) p { opacity: 0.4; }',
    '.xterm .xterm-rows, .xterm-viewport { color: red !important; background: red !important; }',
    '.monaco-editor, .monaco-editor .view-line, .mtk1 { color: red !important; }',
    "p { font-family: '</style><script>alert(1)</script>'; } /* </style><script>alert(1)</script> */",
    '@layer damocles-protected { [data-trusted] { opacity: 0 !important; } }',
    '@scope (body) { * { visibility: hidden } }',
    'p { color: #123456; }',
  ].join('\n');

  it('keeps only the harmless rule', () => {
    const result = checked(sanitizeThemeCss({ transcript: ADVERSARIAL }, { families: [] }));
    expect(result.scoped.transcript).toBe(`${WRAP_START}${['p{}', 'p{}', 'p{}', 'p{}', 'p{color:#123456}'].map((rule) => SCOPED + rule).join('')}${WRAP_END}`);
    expect(result.dropped.map((part) => part.reason)).toEqual([
      'selector', 'selector', 'property', 'property', 'property', 'property', 'pseudoElement', 'url', 'atRule', 'atRule', 'selector',
      'property', 'selector', 'selector', 'selector', 'selector', 'selector', 'selector', 'fontFamily', 'atRule', 'atRule',
    ]);
  });
});

describe('decodeCssEscapes', () => {
  it.each([
    ['\\64 isplay', 'display'], ['\\000064isplay', 'display'], ['\\64\r\nisplay', 'display'], ['\\64\tisplay', 'display'], ['\\3c', '<'],
    ['\\3c /style', '</style'], ['d\\isplay', 'display'], ['\\0', '\uFFFD'], ['\\d800', '\uFFFD'], ['\\110000', '\uFFFD'], ['a\\', 'a\uFFFD'],
    ['\\1F600 x', '\u{1F600}x'], ['a\0b', 'a\uFFFDb'], ['\\\\', '\\'], ['\\64  isplay', 'd isplay'],
  ])('%s', (raw, decoded) => {
    expect(decodeCssEscapes(raw)).toBe(decoded);
  });
});

describe('ALLOWED_CSS_PROPERTIES', () => {
  it('lists none of the layout, stacking, visibility and motion properties a theme may not set', () => {
    for (const banned of ['content', 'display', 'visibility', 'position', 'inset', 'z-index', 'transform', 'filter', 'opacity', 'overflow', 'width', 'height', 'font-size', 'font', 'zoom', 'pointer-events', 'user-select', 'animation', 'contain', 'isolation']) {
      expect(ALLOWED_CSS_PROPERTIES).not.toContain(banned);
    }
    expect(ALLOWED_CSS_PROPERTIES.every((name) => /^[a-z-]+$/.test(name) && !name.startsWith('-'))).toBe(true);
  });
});
