// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyHostTheme } from '../apply-theme';
import type { PanelTheme } from '../panel-channels';
import { HOST_THEME_STYLE_ID, HOST_THEME_USER_STYLE_ID, HOST_TRUSTED_STYLE_ID } from '../../../shared/host-theme';

// A theme's CSS reaches a page only here, as text: main never puts it into a page's HTML.

const THEME: PanelTheme = { kind: 'dark', css: ':root{--d-bg:#000}', trustedCss: '[data-trusted]{--d-bg:#111}', reducedMotion: false, fileIconTheme: 'material' };
const SCOPED = '@layer damocles-user{@scope ([data-theme-scope~="transcript"]) to ([data-trusted], [data-trusted-mark], .monaco-editor, .xterm){p{color:#123456}}}';

beforeEach(() => {
  document.head.innerHTML = `<style id="${HOST_THEME_STYLE_ID}"></style><style id="${HOST_TRUSTED_STYLE_ID}"></style>`;
});

const styleIds = (): string[] => Array.from(document.head.querySelectorAll('style'), (style) => style.id);

describe('the preload\'s theme CSS', () => {
  it('writes the custom CSS as the text of one style after the trusted palette', () => {
    applyHostTheme({ ...THEME, customCss: SCOPED });
    expect(styleIds()).toEqual([HOST_THEME_STYLE_ID, HOST_TRUSTED_STYLE_ID, HOST_THEME_USER_STYLE_ID]);
    expect(document.getElementById(HOST_THEME_USER_STYLE_ID)!.textContent).toBe(SCOPED);

    applyHostTheme({ ...THEME, customCss: SCOPED.replace('#123456', '#654321') });
    expect(document.querySelectorAll(`#${HOST_THEME_USER_STYLE_ID}`)).toHaveLength(1);
    expect(document.getElementById(HOST_THEME_USER_STYLE_ID)!.textContent).toContain('#654321');
  });

  it('mirrors main\'s theme revision, which the page acknowledges, and leaves it for a theme that carries none', () => {
    applyHostTheme({ ...THEME, revision: 7 });
    expect(document.documentElement.dataset['themeRevision']).toBe('7');
    applyHostTheme(THEME);
    expect(document.documentElement.dataset['themeRevision']).toBe('7');
  });

  it('holds transitions off for the one style flush of a change, so the page paints the new theme at once', () => {
    const flushes: { switching: boolean; css: string | null; light: boolean }[] = [];
    Object.defineProperty(document.body, 'offsetHeight', {
      configurable: true,
      get: () => {
        flushes.push({
          switching: document.documentElement.hasAttribute('data-theme-switching'),
          css: document.getElementById(HOST_THEME_STYLE_ID)!.textContent,
          light: document.body.classList.contains('vscode-light'),
        });
        return 0;
      },
    });
    try {
      applyHostTheme({ ...THEME, kind: 'light', css: ':root{--d-bg:#fff}' });
    } finally {
      delete (document.body as unknown as { offsetHeight?: number }).offsetHeight;
    }
    expect(flushes).toEqual([{ switching: true, css: ':root{--d-bg:#fff}', light: true }]);
    expect(document.documentElement.hasAttribute('data-theme-switching')).toBe(false);
  });

  it('has the rule that holds transitions off, important in the app layer so a theme cannot bring them back', () => {
    const css = readFileSync(join(__dirname, '..', '..', '..', 'webview', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
    expect(css).toContain('  [data-theme-switching],\n  [data-theme-switching] *,\n  [data-theme-switching] *::before,\n  [data-theme-switching] *::after {\n    transition: none !important;\n  }');
    expect(css.lastIndexOf('@layer app {', css.indexOf('[data-theme-switching]'))).toBeGreaterThan(css.lastIndexOf('\n}\n', css.indexOf('[data-theme-switching]')));
  });

  it('never parses the CSS as markup', () => {
    const hostile = 'p{color:red}</style><script>window.pwned = true</script><style>';
    applyHostTheme({ ...THEME, customCss: hostile });
    const user = document.getElementById(HOST_THEME_USER_STYLE_ID)!;
    expect(user.textContent).toBe(hostile);
    expect(user.children).toHaveLength(0);
    expect(document.querySelector('script')).toBeNull();
    expect(styleIds()).toEqual([HOST_THEME_STYLE_ID, HOST_TRUSTED_STYLE_ID, HOST_THEME_USER_STYLE_ID]);
  });

  it('adds no style for a page main gives no custom CSS (overlay, notifier, editor dock, forced colors, safe start)', () => {
    applyHostTheme(THEME);
    expect(document.getElementById(HOST_THEME_USER_STYLE_ID)).toBeNull();
  });

  it('empties the style when the custom CSS goes away', () => {
    applyHostTheme({ ...THEME, customCss: SCOPED });
    applyHostTheme(THEME);
    expect(document.getElementById(HOST_THEME_USER_STYLE_ID)!.textContent).toBe('');
  });

  it('appends the custom CSS to the head of a page whose HTML has neither style', () => {
    document.head.innerHTML = '';
    applyHostTheme({ ...THEME, customCss: SCOPED });
    expect(styleIds()).toEqual([HOST_THEME_USER_STYLE_ID]);
    expect(document.getElementById(HOST_THEME_USER_STYLE_ID)!.textContent).toBe(SCOPED);
    applyHostTheme({ ...THEME, customCss: SCOPED });
    expect(styleIds()).toEqual([HOST_THEME_USER_STYLE_ID]);
  });

  it('creates the trusted style first on a page whose HTML had none, and puts the custom CSS after it', () => {
    document.getElementById(HOST_TRUSTED_STYLE_ID)!.remove();
    applyHostTheme({ ...THEME, customCss: SCOPED });
    expect(styleIds()).toEqual([HOST_THEME_STYLE_ID, HOST_TRUSTED_STYLE_ID, HOST_THEME_USER_STYLE_ID]);
  });
});
