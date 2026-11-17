import { describe, expect, it } from 'vitest';
import { fileUrlOfRoot, fileUrlPath, isFileUrl, isServedGrantHost, servedToFile, UNMAPPED_SERVED_PAGE, withAddressParts } from '../served-file-url';

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

  it('reads a host\'s file URL as its UNC path, with no drive', () => {
    expect(fileUrlPath('file://192.0.2.2/share/a.html')).toBe('//192.0.2.2/share/a.html');
    expect(fileUrlPath('FILE://NAS.INVALID/share/my%20dir/a.html')).toBe('//nas.invalid/share/my dir/a.html');
    expect(fileUrlPath('file://192.0.2.2/C:/a.html')).toBe('//192.0.2.2/C:/a.html');
    expect(fileUrlPath('file://192.0.2.2/share/..%2fx')).toBeUndefined();
  });

  it('resolves dot segments as the browser does, drops a query and fragment, and refuses bad escapes', () => {
    expect(fileUrlPath('file:///home/u/proj/../x')).toBe('/home/u/x');
    expect(fileUrlPath('file:///home/u/proj/docs/%2e%2E/x.html')).toBe('/home/u/proj/x.html');
    expect(fileUrlPath('file:///C:/../../x')).toBe('C:/x');
    // Chromium refuses an encoded separator in a file URL
    expect(fileUrlPath('file:///home/u/proj/docs/..%2f..%2fx')).toBeUndefined();
    expect(fileUrlPath('file:///home/u/proj/docs%2Fx.html')).toBeUndefined();
    expect(fileUrlPath('file:///home/u/proj/docs%5cx.html')).toBeUndefined();
    expect(fileUrlPath('file:///home/u/a.html?x=1#top')).toBe('/home/u/a.html');
    expect(fileUrlPath('file:///home/u/%E0%A4%A')).toBeUndefined();
    expect(fileUrlPath('file:///home/u/a%00b')).toBeUndefined();
    expect(fileUrlPath('http://localhost/a.html')).toBeUndefined();
  });
});

describe('isFileUrl', () => {
  it('answers what the browser reads as a file: URL, whatever its path', () => {
    for (const url of ['file:///a', 'FILE://192.0.2.2/x', ' file:///a', 'fi\tle:///a']) expect(isFileUrl(url), url).toBe(true);
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

  it('names a UNC root\'s server as the URL\'s host', () => {
    expect(fileUrlOfRoot('\\\\192.0.2.10\\team\\my proj\\')).toBe('file://192.0.2.10/team/my%20proj');
  });
});

describe('servedToFile', () => {
  const mappings = [{ origin: 'http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:52341', displayRoot: '/home/u/proj' }, { origin: 'http://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.localhost:52342', displayRoot: 'C:\\designs\\d1' }];

  it('puts a served URL in file form with its path, query and fragment', () => {
    expect(servedToFile('[URL] http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:52341/docs/index.html?x=1#y', mappings)).toBe('[URL] file:///home/u/proj/docs/index.html?x=1#y');
    expect(servedToFile('at http://BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB.localhost:52342/screens/S2.html:12:5', mappings)).toBe('at file:///C:/designs/d1/screens/S2.html:12:5');
    expect(servedToFile('HTTP://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.LOCALHOST:52341', mappings)).toBe('file:///home/u/proj');
  });

  it('turns a one-time open URL into the file it opens, its token dropped', () => {
    const open = 'http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:52341/__damocles_preview/open?t=SECRETtoken_-1&p=docs%2Fmy+page.html';
    const text = servedToFile(`Opened browser: ${open} (HTTP 403)`, mappings);
    expect(text).toBe('Opened browser: file:///home/u/proj/docs/my%20page.html (HTTP 403)');
    expect(text).not.toContain('SECRET');
    expect(servedToFile('"http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:52341/__damocles_preview/open?t=SECRET"', mappings)).toBe('"file:///home/u/proj/"');
    const carried = servedToFile('http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:52341/__damocles_preview/open?t=SECRET&p=docs%2Fa.html&q=x%3D1%26y%3D%2520#top done', mappings);
    expect(carried).toBe('file:///home/u/proj/docs/a.html?x=1&y=%20#top done');
  });

  // a saved page's file form is resolved again on restore, so it must name the root file and widen nothing
  it('gives a page address fileUrlPath reads back as its root file, and an encoded separator as no file', () => {
    expect(fileUrlPath(servedToFile('http://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.localhost:52342/screens/my%20S2%23.html?x=1#y', mappings))).toBe('C:/designs/d1/screens/my S2#.html');
    expect(fileUrlPath(servedToFile('http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:52341/docs/index.html', mappings))).toBe('/home/u/proj/docs/index.html');
    expect(fileUrlPath(servedToFile('http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:52341/%2e%2e%2Fetc/passwd', mappings))).toBeUndefined();
    expect(fileUrlPath(servedToFile('http://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.localhost:52342/a%5C..%5C..%5Cx', mappings))).toBeUndefined();
    expect(fileUrlPath(servedToFile(new URL('http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:52341/docs/%2e%2e/../../etc/passwd').href, mappings))).toBe('/home/u/proj/etc/passwd');
  });

  it('leaves other hosts alone, a user\'s own *.localhost dev server included', () => {
    const text = 'http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost.example:52341/a http://127.0.0.1:52341/a http://localhost:52341/a http://xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:52341/a http://app.localhost:5173/x app.localhost:5173 http://api.app.localhost:5173/ deadbeef.localhost:1';
    expect(servedToFile(text, mappings)).toBe(text);
  });

  it('keeps the chat\'s own bare grant host and writes any other bare one, or one under another scheme, as a page it cannot open', () => {
    const own = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:52341';
    const other = 'cccccccccccccccccccccccccccccccc.localhost:52341';
    expect(servedToFile(`host=${own}`, mappings)).toBe(`host=${own}`);
    expect(servedToFile(`host=${other} "${other.toUpperCase()}"`, mappings)).toBe(`host=${UNMAPPED_SERVED_PAGE} "${UNMAPPED_SERVED_PAGE}"`);
    expect(servedToFile('cccccccccccccccccccccccccccccccc.localhost/x', [])).toBe(`${UNMAPPED_SERVED_PAGE}/x`);
    expect(servedToFile(`https://${other}/a`, mappings)).toBe(`https://${UNMAPPED_SERVED_PAGE}/a`);
  });

  it('shows a grant URL no mapping names, another port of a mapped label or another label, as a page the chat cannot open', () => {
    const unmapped = 'http://cccccccccccccccccccccccccccccccc.localhost:52341/docs/a.html?t=x#y';
    expect(servedToFile(`saved ${unmapped} (done)`, mappings)).toBe(`saved ${UNMAPPED_SERVED_PAGE} (done)`);
    expect(servedToFile('http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:5234/a http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:523411/a', mappings)).toBe(`${UNMAPPED_SERVED_PAGE} ${UNMAPPED_SERVED_PAGE}`);
    expect(servedToFile('http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:52341/__damocles_preview/open?t=SECRET&p=a.html', [])).toBe(UNMAPPED_SERVED_PAGE);
    // a trailing dot or no port names no grant origin, and its label stays out of the answer too
    expect(servedToFile('http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost.:52341/a and http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost/a', mappings)).toBe(`${UNMAPPED_SERVED_PAGE} and ${UNMAPPED_SERVED_PAGE}`);
  });

  it('runs in linear time on hostile page output', () => {
    const hostile = `${'http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:52341'.repeat(20_000)}${'http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:'.repeat(20_000)}${'http://cccccccccccccccccccccccccccccccc.localhost:1 '.repeat(20_000)}${'/__damocles_preview/open?'.repeat(20_000)}`;
    const started = performance.now();
    servedToFile(hostile, mappings);
    servedToFile(`http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost:52341/__damocles_preview/open?${'a'.repeat(400_000)}`, mappings);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('isServedGrantHost', () => {
  it('reads only a 32-digit lowercase hex label under localhost, as URL.hostname writes one', () => {
    for (const host of ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost.']) expect(isServedGrantHost(host), host).toBe(true);
    for (const host of ['localhost', '127.0.0.1', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost..', 'xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.example', 'z'.repeat(32) + '.localhost']) expect(isServedGrantHost(host), host).toBe(false);
  });
});
