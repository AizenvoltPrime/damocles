// A stand-in for the `prettier` package with the slice of its Node API the formatter host calls. Its package.json, which
// e2e/desktop/support/prettier.ts writes, picks the API: version 2.x answers format synchronously and takes one ignore
// file, 3.x answers with a promise and takes a list; `delayMs` makes format that much slower.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const manifest = require('./package.json');

const major = Number(manifest.version.split('.')[0]);
const PARSERS = { '.ts': 'typescript', '.js': 'babel', '.json': 'json', '.md': 'markdown' };

// Exact '/'-separated paths, relative to the ignore file's folder; the cwd is the project root.
function isIgnored(file, ignorePath) {
  for (const name of Array.isArray(ignorePath) ? ignorePath : [ignorePath]) {
    const ignoreFile = path.resolve(name);
    if (!fs.existsSync(ignoreFile)) continue;
    const relative = path.relative(path.dirname(ignoreFile), file).split(path.sep).join('/');
    if (fs.readFileSync(ignoreFile, 'utf8').split(/\r?\n/).map((line) => line.trim()).includes(relative)) return true;
  }
  return false;
}

// As Prettier does: the nearest config file from dir up to the filesystem root, skipping a folder of a config's name.
function searchConfig(dir) {
  for (;;) {
    for (const name of ['.prettierrc', 'prettier.config.js']) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    if (path.dirname(dir) === dir) return undefined;
    dir = path.dirname(dir);
  }
}

// A JS config loads as code; a package.json is a config only through its prettier key.
function loadConfig(configFile) {
  if (path.basename(configFile) === 'package.json') return JSON.parse(fs.readFileSync(configFile, 'utf8')).prettier || null;
  if (/\.c?js$/.test(configFile)) return require(configFile);
  return JSON.parse(fs.readFileSync(configFile, 'utf8'));
}

// Prettier 2 requires a plugin resolved from the cwd; Prettier 3 resolves it itself and imports the file.
async function loadPlugins(names) {
  for (const name of names ?? []) {
    const resolved = require.resolve(name, { paths: [process.cwd()] });
    if (major === 2) require(resolved);
    else await import(pathToFileURL(resolved).href);
  }
}

// Spaces around '=', a semicolon at each line's end unless the config says semi: false, blank lines dropped.
function formatText(text, options) {
  if (typeof options.filepath !== 'string') throw new Error('format needs a filepath');
  const semi = options.semi !== false;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  return `${lines.map((line) => line.replace(/\s*=\s*/g, ' = ').replace(/;$/, '') + (semi ? ';' : '')).join('\n')}\n`;
}

module.exports = {
  version: manifest.version,
  async getFileInfo(file, options) {
    if (major === 2 ? typeof options.ignorePath !== 'string' : !Array.isArray(options.ignorePath)) throw new Error(`Prettier ${major} got the wrong ignorePath`);
    await loadPlugins(options.plugins);
    return { ignored: isIgnored(file, options.ignorePath), inferredParser: PARSERS[path.extname(file)] ?? null };
  },
  // As Prettier does: exactly options.config when given, else the nearest config it finds.
  async resolveConfig(file, options) {
    if (options.editorconfig !== true) throw new Error('resolveConfig without editorconfig');
    const configFile = options.config ?? searchConfig(path.dirname(file));
    return configFile === undefined ? null : loadConfig(configFile);
  },
  format(text, options) {
    if (major === 2) {
      for (const name of options.plugins ?? []) require(require.resolve(name, { paths: [process.cwd()] }));
      return formatText(text, options);
    }
    // The host's warm-up formats '' once per parser before the format budget starts; only a real format is slow.
    return loadPlugins(options.plugins).then(() => new Promise((resolve) => setTimeout(() => resolve(formatText(text, options)), text === '' ? 0 : manifest.delayMs ?? 0)));
  },
};
