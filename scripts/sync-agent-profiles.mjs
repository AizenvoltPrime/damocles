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
  'game-development',
]);

// Divisions mirrored only in part: division -> the exact slugs that may cross. A division listed
// here is tracked, but every slug outside its set is treated as denylisted (never copied, deleted by
// --prune). This is the right tool when a large division holds a few relevant agents — a denylist
// would need an entry per rejection AND would silently admit whatever upstream adds next.
//
// `game-development` holds 20 agents across 5 engine subdirectories; only these 5 are engine-neutral
// or otherwise applicable. The three Godot agents are deliberately absent: godot-gameplay-scripter
// mandates a signal-bus autoload and GDScript static-typing rules that contradict this project's
// composition root, godot-multiplayer-engineer has no prediction/reconciliation content at all, and
// godot-shader-developer targets a rendering surface no tracked project uses.
//
// Mirrored from ~/.claude/scripts/sync-claude-agents.mjs — edit both together.
const DIVISION_ALLOWLIST = new Map([
  [
    'game-development',
    new Set([
      'blender-addon-engineer',
      'game-audio-engineer',
      'game-designer',
      'level-designer',
      'technical-artist',
    ]),
  ],
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
  // Government / public-sector compliance verticals
  'engineering-section-508-specialist',
  'engineering-uswds-developer',
  'specialized-fedramp-rmf-compliance',
  // Infrastructure and platform domains outside this stack
  'engineering-api-platform-engineer',
  'engineering-database-reliability-engineer',
  'engineering-finops-engineer',
  'engineering-gaussdb-expert',
  'engineering-identity-access-engineer',
  'engineering-iot-fleet-engineer',
  'engineering-network-engineer',
  'engineering-payments-billing-engineer',
  'engineering-privacy-engineer',
  'engineering-search-relevance-engineer',
  'engineering-video-streaming-engineer',
  'engineering-webassembly-engineer',
  // ML/AI specialisms not used here
  'engineering-llm-post-training-engineer',
  'engineering-rag-pipeline-engineer',
  // Language/CMS specialisms not used here
  'engineering-drupal-performance',
  'engineering-rust-refactoring-specialist',
  'engineering-wordpress-performance',
  // Adjacent but redundant against agents already tracked
  'design-ui-finish-gate-reviewer',
  'engineering-data-visualization-engineer',
  'engineering-mobile-release-engineer',
  // Non-software verticals that landed in `specialized`
  'healthcare-aging-parent-care-companion',
  'resume-tailor',
]);

/** Strip the .md extension from a basename to get the agent slug. */
function slugOf(relPath) {
  return path.basename(relPath, '.md');
}

/**
 * True when a tracked-division file must not cross: either its slug is on the permanent denylist, or
 * its division is partially mirrored and the slug is not in that division's allowlist.
 */
function isDenied(relPath) {
  if (EXCLUDE.has(slugOf(relPath))) return true;
  const allowed = DIVISION_ALLOWLIST.get(relPath.split('/')[0]);
  return allowed ? !allowed.has(slugOf(relPath)) : false;
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
      '  --apply      Copy NEW and CHANGED tracked files into agent-profiles/. Denied slugs are skipped.',
      '  --prune      With --apply, also delete PROFILES-ONLY + EXCLUDED files.',
      '  --source=DIR Upstream catalog path (default env AGENCY_AGENTS_DIR or ' + DEFAULT_SOURCE + ').',
      '',
      'A file crosses only if its division is in TRACKED_DIVISIONS, its slug is not in EXCLUDE, and — for',
      'a division listed in DIVISION_ALLOWLIST (a partial mirror) — its slug is in that allowlist.',
      'Subdirectories are flattened to <division>/<slug>.md; two files claiming one destination is an error.',
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

/**
 * Destination path for an upstream file: always `<division>/<slug>.md`. Some divisions nest agents
 * in engine subdirectories upstream (game-development/blender/…) while every mirrored division is
 * flat here, so the subdirectory is dropped rather than reproduced.
 */
function destPathOf(relPath) {
  return `${relPath.split('/')[0]}/${path.basename(relPath)}`;
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

  // Upstream tracked profiles, before applying the denylist (destination relPath -> source absPath).
  // Flattening subdirectories means two upstream files can claim one destination; that must abort the
  // run rather than let Map.set silently keep whichever was walked last. Upstream already ships
  // game-development/technical-artist.md alongside unreal-engine/unreal-technical-artist.md, so the
  // margin here is a single upstream rename.
  const upstreamAll = new Map();
  const claimedBy = new Map();
  for (const rel of collectMdFiles(sourceDir)) {
    const abs = path.join(sourceDir, rel);
    if (!isTrackedProfile(abs, rel)) continue;
    const dest = destPathOf(rel);
    const prior = claimedBy.get(dest);
    if (prior !== undefined) {
      console.error(`ERROR: two upstream files map to the same profile path: ${dest}`);
      console.error(`  ${prior}`);
      console.error(`  ${rel}`);
      console.error('Flattened destinations must be unique. Rename one upstream, or add one to EXCLUDE.');
      process.exit(1);
    }
    claimedBy.set(dest, rel);
    upstreamAll.set(dest, abs);
  }
  // Tracked upstream = everything the denylist and the per-division allowlists permit.
  const upstream = new Map([...upstreamAll].filter(([rel]) => !isDenied(rel)));

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
  // Local files the denylist or a division allowlist rejects — removed with --prune so they stay out.
  const excluded = [...local.keys()].filter(rel => isDenied(rel));
  // Local files gone upstream for other reasons (moved/renamed), excluding denied ones.
  const profilesOnly = [...local.keys()].filter(rel => !upstreamAll.has(rel) && !isDenied(rel));

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
  list('EXCLUDED (local, denylisted or outside a division allowlist)', excluded);

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
