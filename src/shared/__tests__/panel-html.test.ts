import { describe, expect, it } from 'vitest';
import { browserPageHtml, type BrowserPageStrings } from '../browser-page-html';
import { chatPageHtml, ERROR_PAGE_STRINGS, errorPageHtml } from '../panel-html';

// Desktop pages are built by main with these builders; each CSP below is the one core built at 6dd3c95d
// (panel-manager.ts getHtmlContent / getErrorHtml, browser-panel.ts buildHtml) for a desktop panel proxy, whose cspSource
// was APP_ORIGIN and whose chat workerSrc was CHAT_WORKER_SRC, with the nonce NONCE.
const ORIGIN = 'app://damocles';
const CHAT_CSP_6DD3C95D = "default-src 'none'; style-src app://damocles 'unsafe-inline'; script-src 'nonce-NONCE' 'wasm-unsafe-eval'; font-src app://damocles; img-src app://damocles data: https:; form-action 'none'; worker-src app://damocles/webview/assets/;";
const ERROR_CSP_6DD3C95D = "default-src 'none'; style-src 'unsafe-inline'; img-src app://damocles;";
const BROWSER_CSP_6DD3C95D = "default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-NONCE';";

const cspOf = (html: string): string => {
  const metas = [...html.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/g)];
  expect(metas).toHaveLength(1);
  return metas[0]![1]!;
};

const STRINGS: BrowserPageStrings = {
  back: 'Back',
  forward: 'Forward',
  reload: 'Reload',
  pickElement: 'Pick Element',
  devTools: 'Open Developer Tools (F12)',
  newTab: 'New Tab',
  urlPlaceholder: 'Enter URL...',
  notSecure: 'Not secure',
  notSecureDetail: 'Not encrypted',
  waiting: 'Waiting for browser frames...',
};

describe('desktop page CSPs, pinned to core at 6dd3c95d', () => {
  it('chat page', () => {
    const html = chatPageHtml({
      lang: 'en',
      cspSource: ORIGIN,
      workerSrc: `${ORIGIN}/webview/assets/`,
      nonce: 'NONCE',
      scriptUri: `${ORIGIN}/webview/assets/index.js`,
      styleUri: `${ORIGIN}/webview/assets/index.css`,
      logoUri: `${ORIGIN}/resources/icon.png`,
      themeCss: ':root{--d-bg:#000}',
    });
    expect(cspOf(html)).toBe(CHAT_CSP_6DD3C95D);
  });

  it('error page', () => {
    const html = errorPageHtml({ cspSource: ORIGIN, logoUri: `${ORIGIN}/resources/icon.png`, themeCss: '', strings: ERROR_PAGE_STRINGS });
    expect(cspOf(html)).toBe(ERROR_CSP_6DD3C95D);
  });

  it('browser page, with and without its toolbar', () => {
    for (const toolbar of [true, false]) {
      expect(cspOf(browserPageHtml({ nonce: 'NONCE', strings: STRINGS, toolbar, themeCss: '' }))).toBe(BROWSER_CSP_6DD3C95D);
    }
  });
});

describe('page strings', () => {
  it('escapes what main passes into the error page', () => {
    const html = errorPageHtml({ cspSource: ORIGIN, logoUri: 'x', themeCss: '', strings: { title: '<b>"t"</b>', detail: "a'b&c" } });
    expect(html).toContain('<h2>&lt;b&gt;&quot;t&quot;&lt;/b&gt;</h2>');
    expect(html).toContain('<p>a&#39;b&amp;c</p>');
  });

  it('escapes the browser strings it puts into title and placeholder attributes', () => {
    const html = browserPageHtml({ nonce: 'n', toolbar: true, themeCss: '', strings: { ...STRINGS, back: 'a" onclick="x', urlPlaceholder: "'><img src=x>" } });
    expect(html).toContain('<button id="btn-back" title="a&quot; onclick=&quot;x">');
    expect(html).toContain('placeholder="&#39;&gt;&lt;img src=x&gt;"');
    expect(html).not.toContain('onclick="x');
  });

  it('escapes every value it puts into a chat or error page attribute', () => {
    const hostile = 'x" onerror="y';
    const chat = chatPageHtml({ lang: hostile, cspSource: hostile, workerSrc: hostile, nonce: hostile, scriptUri: hostile, styleUri: hostile, logoUri: hostile, themeCss: '' });
    const error = errorPageHtml({ cspSource: hostile, logoUri: hostile, themeCss: '', strings: ERROR_PAGE_STRINGS });
    for (const html of [chat, error]) {
      expect(html).not.toContain('onerror="y');
      expect(html).toContain('x&quot; onerror=&quot;y');
    }
  });

  it('omits worker-src for a host that gives none', () => {
    const html = chatPageHtml({ lang: 'en', cspSource: ORIGIN, nonce: 'n', scriptUri: 's', styleUri: 'c', logoUri: 'l', themeCss: '' });
    expect(cspOf(html)).not.toContain('worker-src');
  });

  it('names the language the view starts in on the page', () => {
    const html = chatPageHtml({ lang: 'el', cspSource: ORIGIN, nonce: 'n', scriptUri: 's', styleUri: 'c', logoUri: 'l', themeCss: '' });
    expect(html).toContain('<html lang="el">');
  });
});
