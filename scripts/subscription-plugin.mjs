/**
 * The Claude subscription plugin a daemon's core loads (pi-anthropic-auth, MIT): its package.json, LICENSE and src/ at the
 * commit src/core/pi-session/subscription-pin.ts pins, taken from GitHub's archive of that commit and accepted only when
 * their digest equals the pinned SHA-256. The desktop build writes it to dist/subscription-plugin/ for the loopback daemon,
 * and the server build to the staged dist/, so every server package carries it.
 *
 *   node scripts/subscription-plugin.mjs [<dest>]   vendors into <dest> (default dist/subscription-plugin) and prints the digest
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './entry-point.mjs';
import { readTarGz, sha256 } from './server-archive.mjs';
import { SUBSCRIPTION_COMMIT, SUBSCRIPTION_PLUGIN_SHA256, SUBSCRIPTION_REPO } from '../src/core/pi-session/subscription-pin.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// shared with build-server.mjs's downloads
export const CACHE_DIR = join(ROOT, 'dist', 'server-packages', '.cache');
// the folder under a package's dist/ that core loads (subscriptionPluginDir in src/core/pi-session/allowance-transport.ts)
export const PLUGIN_DIR = 'subscription-plugin';
export const ARCHIVE_URL = `${SUBSCRIPTION_REPO}/archive/${SUBSCRIPTION_COMMIT}.tar.gz`;

const kept = (path) => path === 'package.json' || path === 'LICENSE' || path.startsWith('src/');

/** The plugin's files from a GitHub archive of one commit: package.json, LICENSE and src/, top folder stripped. */
export function pluginFiles(archive) {
  const files = [];
  for (const entry of readTarGz(archive)) {
    const path = entry.path.slice(entry.path.indexOf('/') + 1);
    if (!kept(path)) continue;
    if (entry.type !== 'file') throw new Error(`${entry.path} in the subscription plugin archive is a ${entry.type}`);
    files.push({ path, data: entry.data });
  }
  return files;
}

/** One SHA-256 over every file's path and content, in path order. */
export function pluginDigest(files) {
  const hash = createHash('sha256');
  for (const { path, data } of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) hash.update(`${path}\0${sha256(data)}\n`);
  return hash.digest('hex');
}

async function download(url) {
  console.log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** The pinned plugin's files, from the cache when its archive still matches, else downloaded; refused on another digest. */
export async function subscriptionPluginFiles({ cacheDir = CACHE_DIR, fetchArchive = download, expected = SUBSCRIPTION_PLUGIN_SHA256 } = {}) {
  const cached = join(cacheDir, `pi-anthropic-auth-${SUBSCRIPTION_COMMIT}.tar.gz`);
  if (existsSync(cached)) {
    const files = pluginFiles(readFileSync(cached));
    if (pluginDigest(files) === expected) return files;
  }
  const archive = await fetchArchive(ARCHIVE_URL);
  const files = pluginFiles(archive);
  const digest = pluginDigest(files);
  if (digest !== expected) throw new Error(`${ARCHIVE_URL} holds a subscription plugin with digest ${digest}, not the ${expected} src/core/pi-session/subscription-pin.ts pins`);
  if (!files.some((file) => file.path === 'LICENSE')) throw new Error(`${ARCHIVE_URL} holds no LICENSE`);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cached, archive);
  return files;
}

/** Writes the pinned plugin into `dest`, replacing what was there. */
export async function vendorSubscriptionPlugin(dest, options) {
  const files = await subscriptionPluginFiles(options);
  rmSync(dest, { recursive: true, force: true });
  for (const { path, data } of files) {
    mkdirSync(dirname(join(dest, path)), { recursive: true });
    writeFileSync(join(dest, path), data);
  }
  return pluginDigest(files);
}

/** Why a server package's entries do not carry exactly the pinned plugin under dist/subscription-plugin/; empty when they do. */
export function subscriptionPluginProblems(entries, expected = SUBSCRIPTION_PLUGIN_SHA256) {
  const prefix = `dist/${PLUGIN_DIR}/`;
  const files = entries.filter((entry) => entry.path.startsWith(prefix)).map((entry) => ({ path: entry.path.slice(prefix.length), data: entry.data }));
  if (files.length === 0) return [`no ${prefix}`];
  const problems = [];
  if (!files.some((file) => file.path === 'LICENSE')) problems.push(`no ${prefix}LICENSE`);
  const digest = pluginDigest(files);
  if (digest !== expected) problems.push(`${prefix} has digest ${digest}, not the pinned ${expected}`);
  return problems;
}

if (isEntryPoint(import.meta.url)) {
  const dest = process.argv[2] ?? join(ROOT, 'dist', PLUGIN_DIR);
  vendorSubscriptionPlugin(dest).then(
    (digest) => console.log(`${dest}: pi-anthropic-auth ${SUBSCRIPTION_COMMIT}, digest ${digest}`),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
