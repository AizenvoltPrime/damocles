import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() } }));

import { protocol } from 'electron';
import { appResourceUri, handleAppProtocol, mimeTypeFor, panelPageUrl, resolveAppRequest } from '../protocol';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-protocol-'));
  fs.mkdirSync(path.join(root, 'dist', 'webview', 'assets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist', 'desktop'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'webview', 'assets', 'index.js'), '');
  fs.writeFileSync(path.join(root, 'dist', 'webview', 'assets', 'monaco-editor.worker-Ab12.js'), 'self.onmessage = () => {};');
  fs.writeFileSync(path.join(root, 'dist', 'webview', 'assets', 'monaco-codicon-Cd34.ttf'), Buffer.from([0, 1, 0, 0]));
  fs.writeFileSync(path.join(root, 'dist', 'webview', 'assets', 'monaco-editor-Ef56.css'), '.monaco-editor{}');
  fs.writeFileSync(path.join(root, 'dist', 'desktop', 'main.js'), 'secret');
  fs.mkdirSync(path.join(root, 'outside'));
  fs.writeFileSync(path.join(root, 'outside', 'secret.js'), 'secret');
  // A junction needs no privilege on Windows and is a directory symlink elsewhere.
  fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'dist', 'webview', 'assets', 'linked'), 'junction');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('resolveAppRequest', () => {
  it('serves files inside dist/webview and dist/desktop-shell', () => {
    expect(resolveAppRequest('app://damocles/webview/assets/index.js', root)).toEqual({
      kind: 'file',
      root: path.join(root, 'dist', 'webview'),
      filePath: path.join(root, 'dist', 'webview', 'assets', 'index.js'),
    });
    expect(resolveAppRequest('app://damocles/desktop-shell/assets/index.js', root)).toMatchObject({
      kind: 'file',
      filePath: path.join(root, 'dist', 'desktop-shell', 'assets', 'index.js'),
    });
  });

  it.each([
    'app://damocles/webview/../extension.js',
    'app://damocles/webview/assets/../../extension.js',
    'app://damocles/webview/%2e%2e/extension.js',
    'app://damocles/webview/%2E%2E/%2e%2e/package.json',
    'app://damocles/webview/..%2f..%2fpackage.json',
    'app://damocles/webview/%2fetc%2fpasswd',
    'app://damocles/webview',
    'app://damocles/webview/',
    'app://damocles/resources/grammars/tree-sitter.wasm',
    'app://damocles/package.json',
    'app://damocles/dist/extension.js',
    'app://other/webview/assets/index.js',
    'file:///etc/passwd',
    'app://damocles/webview/%E0%A4%A',
    'app://damocles/webview/assets/index.js%00.png',
    'app://damocles/__proto__/x',
    'app://damocles/constructor/x',
    'app://damocles/webview/index.html',
    'app://damocles/desktop-shell/index.html',
    'app://damocles/webview/assets/page.HTM',
  ])('refuses %s', (url) => {
    expect(resolveAppRequest(url, root)).toBeUndefined();
  });

  // A backslash separates path segments only on Windows; elsewhere it is part of a file name inside the root.
  it.runIf(process.platform === 'win32').each([
    'app://damocles/webview/..%5c..%5cpackage.json',
    'app://damocles/webview/%2e%2e%5c%2e%2e%5cpackage.json',
    'app://damocles/webview/C:%5cWindows%5cwin.ini',
    'app://damocles/webview/assets%5c..%5c..%5c..%5cpackage.json',
  ])('refuses the backslash traversal %s', (url) => {
    expect(resolveAppRequest(url, root)).toBeUndefined();
  });

  it('keeps a double-encoded dot segment as a literal name inside the root', () => {
    const target = resolveAppRequest('app://damocles/webview/%252e%252e/package.json', root);
    expect(target).toMatchObject({ kind: 'file', filePath: path.join(root, 'dist', 'webview', '%2e%2e', 'package.json') });
  });

  it('maps a panel page to its panel id', () => {
    expect(resolveAppRequest(panelPageUrl('0f8a-42'), root)).toEqual({ kind: 'panel', panelId: '0f8a-42' });
    expect(resolveAppRequest('app://damocles/panel/../index.html', root)).toBeUndefined();
    expect(resolveAppRequest('app://damocles/panel/a/b/index.html', root)).toBeUndefined();
  });

  it('serves the app icon by exact path only', () => {
    expect(resolveAppRequest('app://damocles/resources/icon.png', root)).toMatchObject({ filePath: path.join(root, 'resources', 'icon.png') });
    expect(resolveAppRequest('app://damocles/resources/icon.svg', root)).toBeUndefined();
  });
});

describe('appResourceUri', () => {
  it('maps served paths to app:// URLs and refuses the rest', () => {
    expect(appResourceUri(root, path.join(root, 'dist', 'webview', 'assets', 'index.js'))).toBe('app://damocles/webview/assets/index.js');
    expect(appResourceUri(root, path.join(root, 'resources', 'icon.png'))).toBe('app://damocles/resources/icon.png');
    expect(() => appResourceUri(root, path.join(root, 'package.json'))).toThrow(/outside/);
  });

  it('round-trips through resolveAppRequest', () => {
    const file = path.join(root, 'dist', 'webview', 'assets', 'a b#c.js');
    expect(resolveAppRequest(appResourceUri(root, file), root)).toMatchObject({ filePath: file });
  });
});

describe('mimeTypeFor', () => {
  it('names the types the webview loads', () => {
    expect(mimeTypeFor('x/index.js')).toBe('text/javascript; charset=utf-8');
    expect(mimeTypeFor('x/index.css')).toBe('text/css; charset=utf-8');
    expect(mimeTypeFor('x/a.wasm')).toBe('application/wasm');
    expect(mimeTypeFor('x/icon.PNG')).toBe('image/png');
    expect(mimeTypeFor('x/unknown.bin')).toBe('application/octet-stream');
  });
});

describe('handleAppProtocol', () => {
  // Monaco's workers load by URL from dist/webview/assets, and a worker served with a non-script type fails under nosniff.
  async function fetchApp(url: string): Promise<Response> {
    vi.mocked(protocol.handle).mockClear();
    handleAppProtocol(root, { panel: () => undefined, shell: () => '', pane: () => '', overlay: () => '' });
    const handler = vi.mocked(protocol.handle).mock.calls[0]?.[1];
    if (!handler) throw new Error('no app:// handler registered');
    return handler(new Request(url)) as Promise<Response>;
  }

  it.each([
    ['monaco-editor.worker-Ab12.js', 'text/javascript; charset=utf-8'],
    ['monaco-codicon-Cd34.ttf', 'font/ttf'],
    ['monaco-editor-Ef56.css', 'text/css; charset=utf-8'],
  ])('serves the Monaco asset %s as %s with nosniff', async (file, mime) => {
    const response = await fetchApp(`app://damocles/webview/assets/${file}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(mime);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(fs.readFileSync(path.join(root, 'dist', 'webview', 'assets', file)));
  });

  it('gives a script its own restrictive policy, which a worker does not inherit from its page', async () => {
    const script = await fetchApp('app://damocles/webview/assets/monaco-editor.worker-Ab12.js');
    expect(script.headers.get('content-security-policy')).toBe("default-src 'none'; script-src app://damocles");
    const style = await fetchApp('app://damocles/webview/assets/monaco-editor-Ef56.css');
    expect(style.headers.get('content-security-policy')).toBeNull();
  });

  it.each([
    'app://damocles/webview/assets/monaco-missing.worker.js',
    'app://damocles/webview/assets/%2e%2e/%2e%2e/desktop/main.js',
    'app://damocles/desktop/main.js',
    'app://damocles/webview/assets/linked/secret.js',
    'app://damocles/__proto__/x',
  ])('answers 404 for %s', async (url) => {
    expect((await fetchApp(url)).status).toBe(404);
  });
});
