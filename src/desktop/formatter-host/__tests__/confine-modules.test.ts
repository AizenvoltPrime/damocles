import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moduleOutsideRoot } from '../confine-modules';

let base: string;
let root: string;
let outside: string;
let bundle: string;

function put(file: string, content: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

// A module that leaves a marker beside itself when it runs.
function marking(file: string, esm = false): string {
  const marker = JSON.stringify(`${file}.ran`);
  return put(file, esm ? `import { writeFileSync } from 'node:fs'; writeFileSync(${marker}, '');\nexport default {};\n` : `require('fs').writeFileSync(${marker}, ''); module.exports = {};\n`);
}

// The hook as the formatter host installs it, in a Node process of its own, since a hook cannot be removed again.
function runConfined(script: string): Record<string, string> {
  const runner = put(path.join(base, `run-${Math.random().toString(36).slice(2)}.cjs`), [
    `const { confineModules } = require(${JSON.stringify(bundle)});`,
    `const { pathToFileURL } = require('node:url');`,
    `const refused = confineModules(${JSON.stringify(root)});`,
    'const results = {};',
    'const attempt = async (name, load) => { try { await load(); results[name] = "loaded"; } catch (err) { results[name] = err.code ?? String(err); } };',
    `(async () => { ${script} results.refused = refused.join('|'); process.stdout.write(JSON.stringify(results)); })();`,
  ].join('\n'));
  return JSON.parse(execFileSync(process.execPath, [runner], { cwd: root, encoding: 'utf8' })) as Record<string, string>;
}

beforeAll(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-confine-modules-')));
  outside = path.join(base, 'outside');
  root = path.join(base, 'outside', 'repo');
  bundle = path.join(base, 'confine-modules.cjs');
  buildSync({ entryPoints: [path.join(__dirname, '..', 'confine-modules.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node24', outfile: bundle, logLevel: 'silent' });
  put(path.join(root, 'node_modules', 'inside-plugin', 'package.json'), '{"name":"inside-plugin","main":"index.js"}');
  put(path.join(root, 'node_modules', 'inside-plugin', 'index.js'), `require('fs'); require('node:path'); module.exports = 'inside';\n`);
  // Hoisted to the parent's node_modules, as in a monorepo whose root is not the trusted folder.
  put(path.join(outside, 'node_modules', 'hoisted-plugin', 'package.json'), '{"name":"hoisted-plugin","main":"index.js"}');
  marking(path.join(outside, 'node_modules', 'hoisted-plugin', 'index.js'));
  marking(path.join(outside, 'shared.cjs'));
  marking(path.join(outside, 'shared.mjs'), true);
  // A junction inside the root whose target lies outside it.
  fs.mkdirSync(path.join(outside, 'linked'));
  marking(path.join(outside, 'linked', 'via-link.cjs'));
  fs.symlinkSync(path.join(outside, 'linked'), path.join(root, 'linked'), 'junction');
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('confineModules (formatter host)', () => {
  it('loads builtins and modules inside the root, and refuses any module whose real path is outside it, before it runs', () => {
    const results = runConfined([
      `await attempt('inside', () => require(${JSON.stringify(path.join(root, 'node_modules', 'inside-plugin'))}));`,
      // Prettier 2 resolves a plugin with require.resolve(name, { paths: [cwd] }), which walks up past the root.
      `await attempt('hoisted', () => require(require.resolve('hoisted-plugin', { paths: [${JSON.stringify(root)}] })));`,
      `await attempt('bare', () => require('node:module').createRequire(${JSON.stringify(path.join(root, 'package.json'))})('hoisted-plugin'));`,
      `await attempt('cjs', () => require(${JSON.stringify(path.join(outside, 'shared.cjs'))}));`,
      // Prettier 3 resolves on its own and imports the file URL.
      `await attempt('esm', () => import(pathToFileURL(${JSON.stringify(path.join(outside, 'shared.mjs'))}).href));`,
      `await attempt('link', () => require(${JSON.stringify(path.join(root, 'linked', 'via-link.cjs'))}));`,
    ].join('\n'));
    expect(results).toMatchObject({ inside: 'loaded', hoisted: 'ERR_DAMOCLES_OUTSIDE_ROOT', bare: 'ERR_DAMOCLES_OUTSIDE_ROOT', cjs: 'ERR_DAMOCLES_OUTSIDE_ROOT', esm: 'ERR_DAMOCLES_OUTSIDE_ROOT', link: 'ERR_DAMOCLES_OUTSIDE_ROOT' });
    expect(results.refused!.split('|')).toContain(path.join(outside, 'linked', 'via-link.cjs'));
    for (const file of ['node_modules/hoisted-plugin/index.js', 'shared.cjs', 'shared.mjs', 'linked/via-link.cjs']) {
      expect(fs.existsSync(path.join(outside, ...file.split('/')) + '.ran'), file).toBe(false);
    }
  });
});

describe('moduleOutsideRoot', () => {
  it('allows builtins and files under the root, and names anything else', () => {
    expect(moduleOutsideRoot(root, 'node:fs')).toBeUndefined();
    expect(moduleOutsideRoot(root, 'fs')).toBeUndefined();
    expect(moduleOutsideRoot(root, pathToFileURL(path.join(root, 'node_modules', 'inside-plugin', 'index.js')).href)).toBeUndefined();
    expect(moduleOutsideRoot(root, 'data:text/javascript,1')).toBe('data:text/javascript,1');
    const sibling = path.join(base, 'outside', 'repo-evil', 'x.js');
    expect(moduleOutsideRoot(root, pathToFileURL(sibling).href)).toBe(sibling);
  });
});
