// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { markdownPreviewHtml, previewLink } from '../editor/markdown-html';

function render(source: string): HTMLElement {
  const holder = document.createElement('div');
  holder.innerHTML = markdownPreviewHtml(source);
  return holder;
}

const hrefs = (holder: HTMLElement): Array<string | null> => [...holder.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href'));

describe('markdownPreviewHtml', () => {
  it('keeps http(s), in-page and relative links', () => {
    const holder = render('[a](https://example.com/x) [b](http://example.com) [c](#usage) [d](docs/guide.md) [e](../up.md#part)');
    expect(hrefs(holder)).toEqual(['https://example.com/x', 'http://example.com', '#usage', 'docs/guide.md', '../up.md#part']);
  });

  it.each([
    ['javascript:', '<a href="javascript:alert(1)">x</a>'],
    ['JavaScript: in mixed case', '<a href="JavaScript:alert(1)">x</a>'],
    ['data:', '<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>'],
    ['vbscript:', '<a href="vbscript:msgbox(1)">x</a>'],
    ['a tab inside its scheme', '<a href="java\tscript:alert(1)">x</a>'],
    ['an encoded tab inside its scheme', '<a href="java&#x09;script:alert(1)">x</a>'],
    ['a newline inside its scheme', '<a href="java\nscript:alert(1)">x</a>'],
    ['leading whitespace', '<a href=" javascript:alert(1)">x</a>'],
    ['file:', '<a href="file:///C:/Windows/System32/calc.exe">x</a>'],
    ['javascript: from a markdown link', '[x](javascript:alert(1))'],
  ])('strips an href with %s', (_name, source) => {
    expect(hrefs(render(source))).toEqual([null]);
  });

  it('keeps only the image placeholder and code language classes, so no shell utility class reaches the page', () => {
    const holder = render('<span class="fixed inset-0 z-50">cover</span>\n\n```ts\nconst a = 1;\n```\n\n![logo](logo.png)');
    expect(holder.querySelector('span:not(.md-preview-image)')?.hasAttribute('class')).toBe(false);
    expect(holder.querySelector('code')?.className).toBe('language-ts');
    expect(holder.querySelector('.md-preview-image')?.textContent).toBe('logo');
  });

  it('drops id, name and style attributes', () => {
    const holder = render('<p id="editor-panel" name="x" style="position:fixed;inset:0">text</p>\n\n<a href="#a" id="b" name="c">a</a>');
    for (const element of holder.querySelectorAll('*')) {
      expect([element.hasAttribute('id'), element.hasAttribute('name'), element.hasAttribute('style')]).toEqual([false, false, false]);
    }
  });

  // One element per case: happy-dom's NodeIterator skips the node after one DOMPurify removes, which Chromium's does not.
  it.each([
    ['img', '<img src="t.png" alt="t">'],
    ['svg', '<svg><circle r="5"></circle></svg>'],
    ['style', '<style>body { display: none }</style>'],
    ['form', '<form action="https://example.com">go</form>'],
    ['iframe', '<iframe></iframe>'],
    ['script', '<script>alert(1)</script>'],
    ['picture', '<picture></picture>'],
    ['video', '<video></video>'],
    ['object', '<object></object>'],
  ])('removes %s', (tag, source) => {
    expect(render(source).querySelector(tag)).toBeNull();
  });

  it('renders an image as its alt text and loads nothing', () => {
    const holder = render('![a <b>bold</b> "alt"](https://example.com/x.png)');
    expect(holder.querySelector('img')).toBeNull();
    expect(holder.querySelector('.md-preview-image')?.textContent).toBe('a <b>bold</b> "alt"');
  });

  it('renders raw HTML only through the allowlist', () => {
    const holder = render('<b>bold</b> <table><tr><td>cell</td></tr></table> <marquee>gone</marquee>');
    expect(holder.querySelector('b')?.textContent).toBe('bold');
    expect(holder.querySelector('td')?.textContent).toBe('cell');
    expect(holder.querySelector('marquee')).toBeNull();
  });

  it('turns every input into a disabled checkbox, a task list\'s and the file\'s own', () => {
    const holder = render('- [x] done\n- [ ] open\n\n<input type="text" value="typed"> <input type="file"> <input type="checkbox">');
    const inputs = [...holder.querySelectorAll('input')];
    expect(inputs).toHaveLength(5);
    for (const input of inputs) expect([input.getAttribute('type'), input.hasAttribute('disabled')]).toEqual(['checkbox', true]);
    expect(inputs[0]!.hasAttribute('checked')).toBe(true);
    expect(inputs[1]!.hasAttribute('checked')).toBe(false);
    expect(inputs[2]!.hasAttribute('value')).toBe(false);
  });
});

describe('previewLink', () => {
  it('opens http(s) outside, scrolls to an anchor and opens a relative file beside the document', () => {
    expect(previewLink('https://example.com', 'docs/a.md')).toEqual({ kind: 'external' });
    expect(previewLink('HTTP://example.com', 'docs/a.md')).toEqual({ kind: 'external' });
    expect(previewLink('#getting-started', 'docs/a.md')).toEqual({ kind: 'anchor', id: 'getting-started' });
    expect(previewLink('#caf%C3%A9', 'docs/a.md')).toEqual({ kind: 'anchor', id: 'café' });
    expect(previewLink('b.md', 'docs/a.md')).toEqual({ kind: 'file', relativePath: 'docs/b.md' });
    expect(previewLink('./img/../c.md?raw#top', 'docs/a.md')).toEqual({ kind: 'file', relativePath: 'docs/c.md' });
    expect(previewLink('../README.md', 'docs/a.md')).toEqual({ kind: 'file', relativePath: 'README.md' });
  });

  it('refuses a path that climbs past the project root', () => {
    expect(previewLink('../../etc/passwd', 'docs/a.md')).toBeUndefined();
    expect(previewLink('../x.md', 'a.md')).toBeUndefined();
    expect(previewLink('..', 'docs/a.md')).toBeUndefined();
  });

  it('decodes %2e%2e before splitting, so an encoded climb is a climb', () => {
    expect(previewLink('%2e%2e/%2e%2e/secret', 'docs/a.md')).toBeUndefined();
    expect(previewLink('%2E%2E%2Fsecret', 'a.md')).toBeUndefined();
    expect(previewLink('%2e%2e/b.md', 'docs/a.md')).toEqual({ kind: 'file', relativePath: 'b.md' });
  });

  it('refuses absolute paths, schemes, a malformed escape and a document with no project path', () => {
    for (const href of ['/etc/passwd', 'C:/Windows/win.ini', 'c:\\Windows\\win.ini', 'file:///etc/passwd', 'javascript:alert(1)', 'mailto:a@b.c', 'vscode://file/x', '%E0%A4%A.md', '?query', '#%E0%A4%A']) {
      expect(previewLink(href, 'docs/a.md'), href).toBeUndefined();
    }
    expect(previewLink('b.md', undefined)).toBeUndefined();
  });
});
