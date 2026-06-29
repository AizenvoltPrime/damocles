/**
 * sync-agent-profiles.mjs — Report (and optionally apply) diffs from the upstream agency-agents
 * catalog into this repo's curated `agent-profiles/` subset.
 *
 * Default behavior is REPORT ONLY — it never writes. Use `--apply` to copy NEW/CHANGED tracked files
 * into `agent-profiles/`, and `--prune` to additionally delete PROFILES-ONLY files (gone upstream)
 * plus EXCLUDED files (on the denylist). After applying, run `npm run generate:profiles` and commit
 * the regenerated catalog.
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

// Divisions we mirror from agency. This set is the policy mirror of DEFAULT_DIVISIONS in
// ~/.claude/scripts/sync-claude-agents.mjs — the script that governs ~/.claude/agents. The two live
// in separate repos and cannot share state; edit them together. The committed catalog regression
// test (src/extension/team/__tests__/agent-profiles.generated.test.ts) is the enforcement that
// catches drift.
const TRACKED_DIVISIONS = new Set([
  'engineering',
  'design',
  'testing',
  'specialized',
  'security',
  'product',
  'project-management',
]);

// Permanently excluded agent slugs (filename without .md). The mirror never copies these, and with
// --prune it deletes any that exist locally — so non-software/business verticals stay out across syncs.
// All currently resolve to the `specialized` division.
//
// Mirrored from ~/.claude/scripts/sync-claude-agents.mjs. The two lists live in separate repos and
// cannot share state — they must be edited together. The committed catalog regression test
// (src/extension/team/__tests__/agent-profiles.generated.test.ts) is the enforcement that catches
// drift.
const EXCLUDE = new Set([
  // Non-software business verticals
  'accounts-payable-agent',
  'business-strategist',
  'change-management-consultant',
  'chief-financial-officer',
  'corporate-training-designer',
  'customer-service',
  'customer-success-manager',
  'data-consolidation-agent',
  'data-privacy-officer',
  'esg-sustainability-officer',
  'government-digital-presales-consultant',
  'grant-writer',
  'healthcare-customer-service',
  'healthcare-marketing-compliance',
  'hospitality-guest-services',
  'hr-onboarding',
  'language-translator',
  'legal-billing-time-tracking',
  'legal-client-intake',
  'legal-document-review',
  'loan-officer-assistant',
  'ma-integration-manager',
  'medical-billing-coding-specialist',
  'operations-manager',
  'organizational-psychologist',
  'personal-growth-mentor',
  'real-estate-buyer-seller',
  'recruitment-specialist',
  'report-distribution-agent',
  'retail-customer-returns',
  'sales-data-extraction-agent',
  'sales-outreach',
  'specialized-cultural-intelligence-strategist',
  'specialized-french-consulting-market',
  'specialized-korean-business-navigator',
  'study-abroad-advisor',
  'supply-chain-strategist',
  // Additional non-software / out-of-scope specialists
  'automation-governance-architect',
  'zk-steward',
  'specialized-strategy-duel-agent',
  'specialized-civil-engineer',
  'specialized-chief-of-staff',
  'specialized-developer-advocate',
  'identity-graph-operator',
  'agentic-identity-trust',
  'lsp-index-engineer',
]);

/** Strip the .md extension from a basename to get the agent slug. */
function slugOf(relPath) {
  return path.basename(relPath, '.md');
}

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
      '  (no flags)   Report NEW / CHANGED / PROFILES-ONLY / EXCLUDED. Makes zero file changes.',
      '  --apply      Copy NEW and CHANGED tracked files into agent-profiles/. Denylisted slugs are skipped.',
      '  --prune      With --apply, also delete PROFILES-ONLY + EXCLUDED files.',
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

  // Upstream tracked profiles, before applying the denylist (relPath -> absPath).
  const upstreamAll = new Map();
  for (const rel of collectMdFiles(sourceDir)) {
    const abs = path.join(sourceDir, rel);
    if (isTrackedProfile(abs, rel)) upstreamAll.set(rel, abs);
  }
  // Tracked upstream = everything except the permanent denylist.
  const upstream = new Map([...upstreamAll].filter(([rel]) => !EXCLUDE.has(slugOf(rel))));

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
  // Local files on the denylist — removed with --prune so excluded profiles stay out.
  const excluded = [...local.keys()].filter(rel => EXCLUDE.has(slugOf(rel)));
  // Local files gone upstream for other reasons (moved/renamed), excluding denylisted ones.
  const profilesOnly = [...local.keys()].filter(
    rel => !upstreamAll.has(rel) && !EXCLUDE.has(slugOf(rel)),
  );

  added.sort();
  changed.sort();
  excluded.sort();
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
  list('EXCLUDED (local, on denylist)', excluded);

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
    for (const rel of [...profilesOnly, ...excluded]) {
      fs.rmSync(path.join(PROFILES_DIR, rel));
      pruned++;
    }
    console.log(`Pruned: ${pruned} PROFILES-ONLY + EXCLUDED file(s) deleted.`);
  }

  console.log('\nNext: run `npm run generate:profiles` and commit the regenerated catalog.');
}

try {
  main();
} catch (err) {
  console.error('ERROR: sync failed:', err.message);
  process.exit(1);
}
