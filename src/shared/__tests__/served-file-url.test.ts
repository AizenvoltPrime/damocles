import { describe, expect, it } from 'vitest';
import { fileUrlOfRoot, fileUrlPath, isFileUrl, servedToFile, withAddressParts } from '../served-file-url';

describe('fileUrlPath', () => {
  it('reads POSIX and Windows file URLs, decoded once', () => {
    expect(fileUrlPath('file:///home/u/proj/docs/index.html')).toBe('/home/u/proj/docs/index.html');
    expect(fileUrlPath('FILE://localhost/home/u/my%20proj/a.html')).toBe('/home/u/my proj/a.html');
    expect(fileUrlPath('file:///C:/Users/u/proj/a.html')).toBe('C:/Users/u/proj/a.html');
    expect(fileUrlPath('file:///c|/Users/u/a.html')).toBe('C:/Users/u/a.html');
    expect(fileUrlPath('file://C:/Users/u/a.html')).toBe('C:/Users/u/a.html');
    expect(fileUrlPath('file:///C:\\Users\\u\\a.html')).toBe('C:/Users/u/a.html');
    expect(fileUrlPath('file:///home/u/a%252e.html')).toBe('/home/u/a%2e.html');
  });

  it('resolves dot segments as the browser does, drops a query and fragment, and refuses other hosts and bad escapes', () => {
    expect(fileUrlPath('file:///home/u/proj/../x')).toBe('/home/u/x');
    expect(fileUrlPath('file:///home/u/proj/docs/%2e%2E/x.html')).toBe('/home/u/proj/x.html');
    expect(fileUrlPath('file:///C:/../../x')).toBe('C:/x');
    // Chromium refuses an encoded separator in a file URL
    expect(fileUrlPath('file:///home/u/proj/docs/..%2f..%2fx')).toBeUndefined();
    expect(fileUrlPath('file:///home/u/proj/docs%2Fx.html')).toBeUndefined();
    expect(fileUrlPath('file:///home/u/proj/docs%5cx.html')).toBeUndefined();
    expect(fileUrlPath('file:///home/u/a.html?x=1#top')).toBe('/home/u/a.html');
    expect(fileUrlPath('file://server/share/a.html')).toBeUndefined();
    expect(fileUrlPath('file:///home/u/%E0%A4%A')).toBeUndefined();
    expect(fileUrlPath('file:///home/u/a%00b')).toBeUndefined();
    expect(fileUrlPath('http://localhost/a.html')).toBeUndefined();
  });
});

describe('isFileUrl', () => {
  it('answers what the browser reads as a file: URL, whatever its path', () => {
    for (const url of ['file:///a', 'FILE://server/x', ' file:///a', 'fi\tle:///a']) expect(isFileUrl(url), url).toBe(true);
    for (const url of ['http://localhost/a', '/home/u/a', 'not a url']) expect(isFileUrl(url), url).toBe(false);
  });
});

describe('withAddressParts', () => {
  const open = 'http://127.0.0.1:5000/__damocles_preview/open?t=T&p=a.html';
  it('puts the query in q and keeps the fragment on the open URL', () => {
    expect(withAddressParts(open, 'file:///r/a.html?x=1&y=%20#top')).toBe(`${open}&q=x%3D1%26y%3D%2520#top`);
    expect(withAddressParts(open, 'file:///r/a.html')).toBe(open);
    expect(withAddressParts(open, 'file:///r/a.html?#')).toBe(open);
  });
});

describe('fileUrlOfRoot', () => {
  it('encodes each segment and keeps a drive letter', () => {
    expect(fileUrlOfRoot('/home/u/my proj/')).toBe('file:///home/u/my%20proj');
    expect(fileUrlOfRoot('c:\\Users\\u\\proj')).toBe('file:///C:/Users/u/proj');
  });
});

describe('servedToFile', () => {
  const mappings = [{ origin: 'http://127.0.0.1:52341', displayRoot: '/home/u/proj' }, { origin: 'http://127.0.0.1:52342', displayRoot: 'C:\\designs\\d1' }];

  it('puts a served URL in file form with its path, query and fragment', () => {
    expect(servedToFile('[URL] http://127.0.0.1:52341/docs/index.html?x=1#y', mappings)).toBe('[URL] file:///home/u/proj/docs/index.html?x=1#y');
    expect(servedToFile('at http://localhost:52342/screens/S2.html:12:5', mappings)).toBe('at file:///C:/designs/d1/screens/S2.html:12:5');
    expect(servedToFile('HTTP://127.0.0.1:52341', mappings)).toBe('file:///home/u/proj');
  });

  it('turns a one-time open URL into the file it opens, its token dropped', () => {
    const open = 'http://127.0.0.1:52341/__damocles_preview/open?t=SECRETtoken_-1&p=docs%2Fmy+page.html';
    const text = servedToFile(`Opened browser: ${open} (HTTP 403)`, mappings);
    expect(text).toBe('Opened browser: file:///home/u/proj/docs/my%20page.html (HTTP 403)');
    expect(text).not.toContain('SECRET');
    expect(servedToFile('"http://127.0.0.1:52341/__damocles_preview/open?t=SECRET"', mappings)).toBe('"file:///home/u/proj/"');
    const carried = servedToFile('http://127.0.0.1:52341/__damocles_preview/open?t=SECRET&p=docs%2Fa.html&q=x%3D1%26y%3D%2520#top done', mappings);
    expect(carried).toBe('file:///home/u/proj/docs/a.html?x=1&y=%20#top done');
  });

  it('leaves other ports, longer port numbers and other schemes alone', () => {
    const text = 'http://127.0.0.1:5234/a http://127.0.0.1:523411/a https://127.0.0.1:52341/a http://127.0.0.2:52341/a';
    expect(servedToFile(text, mappings)).toBe(text);
    expect(servedToFile('http://127.0.0.1:52341/a', [])).toBe('http://127.0.0.1:52341/a');
  });

  it('runs in linear time on hostile page output', () => {
    const hostile = `${'http://127.0.0.1:52341'.repeat(20_000)}${'http://127.0.0.1:'.repeat(20_000)}${'/__damocles_preview/open?'.repeat(20_000)}`;
    const started = performance.now();
    servedToFile(hostile, mappings);
    servedToFile(`http://127.0.0.1:52341/__damocles_preview/open?${'a'.repeat(400_000)}`, mappings);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
