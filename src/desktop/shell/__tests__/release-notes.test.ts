// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { releaseNotesHtml } from '../overlay/settings/release-notes-html';

function render(source: string): HTMLElement {
  const holder = document.createElement('div');
  holder.innerHTML = releaseNotesHtml(source);
  return holder;
}

describe('releaseNotesHtml', () => {
  it('renders a CHANGELOG section: headings marked by kind, bold leads, code spans and nested lists', () => {
    const notes = render([
      '### Added',
      '',
      '- **Desktop: a pill.** Shows `Downloading 42%`.',
      '  - **Nested:** detail.',
      '',
      '### Fixed',
      '',
      '- A fix.',
      '',
      '### Tests',
    ].join('\n'));
    expect([...notes.querySelectorAll('h3')].map((h) => [h.textContent, h.getAttribute('data-section')])).toEqual([
      ['Added', 'added'],
      ['Fixed', 'fixed'],
      ['Tests', null],
    ]);
    expect(notes.querySelector('li > strong')?.textContent).toBe('Desktop: a pill.');
    expect(notes.querySelector('code')?.textContent).toBe('Downloading 42%');
    expect(notes.querySelector('li ul li strong')?.textContent).toBe('Nested:');
  });

  // One vector per case: happy-dom's NodeIterator stops after DOMPurify removes a node, so a combined input would leave
  // the rest unchecked (Chromium does not; about.spec.ts renders a combined one in the app).
  it.each([
    ['a script', '<p>text</p><script>alert(1)</script>'],
    ['event handlers and styles', '<p onclick="alert(2)" style="color:red">text</p>'],
    ['a remote image with onerror', 'text\n\n<img src="https://evil.example/x.png" onerror="alert(3)">'],
    ['a markdown image', 'text ![remote](https://evil.example/y.png)'],
    ['an SVG image', 'text <svg><image href="https://evil.example/z.png"/></svg>'],
    ['an iframe', 'text\n\n<iframe srcdoc="<b>evil.example</b>"></iframe>'],
    ['a data image', 'text <img src="data:image/png;base64,AAAA">'],
  ])('strips %s', (_name, source) => {
    const notes = render(source);
    expect(notes.querySelector('script, img, svg, image, iframe, style')).toBeNull();
    expect(notes.innerHTML).not.toMatch(/onclick|onerror|style=|evil\.example|data:/);
    expect(notes.textContent?.trim()).toBe('text');
  });

  it('keeps only http(s) links and opens them in a new window, which main sends to the browser', () => {
    const notes = render([
      '[release](https://github.com/AizenvoltPrime/damocles/releases)',
      '[plain](http://example.com/a)',
      '[script](javascript:alert(1))',
      '<a href="file:///etc/passwd">file</a>',
      '<a href="app://damocles/x">app</a>',
      '[relative](../secrets)',
    ].join(' '));
    const anchors = [...notes.querySelectorAll('a')];
    const linked = anchors.filter((a) => a.hasAttribute('href'));
    expect(linked.map((a) => [a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')])).toEqual([
      ['https://github.com/AizenvoltPrime/damocles/releases', '_blank', 'noopener noreferrer'],
      ['http://example.com/a', '_blank', 'noopener noreferrer'],
    ]);
    // A refused link keeps its text and loses its href, so it opens nothing.
    expect(anchors.filter((a) => !a.hasAttribute('href')).map((a) => [a.textContent, a.hasAttribute('target')])).toEqual([
      ['script', false],
      ['file', false],
      ['app', false],
      ['relative', false],
    ]);
  });
});
