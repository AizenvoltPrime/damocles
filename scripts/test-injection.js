/**
 * Standalone test script for the injection manager's FTS5 prompt-aware ranking.
 *
 * Initializes an in-memory WASM SQLite database with the same schema as production,
 * inserts test memories, and verifies FTS5 scoring, normalization, budget selection,
 * and fallback behavior.
 *
 * Usage: node scripts/test-injection.js
 */

const path = require('path');
const fs = require('fs');

// ─── Pure functions copied from injection-manager.ts ────────────────────────

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function memoryMentionsFile(memory, activeFile) {
  const normalizedActive = activeFile.replace(/\\/g, '/').toLowerCase();
  const fileName = normalizedActive.split('/').pop() ?? '';
  const checkFields = [memory.content, ...(memory.filesRead ?? []), ...(memory.filesModified ?? [])];
  return checkFields.some(field => {
    const normalized = field.replace(/\\/g, '/').toLowerCase();
    return normalized.includes(fileName) || normalized.includes(normalizedActive);
  });
}

const TIER_WEIGHT = { session: 1.0, project: 0.8, global: 0.6, observation: 0.5, note: 0.3 };

function scoreMemoryFallback(memory, activeFile) {
  const recency = 1 / (1 + (Date.now() - memory.updatedAt) / (24 * 60 * 60 * 1000));
  const fileProximity = activeFile && memoryMentionsFile(memory, activeFile) ? 1 : 0;
  const weight = TIER_WEIGHT[memory.tier];
  const accessBoost = Math.min((memory.accessCount ?? 0) / 10, 0.5);
  return fileProximity * 0.4 + recency * 0.3 + weight * 0.2 + accessBoost * 0.1;
}

function scoreMemoryWithPrompt(memory, ftsScores, activeFile) {
  const ftsRelevance = ftsScores.get(memory.id) ?? 0;
  const recency = 1 / (1 + (Date.now() - memory.updatedAt) / (24 * 60 * 60 * 1000));
  const fileProximity = activeFile && memoryMentionsFile(memory, activeFile) ? 1 : 0;
  const weight = TIER_WEIGHT[memory.tier];
  const accessBoost = Math.min((memory.accessCount ?? 0) / 10, 0.5);
  return ftsRelevance * 0.4 + recency * 0.25 + weight * 0.15 + fileProximity * 0.1 + accessBoost * 0.1;
}

function formatMemoryEntry(m) {
  if (m.tier === 'observation' && m.title) {
    const files = [...(m.filesRead ?? []), ...(m.filesModified ?? [])];
    const fileHint = files.length > 0 ? ` (${files.slice(0, 2).join(', ')})` : '';
    return `- [${m.id}] ${m.title}${fileHint}`;
  }
  return `- ${m.content}`;
}

function normalizeForTier(memories, rawRanks) {
  const tierIds = new Set(memories.map(m => m.id));
  let min = Infinity, max = -Infinity;
  for (const [id, rank] of rawRanks) {
    if (!tierIds.has(id)) continue;
    if (rank < min) min = rank;
    if (rank > max) max = rank;
  }
  if (min === Infinity) return null;
  const range = max - min;
  const normalized = new Map();
  for (const [id, rank] of rawRanks) {
    if (!tierIds.has(id)) continue;
    normalized.set(id, range > 0 ? (rank - min) / range : 1);
  }
  return normalized;
}

function selectByBudget(memories, budget, activeFile, rawFtsRanks) {
  const ftsScores = rawFtsRanks ? normalizeForTier(memories, rawFtsRanks) : null;
  const scored = memories.map(m => ({
    memory: m,
    score: ftsScores ? scoreMemoryWithPrompt(m, ftsScores, activeFile) : scoreMemoryFallback(m, activeFile),
  }));
  scored.sort((a, b) => b.score - a.score);
  const selected = [];
  let tokens = 0;
  for (const { memory } of scored) {
    const cost = estimateTokens(formatMemoryEntry(memory));
    if (tokens + cost > budget) break;
    selected.push(memory);
    tokens += cost;
  }
  return selected;
}

const STOPWORDS = new Set([
  'the', 'be', 'to', 'of', 'and', 'in', 'that', 'have', 'it', 'for',
  'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at', 'this', 'but',
  'his', 'by', 'from', 'they', 'we', 'her', 'she', 'or', 'an', 'will',
  'my', 'one', 'all', 'would', 'there', 'their', 'what', 'so', 'up',
  'if', 'about', 'who', 'get', 'which', 'go', 'me', 'when', 'make',
  'can', 'like', 'no', 'just', 'him', 'know', 'take', 'into', 'your',
  'some', 'could', 'them', 'see', 'other', 'than', 'then', 'now', 'its',
  'also', 'after', 'how', 'our', 'two', 'way', 'did', 'has', 'am', 'is',
  'are', 'was', 'were', 'been', 'being', 'had', 'does', 'done', 'should',
  'help', 'please', 'want', 'need',
]);

function buildFtsQuery(prompt) {
  const tokens = prompt.trim().toLowerCase().split(/\s+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t))
    .map(t => t.replace(/[*^]/g, ''))
    .filter(t => t.length > 0)
    .slice(0, 16);
  if (tokens.length === 0) return null;
  return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

function queryFtsRanks(db, userPrompt) {
  if (!userPrompt) return null;
  const ftsQuery = buildFtsQuery(userPrompt);
  if (!ftsQuery) return null;

  const rows = db.prepare(`
    SELECT m.id, fts.rank
    FROM memories_fts fts
    JOIN memories m ON m.rowid = fts.rowid
    WHERE memories_fts MATCH ?
  `).all(ftsQuery);

  if (rows.length === 0) return null;

  const ranks = new Map();
  for (const row of rows) {
    ranks.set(row.id, Math.abs(row.rank));
  }
  return ranks;
}

// ─── Database setup ─────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  tier TEXT NOT NULL CHECK (tier IN ('session', 'project', 'global', 'note', 'observation')),
  content TEXT NOT NULL,
  session_id TEXT,
  workspace TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  observation_type TEXT,
  title TEXT,
  facts TEXT DEFAULT '[]',
  observation_tags TEXT DEFAULT '[]',
  files_read TEXT DEFAULT '[]',
  files_modified TEXT DEFAULT '[]',
  access_count INTEGER DEFAULT 0
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content, title, tags, facts, observation_tags, files_read, files_modified,
  content=memories, content_rowid=rowid,
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, title, tags, facts, observation_tags, files_read, files_modified)
  VALUES (NEW.rowid, NEW.content, NEW.title, NEW.tags, NEW.facts, NEW.observation_tags, NEW.files_read, NEW.files_modified);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, title, tags, facts, observation_tags, files_read, files_modified)
  VALUES ('delete', OLD.rowid, OLD.content, OLD.title, OLD.tags, OLD.facts, OLD.observation_tags, OLD.files_read, OLD.files_modified);
  INSERT INTO memories_fts(rowid, content, title, tags, facts, observation_tags, files_read, files_modified)
  VALUES (NEW.rowid, NEW.content, NEW.title, NEW.tags, NEW.facts, NEW.observation_tags, NEW.files_read, NEW.files_modified);
END;
`;

function createDbWrapper(sqlDb) {
  return {
    prepare(sql) {
      return {
        run(...params) {
          sqlDb.run(sql, params);
          return { changes: sqlDb.getRowsModified() };
        },
        get(...params) {
          const stmt = sqlDb.prepare(sql);
          try {
            if (params.length) stmt.bind(params);
            if (stmt.step()) return stmt.getAsObject();
            return undefined;
          } finally { stmt.free(); }
        },
        all(...params) {
          const stmt = sqlDb.prepare(sql);
          try {
            if (params.length) stmt.bind(params);
            const results = [];
            while (stmt.step()) results.push(stmt.getAsObject());
            return results;
          } finally { stmt.free(); }
        },
      };
    },
    exec(sql) { sqlDb.exec(sql); },
  };
}

// ─── Test data ──────────────────────────────────────────────────────────────

const now = Date.now();
const DAY = 24 * 60 * 60 * 1000;

const PROJECT_MEMORIES = [
  {
    id: 'mem-jwt', tier: 'project', title: null,
    content: 'JWT tokens expire after 1 hour. Refresh logic lives in auth-service.ts with sliding window.',
    workspace: '/test/workspace', session_id: null,
    files_read: '["src/auth-service.ts"]', files_modified: '["src/auth-service.ts"]',
    created_at: now - 3 * DAY, updated_at: now - 3 * DAY,
  },
  {
    id: 'mem-knex', tier: 'project', title: null,
    content: 'Database uses Knex with PostgreSQL. Migrations are in db/migrations/ directory.',
    workspace: '/test/workspace', session_id: null,
    files_read: '["db/migrations/001_init.ts"]', files_modified: '[]',
    created_at: now - 2 * DAY, updated_at: now - 2 * DAY,
  },
  {
    id: 'mem-css', tier: 'project', title: null,
    content: 'Renamed CSS class from .header-old to .header-main in the navigation component.',
    workspace: '/test/workspace', session_id: null,
    files_read: '[]', files_modified: '["src/components/header.vue"]',
    created_at: now - 1000, updated_at: now - 1000,
  },
  {
    id: 'mem-vitest', tier: 'project', title: null,
    content: 'Unit tests use vitest with coverage threshold set to 80 percent.',
    workspace: '/test/workspace', session_id: null,
    files_read: '["vitest.config.ts"]', files_modified: '[]',
    created_at: now - 1 * DAY, updated_at: now - 1 * DAY,
  },
];

const OBSERVATION_MEMORY = {
  id: 'obs-auth', tier: 'observation', title: 'Fixed authentication token refresh race condition',
  content: 'Resolved a race condition where concurrent API calls could trigger multiple token refreshes simultaneously. Added a mutex lock around the refresh flow in auth-service.ts to serialize refresh attempts. The fix prevents duplicate refresh requests and token invalidation cascades.',
  workspace: '/test/workspace', session_id: 'session-1',
  observation_type: 'fix',
  files_read: '["src/auth-service.ts","src/api-client.ts"]',
  files_modified: '["src/auth-service.ts"]',
  facts: '["race condition in concurrent refresh","mutex lock serializes refreshes","prevents token invalidation cascade"]',
  observation_tags: '["mechanism","fix","caveat"]',
  created_at: now - 2 * DAY, updated_at: now - 2 * DAY,
};

function insertMemory(db, mem) {
  db.prepare(`
    INSERT INTO memories (id, tier, content, session_id, workspace, created_at, updated_at, tags,
      observation_type, title, facts, observation_tags, files_read, files_modified, access_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    mem.id, mem.tier, mem.content, mem.session_id ?? null, mem.workspace ?? null,
    mem.created_at, mem.updated_at, mem.tags ?? '[]',
    mem.observation_type ?? null, mem.title ?? null,
    mem.facts ?? '[]', mem.observation_tags ?? '[]',
    mem.files_read ?? '[]', mem.files_modified ?? '[]',
    mem.access_count ?? 0,
  );
}

function toMemoryEntry(mem) {
  return {
    id: mem.id,
    tier: mem.tier,
    content: mem.content,
    sessionId: mem.session_id,
    workspace: mem.workspace,
    createdAt: mem.created_at,
    updatedAt: mem.updated_at,
    tags: JSON.parse(mem.tags ?? '[]'),
    accessCount: mem.access_count ?? 0,
    ...(mem.title ? { title: mem.title } : {}),
    ...(mem.files_read && mem.files_read !== '[]' ? { filesRead: JSON.parse(mem.files_read) } : {}),
    ...(mem.files_modified && mem.files_modified !== '[]' ? { filesModified: JSON.parse(mem.files_modified) } : {}),
    ...(mem.observation_type ? { observationType: mem.observation_type } : {}),
  };
}

// ─── Test runner ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${message}`);
  } else {
    failed++;
    console.log(`  FAIL  ${message}`);
  }
}

function assertClose(a, b, tolerance, message) {
  assert(Math.abs(a - b) < tolerance, `${message} (got ${a.toFixed(4)}, expected ~${b.toFixed(4)})`);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n=== Injection Manager FTS5 Ranking Tests ===\n');

  // ── Initialize WASM SQLite ──
  const wasmPath = path.join(__dirname, '..', 'node_modules', 'sql.js-fts5', 'dist', 'sql-wasm.wasm');
  if (!fs.existsSync(wasmPath)) {
    console.error('ERROR: sql-wasm.wasm not found at', wasmPath);
    console.error('Run "npm install" first.');
    process.exit(1);
  }

  const wasmBinary = fs.readFileSync(wasmPath);
  const initSqlJs = require('sql.js-fts5');
  const SQL = await initSqlJs({ wasmBinary });
  const sqlDb = new SQL.Database();
  const db = createDbWrapper(sqlDb);

  db.exec(SCHEMA);

  // Insert only project memories first (observations added later to avoid normalization skew)
  for (const mem of PROJECT_MEMORIES) insertMemory(db, mem);

  const projectEntries = PROJECT_MEMORIES.map(toMemoryEntry);

  // ── 1. buildFtsQuery ──
  console.log('--- buildFtsQuery ---');

  assert(buildFtsQuery('hello') === '"hello"', 'single word produces quoted term');
  assert(buildFtsQuery('fix auth bug') === '"fix" OR "auth" OR "bug"', 'multiple words joined with OR');
  assert(buildFtsQuery('help me please') === null, 'all stopwords returns null');
  assert(buildFtsQuery('   ') === null, 'whitespace-only returns null');
  assert(buildFtsQuery('a b c') === null, 'single-char tokens filtered out');
  assert(buildFtsQuery('the be to of and') === null, 'common stopwords all filtered');

  const longPrompt = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
  const longResult = buildFtsQuery(longPrompt);
  const longTokenCount = longResult.split(' OR ').length;
  assert(longTokenCount === 16, `token cap at 16 (got ${longTokenCount})`);

  const quoteResult = buildFtsQuery('test "quoted" value');
  assert(quoteResult.includes('""quoted""'), 'double quotes escaped to doubled quotes in FTS5 phrase');

  assert(buildFtsQuery('auth*') === '"auth"', 'FTS5 prefix operator * stripped from token');
  assert(buildFtsQuery('^start') === '"start"', 'FTS5 positional operator ^ stripped from token');
  assert(buildFtsQuery('** ^^') === null, 'tokens that become empty after stripping are filtered');

  // ── 2. FTS5 query + raw BM25 ranks (project memories only) ──
  console.log('\n--- FTS5 query + raw ranks ---');

  const authRanks = queryFtsRanks(db, 'fix the authentication token expiry bug');
  assert(authRanks !== null, 'auth prompt returns FTS ranks');
  assert(authRanks.has('mem-jwt'), 'JWT memory matched for auth prompt');

  const jwtRank = authRanks.get('mem-jwt') ?? 0;
  assert(jwtRank > 0, `JWT memory has positive raw rank for auth prompt (got ${jwtRank.toFixed(3)})`);

  const dbRanks = queryFtsRanks(db, 'update the database schema migrations');
  assert(dbRanks !== null, 'database prompt returns FTS ranks');
  assert(dbRanks.has('mem-knex'), 'Knex memory matched for database prompt');

  const knexRank = dbRanks.get('mem-knex') ?? 0;
  assert(knexRank > 0, `Knex memory has positive raw rank for database prompt (got ${knexRank.toFixed(3)})`);

  // ── 3. Per-tier normalization: single match normalizes to 1.0 ──
  console.log('\n--- Per-tier normalization ---');

  const cssRanks = queryFtsRanks(db, 'CSS navigation component');
  assert(cssRanks !== null, 'CSS prompt returns FTS ranks');
  assert(cssRanks.has('mem-css'), 'CSS memory matched for CSS prompt');
  const cssNormalized = normalizeForTier(projectEntries, cssRanks);
  if (cssNormalized && cssNormalized.size === 1) {
    const singleScore = [...cssNormalized.values()][0];
    assertClose(singleScore, 1.0, 0.001, 'single tier match normalizes to 1.0');
  } else {
    assert(cssNormalized !== null, 'normalizeForTier returns scores for CSS match');
  }

  // ── 4. Fallback when no FTS match ──
  console.log('\n--- Fallback scoring ---');

  const fallbackRanks = queryFtsRanks(db, 'hello there');
  assert(fallbackRanks === null, 'generic greeting returns null (fallback)');

  const allStopwords = queryFtsRanks(db, 'help me please do it for me');
  assert(allStopwords === null, 'all-stopword prompt returns null (fallback)');

  const emptyPrompt = queryFtsRanks(db, undefined);
  assert(emptyPrompt === null, 'undefined prompt returns null');

  // ── 5. Ranking differs by prompt ──
  console.log('\n--- Prompt-dependent ranking ---');

  const authSelected = selectByBudget(projectEntries, 500, null, authRanks);
  const dbSelected = selectByBudget(projectEntries, 500, null, dbRanks);

  assert(authSelected.length > 0, 'auth prompt selects memories');
  assert(dbSelected.length > 0, 'database prompt selects memories');
  assert(authSelected[0].id === 'mem-jwt', `auth prompt ranks JWT first (got ${authSelected[0].id})`);
  assert(dbSelected[0].id === 'mem-knex', `database prompt ranks Knex first (got ${dbSelected[0].id})`);

  // ── 6. Fallback uses recency ──
  console.log('\n--- Fallback prefers recency ---');

  const fallbackSelected = selectByBudget(projectEntries, 500, null, null);
  assert(fallbackSelected.length > 0, 'fallback selects memories');
  assert(fallbackSelected[0].id === 'mem-css', `fallback ranks most recent first (got ${fallbackSelected[0].id})`);

  // ── 7. File proximity as tiebreaker ──
  console.log('\n--- File proximity tiebreaker ---');

  const activeFile = 'src/auth-service.ts';
  const authWithFile = selectByBudget(projectEntries, 500, activeFile, authRanks);
  assert(authWithFile[0].id === 'mem-jwt', `auth + file context still ranks JWT first (got ${authWithFile[0].id})`);

  const noFtsWithFile = selectByBudget(projectEntries, 500, activeFile, null);
  assert(noFtsWithFile[0].id === 'mem-jwt', `fallback with auth file open ranks JWT first (got ${noFtsWithFile[0].id})`);

  // ── 8. Budget estimation uses rendered output ──
  console.log('\n--- Budget estimation accuracy ---');

  const obsEntry = toMemoryEntry(OBSERVATION_MEMORY);
  const rendered = formatMemoryEntry(obsEntry);
  const renderedCost = estimateTokens(rendered);
  const contentCost = estimateTokens(obsEntry.content);

  assert(rendered.startsWith('- [obs-auth]'), 'observation renders ID + title, not content');
  assert(renderedCost < contentCost, `rendered cost (${renderedCost}) < content cost (${contentCost})`);
  assert(!rendered.includes('mutex lock'), 'rendered output does not contain narrative detail');

  // ── 9. Budget constraint respected ──
  console.log('\n--- Budget constraint ---');

  const tinyBudget = selectByBudget(projectEntries, 10, null, authRanks);
  assert(tinyBudget.length <= 1, `tiny budget (10 tokens) limits selection (got ${tinyBudget.length})`);

  const zeroBudget = selectByBudget(projectEntries, 0, null, authRanks);
  assert(zeroBudget.length === 0, 'zero budget selects nothing');

  // ── 10. Observation budget not starved by verbose content ──
  console.log('\n--- Observation budget not inflated by content ---');

  const obsSelected = selectByBudget([obsEntry], 100, null, null);
  assert(obsSelected.length > 0, `observation selected within 100-token budget (rendered ~${renderedCost} tokens)`);

  // ── 11. Insert observation, test porter stemming across tiers ──
  console.log('\n--- Porter stemming ---');

  insertMemory(db, OBSERVATION_MEMORY);

  const stemRanks = queryFtsRanks(db, 'authenticating tokens');
  if (stemRanks) {
    assert(stemRanks.has('mem-jwt') || stemRanks.has('obs-auth'),
      'porter stemming matches "authenticating" to "authentication"');
  } else {
    assert(false, 'porter stemming should match "authenticating" to "authentication"');
  }

  // ── 12. Per-tier normalization prevents cross-tier skew ──
  console.log('\n--- Per-tier normalization prevents skew ---');

  const crossTierRanks = queryFtsRanks(db, 'fix authentication token');
  assert(crossTierRanks !== null, 'cross-tier auth prompt returns ranks');

  const obsEntryForTier = toMemoryEntry(OBSERVATION_MEMORY);
  const projectNorm = normalizeForTier(projectEntries, crossTierRanks);
  const obsNorm = normalizeForTier([obsEntryForTier], crossTierRanks);

  assert(projectNorm !== null, 'project tier has FTS matches');
  assert(obsNorm !== null, 'observation tier has FTS matches');

  const jwtInProject = projectNorm.get('mem-jwt') ?? 0;
  const obsInObsTier = obsNorm.get('obs-auth') ?? 0;

  assert(jwtInProject > 0,
    `per-tier: JWT gets positive score within project tier (got ${jwtInProject.toFixed(3)})`);
  assertClose(obsInObsTier, 1.0, 0.001,
    'per-tier: single observation normalizes to 1.0 in its own tier');

  const crossTierProject = selectByBudget(projectEntries, 500, null, crossTierRanks);
  assert(crossTierProject[0].id === 'mem-jwt',
    `per-tier: JWT ranks first in project tier even with observation in FTS results (got ${crossTierProject[0].id})`);

  // ── Summary ──
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

  sqlDb.close();
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
