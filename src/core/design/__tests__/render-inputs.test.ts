import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { designRefPath } from '../design-refs';
import { RENDER_HASH_SCHEME, renderInputHashes, screenRenderInputs } from '../render-inputs';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

function folderWith(files: Record<string, string>): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'render-inputs-'));
  folders.push(folder);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    fs.writeFileSync(path.join(folder, name), text);
  }
  return folder;
}

describe('a page\'s render inputs (D86)', () => {
  it('resolves a ref against the loading file\'s folder, its escapes decoded once as the servers decode a path', () => {
    expect(designRefPath('screens/S1.html', '../shared/app%20shell.css?v=1#top')).toBe('shared/app shell.css');
    expect(designRefPath('shared/base.css', '../assets/bg.png')).toBe('assets/bg.png');
    for (const ref of ['%2e%2e/%2e%2e/x.css', '../../x.css', '/shared/a.css', '%2Fshared/a.css', 'https://cdn.example/a.css', '//cdn.example/a.css', '../shared/%zz.css', '', '#x']) {
      expect(designRefPath('screens/S1.html', ref), ref).toBeUndefined();
    }
  });

  it('holds the page, tokens.css, what it loads and what a stylesheet among those loads, @imports followed', async () => {
    const folder = folderWith({
      'screens/S1.html': '<link rel="stylesheet" href="../shared/app%20shell.css"><img src="../assets/a.png"><div style="background: url(../assets/b.png)"></div>',
      'shared/app shell.css': '@import "../shared/more.css"; .x { background: url(../assets/c.png); }',
      'shared/more.css': '.y { background: url(../assets/d.png); }',
      'tokens.css': '@font-face { font-family: Inter; src: url(assets/inter.woff2); }',
    });
    expect([...(await screenRenderInputs(folder, 'screens/S1.html')).keys()].sort()).toEqual([
      'assets/a.png', 'assets/b.png', 'assets/c.png', 'assets/d.png', 'assets/inter.woff2', 'screens/S1.html', 'shared/app shell.css', 'shared/more.css', 'tokens.css',
    ]);
  });

  it('changes a screen\'s hash when a file it loads through an escaped ref changes, and not for a file it does not load', async () => {
    const folder = folderWith({
      'screens/S1.html': '<link rel="stylesheet" href="../shared/app%20shell.css">',
      'screens/S2.html': '<p>Plain</p>',
      'shared/app shell.css': '.shell { padding: 1px; }',
    });
    const before = await renderInputHashes(folder, ['screens/S1.html', 'screens/S2.html']);
    fs.writeFileSync(path.join(folder, 'shared', 'app shell.css'), '.shell { padding: 2px; }');
    const after = await renderInputHashes(folder, ['screens/S1.html', 'screens/S2.html']);
    expect(after['screens/S1.html']).not.toBe(before['screens/S1.html']);
    expect(after['screens/S2.html']).toBe(before['screens/S2.html']);
  });
});

describe('what counts as a render input (D86)', () => {
  const inputsOf = async (files: Record<string, string>, page = 'screens/S1.html'): Promise<string[]> => [...(await screenRenderInputs(folderWith(files), page)).keys()].sort();

  it('follows @import chains transitively, each stylesheet once, so a cycle ends', async () => {
    expect(await inputsOf({
      'screens/S1.html': '<style>@import url("../shared/a.css");</style>',
      'shared/a.css': '@import "b.css"; .a { background: url(../assets/a.png); }',
      'shared/b.css': '@import "c.css";',
      'shared/c.css': '@import "a.css"; .c { background: url(../assets/c.png); }',
    })).toEqual(['assets/a.png', 'assets/c.png', 'screens/S1.html', 'shared/a.css', 'shared/b.css', 'shared/c.css', 'tokens.css']);
  });

  it('takes the href and xlink:href of SVG use, image and feImage, and the bare strings of image-set()', async () => {
    expect(await inputsOf({
      'screens/S1.html': '<svg><use href="../assets/icons.svg#add"></use><image xlink:href="../assets/photo.png"></image><filter><feImage href="../assets/noise.png"></feImage></filter></svg>'
        + '<div style="background: image-set(&quot;../assets/a.png&quot; 1x, \'../assets/b.png\' 2x)"></div>',
    })).toEqual(['assets/a.png', 'assets/b.png', 'assets/icons.svg', 'assets/noise.png', 'assets/photo.png', 'screens/S1.html', 'tokens.css']);
  });

  it('takes every file under shared/ and assets/ for a page that runs any script, and none it does not load for one that runs none', async () => {
    const files = {
      'shared/app.js': 'import("./lazy.js");',
      'shared/lazy.js': 'fetch("../assets/data.json");',
      'assets/data.json': '{}',
      'assets/img/a.png': 'png',
      'variants/x/a.html': '<p>other</p>',
    };
    const all = ['assets/data.json', 'assets/img/a.png', 'screens/S1.html', 'shared/app.js', 'shared/lazy.js', 'tokens.css'];
    for (const page of ['<script type="module" src="../shared/app.js"></script>', '<script>void 0;</script>', '<button onclick="go()">Go</button>']) {
      expect(await inputsOf({ ...files, 'screens/S1.html': page }), page).toEqual(all);
    }
    expect(await inputsOf({ ...files, 'screens/S1.html': '<script type="application/json">{}</script>' })).toEqual(['screens/S1.html', 'tokens.css']);
  });

  it('reads a backslash as a slash, as Chromium does on the design scheme', async () => {
    expect(designRefPath('screens/S1.html', '..\\assets\\x.png')).toBe('assets/x.png');
    expect(designRefPath('screens/S1.html', '..%5Cassets%5Cx.png')).toBeUndefined();
  });

  it('tags each hash with its scheme, and hashes a file it does not hold whole the same as one it reads', async () => {
    const folder = folderWith({ 'screens/S1.html': '<img src="../assets/big.bin">', 'assets/big.bin': 'x'.repeat(3 * 1024 * 1024 + 5) });
    const first = (await renderInputHashes(folder, ['screens/S1.html']))['screens/S1.html']!;
    expect(first.startsWith(RENDER_HASH_SCHEME)).toBe(true);
    expect((await screenRenderInputs(folder, 'screens/S1.html')).get('assets/big.bin')).toBe(createHash('sha256').update('x'.repeat(3 * 1024 * 1024 + 5)).digest('hex'));
    fs.appendFileSync(path.join(folder, 'assets', 'big.bin'), 'y');
    expect((await renderInputHashes(folder, ['screens/S1.html']))['screens/S1.html']).not.toBe(first);
  });
});
