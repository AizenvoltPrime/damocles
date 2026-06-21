/**
 * sync-agent-profiles.mjs — Report (and optionally apply) diffs from the upstream agency-agents
 * catalog into this repo's curated `agent-profiles/` subset.
 *
 * Default behavior is REPORT ONLY — it never writes. Use `--apply` to copy NEW/CHANGED tracked files
 * into `agent-profiles/`, and `--prune` to additionally delete PROFILES-ONLY files that no longer
 * exist upstream. After applying, run `npm run generate:profiles` and commit the regenerated catalog.
 *
 * Source path: --source=<dir> flag, else AGENCY_AGENTS_DIR env, else a sibling `../agency-agents`
 * checkout (resolved relative to the repo root, not the current working directory).
 *
 * Usage:
 *   node scripts/sync-agent-profiles.mjs                 # report only
 *   node scripts/sync-agent-profiles.mjs --apply         # copy NEW + CHANGED
 *   node scripts/sync-agent-profiles.mjs --apply --prune # also delete PROFILES-ONLY
 *   node scripts/sync-agent-profiles.mjs --source=/path/to/agency-agents
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

// Anchor every path to the repo root (not process.cwd()), so `--apply --prune` always writes to THIS
// repo's agent-profiles/ regardless of the directory the script is invoked from.
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILES_DIR = path.join(REPO_ROOT, 'agent-profiles');

// Default to a sibling checkout (../agency-agents) so any contributor who clones both repos side by
// side works with no flag; override with --source=<dir> or AGENCY_AGENTS_DIR for other layouts.
const DEFAULT_SOURCE = path.join(REPO_ROOT, '..', 'agency-agents');

// Divisions we mirror from agency. finance/gis are intentionally excluded — add an entry to track one.
const TRACKED_DIVISIONS = new Set([
  'academic',
  'design',
  'engineering',
  'game-development',
  'marketing',
  'paid-media',
  'product',
  'project-management',
  'sales',
  'security',
  'spatial-computing',
  'specialized',
  'support',
  'testing',
]);

function parseArgs(argv) {
  const opts = { apply: false, prune: false, source: process.env.AGENCY_AGENTS_DIR || DEFAULT_SOURCE };
  for (const arg of argv) {
    if (arg === '--apply') opts.apply = true;
    else if (arg === '--prune') opts.prune = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--source=')) opts.source = arg.slice('--source='.length);
    else {
      console.error(`Unknown argument: ${arg}`);
      opts.help = true;
    }
  }
  return opts;
}

function printHelp() {
  console.log(
    [
      'sync-agent-profiles — mirror tracked agency-agents divisions into agent-profiles/',
      '',
      'Usage: node scripts/sync-agent-profiles.mjs [--apply] [--prune] [--source=<dir>]',
      '',
      '  (no flags)   Report NEW / CHANGED / PROFILES-ONLY. Makes zero file changes.',
      '  --apply      Copy NEW and CHANGED tracked files into agent-profiles/.',
      '  --prune      With --apply, also delete PROFILES-ONLY files (removed upstream).',
      '  --source=DIR Upstream catalog path (default env AGENCY_AGENTS_DIR or ' + DEFAULT_SOURCE + ').',
      '',
      'After --apply, run `npm run generate:profiles` and commit the regenerated catalog.',
    ].join('\n'),
  );
}

/** Recursively collect .md files under dir, returning paths relative to dir (forward-slashed). */
function collectMdFiles(dir, baseDir = dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMdFiles(full, baseDir));
    } else if (entry.name.endsWith('.md')) {
      results.push(path.relative(baseDir, full).split(path.sep).join('/'));
    }
  }
  return results;
}

/** A file is a profile candidate only if it lives in a tracked division and has `name:` frontmatter. */
function isTrackedProfile(absPath, relPath) {
  const division = relPath.split('/')[0];
  if (!TRACKED_DIVISIONS.has(division)) return false;
  const raw = fs.readFileSync(absPath, 'utf-8');
  if (!raw.startsWith('---')) return false;
  try {
    return Boolean(matter(raw).data.name);
  } catch {
    return false;
  }
}

/** Normalize line endings so CRLF/LF differences don't register as content changes. */
function normalize(text) {
  return text.replace(/\r\n/g, '\n');
}

function sameContent(a, b) {
  return normalize(fs.readFileSync(a, 'utf-8')) === normalize(fs.readFileSync(b, 'utf-8'));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  const sourceDir = path.resolve(opts.source);
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    console.error(`ERROR: agency-agents source not found: ${sourceDir}`);
    console.error('Pass --source=<dir> or set AGENCY_AGENTS_DIR to the agency-agents checkout.');
    process.exit(1);
  }

  // Upstream tracked profiles (relPath -> absPath).
  const upstream = new Map();
  for (const rel of collectMdFiles(sourceDir)) {
    const abs = path.join(sourceDir, rel);
    if (isTrackedProfile(abs, rel)) upstream.set(rel, abs);
  }

  // Local profiles in tracked divisions (relPath -> absPath).
  const local = new Map();
  if (fs.existsSync(PROFILES_DIR)) {
    for (const rel of collectMdFiles(PROFILES_DIR)) {
      if (TRACKED_DIVISIONS.has(rel.split('/')[0])) local.set(rel, path.join(PROFILES_DIR, rel));
    }
  }

  const added = [];
  const changed = [];
  for (const [rel, abs] of upstream) {
    if (!local.has(rel)) added.push(rel);
    else if (!sameContent(abs, local.get(rel))) changed.push(rel);
  }
  const profilesOnly = [...local.keys()].filter(rel => !upstream.has(rel));

  added.sort();
  changed.sort();
  profilesOnly.sort();

  console.log(`Source:   ${sourceDir}`);
  console.log(`Profiles: ${PROFILES_DIR}`);
  console.log(`Tracked divisions: ${[...TRACKED_DIVISIONS].sort().join(', ')}\n`);

  const list = (label, items) => {
    console.log(`${label} (${items.length})`);
    for (const rel of items) console.log(`  ${rel}`);
    console.log('');
  };
  list('NEW (in agency, not in profiles)', added);
  list('CHANGED (content differs)', changed);
  list('PROFILES-ONLY (not in agency)', profilesOnly);

  if (!opts.apply) {
    console.log('Report only. Re-run with --apply to copy NEW + CHANGED into agent-profiles/.');
    return;
  }

  let written = 0;
  for (const rel of [...added, ...changed]) {
    const dest = path.join(PROFILES_DIR, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(upstream.get(rel), dest);
    written++;
  }
  console.log(`Applied: ${written} file(s) copied (${added.length} new, ${changed.length} changed).`);

  if (opts.prune) {
    let pruned = 0;
    for (const rel of profilesOnly) {
      fs.rmSync(path.join(PROFILES_DIR, rel));
      pruned++;
    }
    console.log(`Pruned: ${pruned} PROFILES-ONLY file(s) deleted.`);
  }

  console.log('\nNext: run `npm run generate:profiles` and commit the regenerated catalog.');
}

try {
  main();
} catch (err) {
  console.error('ERROR: sync failed:', err.message);
  process.exit(1);
}
