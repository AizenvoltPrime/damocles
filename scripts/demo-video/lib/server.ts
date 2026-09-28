import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

/**
 * The page VS Code would host: the built webview plus the theme variables, body attributes and
 * `acquireVsCodeApi` a real webview gets. Posted messages queue on `window.__posted`, which the stage
 * drains by polling, because Patchright's `exposeFunction` binding never reaches the main world.
 */
function hostHtml(webviewRoot: string, themeCss: string): string {
  const stub = `<script>
window.__posted = [];
window.acquireVsCodeApi = () => ({
  postMessage: (m) => window.__posted.push(JSON.parse(JSON.stringify(m))),
  getState: () => undefined,
  setState: () => {},
});
</script>`;
  return fs
    .readFileSync(path.join(webviewRoot, 'index.html'), 'utf8')
    .replace('<head>', `<head>${stub}<style>${themeCss}</style>`)
    .replace('<body>', '<body class="vscode-dark" data-vscode-theme-kind="vscode-dark" data-vscode-theme-name="Solarized Dark">')
    .replace('<div id="app">', '<div id="app" data-logo-uri="/__resources/icon.png">');
}

export interface StaticServer {
  url: string;
  close(): Promise<void>;
}

export async function startServer(repoRoot: string, themeCssPath: string): Promise<StaticServer> {
  const webviewRoot = path.join(repoRoot, 'dist', 'webview');
  const resourcesRoot = path.join(repoRoot, 'resources');
  if (!fs.existsSync(path.join(webviewRoot, 'index.html'))) {
    throw new Error(`No webview build at ${webviewRoot}. Run "npm run build" first.`);
  }
  const html = hostHtml(webviewRoot, fs.readFileSync(themeCssPath, 'utf8'));

  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    if (pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html);
      return;
    }
    const [base, rel] = pathname.startsWith('/__resources/')
      ? [resourcesRoot, pathname.slice('/__resources/'.length)]
      : [webviewRoot, pathname.slice(1)];
    const file = path.resolve(base, rel);
    if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
