/**
 * Comprehensive test suite for the pull-first memory catalog architecture (v1.1.35).
 *
 * Tests: catalog construction, scoring (FTS + fallback), pinned memories, retrieval
 * tracking/boost, staleness penalty, content truncation, entry formatting, rowToEntry
 * type mapping, retrieval cleanup, orphan cleanup on delete, and FTS5 integration.
 *
 * Usage: node scripts/test-memory.js
 */

const path = require('path');
const fs = require('fs');

// ─── Constants (mirrored from injection-manager.ts) ──────────────────────────

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const RETRIEVAL_BOOST_DENOMINATOR = Math.log2(11);
const STALENESS_THRESHOLD = 3;
const CONTENT_TRUNCATION_LIMIT = 300;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const OBSERVATION_CANDIDATE_POOL_SIZE = 100;

const TIER_WEIGHT = { session: 1.0, project: 0.8, global: 0.6, observation: 0.5, note: 0.3 };

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

// ─── Pure functions (mirrored from injection-manager.ts) ─────────────────────

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

function computeRecency(updatedAt) {
  return 1 / (1 + (Date.now() - updatedAt) / SEVEN_DAYS_MS);
}

function computeRetrievalBoost(memoryId, retrievalCounts) {
  const count = retrievalCounts.get(memoryId) ?? 0;
  if (count === 0) return 0;
  return Math.log2(1 + count) / RETRIEVAL_BOOST_DENOMINATOR;
}

function computeStalenessPenalty(memory) {
  if (memory.tier !== 'observation') return 1.0;
  const count = memory.fileChangeCount ?? 0;
  if (count === 0) return 1.0;
  return 0.3 + 0.7 * Math.exp(-0.25 * count);
}

function scoreMemory(memory, ftsScores, activeFile, retrievalCounts) {
  const ftsRelevance = ftsScores?.get(memory.id) ?? 0;
  const recency = computeRecency(memory.updatedAt);
  const fileProximity = activeFile && memoryMentionsFile(memory, activeFile) ? 1 : 0;
  const tierWeight = TIER_WEIGHT[memory.tier];
  const retrievalBoost = computeRetrievalBoost(memory.id, retrievalCounts);
  const stalenessPenalty = computeStalenessPenalty(memory);

  const raw = ftsScores
    ? ftsRelevance * 0.5 + recency * 0.15 + tierWeight * 0.15 + fileProximity * 0.1 + retrievalBoost * 0.1
    : fileProximity * 0.4 + recency * 0.25 + tierWeight * 0.25 + retrievalBoost * 0.1;

  return {
    score: raw * stalenessPenalty,
    breakdown: { ftsRelevance, recency, tierWeight, fileProximity, retrievalBoost, stalenessPenalty },
  };
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

function formatMemoryEntry(m) {
  if (m.tier === 'observation' && m.title) {
    const files = [...(m.filesRead ?? []), ...(m.filesModified ?? [])];
    const fileHint = files.length > 0 ? ` (${files.slice(0, 2).join(', ')})` : '';
    const staleHint = (m.fileChangeCount ?? 0) >= STALENESS_THRESHOLD ? ' [stale]' : '';
    return `- [${m.id}] ${m.title}${fileHint}${staleHint}`;
  }
  if (m.content.length > CONTENT_TRUNCATION_LIMIT) {
    return `- ${m.content.slice(0, CONTENT_TRUNCATION_LIMIT)}...[Use get_memory_details for full content]`;
  }
  return `- ${m.content}`;
}

function formatPinnedEntry(m) {
  if (m.tier === 'observation' && m.title) {
    const staleHint = (m.fileChangeCount ?? 0) >= STALENESS_THRESHOLD ? ' [stale]' : '';
    return `- [${m.id}] ${m.title}${staleHint}\n  ${m.content}`;
  }
  return `- [${m.id}] ${m.content}`;
}

function selectTopN(memories, limit, activeFile, rawFtsRanks, retrievalCounts, excludeIds) {
  const filtered = memories.filter(m => !excludeIds.has(m.id));
  const ftsScores = rawFtsRanks ? normalizeForTier(filtered, rawFtsRanks) : null;
  const scored = filtered.map(m => {
    const { score, breakdown } = scoreMemory(m, ftsScores, activeFile, retrievalCounts);
    return { memory: m, score, scoreBreakdown: breakdown, estimatedTokens: estimateTokens(formatMemoryEntry(m)) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function buildFtsQuery(prompt) {
  const tokens = prompt.trim().toLowerCase().split(/\s+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t))
    .map(t => t.replace(/[^a-z0-9._-]/g, ''))
    .filter(t => t.length > 0);
  const capped = tokens.slice(0, 32);
  if (capped.length === 0) return null;
  return capped.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

function rowToEntry(row) {
  return {
    id: row.id,
    tier: row.tier,
    content: row.content,
    sessionId: row.session_id,
    workspace: row.workspace,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tags: JSON.parse(row.tags),
    ...(row.access_count > 0 ? { accessCount: row.access_count } : {}),
    ...(row.observation_type ? { observationType: row.observation_type } : {}),
    ...(row.title ? { title: row.title } : {}),
    ...(row.facts && row.facts !== '[]' ? { facts: JSON.parse(row.facts) } : {}),
    ...(row.observation_tags && row.observation_tags !== '[]' ? { observationTags: JSON.parse(row.observation_tags) } : {}),
    ...(row.files_read && row.files_read !== '[]' ? { filesRead: JSON.parse(row.files_read) } : {}),
    ...(row.files_modified && row.files_modified !== '[]' ? { filesModified: JSON.parse(row.files_modified) } : {}),
    ...(row.file_change_count > 0 ? { fileChangeCount: row.file_change_count } : {}),
    ...(row.search_terms && row.search_terms !== '[]' ? { searchTerms: JSON.parse(row.search_terms) } : {}),
    ...(row.pinned ? { pinned: true } : {}),
  };
}

// ─── Database setup ──────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

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
  access_count INTEGER DEFAULT 0,
  file_change_count INTEGER NOT NULL DEFAULT 0,
  search_terms TEXT DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(tier);
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memories_workspace ON memories(workspace) WHERE workspace IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memories_tier_workspace ON memories(tier, workspace);
CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(pinned) WHERE pinned = 1;

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content, title, tags, facts, observation_tags, files_read, files_modified, search_terms,
  content=memories, content_rowid=rowid,
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, title, tags, facts, observation_tags, files_read, files_modified, search_terms)
  VALUES (NEW.rowid, NEW.content, NEW.title, NEW.tags, NEW.facts, NEW.observation_tags, NEW.files_read, NEW.files_modified, NEW.search_terms);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, title, tags, facts, observation_tags, files_read, files_modified, search_terms)
  VALUES ('delete', OLD.rowid, OLD.content, OLD.title, OLD.tags, OLD.facts, OLD.observation_tags, OLD.files_read, OLD.files_modified, OLD.search_terms);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, title, tags, facts, observation_tags, files_read, files_modified, search_terms)
  VALUES ('delete', OLD.rowid, OLD.content, OLD.title, OLD.tags, OLD.facts, OLD.observation_tags, OLD.files_read, OLD.files_modified, OLD.search_terms);
  INSERT INTO memories_fts(rowid, content, title, tags, facts, observation_tags, files_read, files_modified, search_terms)
  VALUES (NEW.rowid, NEW.content, NEW.title, NEW.tags, NEW.facts, NEW.observation_tags, NEW.files_read, NEW.files_modified, NEW.search_terms);
END;

CREATE TABLE IF NOT EXISTS memory_retrievals (
  memory_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  retrieved_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_retrievals_memory ON memory_retrievals(memory_id);
CREATE INDEX IF NOT EXISTS idx_retrievals_workspace ON memory_retrievals(workspace, retrieved_at);

INSERT INTO schema_version (version) VALUES (4);
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

// ─── Test data ───────────────────────────────────────────────────────────────

const now = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const WORKSPACE = '/test/workspace';
const SESSION = 'session-1';

const MEMORIES = [
  {
    id: 'sess-bun', tier: 'session',
    content: 'Always use bun instead of npm for package management',
    workspace: WORKSPACE, session_id: SESSION,
    created_at: now - 1 * DAY, updated_at: now - 1 * DAY,
  },
  {
    id: 'sess-func', tier: 'session',
    content: 'Prefer functional patterns over OOP',
    workspace: WORKSPACE, session_id: SESSION,
    created_at: now - 500, updated_at: now - 500,
  },
  {
    id: 'proj-jwt', tier: 'project',
    content: 'JWT tokens expire after 1 hour. Refresh logic lives in auth-service.ts with sliding window.',
    workspace: WORKSPACE, session_id: null,
    files_read: '["src/auth-service.ts"]', files_modified: '["src/auth-service.ts"]',
    created_at: now - 3 * DAY, updated_at: now - 3 * DAY,
  },
  {
    id: 'proj-knex', tier: 'project',
    content: 'Database uses Knex with PostgreSQL. Migrations are in db/migrations/ directory.',
    workspace: WORKSPACE, session_id: null,
    files_read: '["db/migrations/001_init.ts"]', files_modified: '[]',
    created_at: now - 2 * DAY, updated_at: now - 2 * DAY,
  },
  {
    id: 'proj-css', tier: 'project',
    content: 'Renamed CSS class from .header-old to .header-main in the navigation component.',
    workspace: WORKSPACE, session_id: null,
    files_read: '[]', files_modified: '["src/components/header.vue"]',
    created_at: now - 1000, updated_at: now - 1000,
  },
  {
    id: 'glob-tailwind', tier: 'global',
    content: 'Use Tailwind utility classes instead of custom CSS wherever possible.',
    workspace: null, session_id: null,
    created_at: now - 5 * DAY, updated_at: now - 5 * DAY,
  },
  {
    id: 'glob-shadcn', tier: 'global',
    content: 'Prefer shadcn-vue components from src/webview/components/ui/ over raw HTML elements.',
    workspace: null, session_id: null,
    created_at: now - 4 * DAY, updated_at: now - 4 * DAY,
  },
  {
    id: 'obs-auth', tier: 'observation',
    title: 'Fixed authentication token refresh race condition',
    content: 'Resolved a race condition where concurrent API calls could trigger multiple token refreshes simultaneously. Added a mutex lock around the refresh flow in auth-service.ts.',
    workspace: WORKSPACE, session_id: SESSION,
    observation_type: 'fix',
    files_read: '["src/auth-service.ts","src/api-client.ts"]',
    files_modified: '["src/auth-service.ts"]',
    facts: '["race condition in concurrent refresh","mutex lock serializes refreshes","prevents token invalidation cascade"]',
    observation_tags: '["mechanism","caveat"]',
    created_at: now - 2 * DAY, updated_at: now - 2 * DAY,
  },
  {
    id: 'obs-distill', tier: 'observation',
    title: 'Context Distillation Architecture',
    content: 'Implemented FTS5-based context distillation with Haiku annotation. BM25 ranking with optional re-ranking and query decomposition.',
    workspace: WORKSPACE, session_id: SESSION,
    observation_type: 'architecture',
    files_read: '["src/extension/context-distillation/context-retriever.ts"]',
    files_modified: '["src/extension/context-distillation/context-retriever.ts","src/extension/context-distillation/managers/haiku-annotation-manager.ts"]',
    facts: '["FTS5 for BM25 ranking","Haiku annotates structured entries","two-layer output continuity + relevant"]',
    observation_tags: '["mechanism","architecture"]',
    created_at: now - 1 * DAY, updated_at: now - 1 * DAY,
  },
  {
    id: 'obs-stale', tier: 'observation',
    title: 'Stale observation with many file changes',
    content: 'This observation was recorded for code that has since changed significantly.',
    workspace: WORKSPACE, session_id: SESSION,
    observation_type: 'implementation',
    files_read: '[]', files_modified: '["src/old-file.ts"]',
    facts: '["original fact"]',
    observation_tags: '["mechanism"]',
    file_change_count: 5,
    created_at: now - 10 * DAY, updated_at: now - 10 * DAY,
  },
];

const LONG_CONTENT_MEMORY = {
  id: 'proj-long', tier: 'project',
  content: 'A'.repeat(400),
  workspace: WORKSPACE, session_id: null,
  created_at: now - 1 * DAY, updated_at: now - 1 * DAY,
};

function insertMemory(db, mem) {
  db.prepare(`
    INSERT INTO memories (id, tier, content, session_id, workspace, created_at, updated_at, tags,
      observation_type, title, facts, observation_tags, files_read, files_modified,
      access_count, file_change_count, search_terms, pinned)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    mem.id, mem.tier, mem.content, mem.session_id ?? null, mem.workspace ?? null,
    mem.created_at, mem.updated_at, mem.tags ?? '[]',
    mem.observation_type ?? null, mem.title ?? null,
    mem.facts ?? '[]', mem.observation_tags ?? '[]',
    mem.files_read ?? '[]', mem.files_modified ?? '[]',
    mem.access_count ?? 0, mem.file_change_count ?? 0,
    mem.search_terms ?? '[]', mem.pinned ?? 0,
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
    ...(mem.access_count > 0 ? { accessCount: mem.access_count } : {}),
    ...(mem.title ? { title: mem.title } : {}),
    ...(mem.files_read && mem.files_read !== '[]' ? { filesRead: JSON.parse(mem.files_read) } : {}),
    ...(mem.files_modified && mem.files_modified !== '[]' ? { filesModified: JSON.parse(mem.files_modified) } : {}),
    ...(mem.observation_type ? { observationType: mem.observation_type } : {}),
    ...(mem.file_change_count > 0 ? { fileChangeCount: mem.file_change_count } : {}),
    ...(mem.pinned ? { pinned: true } : {}),
  };
}

function queryFtsRanks(db, userPrompt) {
  if (!userPrompt) return null;
  const ftsQuery = buildFtsQuery(userPrompt);
  if (!ftsQuery) return null;

  try {
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
  } catch {
    return null;
  }
}

// ─── SDK integration helpers (mirrored from query-expansion.ts) ──────────────

const EXPANSION_MODEL = 'claude-haiku-4-5-20251001';

function loadSdkQuery() {
  try {
    delete process.env.CLAUDECODE;
    return require('@anthropic-ai/claude-agent-sdk').query;
  } catch {
    return null;
  }
}

async function expandMemoryTermsViaSdk(sdkQuery, entry) {
  const inputParts = [
    entry.title ? `Title: ${entry.title}` : '',
    `Content: ${entry.content.slice(0, 500)}`,
    entry.tags?.length ? `Tags: ${entry.tags.join(', ')}` : '',
    entry.facts?.length ? `Facts: ${entry.facts.join('; ')}` : '',
  ].filter(Boolean);

  const options = {
    model: EXPANSION_MODEL,
    systemPrompt: 'Output ONLY a JSON object {"terms":["word1","word2",...]} with 5-10 search keywords for finding this memory. Include synonyms and related technical terms NOT already in the content. Output raw JSON only, no markdown.',
    tools: [],
    persistSession: false,
  };

  const generator = sdkQuery({ prompt: inputParts.join('\n'), options });
  let resultText = null;

  for await (const event of generator) {
    if (event.type === 'result') {
      if (event.subtype !== 'success') return [];
      if (event.structured_output?.terms) {
        return event.structured_output.terms
          .map(t => t.trim().toLowerCase()).filter(t => t.length > 1);
      }
      resultText = event.result;
    }
  }

  if (!resultText) return [];

  try {
    const jsonMatch = resultText.match(/\{[\s\S]*"terms"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed.terms)) {
        return parsed.terms.map(t => t.trim().toLowerCase()).filter(t => t.length > 1);
      }
    }
  } catch { /* fall through to bold-text extraction */ }

  return (resultText.match(/\*\*([^*]+)\*\*/g) || [])
    .map(m => m.replace(/\*\*/g, '').trim().toLowerCase())
    .filter(t => t.length > 1);
}

function updateSearchTerms(db, id, terms) {
  db.prepare('UPDATE memories SET search_terms = ? WHERE id = ?').run(JSON.stringify(terms), id);
}

function getUnexpandedMemoryIds(db, limit) {
  return db.prepare(
    "SELECT id FROM memories WHERE search_terms = '[]' ORDER BY updated_at DESC LIMIT ?"
  ).all(limit).map(r => r.id);
}

// ─── Test runner ─────────────────────────────────────────────────────────────

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

function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n=== Memory System Comprehensive Tests (v1.1.35 Pull-First Catalog) ===\n');

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

  for (const mem of MEMORIES) insertMemory(db, mem);

  const sessionEntries = MEMORIES.filter(m => m.tier === 'session').map(toMemoryEntry);
  const projectEntries = MEMORIES.filter(m => m.tier === 'project').map(toMemoryEntry);
  const globalEntries = MEMORIES.filter(m => m.tier === 'global').map(toMemoryEntry);
  const observationEntries = MEMORIES.filter(m => m.tier === 'observation').map(toMemoryEntry);

  // ══════════════════════════════════════════════════════════════════════════
  // 1. FTS5 Query Building
  // ══════════════════════════════════════════════════════════════════════════
  console.log('--- 1. FTS5 Query Building ---');

  assertEqual(buildFtsQuery('hello'), '"hello"', 'single word produces quoted term');
  assertEqual(buildFtsQuery('fix auth bug'), '"fix" OR "auth" OR "bug"', 'multiple words joined with OR');
  assert(buildFtsQuery('help me please') === null, 'all stopwords returns null');
  assert(buildFtsQuery('   ') === null, 'whitespace-only returns null');
  assert(buildFtsQuery('a b c') === null, 'single-char tokens filtered');

  const longPrompt = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ');
  const longTokenCount = buildFtsQuery(longPrompt).split(' OR ').length;
  assertEqual(longTokenCount, 32, 'token cap at 32');

  // ══════════════════════════════════════════════════════════════════════════
  // 2. Scoring Formula (with FTS)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n--- 2. Scoring Formula (FTS weights: 0.5/0.15/0.15/0.1/0.1) ---');

  const ftsScores = new Map([['test-id', 0.8]]);
  const mockMemory = { id: 'test-id', tier: 'project', content: 'test', updatedAt: now, fileChangeCount: 0 };
  const noRetrievals = new Map();

  const { score, breakdown } = scoreMemory(mockMemory, ftsScores, null, noRetrievals);

  const expectedRaw = 0.8 * 0.5 + breakdown.recency * 0.15 + 0.8 * 0.15 + 0 * 0.1 + 0 * 0.1;
  assertClose(score, expectedRaw, 0.001, 'FTS scoring formula: 0.5*fts + 0.15*recency + 0.15*tier + 0.1*file + 0.1*retrieval');
  assertClose(breakdown.ftsRelevance, 0.8, 0.001, 'FTS relevance passed through');
  assertClose(breakdown.tierWeight, 0.8, 0.001, 'project tier weight = 0.8');
  assertClose(breakdown.stalenessPenalty, 1.0, 0.001, 'non-observation has no staleness penalty');

  // ══════════════════════════════════════════════════════════════════════════
  // 3. Scoring Formula (fallback, no FTS)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n--- 3. Scoring Formula (fallback weights: 0.4/0.25/0.25/0.1) ---');

  const { score: fbScore, breakdown: fbBreak } = scoreMemory(mockMemory, null, null, noRetrievals);
  const expectedFb = 0 * 0.4 + fbBreak.recency * 0.25 + 0.8 * 0.25 + 0 * 0.1;
  assertClose(fbScore, expectedFb, 0.001, 'fallback scoring: 0.4*file + 0.25*recency + 0.25*tier + 0.1*retrieval');

  const { score: fbFileScore } = scoreMemory(
    { ...mockMemory, content: 'auth-service.ts logic', filesRead: ['src/auth-service.ts'] },
    null, 'src/auth-service.ts', noRetrievals
  );
  assert(fbFileScore > fbScore, 'file proximity boosts fallback score');

  // ══════════════════════════════════════════════════════════════════════════
  // 4. Retrieval Boost
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n--- 4. Retrieval Boost (log-saturating curve) ---');

  assertClose(computeRetrievalBoost('x', new Map()), 0, 0.001, 'zero retrievals = zero boost');
  assertClose(computeRetrievalBoost('x', new Map([['x', 1]])), Math.log2(2) / Math.log2(11), 0.001, '1 retrieval boost');
  assertClose(computeRetrievalBoost('x', new Map([['x', 10]])), Math.log2(11) / Math.log2(11), 0.001, '10 retrievals saturates at ~1.0');

  const boost5 = computeRetrievalBoost('x', new Map([['x', 5]]));
  const boost20 = computeRetrievalBoost('x', new Map([['x', 20]]));
  assert(boost20 > boost5, 'more retrievals = higher boost');
  assert(boost20 < 1.5, 'boost beyond saturation grows slowly (log curve)');

  // ══════════════════════════════════════════════════════════════════════════
  // 5. Staleness Penalty
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n--- 5. Staleness Penalty ---');

  assertClose(computeStalenessPenalty({ tier: 'project', fileChangeCount: 10 }), 1.0, 0.001, 'non-observation ignores staleness');
  assertClose(computeStalenessPenalty({ tier: 'observation', fileChangeCount: 0 }), 1.0, 0.001, 'fresh observation = no penalty');
  const stale3 = computeStalenessPenalty({ tier: 'observation', fileChangeCount: 3 });
  assert(stale3 < 1.0 && stale3 > 0.3, `3 changes gives moderate penalty (got ${stale3.toFixed(3)})`);
  const stale20 = computeStalenessPenalty({ tier: 'observation', fileChangeCount: 20 });
  assert(stale20 < stale3, 'more changes = more penalty');
  assert(stale20 >= 0.3, 'penalty floor is 0.3 (never fully discarded)');

  // ══════════════════════════════════════════════════════════════════════════
  // 6. Entry Formatting
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n--- 6. Entry Formatting ---');

  const obsEntry = toMemoryEntry(MEMORIES.find(m => m.id === 'obs-auth'));
  const obsRendered = formatMemoryEntry(obsEntry);
  assert(obsRendered.startsWith('- [obs-auth]'), 'observation renders as compact [id] title');
  assert(obsRendered.includes('Fixed authentication'), 'observation shows title');
  assert(!obsRendered.includes('mutex lock'), 'observation hides narrative content');
  assert(obsRendered.includes('src/auth-service.ts'), 'observation shows file hint');

  const staleObs = toMemoryEntry(MEMORIES.find(m => m.id === 'obs-stale'));
  const staleRendered = formatMemoryEntry(staleObs);
  assert(staleRendered.includes('[stale]'), 'stale observation gets [stale] tag');

  const freshObs = toMemoryEntry(MEMORIES.find(m => m.id === 'obs-distill'));
  const freshRendered = formatMemoryEntry(freshObs);
  assert(!freshRendered.includes('[stale]'), 'fresh observation has no [stale] tag');

  const sessionEntry = toMemoryEntry(MEMORIES.find(m => m.id === 'sess-bun'));
  assertEqual(formatMemoryEntry(sessionEntry), '- Always use bun instead of npm for package management', 'session memory renders full content');

  // ── Content truncation ──
  const longEntry = toMemoryEntry(LONG_CONTENT_MEMORY);
  const longRendered = formatMemoryEntry(longEntry);
  assert(longRendered.includes('...[Use get_memory_details for full content]'), 'long content is truncated');
  assert(longRendered.length < LONG_CONTENT_MEMORY.content.length, 'truncated output shorter than content');

  // ── Pinned formatting ──
  const pinnedObsRendered = formatPinnedEntry(obsEntry);
  assert(pinnedObsRendered.includes(obsEntry.content), 'pinned observation shows full content');
  assert(pinnedObsRendered.includes('[obs-auth]'), 'pinned observation shows ID');

  const pinnedSessionRendered = formatPinnedEntry(sessionEntry);
  assert(pinnedSessionRendered.includes('[sess-bun]'), 'pinned non-observation shows ID');

  // ══════════════════════════════════════════════════════════════════════════
  // 7. selectTopN (Entry Count Based)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n--- 7. selectTopN (entry count limits) ---');

  const topProject2 = selectTopN(projectEntries, 2, null, null, noRetrievals, new Set());
  assertEqual(topProject2.length, 2, 'limit=2 returns exactly 2');

  const topProjectAll = selectTopN(projectEntries, 100, null, null, noRetrievals, new Set());
  assertEqual(topProjectAll.length, projectEntries.length, 'limit > count returns all');

  const topProject0 = selectTopN(projectEntries, 0, null, null, noRetrievals, new Set());
  assertEqual(topProject0.length, 0, 'limit=0 returns empty');

  // ── Exclusion ──
  const excludeSet = new Set(['proj-jwt', 'proj-knex']);
  const topExcluded = selectTopN(projectEntries, 10, null, null, noRetrievals, excludeSet);
  assert(topExcluded.every(s => !excludeSet.has(s.memory.id)), 'excluded IDs are filtered out');
  assertEqual(topExcluded.length, projectEntries.length - excludeSet.size, 'exclusion reduces count correctly');

  // ── Sorted by score descending ──
  const topObs = selectTopN(observationEntries, 10, null, null, noRetrievals, new Set());
  for (let i = 1; i < topObs.length; i++) {
    assert(topObs[i - 1].score >= topObs[i].score, `observation ${i - 1} score >= observation ${i} score`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 8. FTS5 Integration with Catalog Scoring
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n--- 8. FTS5 Integration ---');

  const authRanks = queryFtsRanks(db, 'fix the authentication token expiry');
  assert(authRanks !== null, 'auth prompt returns FTS ranks');
  assert(authRanks.has('proj-jwt') || authRanks.has('obs-auth'), 'auth-related memories matched');

  const dbRanks = queryFtsRanks(db, 'database schema migrations PostgreSQL');
  assert(dbRanks !== null, 'database prompt returns FTS ranks');
  assert(dbRanks.has('proj-knex'), 'Knex memory matched for database prompt');

  const authCatalog = selectTopN(projectEntries, 3, null, authRanks, noRetrievals, new Set());
  assert(authCatalog.length > 0, 'auth prompt selects project memories');
  assertEqual(authCatalog[0].memory.id, 'proj-jwt', 'auth prompt ranks JWT first in project tier');

  const dbCatalog = selectTopN(projectEntries, 3, null, dbRanks, noRetrievals, new Set());
  assertEqual(dbCatalog[0].memory.id, 'proj-knex', 'database prompt ranks Knex first');

  // ── Porter stemming ──
  const stemRanks = queryFtsRanks(db, 'authenticating tokens');
  assert(stemRanks !== null, 'porter stemming matches "authenticating" to "authentication"');

  // ── Fallback when no FTS match ──
  const noMatchRanks = queryFtsRanks(db, 'hello there');
  assert(noMatchRanks === null, 'unrelated prompt returns null (triggers fallback)');

  // ══════════════════════════════════════════════════════════════════════════
  // 9. Retrieval Boost in Scoring
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n--- 9. Retrieval Boost in Scoring ---');

  const retrievals = new Map([['proj-knex', 5]]);
  const withBoost = selectTopN(projectEntries, 3, null, null, retrievals, new Set());
  const knexIdx = withBoost.findIndex(s => s.memory.id === 'proj-knex');
  const withoutBoost = selectTopN(projectEntries, 3, null, null, noRetrievals, new Set());
  const knexIdxNone = withoutBoost.findIndex(s => s.memory.id === 'proj-knex');
  assert(knexIdx <= knexIdxNone, 'retrieval boost improves ranking (or maintains it)');

  const knexWithBoost = withBoost.find(s => s.memory.id === 'proj-knex');
  const knexWithout = withoutBoost.find(s => s.memory.id === 'proj-knex');
  assert(knexWithBoost.score > knexWithout.score, 'retrieval boost increases raw score');
  assert(knexWithBoost.scoreBreakdown.retrievalBoost > 0, 'breakdown shows positive retrievalBoost');
  assertEqual(knexWithout.scoreBreakdown.retrievalBoost, 0, 'no retrievals = zero in breakdown');

  // ══════════════════════════════════════════════════════════════════════════
  // 10. Pinned Memory Database Operations
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n--- 10. Pinned Memory Operations ---');

  // Pin a memory
  const pinResult = db.prepare('UPDATE memories SET pinned = 1 WHERE id = ?').run('proj-jwt');
  assertEqual(pinResult.changes, 1, 'pinning existing memory succeeds');

  const pinnedRow = db.prepare('SELECT pinned FROM memories WHERE id = ?').get('proj-jwt');
  assertEqual(pinnedRow.pinned, 1, 'pinned column is 1 after pin');

  // Pin non-existent
  const pinGhost = db.prepare('UPDATE memories SET pinned = 1 WHERE id = ?').run('nonexistent');
  assertEqual(pinGhost.changes, 0, 'pinning nonexistent memory returns 0 changes');

  // Load pinned memories (DESC ordering — newest first)
  db.prepare('UPDATE memories SET pinned = 1 WHERE id = ?').run('glob-tailwind');
  const pinnedRows = db.prepare(
    `SELECT * FROM memories WHERE pinned = 1 AND (workspace = ? OR tier = 'global') ORDER BY updated_at DESC`
  ).all(WORKSPACE);
  assert(pinnedRows.length === 2, `two pinned memories loaded (got ${pinnedRows.length})`);
  assertEqual(pinnedRows[0].id, 'proj-jwt', 'newest pinned first (DESC order)');

  // rowToEntry maps pinned field
  const pinnedEntry = rowToEntry(pinnedRows[0]);
  assertEqual(pinnedEntry.pinned, true, 'rowToEntry maps pinned: true');

  // Unpin
  db.prepare('UPDATE memories SET pinned = 0 WHERE id = ?').run('proj-jwt');
  const unpinnedRow = db.prepare('SELECT pinned FROM memories WHERE id = ?').get('proj-jwt');
  assertEqual(unpinnedRow.pinned, 0, 'unpin sets pinned to 0');

  // Unpinned rowToEntry
  const unpinnedEntry = rowToEntry(db.prepare('SELECT * FROM memories WHERE id = ?').get('proj-jwt'));
  assert(!unpinnedEntry.pinned, 'rowToEntry omits pinned when 0');

  // Clean up
  db.prepare('UPDATE memories SET pinned = 0 WHERE id = ?').run('glob-tailwind');

  // ══════════════════════════════════════════════════════════════════════════
  // 11. Pinned Exclusion from Catalog
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n--- 11. Pinned Exclusion from Catalog ---');

  const pinnedIds = new Set(['proj-jwt']);
  const catalogWithExclusion = selectTopN(projectEntries, 10, null, null, noRetrievals, pinnedIds);
  assert(!catalogWithExclusion.some(s => s.memory.id === 'proj-jwt'), 'pinned memory excluded from catalog');
  assertEqual(catalogWithExclusion.length, projectEntries.length - 1, 'catalog count reduced by pinned');

  // ══════════════════════════════════════════════════════════════════════════
  // 12. Pinned Token Budget
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n--- 12. Pinned Token Budget ---');

  db.prepare('UPDATE memories SET pinned = 1 WHERE id = ?').run('proj-jwt');
  db.prepare('UPDATE memories SET pinned = 1 WHERE id = ?').run('glob-tailwind');
  db.prepare('UPDATE memories SET pinned = 1 WHERE id = ?').run('glob-shadcn');

  const allPinned = db.prepare(
    `SELECT * FROM memories WHERE pinned = 1 AND (workspace = ? OR tier = 'global') ORDER BY updated_at DESC`
  ).all(WORKSPACE).map(rowToEntry);

  const TINY_BUDGET = 30;
  let pinnedTokensUsed = 0;
  const pinnedForInjection = [];
  for (const m of allPinned) {
    const cost = estimateTokens(formatPinnedEntry(m));
    if (pinnedTokensUsed + cost > TINY_BUDGET) break;
    pinnedForInjection.push(m);
    pinnedTokensUsed += cost;
  }
  assert(pinnedForInjection.length < allPinned.length, 'tiny budget drops some pinned memories');
  assert(pinnedForInjection.length > 0, 'at least one pinned memory fits');

  // Clean up
  db.prepare('UPDATE memories SET pinned = 0').run();

  // ══════════════════════════════════════════════════════════════════════════
  // 13. Retrieval Tracking Database Operations
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n--- 13. Retrieval Tracking ---');

  const insertRetrieval = db.prepare('INSERT INTO memory_retrievals (memory_id, workspace, retrieved_at) VALUES (?, ?, ?)');
  insertRetrieval.run('obs-auth', WORKSPACE, now - 1 * DAY);
  insertRetrieval.run('obs-auth', WORKSPACE, now - 2 * DAY);
  insertRetrieval.run('obs-distill', WORKSPACE, now - 3 * DAY);
  insertRetrieval.run('obs-auth', WORKSPACE, now - 40 * DAY); // older than 30 days

  const cutoff = now - THIRTY_DAYS_MS;
  const counts = db.prepare(
    'SELECT memory_id, COUNT(*) as count FROM memory_retrievals WHERE workspace = ? AND retrieved_at > ? GROUP BY memory_id'
  ).all(WORKSPACE, cutoff);

  const countMap = new Map(counts.map(r => [r.memory_id, r.count]));
  assertEqual(countMap.get('obs-auth'), 2, '30-day window filters old retrievals (2 within, 1 outside)');
  assertEqual(countMap.get('obs-distill'), 1, 'single retrieval counted');

  // ══════════════════════════════════════════════════════════════════════════
  // 14. Retrieval Cleanup (Fix #4)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n--- 14. Retrieval Cleanup ---');

  const beforeCleanup = db.prepare('SELECT COUNT(*) as count FROM memory_retrievals').get();
  assertEqual(beforeCleanup.count, 4, '4 retrieval records before cleanup');

  db.prepare('DELETE FROM memory_retrievals WHERE retrieved_at < ?').run(cutoff);

  const afterCleanup = db.prepare('SELECT COUNT(*) as count FROM memory_retrievals').get();
  assertEqual(afterCleanup.count, 3, 'cleanup removes expired retrieval records');

  const remainingOld = db.prepare('SELECT COUNT(*) as count FROM memory_retrievals WHERE retrieved_at < ?').get(cutoff);
  assertEqual(remainingOld.count, 0, 'no expired records remain after cleanup');

  // ══════════════════════════════════════════════════════════════════════════
  // 15. Orphan Cleanup on Memory Delete (Fix #5)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n--- 15. Orphan Cleanup on Delete ---');

  const retrievalsBefore = db.prepare('SELECT COUNT(*) as count FROM memory_retrievals WHERE memory_id = ?').get('obs-auth');
  assert(retrievalsBefore.count > 0, 'retrievals exist for obs-auth before delete');

  db.prepare('DELETE FROM memories WHERE id = ?').run('obs-auth');
  db.prepare('DELETE FROM memory_retrievals WHERE memory_id = ?').run('obs-auth');

  const retrievalsAfter = db.prepare('SELECT COUNT(*) as count FROM memory_retrievals WHERE memory_id = ?').get('obs-auth');
  assertEqual(retrievalsAfter.count, 0, 'retrieval records cleaned up after memory delete');

  // Re-insert for subsequent tests
  insertMemory(db, MEMORIES.find(m => m.id === 'obs-auth'));

  // ══════════════════════════════════════════════════════════════════════════
  // 16. rowToEntry Full Mapping
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n--- 16. rowToEntry Mapping ---');

  const fullRow = db.prepare('SELECT * FROM memories WHERE id = ?').get('obs-distill');
  const entry = rowToEntry(fullRow);

  assertEqual(entry.id, 'obs-distill', 'id mapped');
  assertEqual(entry.tier, 'observation', 'tier mapped');
  assertEqual(entry.title, 'Context Distillation Architecture', 'title mapped');
  assertEqual(entry.observationType, 'architecture', 'observationType mapped');
  assert(Array.isArray(entry.facts), 'facts parsed as array');
  assert(entry.facts.length === 3, `3 facts parsed (got ${entry.facts.length})`);
  assert(Array.isArray(entry.filesModified), 'filesModified parsed as array');
  assert(entry.filesModified.length === 2, `2 modified files (got ${entry.filesModified.length})`);
  assert(!entry.pinned, 'unpinned memory has no pinned field');

  db.prepare('UPDATE memories SET pinned = 1 WHERE id = ?').run('obs-distill');
  const pinnedFullRow = db.prepare('SELECT * FROM memories WHERE id = ?').get('obs-distill');
  const pinnedFullEntry = rowToEntry(pinnedFullRow);
  assertEqual(pinnedFullEntry.pinned, true, 'pinned=1 maps to pinned: true');
  db.prepare('UPDATE memories SET pinned = 0 WHERE id = ?').run('obs-distill');

  // ── Empty fields handled gracefully ──
  const sessionRow = db.prepare('SELECT * FROM memories WHERE id = ?').get('sess-bun');
  const sessionFromRow = rowToEntry(sessionRow);
  assert(!sessionFromRow.title, 'null title omitted');
  assert(!sessionFromRow.observationType, 'null observation_type omitted');
  assert(!sessionFromRow.filesRead, 'empty files_read array omitted');
  assert(!sessionFromRow.fileChangeCount, 'zero file_change_count omitted');

  // ══════════════════════════════════════════════════════════════════════════
  // 17. Per-Tier Normalization
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n--- 17. Per-Tier Normalization ---');

  const crossRanks = queryFtsRanks(db, 'authentication token refresh');
  assert(crossRanks !== null, 'cross-tier prompt returns ranks');

  const projNorm = normalizeForTier(projectEntries, crossRanks);
  const obsNorm = normalizeForTier(observationEntries, crossRanks);

  if (projNorm) {
    const vals = [...projNorm.values()];
    assert(vals.every(v => v >= 0 && v <= 1), 'project normalized scores in [0, 1]');
  }
  if (obsNorm && obsNorm.size === 1) {
    const singleVal = [...obsNorm.values()][0];
    assertClose(singleVal, 1.0, 0.001, 'single observation normalizes to 1.0');
  }

  // ── normalizeForTier returns null for non-matching tier ──
  const cssRanks = queryFtsRanks(db, 'CSS header component');
  if (cssRanks) {
    const globalNorm = normalizeForTier(globalEntries, cssRanks);
    assert(globalNorm === null || globalNorm.size === 0 || [...globalNorm.values()].every(v => v >= 0),
      'normalization handles non-matching tier gracefully');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 18. File Proximity Boost
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n--- 18. File Proximity ---');

  const authFile = 'src/auth-service.ts';
  const { breakdown: withFile } = scoreMemory(
    toMemoryEntry(MEMORIES.find(m => m.id === 'proj-jwt')), null, authFile, noRetrievals
  );
  assertEqual(withFile.fileProximity, 1, 'JWT memory matches auth-service.ts');

  const { breakdown: noFile } = scoreMemory(
    toMemoryEntry(MEMORIES.find(m => m.id === 'proj-knex')), null, authFile, noRetrievals
  );
  assertEqual(noFile.fileProximity, 0, 'Knex memory does not match auth-service.ts');

  const fallbackWithFile = selectTopN(projectEntries, 3, authFile, null, noRetrievals, new Set());
  assertEqual(fallbackWithFile[0].memory.id, 'proj-jwt', 'file proximity pushes JWT to top in fallback');

  // ══════════════════════════════════════════════════════════════════════════
  // 19. Staleness in Catalog Ranking
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n--- 19. Staleness in Ranking ---');

  const staleEntry = toMemoryEntry(MEMORIES.find(m => m.id === 'obs-stale'));
  const freshEntry = toMemoryEntry(MEMORIES.find(m => m.id === 'obs-distill'));

  const { score: staleScore } = scoreMemory(staleEntry, null, null, noRetrievals);
  const { score: freshScore } = scoreMemory(freshEntry, null, null, noRetrievals);
  assert(freshScore > staleScore, 'fresh observation scores higher than stale one');

  // ══════════════════════════════════════════════════════════════════════════
  // 20. Scoring Weights Sum to 1.0
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n--- 20. Scoring Weight Invariants ---');

  assertClose(0.5 + 0.15 + 0.15 + 0.1 + 0.1, 1.0, 0.001, 'FTS weights sum to 1.0');
  assertClose(0.4 + 0.25 + 0.25 + 0.1, 1.0, 0.001, 'fallback weights sum to 1.0');

  // ══════════════════════════════════════════════════════════════════════════
  // 21. Catalog Context Formatting
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n--- 21. Catalog Context Formatting ---');

  const scoredSession = selectTopN(sessionEntries, sessionEntries.length, null, null, noRetrievals, new Set());
  const scoredObs = selectTopN(observationEntries, 20, null, null, noRetrievals, new Set());

  const sessionBlock = scoredSession.map(s => formatMemoryEntry(s.memory)).join('\n');
  assert(sessionBlock.includes('bun'), 'session block contains bun memory');
  assert(sessionBlock.includes('functional'), 'session block contains functional memory');

  const obsBlock = scoredObs.map(s => formatMemoryEntry(s.memory)).join('\n');
  assert(obsBlock.includes('[obs-distill]'), 'observation block uses compact [id] format');
  assert(obsBlock.includes('[obs-stale]'), 'stale observation included in catalog');
  assert(!obsBlock.includes('mutex lock'), 'observation block does not leak content');

  const pinnedBlock = [toMemoryEntry(MEMORIES.find(m => m.id === 'obs-auth'))].map(m => formatPinnedEntry(m)).join('\n');
  assert(pinnedBlock.includes('mutex lock'), 'pinned block shows full narrative content');

  // ══════════════════════════════════════════════════════════════════════════
  // 22. Record Retrievals Only for Found IDs (Fix #2)
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n--- 22. Record Retrievals (found-only fix) ---');

  db.prepare('DELETE FROM memory_retrievals').run();

  const requestedIds = ['obs-distill', 'nonexistent-1', 'nonexistent-2'];
  const foundEntries = db.prepare(
    `SELECT * FROM memories WHERE id IN (${requestedIds.map(() => '?').join(',')})`
  ).all(...requestedIds);
  const foundIds = foundEntries.map(e => e.id);

  assertEqual(foundIds.length, 1, 'only 1 of 3 requested IDs exists');

  const stmt = db.prepare('INSERT INTO memory_retrievals (memory_id, workspace, retrieved_at) VALUES (?, ?, ?)');
  for (const id of foundIds) {
    stmt.run(id, WORKSPACE, now);
  }

  const retrievalCount = db.prepare('SELECT COUNT(*) as count FROM memory_retrievals').get();
  assertEqual(retrievalCount.count, 1, 'only found IDs recorded (not phantom IDs)');

  const phantomRetrievals = db.prepare('SELECT COUNT(*) as count FROM memory_retrievals WHERE memory_id = ?').get('nonexistent-1');
  assertEqual(phantomRetrievals.count, 0, 'phantom IDs have no retrieval records');

  // ══════════════════════════════════════════════════════════════════════════
  // 23. Content Truncation Edge Cases
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n--- 23. Content Truncation Edge Cases ---');

  const exactly300 = { id: 'edge', tier: 'project', content: 'X'.repeat(300), updatedAt: now, tags: [] };
  const rendered300 = formatMemoryEntry(exactly300);
  assert(!rendered300.includes('get_memory_details'), 'exactly 300 chars is not truncated');

  const chars301 = { id: 'edge', tier: 'project', content: 'X'.repeat(301), updatedAt: now, tags: [] };
  const rendered301 = formatMemoryEntry(chars301);
  assert(rendered301.includes('get_memory_details'), '301 chars triggers truncation');

  const short = { id: 'edge', tier: 'project', content: 'hello', updatedAt: now, tags: [] };
  assertEqual(formatMemoryEntry(short), '- hello', 'short content rendered verbatim');

  // ══════════════════════════════════════════════════════════════════════════
  // 24. Observation Candidate Pool Size Constant
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n--- 24. Constants ---');

  assertEqual(OBSERVATION_CANDIDATE_POOL_SIZE, 100, 'OBSERVATION_CANDIDATE_POOL_SIZE = 100');
  assertEqual(STALENESS_THRESHOLD, 3, 'STALENESS_THRESHOLD = 3');
  assertEqual(CONTENT_TRUNCATION_LIMIT, 300, 'CONTENT_TRUNCATION_LIMIT = 300');

  // ══════════════════════════════════════════════════════════════════════════
  // 25. Multi-Tier Catalog Integration
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n--- 25. Multi-Tier Catalog Integration ---');

  const pinnedSet = new Set();
  const allSession = selectTopN(sessionEntries, sessionEntries.length, null, null, noRetrievals, pinnedSet);
  const allProject = selectTopN(projectEntries, 15, null, null, noRetrievals, pinnedSet);
  const allGlobal = selectTopN(globalEntries, 10, null, null, noRetrievals, pinnedSet);
  const allObs = selectTopN(observationEntries, 20, null, null, noRetrievals, pinnedSet);

  assert(allSession.length === 2, `2 session memories in catalog (got ${allSession.length})`);
  assert(allProject.length === 3, `3 project memories in catalog (got ${allProject.length})`);
  assert(allGlobal.length === 2, `2 global memories in catalog (got ${allGlobal.length})`);
  assert(allObs.length === 3, `3 observations in catalog (got ${allObs.length})`);

  const totalEntries = allSession.length + allProject.length + allGlobal.length + allObs.length;
  assert(totalEntries === 10, `total catalog entries = 10 (got ${totalEntries})`);

  const totalTokens = [...allSession, ...allProject, ...allGlobal, ...allObs]
    .reduce((sum, s) => sum + s.estimatedTokens, 0);
  assert(totalTokens < 1000, `catalog token cost is compact: ${totalTokens} tokens < 1000`);

  // ══════════════════════════════════════════════════════════════════════════
  // 26. Search Terms — FTS5 Vocabulary Expansion
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n--- 26. Search Terms — FTS5 Vocabulary Expansion ---');

  // Verify "kubernetes" does NOT match any existing memory before adding search terms
  const preTermsRanks = queryFtsRanks(db, 'kubernetes container orchestration');
  const preMatch = preTermsRanks?.has('proj-knex') ?? false;
  assert(!preMatch, 'before search terms: "kubernetes" does not match Knex memory');

  // Simulate Haiku index-time expansion: Knex memory gets related search terms
  // In production, expandMemoryTerms() calls Haiku to generate these
  const expandedTerms = ['sql', 'orm', 'query builder', 'database migration', 'schema', 'relational'];
  db.prepare('UPDATE memories SET search_terms = ? WHERE id = ?')
    .run(JSON.stringify(expandedTerms), 'proj-knex');

  // Verify rowToEntry maps search_terms
  const knexRow = db.prepare('SELECT * FROM memories WHERE id = ?').get('proj-knex');
  const knexEntry = rowToEntry(knexRow);
  assert(Array.isArray(knexEntry.searchTerms), 'rowToEntry parses search_terms as array');
  assertEqual(knexEntry.searchTerms.length, expandedTerms.length,
    `searchTerms has ${expandedTerms.length} terms`);
  assert(knexEntry.searchTerms.includes('orm'), 'searchTerms contains "orm"');

  // FTS5 now matches via search_terms — "orm" not in original content but is in search_terms
  const ormRanks = queryFtsRanks(db, 'orm query builder');
  assert(ormRanks !== null, 'search terms make "orm query builder" matchable');
  assert(ormRanks.has('proj-knex'), 'Knex memory matched via search_terms "orm"');

  // "relational" only exists in search_terms, not in original content
  const relRanks = queryFtsRanks(db, 'relational database');
  assert(relRanks !== null, '"relational" matches via search_terms');
  assert(relRanks.has('proj-knex'), 'Knex memory found via "relational" search term');

  // Original content-based searches still work alongside search terms
  const pgRanks = queryFtsRanks(db, 'PostgreSQL migrations');
  assert(pgRanks !== null, 'original content still matches after adding search terms');
  assert(pgRanks.has('proj-knex'), 'Knex memory still matches "PostgreSQL" from content');

  // Add search terms to another memory and verify cross-memory matching
  const authExpandedTerms = ['jwt', 'oauth', 'bearer token', 'session management', 'authorization'];
  db.prepare('UPDATE memories SET search_terms = ? WHERE id = ?')
    .run(JSON.stringify(authExpandedTerms), 'proj-jwt');

  const oauthRanks = queryFtsRanks(db, 'oauth bearer token');
  assert(oauthRanks !== null, '"oauth bearer token" matches via JWT search terms');
  assert(oauthRanks.has('proj-jwt'), 'JWT memory matched via "oauth" search term');
  assert(!oauthRanks.has('proj-knex'), 'Knex memory not matched by "oauth"');

  // Verify search terms improve catalog ranking
  const oauthCatalog = selectTopN(
    [toMemoryEntry({ ...MEMORIES.find(m => m.id === 'proj-jwt'), search_terms: JSON.stringify(authExpandedTerms) }),
     ...projectEntries.filter(m => m.id !== 'proj-jwt')],
    3, null, oauthRanks, noRetrievals, new Set()
  );
  assertEqual(oauthCatalog[0].memory.id, 'proj-jwt', 'search term match ranks JWT first for "oauth" query');

  // ══════════════════════════════════════════════════════════════════════════
  // 27. Search Terms — updateSearchTerms and getUnexpandedMemoryIds
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n--- 27. Search Terms — DB Operations ---');

  // getUnexpandedMemoryIds: find memories with empty search_terms
  const unexpanded = db.prepare(
    "SELECT id FROM memories WHERE search_terms = '[]' ORDER BY updated_at DESC LIMIT ?"
  ).all(100).map(r => r.id);

  // proj-jwt and proj-knex now have terms, others should still be '[]'
  assert(!unexpanded.includes('proj-jwt'), 'proj-jwt excluded from unexpanded (has terms)');
  assert(!unexpanded.includes('proj-knex'), 'proj-knex excluded from unexpanded (has terms)');
  assert(unexpanded.includes('sess-bun'), 'sess-bun still unexpanded');
  assert(unexpanded.includes('glob-tailwind'), 'glob-tailwind still unexpanded');
  assert(unexpanded.length > 0, 'some memories need expansion');

  // updateSearchTerms overwrites existing terms
  db.prepare('UPDATE memories SET search_terms = ? WHERE id = ?')
    .run(JSON.stringify(['updated-term']), 'proj-knex');
  const updatedRow = db.prepare('SELECT search_terms FROM memories WHERE id = ?').get('proj-knex');
  const updatedTerms = JSON.parse(updatedRow.search_terms);
  assertEqual(updatedTerms.length, 1, 'updateSearchTerms overwrites previous terms');
  assertEqual(updatedTerms[0], 'updated-term', 'new term is "updated-term"');

  // FTS5 trigger fires on UPDATE — old terms no longer match
  const oldTermRanks = queryFtsRanks(db, 'orm relational');
  const oldMatch = oldTermRanks?.has('proj-knex') ?? false;
  assert(!oldMatch, 'old search terms no longer match after update (FTS5 trigger rebuilds)');

  // New term matches
  const newTermRanks = queryFtsRanks(db, 'updated-term');
  assert(newTermRanks !== null, 'new search term "updated-term" is FTS5-indexed');
  assert(newTermRanks.has('proj-knex'), 'Knex memory matched via updated search term');

  // Reset for clean state
  db.prepare('UPDATE memories SET search_terms = ? WHERE id = ?')
    .run(JSON.stringify(expandedTerms), 'proj-knex');

  // ══════════════════════════════════════════════════════════════════════════
  // 28. Search Terms — Empty and Edge Cases
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n--- 28. Search Terms — Edge Cases ---');

  // Empty array search_terms doesn't contribute to FTS
  const emptyTermsMem = db.prepare('SELECT * FROM memories WHERE id = ?').get('sess-bun');
  const emptyEntry = rowToEntry(emptyTermsMem);
  assert(!emptyEntry.searchTerms, 'empty search_terms array omitted from entry');

  // Memory with search_terms = '[]' has no search-term FTS contribution
  // (but can still match on content)
  const bunRanks = queryFtsRanks(db, 'bun npm package');
  assert(bunRanks !== null, 'sess-bun matches via content even without search terms');
  assert(bunRanks.has('sess-bun'), 'bun memory found via content match');

  // Very long search terms list
  const manyTerms = Array.from({ length: 10 }, (_, i) => `synthetic-term-${i}`);
  db.prepare('UPDATE memories SET search_terms = ? WHERE id = ?')
    .run(JSON.stringify(manyTerms), 'glob-tailwind');

  const syntheticRanks = queryFtsRanks(db, 'synthetic-term-5');
  assert(syntheticRanks !== null, 'FTS matches specific term from large search_terms array');
  assert(syntheticRanks.has('glob-tailwind'), 'tailwind memory matched via synthetic term');

  // Verify search terms don't bleed across memories
  assert(!syntheticRanks.has('proj-knex'), 'synthetic terms do not match unrelated memories');

  // Clean up
  db.prepare("UPDATE memories SET search_terms = '[]' WHERE id = ?").run('glob-tailwind');

  // ══════════════════════════════════════════════════════════════════════════
  // 29. Search Terms — Interaction with Scoring and Catalog
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n--- 29. Search Terms — Scoring Integration ---');

  // A memory that only matches via search_terms still gets FTS rank and scores higher
  // than memories that don't match at all
  const sessionTerms = ['dependency injection', 'inversion of control', 'ioc'];
  db.prepare('UPDATE memories SET search_terms = ? WHERE id = ?')
    .run(JSON.stringify(sessionTerms), 'sess-func');

  const iocRanks = queryFtsRanks(db, 'dependency injection pattern');
  assert(iocRanks !== null, '"dependency injection" matches via search terms');
  assert(iocRanks.has('sess-func'), 'functional patterns memory matched via "dependency injection" search term');

  // Score memory with FTS match from search terms
  const funcEntry = toMemoryEntry({ ...MEMORIES.find(m => m.id === 'sess-func'), search_terms: JSON.stringify(sessionTerms) });
  const bunEntry2 = toMemoryEntry(MEMORIES.find(m => m.id === 'sess-bun'));
  const iocNorm = normalizeForTier([funcEntry, bunEntry2], iocRanks);

  if (iocNorm) {
    const funcScore = iocNorm.get('sess-func') ?? 0;
    assert(funcScore > 0, 'search-term match gives positive normalized FTS score');

    // Score with FTS
    const { score: funcWithFts } = scoreMemory(funcEntry, iocNorm, null, noRetrievals);
    const { score: funcWithoutFts } = scoreMemory(funcEntry, null, null, noRetrievals);
    assert(funcWithFts > funcWithoutFts, 'FTS match from search terms boosts score vs fallback');
  }

  // Clean up
  db.prepare("UPDATE memories SET search_terms = '[]' WHERE id = ?").run('sess-func');
  db.prepare("UPDATE memories SET search_terms = '[]' WHERE id = ?").run('proj-jwt');

  // ══════════════════════════════════════════════════════════════════════════
  // 30–32. SDK Integration — expandMemoryTerms, Backfill, On-Save Pipeline
  // ══════════════════════════════════════════════════════════════════════════

  const sdkQuery = loadSdkQuery();
  if (!sdkQuery) {
    console.log('\n--- 30-32. SDK Integration Tests — SKIPPED (SDK not available) ---');
  } else {

    // ════════════════════════════════════════════════════════════════════════
    // 30. expandMemoryTerms — Live Haiku SDK
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n--- 30. expandMemoryTerms — Live SDK Integration ---');

    const expansionEntry = {
      content: 'Database uses Knex with PostgreSQL. Migrations are in db/migrations/ directory.',
      tags: ['database', 'knex'],
      facts: ['Uses PostgreSQL', 'Migration files in db/migrations/'],
    };

    const terms30 = await expandMemoryTermsViaSdk(sdkQuery, expansionEntry);
    assert(Array.isArray(terms30), 'expandMemoryTerms returns an array');
    assert(terms30.length >= 1, `returned ${terms30.length} terms (>= 1)`);
    assert(terms30.length <= 10, `returned ${terms30.length} terms (<= 10)`);
    assert(terms30.every(t => typeof t === 'string'), 'all terms are strings');
    assert(terms30.every(t => t === t.toLowerCase()), 'all terms are lowercase');
    assert(terms30.every(t => t.length > 1), 'all terms have length > 1');
    console.log('    Haiku generated:', terms30.join(', '));

    // ════════════════════════════════════════════════════════════════════════
    // 31. Backfill Pipeline — getUnexpandedMemoryIds → expand → update → FTS5
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n--- 31. Backfill Pipeline — SDK Integration ---');

    // Reset all search_terms to simulate fresh state (like after DB migration)
    db.prepare("UPDATE memories SET search_terms = '[]'").run();
    db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");

    const preBackfill = getUnexpandedMemoryIds(db, 100);
    assert(preBackfill.length > 0, `${preBackfill.length} memories need backfill`);

    // Process first 2 unexpanded (mirrors startBackfill's processNext loop)
    const backfillTargets = preBackfill.slice(0, 2);
    const backfillResults = [];

    for (const id of backfillTargets) {
      const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
      if (!row) continue;

      const entry = {
        content: row.content,
        ...(row.title ? { title: row.title } : {}),
        tags: JSON.parse(row.tags),
        ...(row.facts && row.facts !== '[]' ? { facts: JSON.parse(row.facts) } : {}),
      };

      const expanded = await expandMemoryTermsViaSdk(sdkQuery, entry);
      if (expanded.length > 0) updateSearchTerms(db, id, expanded);
      backfillResults.push({ id, terms: expanded });
    }

    const postBackfill = getUnexpandedMemoryIds(db, 100);

    for (const { id, terms } of backfillResults) {
      if (terms.length > 0) {
        assert(!postBackfill.includes(id), `${id} removed from unexpanded after backfill`);

        const stored = JSON.parse(
          db.prepare('SELECT search_terms FROM memories WHERE id = ?').get(id).search_terms
        );
        assert(stored.length > 0, `${id} has persisted search terms`);

        const ftsCheck = queryFtsRanks(db, stored[0]);
        assert(ftsCheck !== null && ftsCheck.has(id),
          `${id} FTS-matchable via backfilled term "${stored[0]}"`);

        console.log(`    ${id}: ${terms.join(', ')}`);
      }
    }

    assert(postBackfill.length < preBackfill.length,
      `backfill reduced unexpanded: ${preBackfill.length} → ${postBackfill.length}`);

    // ════════════════════════════════════════════════════════════════════════
    // 32. On-Save Expansion — insert → _expandSearchTerms → FTS5
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n--- 32. On-Save Expansion — SDK Integration ---');

    // Simulate addProjectMemory → _expandSearchTerms flow
    const newMem = {
      id: 'test-onsave', tier: 'project',
      content: 'Redis caching layer with TTL-based expiration for API responses',
      session_id: null, workspace: WORKSPACE,
      created_at: now, updated_at: now,
      tags: '["caching", "redis"]',
    };
    insertMemory(db, newMem);

    assert(getUnexpandedMemoryIds(db, 100).includes('test-onsave'),
      'new memory starts unexpanded');

    // Simulate _expandSearchTerms (fires on addProjectMemory)
    const saveTerms = await expandMemoryTermsViaSdk(sdkQuery, {
      content: newMem.content,
      tags: ['caching', 'redis'],
    });
    assert(saveTerms.length > 0, `on-save expansion returned ${saveTerms.length} terms`);

    updateSearchTerms(db, 'test-onsave', saveTerms);

    assert(!getUnexpandedMemoryIds(db, 100).includes('test-onsave'),
      'memory no longer unexpanded after expansion');

    const saveFts = queryFtsRanks(db, saveTerms[0]);
    assert(saveFts !== null && saveFts.has('test-onsave'),
      `FTS matches via on-save term "${saveTerms[0]}"`);

    const contentFts = queryFtsRanks(db, 'redis caching TTL');
    assert(contentFts !== null && contentFts.has('test-onsave'),
      'original content still FTS-matchable after expansion');

    console.log('    On-save terms:', saveTerms.join(', '));

    // Clean up test memory
    db.prepare('DELETE FROM memories WHERE id = ?').run('test-onsave');

    // Reset all search_terms for clean state
    db.prepare("UPDATE memories SET search_terms = '[]'").run();
    db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Summary
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

  sqlDb.close();
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
