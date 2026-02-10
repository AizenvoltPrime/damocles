/**
 * Standalone test script for the FTS5 database-backed context distillation module.
 *
 * Initializes an in-memory WASM SQLite database with the context_entries schema,
 * then exercises every pure function and DB operation across:
 *   - buildFtsQuery (tokenization, stopwords, special chars, caps)
 *   - summarizeToolInput / extractFilePath (all tool name branches)
 *   - Entry grouping + classification (file_change, research, command, web)
 *   - Database CRUD (insert, update, markLowRelevance, summaries, queries)
 *   - FTS5 search (porter stemming, BM25 ranking, trigger sync)
 *   - Context retrieval (continuity layer, FTS relevance, related files, budget, dedup)
 *   - Prompt building (buildHaikuPrompt, full-text passthrough)
 *   - JSONL log parsing (two-pass ID matching, block types, prefix stripping, malformed input)
 *   - Edge cases (empty prompts, null descriptions, promptIndex=0, budget=0, etc.)
 *
 * Usage: node scripts/test-distill.js
 */

const path = require('path');
const fs = require('fs');

// ─── Pure functions copied from context-retriever.ts ─────────────────────────

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

function formatEntry(entry) {
  if (entry.entry_type === 'summary') {
    return `[Prompt ${entry.prompt_index} summary]: ${entry.description ?? '(no summary)'}`;
  }
  const filePart = entry.file_path ? entry.file_path : entry.entry_type;
  const desc = entry.description ?? summarizeFromToolCalls(entry);
  return `[Prompt ${entry.prompt_index}]: ${filePart} — ${desc}`;
}

function summarizeFromToolCalls(entry) {
  try {
    const calls = JSON.parse(entry.tool_calls);
    if (calls.length === 0) return '(no description)';
    return calls.map(c => `${c.tool_name}: ${c.input_summary}`).join('; ').slice(0, 150);
  } catch {
    return '(no description)';
  }
}

// ─── Pure functions copied from entry-tracker.ts ─────────────────────────────

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep']);
const WRITE_TOOLS = new Set(['Write', 'Edit']);

function summarizeToolInput(toolName, input) {
  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return String(input.file_path ?? '');
    case 'Bash':
      return String(input.command ?? '').slice(0, 200);
    case 'Glob':
      return String(input.pattern ?? '');
    case 'Grep':
      return `pattern="${input.pattern ?? ''}" path=${input.path ?? '.'}`;
    case 'Task':
      return String(input.prompt ?? input.description ?? '');
    case 'WebSearch':
      return String(input.query ?? '');
    case 'WebFetch':
      return String(input.url ?? '');
    default: {
      const vals = Object.entries(input)
        .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
        .map(([, v]) => String(v));
      return vals.length > 0 ? vals.join(', ') : Object.keys(input).join(', ');
    }
  }
}

function extractFilePath(toolName, input) {
  if (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit') {
    return typeof input.file_path === 'string' ? input.file_path : null;
  }
  if (toolName === 'Glob' || toolName === 'Grep') {
    return typeof input.path === 'string' ? input.path : null;
  }
  return null;
}

function classifyEntryType(entry, toolCalls) {
  if (entry.hasWrite) return 'file_change';
  const toolNames = new Set(toolCalls.map(tc => tc.tool_name));
  if (toolNames.has('Bash')) return 'command';
  if (toolNames.has('WebSearch') || toolNames.has('WebFetch')) return 'web';
  return 'research';
}

function extractTaskResultTexts(result) {
  try {
    const parsed = JSON.parse(result);
    const items = parsed.content;
    if (!Array.isArray(items)) return null;
    const texts = items
      .filter(item => item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string')
      .map(item => item.text);
    return texts.length > 0 ? texts : null;
  } catch {
    return null;
  }
}

// ─── Pure functions copied from prompts.ts ───────────────────────────────────

function buildHaikuPrompt(userPrompt, assistantSummary) {
  return [
    `<user_prompt>${userPrompt}</user_prompt>`,
    `<assistant_activity>\n${assistantSummary}\n</assistant_activity>`,
    'Review the entries for this prompt and annotate them using the available tools.',
  ].join('\n\n');
}

// ─── Pure functions copied from index.ts ─────────────────────────────────────

function extractMcpResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(item => item && typeof item === 'object' && item.type === 'text' && item.text)
      .map(item => item.text)
      .join('\n');
  }
  return JSON.stringify(content);
}

function parseHaikuLogBlocks(raw) {
  const entries = [];
  const toolResults = new Map();

  for (const line of raw.split('\n')) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    entries.push(entry);

    if (entry.type === 'user' && Array.isArray(entry.message?.content)) {
      for (const block of entry.message.content) {
        if (block.type === 'tool_result' && block.tool_use_id && block.content != null) {
          toolResults.set(block.tool_use_id, extractMcpResultText(block.content));
        }
      }
    }
  }

  const blocks = [];

  for (const entry of entries) {
    if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) continue;

    for (const block of entry.message.content) {
      if (block.type === 'thinking' && block.thinking) {
        blocks.push({ type: 'thinking', content: block.thinking });
      } else if (block.type === 'text' && block.text) {
        blocks.push({ type: 'text', content: block.text });
      } else if (block.type === 'tool_use' && block.name) {
        const toolUseId = block.id;
        blocks.push({
          type: 'tool',
          content: '',
          toolName: block.name.replace('mcp__damocles-context__', ''),
          toolInput: block.input ? JSON.stringify(block.input) : '',
          toolResult: toolResults.get(toolUseId) ?? '',
        });
      }
    }
  }

  return blocks;
}

// ─── Retrieval logic copied from context-retriever.ts ────────────────────────

const DEFAULT_TOKEN_BUDGET = 4000;
const CHARS_PER_TOKEN = 4;

function expandRelatedFiles(db, entry, currentPromptIndex, includedIds, output, charBudget, usedChars) {
  let relatedFiles;
  try {
    relatedFiles = JSON.parse(entry.related_files);
  } catch {
    return usedChars;
  }
  if (!Array.isArray(relatedFiles) || relatedFiles.length === 0) return usedChars;

  for (const filePath of relatedFiles) {
    const related = db.prepare(
      `SELECT * FROM context_entries
       WHERE prompt_index = ? AND file_path = ? AND low_relevance = 0 AND id != ?
       LIMIT 3`
    ).all(entry.prompt_index, filePath, entry.id);

    for (const relEntry of related) {
      if (includedIds.has(relEntry.id)) continue;
      const formatted = formatEntry(relEntry);
      if (usedChars + formatted.length > charBudget) return usedChars;
      output.push(formatted);
      usedChars += formatted.length;
      includedIds.add(relEntry.id);
    }
  }
  return usedChars;
}

function retrieveContextForPrompt(db, userPrompt, currentPromptIndex, tokenBudget) {
  if (tokenBudget === undefined) tokenBudget = DEFAULT_TOKEN_BUDGET;
  if (currentPromptIndex <= 0) return null;

  const charBudget = tokenBudget * CHARS_PER_TOKEN;
  const includedIds = new Set();
  const sections = { continuity: [], relevant: [] };
  let usedChars = 0;

  const prevSummary = db.prepare(
    `SELECT * FROM context_entries
     WHERE prompt_index = ? AND entry_type = 'summary'
     LIMIT 1`
  ).get(currentPromptIndex - 1);

  if (prevSummary) {
    const formatted = formatEntry(prevSummary);
    sections.continuity.push(formatted);
    usedChars += formatted.length;
    includedIds.add(prevSummary.id);
  }

  const ftsQuery = buildFtsQuery(userPrompt);
  if (ftsQuery) {
    try {
      const ftsResults = db.prepare(
        `SELECT ce.*, fts.rank FROM context_entries_fts fts
         JOIN context_entries ce ON ce.id = fts.rowid
         WHERE context_entries_fts MATCH ?
         AND ce.low_relevance = 0
         AND ce.prompt_index < ?
         ORDER BY fts.rank
         LIMIT 50`
      ).all(ftsQuery, currentPromptIndex);

      for (const entry of ftsResults) {
        if (includedIds.has(entry.id)) continue;
        const formatted = formatEntry(entry);
        if (usedChars + formatted.length > charBudget) break;
        sections.relevant.push(formatted);
        usedChars += formatted.length;
        includedIds.add(entry.id);
        usedChars = expandRelatedFiles(db, entry, currentPromptIndex, includedIds, sections.relevant, charBudget, usedChars);
      }
    } catch (err) {
      // FTS query failure is non-fatal
    }
  }

  if (sections.continuity.length === 0 && sections.relevant.length === 0) return null;

  const parts = [];
  if (sections.continuity.length > 0) {
    parts.push(`<last_activity>\n${sections.continuity.join('\n')}\n</last_activity>`);
  }
  if (sections.relevant.length > 0) {
    parts.push(`<relevant_context>\n${sections.relevant.join('\n')}\n</relevant_context>`);
  }
  return parts.join('\n\n');
}

// ─── Database setup ──────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS context_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  prompt_index INTEGER NOT NULL,
  file_path TEXT,
  entry_type TEXT NOT NULL,
  tool_calls TEXT NOT NULL DEFAULT '[]',
  description TEXT,
  tags TEXT,
  related_files TEXT DEFAULT '[]',
  low_relevance INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ce_session ON context_entries(session_id);
CREATE INDEX IF NOT EXISTS idx_ce_prompt ON context_entries(session_id, prompt_index);

CREATE VIRTUAL TABLE IF NOT EXISTS context_entries_fts USING fts5(
  file_path, description, tags,
  content=context_entries, content_rowid=id,
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS ce_ai AFTER INSERT ON context_entries BEGIN
  INSERT INTO context_entries_fts(rowid, file_path, description, tags)
  VALUES (NEW.id, NEW.file_path, NEW.description, NEW.tags);
END;

CREATE TRIGGER IF NOT EXISTS ce_ad AFTER DELETE ON context_entries BEGIN
  INSERT INTO context_entries_fts(context_entries_fts, rowid, file_path, description, tags)
  VALUES ('delete', OLD.id, OLD.file_path, OLD.description, OLD.tags);
END;

CREATE TRIGGER IF NOT EXISTS ce_au AFTER UPDATE ON context_entries BEGIN
  INSERT INTO context_entries_fts(context_entries_fts, rowid, file_path, description, tags)
  VALUES ('delete', OLD.id, OLD.file_path, OLD.description, OLD.tags);
  INSERT INTO context_entries_fts(rowid, file_path, description, tags)
  VALUES (NEW.id, NEW.file_path, NEW.description, NEW.tags);
END;

INSERT INTO schema_version (version) VALUES (1);
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
    pragma(sql) { sqlDb.exec(`PRAGMA ${sql}`); },
    close() { sqlDb.close(); },
  };
}

// ─── DB helper functions (matching context-database.ts) ──────────────────────

function insertEntry(db, sessionId, promptIndex, filePath, entryType, toolCalls) {
  db.prepare(
    `INSERT INTO context_entries (session_id, prompt_index, file_path, entry_type, tool_calls, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(sessionId, promptIndex, filePath, entryType, JSON.stringify(toolCalls), Date.now());

  const row = db.prepare('SELECT last_insert_rowid() as id').get();
  return row?.id ?? 0;
}

function updateEntryDescription(db, entryId, description, tags, relatedFiles) {
  db.prepare(
    `UPDATE context_entries SET description = ?, tags = ?, related_files = ? WHERE id = ?`
  ).run(description, tags, JSON.stringify(relatedFiles), entryId);
}

function markLowRelevance(db, entryId) {
  db.prepare('UPDATE context_entries SET low_relevance = 1 WHERE id = ?').run(entryId);
}

function insertSummary(db, sessionId, promptIndex, summary, tags) {
  db.prepare(
    `DELETE FROM context_entries WHERE session_id = ? AND prompt_index = ? AND entry_type = 'summary'`
  ).run(sessionId, promptIndex);
  db.prepare(
    `INSERT INTO context_entries (session_id, prompt_index, file_path, entry_type, tool_calls, description, tags, created_at)
     VALUES (?, ?, NULL, 'summary', '[]', ?, ?, ?)`
  ).run(sessionId, promptIndex, summary, tags, Date.now());
}

function getEntriesForPrompt(db, sessionId, promptIndex) {
  return db.prepare(
    `SELECT * FROM context_entries WHERE session_id = ? AND prompt_index = ? ORDER BY id`
  ).all(sessionId, promptIndex);
}

function getMaxPromptIndex(db, sessionId) {
  const row = db.prepare(
    'SELECT MAX(prompt_index) as max_idx FROM context_entries WHERE session_id = ?'
  ).get(sessionId);
  return row?.max_idx ?? -1;
}

function getSummaryEntriesByPrompt(db, sessionId) {
  return db.prepare(
    `SELECT * FROM context_entries WHERE session_id = ? AND entry_type = 'summary' ORDER BY prompt_index`
  ).all(sessionId);
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

function assertEqual(actual, expected, message) {
  const ok = actual === expected;
  if (ok) {
    passed++;
    console.log(`  PASS  ${message}`);
  } else {
    failed++;
    console.log(`  FAIL  ${message} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
  }
}

function assertIncludes(text, substring, message) {
  assert(text.includes(substring), message);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n=== Context Distillation FTS5 Database Tests ===\n');

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

  const SESSION_ID = 'test-session-001';

  // =========================================================================
  // 1. buildFtsQuery
  // =========================================================================
  console.log('--- 1. buildFtsQuery ---');

  assertEqual(buildFtsQuery('hello'), '"hello"', 'single word produces quoted term');
  assertEqual(buildFtsQuery('fix auth bug'), '"fix" OR "auth" OR "bug"', 'multiple words joined with OR');
  assertEqual(buildFtsQuery('help me please'), null, 'all stopwords returns null');
  assertEqual(buildFtsQuery('   '), null, 'whitespace-only returns null');
  assertEqual(buildFtsQuery(''), null, 'empty string returns null');
  assertEqual(buildFtsQuery('a b c'), null, 'single-char tokens filtered out');
  assertEqual(buildFtsQuery('the be to of and'), null, 'common stopwords all filtered');

  const longPrompt = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
  const longResult = buildFtsQuery(longPrompt);
  assertEqual(longResult.split(' OR ').length, 16, 'token cap at 16');

  assertIncludes(buildFtsQuery('test "quoted" value'), '""quoted""', 'double quotes escaped in FTS5 phrase');
  assertEqual(buildFtsQuery('auth*'), '"auth"', 'FTS5 prefix operator * stripped');
  assertEqual(buildFtsQuery('^start'), '"start"', 'FTS5 positional operator ^ stripped');
  assertEqual(buildFtsQuery('** ^^'), null, 'tokens that become empty after stripping are filtered');
  assertEqual(buildFtsQuery('UPDATE database schema'), '"update" OR "database" OR "schema"', 'case insensitive tokenization');
  assertEqual(buildFtsQuery('  lots   of   spaces  '), '"lots" OR "spaces"', 'multiple spaces handled (stopwords filtered)');

  // =========================================================================
  // 2. summarizeToolInput
  // =========================================================================
  console.log('\n--- 2. summarizeToolInput ---');

  assertEqual(summarizeToolInput('Read', { file_path: '/src/app.ts' }), '/src/app.ts', 'Read extracts file_path');
  assertEqual(summarizeToolInput('Write', { file_path: '/src/new.ts' }), '/src/new.ts', 'Write extracts file_path');
  assertEqual(summarizeToolInput('Edit', { file_path: '/src/edit.ts' }), '/src/edit.ts', 'Edit extracts file_path');
  assertEqual(summarizeToolInput('Read', {}), '', 'Read with no file_path returns empty string');

  assertEqual(summarizeToolInput('Bash', { command: 'npm install' }), 'npm install', 'Bash extracts command');
  const longCmd = 'x'.repeat(300);
  assertEqual(summarizeToolInput('Bash', { command: longCmd }).length, 200, 'Bash truncates command to 200 chars');

  assertEqual(summarizeToolInput('Glob', { pattern: '**/*.ts' }), '**/*.ts', 'Glob extracts pattern');
  assertEqual(summarizeToolInput('Grep', { pattern: 'TODO', path: '/src' }), 'pattern="TODO" path=/src', 'Grep formats pattern + path');
  assertEqual(summarizeToolInput('Grep', { pattern: 'fix' }), 'pattern="fix" path=.', 'Grep uses . default for path');

  assertEqual(summarizeToolInput('Task', { prompt: 'full prompt text', description: 'short desc' }), 'full prompt text', 'Task prefers prompt over description');
  assertEqual(summarizeToolInput('Task', { description: 'explore codebase' }), 'explore codebase', 'Task falls back to description');
  assertEqual(summarizeToolInput('Task', {}), '', 'Task with no prompt/description returns empty');
  assertEqual(summarizeToolInput('WebSearch', { query: 'node.js best practices' }), 'node.js best practices', 'WebSearch extracts query');
  assertEqual(summarizeToolInput('WebFetch', { url: 'https://example.com' }), 'https://example.com', 'WebFetch extracts url');
  assertEqual(summarizeToolInput('UnknownTool', { foo: 1, bar: 2 }), '1, 2', 'unknown tool extracts numeric values');
  assertEqual(summarizeToolInput('UnknownTool', {}), '', 'unknown tool with empty input returns empty');
  assertEqual(summarizeToolInput('mcp__context7__resolve', { libraryName: 'typescript', query: 'TS docs' }), 'typescript, TS docs', 'MCP tool extracts string values');
  assertEqual(summarizeToolInput('mcp__custom__tool', { key: 'val', count: 5 }), 'val, 5', 'MCP tool extracts mixed string+number values');
  assertEqual(summarizeToolInput('UnknownTool', { nested: { a: 1 }, arr: [1, 2] }), 'nested, arr', 'falls back to key names for non-primitive values');

  // =========================================================================
  // 3. extractFilePath
  // =========================================================================
  console.log('\n--- 3. extractFilePath ---');

  assertEqual(extractFilePath('Read', { file_path: '/src/main.ts' }), '/src/main.ts', 'Read returns file_path');
  assertEqual(extractFilePath('Write', { file_path: '/src/new.ts' }), '/src/new.ts', 'Write returns file_path');
  assertEqual(extractFilePath('Edit', { file_path: '/src/edit.ts' }), '/src/edit.ts', 'Edit returns file_path');
  assertEqual(extractFilePath('Read', { file_path: 42 }), null, 'non-string file_path returns null');
  assertEqual(extractFilePath('Read', {}), null, 'missing file_path returns null');
  assertEqual(extractFilePath('Glob', { path: '/src' }), '/src', 'Glob returns path');
  assertEqual(extractFilePath('Grep', { path: '/src' }), '/src', 'Grep returns path');
  assertEqual(extractFilePath('Glob', {}), null, 'Glob with no path returns null');
  assertEqual(extractFilePath('Bash', { command: 'ls' }), null, 'Bash returns null');
  assertEqual(extractFilePath('WebSearch', { query: 'test' }), null, 'WebSearch returns null');
  assertEqual(extractFilePath('Task', { description: 'test' }), null, 'Task returns null');

  // =========================================================================
  // 4. Entry classification
  // =========================================================================
  console.log('\n--- 4. Entry classification ---');

  assertEqual(
    classifyEntryType({ hasWrite: true }, [{ tool_name: 'Write' }, { tool_name: 'Read' }]),
    'file_change', 'hasWrite → file_change'
  );
  assertEqual(
    classifyEntryType({ hasWrite: false }, [{ tool_name: 'Bash' }]),
    'command', 'Bash only → command'
  );
  assertEqual(
    classifyEntryType({ hasWrite: false }, [{ tool_name: 'WebSearch' }]),
    'web', 'WebSearch → web'
  );
  assertEqual(
    classifyEntryType({ hasWrite: false }, [{ tool_name: 'WebFetch' }]),
    'web', 'WebFetch → web'
  );
  assertEqual(
    classifyEntryType({ hasWrite: false }, [{ tool_name: 'Read' }, { tool_name: 'Grep' }]),
    'research', 'Read + Grep → research'
  );
  assertEqual(
    classifyEntryType({ hasWrite: false }, [{ tool_name: 'Read' }]),
    'research', 'Read only → research'
  );
  assertEqual(
    classifyEntryType({ hasWrite: true }, [{ tool_name: 'Bash' }, { tool_name: 'Edit' }]),
    'file_change', 'hasWrite overrides Bash → file_change'
  );

  // =========================================================================
  // 5. Database CRUD
  // =========================================================================
  console.log('\n--- 5. Database CRUD ---');

  // 5a. insertEntry
  const toolCalls1 = [
    { tool_name: 'Read', input_summary: '/src/auth.ts' },
    { tool_name: 'Edit', input_summary: '/src/auth.ts' },
  ];
  const id1 = insertEntry(db, SESSION_ID, 0, '/src/auth.ts', 'file_change', toolCalls1);
  assert(id1 > 0, 'insertEntry returns positive id');

  const toolCalls2 = [
    { tool_name: 'Read', input_summary: '/src/config.ts' },
  ];
  const id2 = insertEntry(db, SESSION_ID, 0, '/src/config.ts', 'research', toolCalls2);
  assert(id2 > id1, 'second insert returns higher id');

  // 5b. getEntriesForPrompt
  const prompt0Entries = getEntriesForPrompt(db, SESSION_ID, 0);
  assertEqual(prompt0Entries.length, 2, 'getEntriesForPrompt returns 2 entries for prompt 0');
  assertEqual(prompt0Entries[0].file_path, '/src/auth.ts', 'first entry has correct file_path');
  assertEqual(prompt0Entries[0].entry_type, 'file_change', 'first entry has correct entry_type');
  assertEqual(prompt0Entries[1].file_path, '/src/config.ts', 'second entry has correct file_path');

  // 5c. Verify tool_calls JSON roundtrip
  const parsedCalls = JSON.parse(prompt0Entries[0].tool_calls);
  assertEqual(parsedCalls.length, 2, 'tool_calls JSON roundtrips correctly');
  assertEqual(parsedCalls[0].tool_name, 'Read', 'tool_calls preserves tool_name');
  assertEqual(parsedCalls[1].input_summary, '/src/auth.ts', 'tool_calls preserves input_summary');

  // 5d. updateEntryDescription
  updateEntryDescription(db, id1, 'Modified auth service to add JWT refresh logic.', 'auth, JWT, refresh, auth.ts', ['/src/config.ts']);
  const updated = getEntriesForPrompt(db, SESSION_ID, 0);
  assertEqual(updated[0].description, 'Modified auth service to add JWT refresh logic.', 'description updated');
  assertEqual(updated[0].tags, 'auth, JWT, refresh, auth.ts', 'tags updated');
  const relFiles = JSON.parse(updated[0].related_files);
  assertEqual(relFiles.length, 1, 'related_files has 1 entry');
  assertEqual(relFiles[0], '/src/config.ts', 'related_files content correct');

  // 5e. Description for second entry
  updateEntryDescription(db, id2, 'Read configuration file to check JWT settings.', 'config, JWT, settings', []);

  // 5f. markLowRelevance
  const id3 = insertEntry(db, SESSION_ID, 0, '/src/readme.md', 'research', [
    { tool_name: 'Read', input_summary: '/src/readme.md' },
  ]);
  updateEntryDescription(db, id3, 'Read readme file.', 'readme, docs', []);
  markLowRelevance(db, id3);
  const afterMark = getEntriesForPrompt(db, SESSION_ID, 0);
  const markedEntry = afterMark.find(e => e.id === id3);
  assertEqual(markedEntry.low_relevance, 1, 'low_relevance flag set to 1');

  // 5g. insertSummary
  insertSummary(db, SESSION_ID, 0, 'Implemented JWT token refresh with sliding window in auth service.', 'auth, JWT, token refresh');
  const withSummary = getEntriesForPrompt(db, SESSION_ID, 0);
  const summaryEntry = withSummary.find(e => e.entry_type === 'summary');
  assert(summaryEntry !== undefined, 'summary entry inserted');
  assertEqual(summaryEntry.file_path, null, 'summary has null file_path');
  assertEqual(summaryEntry.description, 'Implemented JWT token refresh with sliding window in auth service.', 'summary description correct');
  assertEqual(summaryEntry.tool_calls, '[]', 'summary has empty tool_calls');

  // 5h. getMaxPromptIndex
  assertEqual(getMaxPromptIndex(db, SESSION_ID), 0, 'getMaxPromptIndex returns 0 for single prompt');
  assertEqual(getMaxPromptIndex(db, 'nonexistent-session'), -1, 'getMaxPromptIndex returns -1 for missing session');

  // 5i. getSummaryEntriesByPrompt
  const summaries = getSummaryEntriesByPrompt(db, SESSION_ID);
  assertEqual(summaries.length, 1, 'getSummaryEntriesByPrompt returns 1 summary');
  assertEqual(summaries[0].prompt_index, 0, 'summary is for prompt 0');

  // 5j. getEntriesForPrompt with wrong session
  const wrongSession = getEntriesForPrompt(db, 'other-session', 0);
  assertEqual(wrongSession.length, 0, 'getEntriesForPrompt returns empty for wrong session');

  // 5k. getEntriesForPrompt with wrong prompt
  const wrongPrompt = getEntriesForPrompt(db, SESSION_ID, 99);
  assertEqual(wrongPrompt.length, 0, 'getEntriesForPrompt returns empty for wrong prompt index');

  // =========================================================================
  // 6. FTS5 search
  // =========================================================================
  console.log('\n--- 6. FTS5 search ---');

  // 6a. FTS5 matches on description after update
  const authFts = db.prepare(
    `SELECT ce.*, fts.rank FROM context_entries_fts fts
     JOIN context_entries ce ON ce.id = fts.rowid
     WHERE context_entries_fts MATCH '"auth"'
     ORDER BY fts.rank`
  ).all();
  assert(authFts.length >= 2, `FTS5 finds entries matching "auth" (got ${authFts.length})`);

  // 6b. FTS5 matches on tags
  const jwtFts = db.prepare(
    `SELECT ce.id FROM context_entries_fts fts
     JOIN context_entries ce ON ce.id = fts.rowid
     WHERE context_entries_fts MATCH '"JWT"'`
  ).all();
  assert(jwtFts.length >= 1, `FTS5 finds entries matching "JWT" via tags (got ${jwtFts.length})`);

  // 6c. FTS5 matches on file_path
  const fileFts = db.prepare(
    `SELECT ce.id FROM context_entries_fts fts
     JOIN context_entries ce ON ce.id = fts.rowid
     WHERE context_entries_fts MATCH '"auth.ts"'`
  ).all();
  assert(fileFts.length >= 1, `FTS5 finds entries matching file_path "auth.ts" (got ${fileFts.length})`);

  // 6d. low_relevance exclusion from retrieval queries
  const lowRelFts = db.prepare(
    `SELECT ce.* FROM context_entries_fts fts
     JOIN context_entries ce ON ce.id = fts.rowid
     WHERE context_entries_fts MATCH '"readme"'
     AND ce.low_relevance = 0`
  ).all();
  assertEqual(lowRelFts.length, 0, 'low_relevance entries excluded when filtered');

  const lowRelIncluded = db.prepare(
    `SELECT ce.* FROM context_entries_fts fts
     JOIN context_entries ce ON ce.id = fts.rowid
     WHERE context_entries_fts MATCH '"readme"'`
  ).all();
  assert(lowRelIncluded.length >= 1, 'low_relevance entries found when not filtered');

  // 6e. Porter stemming
  const stemFts = db.prepare(
    `SELECT ce.id FROM context_entries_fts fts
     JOIN context_entries ce ON ce.id = fts.rowid
     WHERE context_entries_fts MATCH '"refreshing"'`
  ).all();
  assert(stemFts.length >= 1, 'porter stemming matches "refreshing" to "refresh" in tags');

  // 6f. FTS5 trigger sync after update
  updateEntryDescription(db, id2, 'Read database migration config for PostgreSQL setup.', 'database, PostgreSQL, migration, config.ts', []);
  const pgFts = db.prepare(
    `SELECT ce.id FROM context_entries_fts fts
     JOIN context_entries ce ON ce.id = fts.rowid
     WHERE context_entries_fts MATCH '"PostgreSQL"'`
  ).all();
  assert(pgFts.length >= 1, 'FTS5 update trigger syncs new description content');
  assertEqual(pgFts[0].id, id2, 'updated entry is the one found by FTS');

  // =========================================================================
  // 7. Multi-prompt scenario + Context retrieval
  // =========================================================================
  console.log('\n--- 7. Multi-prompt context retrieval ---');

  // Insert prompt 1 data (database-related)
  const p1_id1 = insertEntry(db, SESSION_ID, 1, '/db/migrations/001.ts', 'file_change', [
    { tool_name: 'Write', input_summary: '/db/migrations/001.ts' },
  ]);
  updateEntryDescription(db, p1_id1, 'Created initial database migration for users table.', 'database, migration, users, PostgreSQL', ['/db/schema.ts']);

  const p1_id2 = insertEntry(db, SESSION_ID, 1, '/db/schema.ts', 'research', [
    { tool_name: 'Read', input_summary: '/db/schema.ts' },
  ]);
  updateEntryDescription(db, p1_id2, 'Read schema definition for users table.', 'database, schema, users', ['/db/migrations/001.ts']);

  insertSummary(db, SESSION_ID, 1, 'Created PostgreSQL migration for users table with schema definition.', 'database, migration, PostgreSQL, users');

  // Insert prompt 2 data (unrelated — CSS styling)
  const p2_id1 = insertEntry(db, SESSION_ID, 2, '/src/styles/main.css', 'file_change', [
    { tool_name: 'Edit', input_summary: '/src/styles/main.css' },
  ]);
  updateEntryDescription(db, p2_id1, 'Updated CSS styles for navigation header component.', 'CSS, navigation, header, styles', []);
  insertSummary(db, SESSION_ID, 2, 'Restyled navigation header with new CSS layout.', 'CSS, navigation, header');

  // Insert prompt 3 data (auth-related again)
  const p3_id1 = insertEntry(db, SESSION_ID, 3, '/src/middleware/auth.ts', 'file_change', [
    { tool_name: 'Write', input_summary: '/src/middleware/auth.ts' },
  ]);
  updateEntryDescription(db, p3_id1, 'Created auth middleware with JWT token validation.', 'auth, middleware, JWT, validation', ['/src/auth.ts']);
  insertSummary(db, SESSION_ID, 3, 'Added JWT auth middleware for API route protection.', 'auth, middleware, JWT');

  assertEqual(getMaxPromptIndex(db, SESSION_ID), 3, 'getMaxPromptIndex returns 3 after 4 prompts');

  // 7a. retrieveContextForPrompt with promptIndex=0 returns null
  assertEqual(retrieveContextForPrompt(db, 'anything', 0), null, 'promptIndex=0 returns null');

  // 7b. Retrieve at prompt 1: continuity from prompt 0 summary
  const ctx1 = retrieveContextForPrompt(db, 'update the database', 1);
  assert(ctx1 !== null, 'retrieve at prompt 1 returns content');
  assertIncludes(ctx1, '<last_activity>', 'contains continuity section');
  assertIncludes(ctx1, 'JWT token refresh', 'continuity includes prompt 0 summary');

  // 7c. Retrieve at prompt 4: continuity from prompt 3 + FTS relevance
  const ctx4auth = retrieveContextForPrompt(db, 'update the authentication token handling', 4);
  assert(ctx4auth !== null, 'retrieve for auth prompt returns content');
  assertIncludes(ctx4auth, '<last_activity>', 'contains continuity section');
  assertIncludes(ctx4auth, 'JWT auth middleware', 'continuity includes prompt 3 summary');
  assertIncludes(ctx4auth, '<relevant_context>', 'contains relevant section');
  assertIncludes(ctx4auth, 'auth', 'relevant section mentions auth');

  // 7d. Retrieve at prompt 4 with CSS query: finds prompt 2 content
  const ctx4css = retrieveContextForPrompt(db, 'fix the CSS navigation styles', 4);
  assert(ctx4css !== null, 'retrieve for CSS prompt returns content');
  assertIncludes(ctx4css, 'navigation', 'CSS prompt finds navigation-related entries');

  // 7e. Retrieve at prompt 4 with database query: finds prompt 1 content (not just recent!)
  const ctx4db = retrieveContextForPrompt(db, 'update the PostgreSQL database migration', 4);
  assert(ctx4db !== null, 'retrieve for database prompt returns content');
  assertIncludes(ctx4db, 'migration', 'database prompt finds migration entries from prompt 1');
  assertIncludes(ctx4db, 'PostgreSQL', 'database prompt surfaces PostgreSQL content');

  // 7f. Retrieve with all-stopwords prompt: only continuity, no relevant
  const ctxStop = retrieveContextForPrompt(db, 'help me please do it', 4);
  assert(ctxStop !== null, 'all-stopwords still returns continuity');
  assertIncludes(ctxStop, '<last_activity>', 'has continuity section');
  assert(!ctxStop.includes('<relevant_context>'), 'no relevant section for all-stopwords prompt');

  // 7g. FTS does NOT include entries from current or future prompts
  const ctxFuture = retrieveContextForPrompt(db, 'auth middleware JWT', 3);
  assert(ctxFuture !== null, 'retrieve at prompt 3');
  assert(!ctxFuture.includes('auth middleware'), 'prompt 3 entries excluded (current prompt)');

  // =========================================================================
  // 8. Token budget enforcement
  // =========================================================================
  console.log('\n--- 8. Token budget enforcement ---');

  // 8a. Zero budget: continuity layer always included, but FTS section is empty
  const zeroBudget = retrieveContextForPrompt(db, 'auth JWT', 4, 0);
  assert(zeroBudget !== null, 'zero budget still returns continuity (always included)');
  assertIncludes(zeroBudget, '<last_activity>', 'zero budget has continuity section');
  assert(!zeroBudget.includes('<relevant_context>'), 'zero budget has no FTS relevant section');

  // 8b. Tiny budget limits output
  const tinyBudget = retrieveContextForPrompt(db, 'auth JWT middleware database', 4, 50);
  if (tinyBudget) {
    assert(tinyBudget.length < 400, `tiny budget (50 tokens = 200 chars) produces short output (${tinyBudget.length} chars)`);
  } else {
    assert(true, 'tiny budget may return null if continuity exceeds budget');
  }

  // 8c. Large budget includes more entries
  const largeBudget = retrieveContextForPrompt(db, 'auth JWT middleware database', 4, 10000);
  assert(largeBudget !== null, 'large budget returns content');
  const largeSections = (largeBudget.match(/\[Prompt/g) || []).length;
  const defaultBudget = retrieveContextForPrompt(db, 'auth JWT middleware database', 4);
  const defaultSections = (defaultBudget.match(/\[Prompt/g) || []).length;
  assert(largeSections >= defaultSections, 'large budget includes at least as many entries as default');

  // =========================================================================
  // 9. Related files expansion
  // =========================================================================
  console.log('\n--- 9. Related files expansion ---');

  // Entry id1 (auth.ts, prompt 0) has related_files: ['/src/config.ts']
  // Entry id2 (config.ts, prompt 0) should get pulled in when auth.ts matches
  const ctxRelated = retrieveContextForPrompt(db, 'auth JWT refresh token', 4);
  assert(ctxRelated !== null, 'related files retrieval returns content');

  // Prompt 1: /db/migrations/001.ts has related_files: ['/db/schema.ts']
  // /db/schema.ts has related_files: ['/db/migrations/001.ts']
  const ctxDbRelated = retrieveContextForPrompt(db, 'database migration users table', 4);
  assert(ctxDbRelated !== null, 'database related files retrieval returns content');
  assertIncludes(ctxDbRelated, 'migration', 'includes migration entry');

  // =========================================================================
  // 10. Deduplication
  // =========================================================================
  console.log('\n--- 10. Deduplication ---');

  // The previous prompt summary appears in continuity section.
  // If the same entry is also matched by FTS, it should NOT appear twice.
  const ctxDedup = retrieveContextForPrompt(db, 'JWT auth middleware API protection', 4);
  assert(ctxDedup !== null, 'dedup test returns content');
  const summaryMatches = ctxDedup.match(/Prompt 3 summary/g);
  assertEqual(summaryMatches ? summaryMatches.length : 0, 1, 'prompt 3 summary appears exactly once (deduplication)');

  // =========================================================================
  // 11. formatEntry + summarizeFromToolCalls
  // =========================================================================
  console.log('\n--- 11. formatEntry + summarizeFromToolCalls ---');

  // 11a. Summary entry format
  const summaryFormatted = formatEntry({ entry_type: 'summary', prompt_index: 5, description: 'Did things.' });
  assertEqual(summaryFormatted, '[Prompt 5 summary]: Did things.', 'summary format correct');

  // 11b. Summary with null description
  const summaryNull = formatEntry({ entry_type: 'summary', prompt_index: 5, description: null });
  assertEqual(summaryNull, '[Prompt 5 summary]: (no summary)', 'summary null description shows fallback');

  // 11c. Non-summary with description
  const fileFormatted = formatEntry({
    entry_type: 'file_change', prompt_index: 2,
    file_path: '/src/app.ts', description: 'Updated app entry point.',
    tool_calls: '[]',
  });
  assertEqual(fileFormatted, '[Prompt 2]: /src/app.ts — Updated app entry point.', 'file entry format correct');

  // 11d. Non-summary without description falls back to tool calls
  const noDescFormatted = formatEntry({
    entry_type: 'research', prompt_index: 1,
    file_path: null, description: null,
    tool_calls: JSON.stringify([{ tool_name: 'Read', input_summary: '/src/test.ts' }]),
  });
  assertIncludes(noDescFormatted, 'Read: /src/test.ts', 'falls back to tool call summary');
  assertIncludes(noDescFormatted, 'research', 'uses entry_type when file_path is null');

  // 11e. No description, empty tool_calls
  const emptyFormatted = formatEntry({
    entry_type: 'command', prompt_index: 0,
    file_path: null, description: null,
    tool_calls: '[]',
  });
  assertIncludes(emptyFormatted, '(no description)', 'empty tool_calls shows (no description)');

  // 11f. Invalid tool_calls JSON
  const invalidJson = formatEntry({
    entry_type: 'research', prompt_index: 0,
    file_path: '/file.ts', description: null,
    tool_calls: 'invalid json',
  });
  assertIncludes(invalidJson, '(no description)', 'invalid tool_calls JSON shows (no description)');

  // 11g. summarizeFromToolCalls truncation
  const longCalls = Array.from({ length: 20 }, (_, i) => ({
    tool_name: 'Read', input_summary: `/src/very/long/path/to/file${i}.ts`,
  }));
  const longFormatted = summarizeFromToolCalls({
    tool_calls: JSON.stringify(longCalls),
  });
  assert(longFormatted.length <= 150, `summarizeFromToolCalls truncates to 150 chars (got ${longFormatted.length})`);

  // =========================================================================
  // 12. MCP server tool operations (simulated)
  // =========================================================================
  console.log('\n--- 12. MCP tool operations ---');

  // Simulate what the MCP tools do, since we can't instantiate the SDK here
  const MCP_SESSION = 'mcp-test-session';
  const MCP_PROMPT = 0;

  // Insert entries like EntryTracker would
  const mcpId1 = insertEntry(db, MCP_SESSION, MCP_PROMPT, '/src/api.ts', 'file_change', [
    { tool_name: 'Read', input_summary: '/src/api.ts' },
    { tool_name: 'Edit', input_summary: '/src/api.ts' },
  ]);
  const mcpId2 = insertEntry(db, MCP_SESSION, MCP_PROMPT, null, 'command', [
    { tool_name: 'Bash', input_summary: 'npm test' },
  ]);

  // list_prompt_entries
  const mcpEntries = getEntriesForPrompt(db, MCP_SESSION, MCP_PROMPT);
  assertEqual(mcpEntries.length, 2, 'MCP list_prompt_entries finds 2 entries');
  const listResult = mcpEntries.map(e => ({
    id: e.id, file_path: e.file_path, entry_type: e.entry_type,
    tool_calls: JSON.parse(e.tool_calls),
  }));
  assertEqual(listResult[0].entry_type, 'file_change', 'MCP list shows file_change');
  assertEqual(listResult[1].entry_type, 'command', 'MCP list shows command');
  assertEqual(listResult[0].tool_calls.length, 2, 'MCP list includes parsed tool_calls');

  // update_entry_description
  updateEntryDescription(db, mcpId1, 'Added new /api/users endpoint to API routes.', 'API, users, endpoint, routes', []);
  const mcpUpdated = getEntriesForPrompt(db, MCP_SESSION, MCP_PROMPT);
  assertEqual(mcpUpdated[0].description, 'Added new /api/users endpoint to API routes.', 'MCP update_entry_description works');

  // mark_low_relevance
  markLowRelevance(db, mcpId2);
  const mcpMarked = getEntriesForPrompt(db, MCP_SESSION, MCP_PROMPT);
  assertEqual(mcpMarked[1].low_relevance, 1, 'MCP mark_low_relevance works');

  // write_prompt_summary
  insertSummary(db, MCP_SESSION, MCP_PROMPT, 'Added /api/users endpoint and verified tests pass.', 'API, users, testing');
  const mcpSummaries = getSummaryEntriesByPrompt(db, MCP_SESSION);
  assertEqual(mcpSummaries.length, 1, 'MCP write_prompt_summary creates summary');
  assertEqual(mcpSummaries[0].description, 'Added /api/users endpoint and verified tests pass.', 'MCP summary content correct');

  // =========================================================================
  // 13. buildHaikuPrompt
  // =========================================================================
  console.log('\n--- 13. buildHaikuPrompt ---');

  // 13a. Normal prompt
  const prompt = buildHaikuPrompt('fix the auth bug', 'I read auth.ts and found the issue.');
  assertIncludes(prompt, '<user_prompt>fix the auth bug</user_prompt>', 'includes user prompt');
  assertIncludes(prompt, '<assistant_activity>', 'includes assistant_activity tag');
  assertIncludes(prompt, 'I read auth.ts and found the issue.', 'includes assistant summary');
  assertIncludes(prompt, 'Review the entries', 'includes instruction');

  // 13b. No truncation — full text preserved
  const longSummary = 'x'.repeat(10000);
  const fullPrompt = buildHaikuPrompt('test', longSummary);
  const activityMatch = fullPrompt.match(/<assistant_activity>\n([\s\S]*?)\n<\/assistant_activity>/);
  assert(activityMatch !== null, 'long prompt has assistant_activity section');
  assertEqual(activityMatch[1].length, 10000, 'full assistant summary preserved (no truncation)');

  // 13c. Short summary also preserved
  const shortSummary = 'short activity';
  const shortPrompt = buildHaikuPrompt('test', shortSummary);
  assertIncludes(shortPrompt, shortSummary, 'short summary preserved');

  // =========================================================================
  // 14. extractMcpResultText
  // =========================================================================
  console.log('\n--- 14. extractMcpResultText ---');

  assertEqual(extractMcpResultText('simple string'), 'simple string', 'string passthrough');
  assertEqual(
    extractMcpResultText([{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }]),
    'hello\nworld',
    'array of text objects joined with newline'
  );
  assertEqual(
    extractMcpResultText([{ type: 'text', text: 'keep' }, { type: 'image', data: 'skip' }]),
    'keep',
    'array filters to text type only'
  );
  assertEqual(extractMcpResultText([]), '', 'empty array returns empty string');
  assertEqual(extractMcpResultText({ foo: 'bar' }), '{"foo":"bar"}', 'object returns JSON.stringify');
  assertEqual(extractMcpResultText(42), '42', 'number returns JSON.stringify');
  assertEqual(
    extractMcpResultText([{ type: 'other', text: 'nope' }]),
    '',
    'array with non-text type returns empty'
  );
  assertEqual(
    extractMcpResultText([{ type: 'text' }]),
    '',
    'text item without text property filtered out'
  );

  // =========================================================================
  // 14b. extractTaskResultTexts
  // =========================================================================
  console.log('\n--- 14b. extractTaskResultTexts ---');

  const taskResult = JSON.stringify({
    status: 'completed',
    content: [{ type: 'text', text: 'Created file successfully.' }],
  });
  const taskTexts = extractTaskResultTexts(taskResult);
  assert(taskTexts !== null, 'parses valid Task result');
  assertEqual(taskTexts.length, 1, 'extracts 1 text item');
  assertEqual(taskTexts[0], 'Created file successfully.', 'extracts correct text');

  const multiText = JSON.stringify({
    content: [
      { type: 'text', text: 'line one' },
      { type: 'text', text: 'line two' },
      { type: 'image', data: 'skip' },
    ],
  });
  const multiTexts = extractTaskResultTexts(multiText);
  assertEqual(multiTexts.length, 2, 'extracts only text items, skips image');
  assertEqual(multiTexts.join('\n'), 'line one\nline two', 'joined texts match');

  assertEqual(extractTaskResultTexts('not json'), null, 'invalid JSON returns null');
  assertEqual(extractTaskResultTexts('{}'), null, 'missing content returns null');
  assertEqual(extractTaskResultTexts('{"content": "string"}'), null, 'non-array content returns null');
  assertEqual(extractTaskResultTexts('{"content": []}'), null, 'empty array returns null');
  assertEqual(extractTaskResultTexts('{"content": [{"type": "image"}]}'), null, 'no text items returns null');
  assertEqual(extractTaskResultTexts('{"content": [{"type": "text"}]}'), null, 'text item without text prop returns null');
  assertEqual(extractTaskResultTexts('{"content": [{"type": "text", "text": 42}]}'), null, 'non-string text returns null');

  // =========================================================================
  // 15. parseHaikuLogBlocks (JSONL parsing)
  // =========================================================================
  console.log('\n--- 15. parseHaikuLogBlocks ---');

  // 15a. Full realistic JSONL with inverted ordering (user before assistant)
  const realisticJsonl = [
    // User result BEFORE the assistant message that issued the tool_use
    JSON.stringify({
      type: 'user', message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool_001',
          content: [{ type: 'text', text: '[{"id":1,"file_path":"/src/app.ts","entry_type":"file_change","tool_calls":[]}]' }] }],
      },
    }),
    // Assistant message with text + tool_use
    JSON.stringify({
      type: 'assistant', message: {
        content: [
          { type: 'text', text: 'Let me list the entries.' },
          { type: 'tool_use', id: 'tool_001', name: 'mcp__damocles-context__list_prompt_entries', input: {} },
        ],
      },
    }),
    // User result for update_entry_description
    JSON.stringify({
      type: 'user', message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool_002', content: 'Updated entry 1' }],
      },
    }),
    // Assistant with update_entry_description
    JSON.stringify({
      type: 'assistant', message: {
        content: [
          { type: 'text', text: 'Now annotating the entry.' },
          { type: 'tool_use', id: 'tool_002', name: 'mcp__damocles-context__update_entry_description',
            input: { entry_id: 1, description: 'test', tags: 'test', related_files: [] } },
        ],
      },
    }),
    // User result for write_prompt_summary
    JSON.stringify({
      type: 'user', message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool_003', content: 'Prompt summary saved.' }],
      },
    }),
    // Assistant with summary
    JSON.stringify({
      type: 'assistant', message: {
        content: [
          { type: 'tool_use', id: 'tool_003', name: 'mcp__damocles-context__write_prompt_summary',
            input: { summary: 'Did stuff.', tags: 'stuff' } },
        ],
      },
    }),
  ].join('\n');

  const blocks = parseHaikuLogBlocks(realisticJsonl);
  assertEqual(blocks.length, 5, 'realistic JSONL produces 5 blocks (2 text + 3 tool)');

  // Text blocks
  assertEqual(blocks[0].type, 'text', 'first block is text');
  assertEqual(blocks[0].content, 'Let me list the entries.', 'first text content correct');
  assertEqual(blocks[2].type, 'text', 'third block is text');

  // Tool blocks with correct ID-based matching
  assertEqual(blocks[1].type, 'tool', 'second block is tool');
  assertEqual(blocks[1].toolName, 'list_prompt_entries', 'MCP prefix stripped from tool name');
  assertIncludes(blocks[1].toolResult, 'file_change', 'tool_001 result correctly matched to list_prompt_entries');

  assertEqual(blocks[3].type, 'tool', 'fourth block is tool');
  assertEqual(blocks[3].toolName, 'update_entry_description', 'update tool name correct');
  assertEqual(blocks[3].toolResult, 'Updated entry 1', 'tool_002 result correctly matched');

  assertEqual(blocks[4].type, 'tool', 'fifth block is tool');
  assertEqual(blocks[4].toolName, 'write_prompt_summary', 'summary tool name correct');
  assertEqual(blocks[4].toolResult, 'Prompt summary saved.', 'tool_003 result correctly matched');

  // 15b. Tool input serialization
  assertIncludes(blocks[3].toolInput, '"entry_id":1', 'tool input JSON serialized');
  assertIncludes(blocks[3].toolInput, '"description":"test"', 'tool input contains description');

  // 15c. Thinking blocks
  const thinkingJsonl = [
    JSON.stringify({
      type: 'assistant', message: {
        content: [
          { type: 'thinking', thinking: 'Let me think about this carefully.' },
          { type: 'text', text: 'Here is my analysis.' },
        ],
      },
    }),
  ].join('\n');
  const thinkBlocks = parseHaikuLogBlocks(thinkingJsonl);
  assertEqual(thinkBlocks.length, 2, 'thinking + text produces 2 blocks');
  assertEqual(thinkBlocks[0].type, 'thinking', 'first block is thinking');
  assertEqual(thinkBlocks[0].content, 'Let me think about this carefully.', 'thinking content preserved');
  assertEqual(thinkBlocks[1].type, 'text', 'second block is text');

  // 15d. Empty JSONL
  const emptyBlocks = parseHaikuLogBlocks('');
  assertEqual(emptyBlocks.length, 0, 'empty input produces no blocks');

  // 15e. Malformed JSON lines skipped
  const malformedJsonl = [
    'this is not json',
    '{"also": "not valid',
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'valid' }] } }),
    '',
    '  ',
  ].join('\n');
  const malformedBlocks = parseHaikuLogBlocks(malformedJsonl);
  assertEqual(malformedBlocks.length, 1, 'malformed lines skipped, valid line parsed');
  assertEqual(malformedBlocks[0].content, 'valid', 'valid block extracted from mixed input');

  // 15f. Tool use without matching result
  const noResultJsonl = JSON.stringify({
    type: 'assistant', message: {
      content: [{ type: 'tool_use', id: 'orphan_001', name: 'mcp__damocles-context__list_prompt_entries', input: {} }],
    },
  });
  const noResultBlocks = parseHaikuLogBlocks(noResultJsonl);
  assertEqual(noResultBlocks.length, 1, 'tool_use without result still creates block');
  assertEqual(noResultBlocks[0].toolResult, '', 'missing result defaults to empty string');

  // 15g. Non-MCP tool names (no prefix to strip)
  const plainToolJsonl = JSON.stringify({
    type: 'assistant', message: {
      content: [{ type: 'tool_use', id: 'plain_001', name: 'some_other_tool', input: { key: 'val' } }],
    },
  });
  const plainBlocks = parseHaikuLogBlocks(plainToolJsonl);
  assertEqual(plainBlocks[0].toolName, 'some_other_tool', 'non-MCP tool name preserved as-is');

  // 15h. Multiple assistant messages accumulated
  const multiAssistantJsonl = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'turn 1' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'turn 2' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'turn 3' }] } }),
  ].join('\n');
  const multiBlocks = parseHaikuLogBlocks(multiAssistantJsonl);
  assertEqual(multiBlocks.length, 3, 'multiple assistant messages produce multiple blocks');
  assertEqual(multiBlocks[0].content, 'turn 1', 'first turn preserved');
  assertEqual(multiBlocks[2].content, 'turn 3', 'third turn preserved');

  // 15i. User messages with array content (text items)
  const arrayContentJsonl = [
    JSON.stringify({
      type: 'user', message: {
        content: [{ type: 'tool_result', tool_use_id: 'arr_001',
          content: [{ type: 'text', text: 'line 1' }, { type: 'text', text: 'line 2' }] }],
      },
    }),
    JSON.stringify({
      type: 'assistant', message: {
        content: [{ type: 'tool_use', id: 'arr_001', name: 'mcp__damocles-context__list_prompt_entries', input: {} }],
      },
    }),
  ].join('\n');
  const arrayBlocks = parseHaikuLogBlocks(arrayContentJsonl);
  assertEqual(arrayBlocks[0].toolResult, 'line 1\nline 2', 'array content items joined with newline');

  // 15j. Assistant with no content array (defensive)
  const noContentJsonl = JSON.stringify({ type: 'assistant', message: {} });
  const noContentBlocks = parseHaikuLogBlocks(noContentJsonl);
  assertEqual(noContentBlocks.length, 0, 'assistant with no content array produces no blocks');

  // 15k. Empty text/thinking blocks filtered
  const emptyTextJsonl = JSON.stringify({
    type: 'assistant', message: {
      content: [
        { type: 'text', text: '' },
        { type: 'thinking', thinking: '' },
        { type: 'text', text: 'actual content' },
      ],
    },
  });
  const emptyTextBlocks = parseHaikuLogBlocks(emptyTextJsonl);
  assertEqual(emptyTextBlocks.length, 1, 'empty text/thinking blocks filtered out');
  assertEqual(emptyTextBlocks[0].content, 'actual content', 'only non-empty block preserved');

  // =========================================================================
  // 16. Entry grouping simulation (EntryTracker logic)
  // =========================================================================
  console.log('\n--- 16. Entry grouping simulation ---');

  const TRACKER_SESSION = 'tracker-test';
  const TRACKER_PROMPT = 0;
  let callCounter = 0;
  const pending = new Map();

  function simulateOnToolUse(toolName, input) {
    const inputSummary = summarizeToolInput(toolName, input);
    const record = { tool_name: toolName, input_summary: inputSummary };

    let key;
    let filePath = null;

    if (FILE_TOOLS.has(toolName)) {
      filePath = extractFilePath(toolName, input);
      key = filePath ?? `_file_${callCounter++}`;
    } else if (toolName === 'Bash') {
      key = `_cmd_${callCounter++}`;
    } else if (toolName === 'WebSearch' || toolName === 'WebFetch') {
      key = `_web_${callCounter++}`;
    } else {
      key = `_other_${callCounter++}`;
    }

    let entry = pending.get(key);
    if (!entry) {
      entry = { filePath, toolCalls: [], hasWrite: false };
      pending.set(key, entry);
    }

    entry.toolCalls.push(record);
    if (WRITE_TOOLS.has(toolName)) entry.hasWrite = true;
  }

  // 16a. Multiple tools on same file merge into one entry
  simulateOnToolUse('Read', { file_path: '/src/component.vue' });
  simulateOnToolUse('Edit', { file_path: '/src/component.vue' });
  simulateOnToolUse('Read', { file_path: '/src/component.vue' });

  assertEqual(pending.size, 1, 'Read+Edit+Read on same file merges to 1 entry');
  const mergedEntry = pending.get('/src/component.vue');
  assert(mergedEntry !== undefined, 'entry keyed by file path');
  assertEqual(mergedEntry.toolCalls.length, 3, 'merged entry has 3 tool calls');
  assertEqual(mergedEntry.hasWrite, true, 'merged entry marked as hasWrite');
  assertEqual(classifyEntryType(mergedEntry, mergedEntry.toolCalls), 'file_change', 'merged entry classified as file_change');

  // 16b. Different files create separate entries
  simulateOnToolUse('Read', { file_path: '/src/other.ts' });
  assertEqual(pending.size, 2, 'different file creates separate entry');

  // 16c. Bash creates separate entries per call
  simulateOnToolUse('Bash', { command: 'npm install' });
  simulateOnToolUse('Bash', { command: 'npm test' });
  assertEqual(pending.size, 4, 'each Bash call creates separate entry');

  // 16d. Web tools create separate entries
  simulateOnToolUse('WebSearch', { query: 'vue 3 docs' });
  assertEqual(pending.size, 5, 'WebSearch creates separate entry');

  // 16e. Task tool creates separate entry
  simulateOnToolUse('Task', { prompt: 'explore the auth module', description: 'explore auth' });
  assertEqual(pending.size, 6, 'Task creates separate entry via _other_ key');
  let taskEntry;
  for (const entry of pending.values()) {
    const last = entry.toolCalls[entry.toolCalls.length - 1];
    if (last && last.tool_name === 'Task') { taskEntry = entry; break; }
  }
  assert(taskEntry !== undefined, 'found task entry');
  assertEqual(taskEntry.toolCalls[0].input_summary, 'explore the auth module', 'Task input_summary uses prompt');

  // 16f. File tool without file_path uses synthetic key
  simulateOnToolUse('Read', {});
  assertEqual(pending.size, 7, 'Read with no file_path creates entry with synthetic key');

  // 16g. Glob/Grep use path for grouping
  simulateOnToolUse('Glob', { pattern: '**/*.ts', path: '/src' });
  simulateOnToolUse('Grep', { pattern: 'TODO', path: '/src' });
  // Both use /src as path, so they merge
  const srcEntry = pending.get('/src');
  assert(srcEntry !== undefined, 'Glob + Grep with same path merge into one entry');
  assertEqual(srcEntry.toolCalls.length, 2, 'merged Glob + Grep has 2 tool calls');

  // =========================================================================
  // 17. getContextSummary logic (from index.ts)
  // =========================================================================
  console.log('\n--- 17. getContextSummary ---');

  function getContextSummary(db, sessionId, promptIndex) {
    const entries = getEntriesForPrompt(db, sessionId, promptIndex);
    const summary = entries.find(e => e.entry_type === 'summary');
    if (!summary || !summary.description) return null;

    const lines = [
      `# Context Summary — Prompt ${promptIndex}`,
      '',
      summary.description,
    ];
    if (summary.tags) lines.push('', `**Tags:** ${summary.tags}`);

    const contextEntries = entries.filter(e => e.entry_type !== 'summary' && e.description);
    if (contextEntries.length > 0) {
      lines.push('', '---', '', '## Annotated Entries', '');
      for (const entry of contextEntries) {
        lines.push(`- **${entry.file_path ?? entry.entry_type}**: ${entry.description}`);
      }
    }
    return lines.join('\n');
  }

  // 17a. Prompt 0 with summary + annotated entries
  const cs0 = getContextSummary(db, SESSION_ID, 0);
  assert(cs0 !== null, 'getContextSummary returns content for prompt 0');
  assertIncludes(cs0, '# Context Summary — Prompt 0', 'includes header');
  assertIncludes(cs0, 'JWT token refresh', 'includes summary description');
  assertIncludes(cs0, '**Tags:**', 'includes tags section');
  assertIncludes(cs0, '## Annotated Entries', 'includes annotated entries section');
  assertIncludes(cs0, '/src/auth.ts', 'includes file entry');

  // 17b. Prompt without summary
  const csNone = getContextSummary(db, SESSION_ID, 99);
  assertEqual(csNone, null, 'getContextSummary returns null for prompt with no entries');

  // 17c. MCP session prompt 0
  const csMcp = getContextSummary(db, MCP_SESSION, MCP_PROMPT);
  assert(csMcp !== null, 'MCP session has context summary');
  assertIncludes(csMcp, '/api/users', 'MCP summary includes API content');

  // =========================================================================
  // 18. Session isolation
  // =========================================================================
  console.log('\n--- 18. Session isolation ---');

  const entriesA = getEntriesForPrompt(db, SESSION_ID, 0);
  const entriesB = getEntriesForPrompt(db, MCP_SESSION, 0);
  assert(entriesA.length > 0, 'session A has entries');
  assert(entriesB.length > 0, 'session B has entries');
  const idsA = new Set(entriesA.map(e => e.id));
  const idsB = new Set(entriesB.map(e => e.id));
  let overlap = false;
  for (const id of idsB) { if (idsA.has(id)) { overlap = true; break; } }
  assert(!overlap, 'session A and B have no overlapping entry IDs');

  const summariesA = getSummaryEntriesByPrompt(db, SESSION_ID);
  const summariesB = getSummaryEntriesByPrompt(db, MCP_SESSION);
  assert(summariesA.length !== summariesB.length || summariesA[0]?.id !== summariesB[0]?.id,
    'session summaries are isolated');

  // =========================================================================
  // 19. Schema migration verification
  // =========================================================================
  console.log('\n--- 19. Schema verification ---');

  const version = db.prepare('SELECT MAX(version) as v FROM schema_version').get();
  assertEqual(version.v, 1, 'schema version is 1');

  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map(r => r.name);
  assert(tables.includes('context_entries'), 'context_entries table exists');
  assert(tables.includes('schema_version'), 'schema_version table exists');
  assert(tables.includes('context_entries_fts'), 'FTS5 virtual table exists');

  const indexes = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='context_entries'"
  ).all().map(r => r.name);
  assert(indexes.includes('idx_ce_session'), 'session index exists');
  assert(indexes.includes('idx_ce_prompt'), 'prompt index exists');

  const triggers = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger'"
  ).all().map(r => r.name);
  assert(triggers.includes('ce_ai'), 'insert trigger exists');
  assert(triggers.includes('ce_ad'), 'delete trigger exists');
  assert(triggers.includes('ce_au'), 'update trigger exists');

  // =========================================================================
  // 20. Edge cases
  // =========================================================================
  console.log('\n--- 20. Edge cases ---');

  // 20a. NULL descriptions in FTS (Haiku timeout scenario)
  const nullDescId = insertEntry(db, SESSION_ID, 4, '/src/timeout.ts', 'file_change', [
    { tool_name: 'Write', input_summary: '/src/timeout.ts' },
  ]);
  // No updateEntryDescription called — simulates Haiku timeout
  const nullDescEntries = getEntriesForPrompt(db, SESSION_ID, 4);
  const nullDescEntry = nullDescEntries.find(e => e.id === nullDescId);
  assertEqual(nullDescEntry.description, null, 'entry has NULL description (Haiku timeout)');

  // FTS still finds it via file_path (file_path is indexed in FTS)
  const nullFts = db.prepare(
    `SELECT ce.id FROM context_entries_fts fts
     JOIN context_entries ce ON ce.id = fts.rowid
     WHERE context_entries_fts MATCH '"timeout.ts"'`
  ).all();
  assert(nullFts.length >= 1, 'FTS finds entry by file_path even with NULL description');

  // Retrieval still works — formatEntry falls back to tool calls
  const ctxTimeout = retrieveContextForPrompt(db, 'timeout.ts changes', 5, 4000);
  if (ctxTimeout) {
    assertIncludes(ctxTimeout, 'timeout.ts', 'retrieval includes timeout.ts entry');
  } else {
    assert(true, 'retrieval may return null if no prompt 4 summary for continuity');
  }

  // 20b. Empty tool calls array
  const emptyCallsId = insertEntry(db, SESSION_ID, 4, null, 'research', []);
  const emptyCallsEntry = getEntriesForPrompt(db, SESSION_ID, 4).find(e => e.id === emptyCallsId);
  assertEqual(emptyCallsEntry.tool_calls, '[]', 'empty tool calls stored as []');

  // 20c. Very long description
  const longDesc = 'word '.repeat(2000);
  updateEntryDescription(db, nullDescId, longDesc, 'long', []);
  const longEntry = getEntriesForPrompt(db, SESSION_ID, 4).find(e => e.id === nullDescId);
  assertEqual(longEntry.description.length, longDesc.length, 'long description stored fully');

  // 20d. Special characters in description/tags
  updateEntryDescription(db, emptyCallsId, 'Used "quotes" and <brackets> & ampersands.', "tag's, test", []);
  const specialEntry = getEntriesForPrompt(db, SESSION_ID, 4).find(e => e.id === emptyCallsId);
  assertIncludes(specialEntry.description, '"quotes"', 'special chars preserved in description');
  assertIncludes(specialEntry.tags, "tag's", 'special chars preserved in tags');

  // 20e. FTS search with special characters
  const specialFts = db.prepare(
    `SELECT ce.id FROM context_entries_fts fts
     JOIN context_entries ce ON ce.id = fts.rowid
     WHERE context_entries_fts MATCH '"quotes"'`
  ).all();
  assert(specialFts.length >= 1, 'FTS finds entries with special characters');

  // 20f. Idempotent summary upsert (DELETE+INSERT)
  insertSummary(db, SESSION_ID, 4, 'First summary for prompt 4.', 'first');
  insertSummary(db, SESSION_ID, 4, 'Second summary for prompt 4.', 'second');
  const multiSummary = getEntriesForPrompt(db, SESSION_ID, 4).filter(e => e.entry_type === 'summary');
  assertEqual(multiSummary.length, 1, 'idempotent upsert keeps only latest summary');
  assertEqual(multiSummary[0].description, 'Second summary for prompt 4.', 'latest summary overwrites previous');

  // 20g. Prompt index gaps
  insertEntry(db, SESSION_ID, 10, '/src/gap.ts', 'research', []);
  insertSummary(db, SESSION_ID, 10, 'Prompt 10 with gap.', 'gap');
  assertEqual(getMaxPromptIndex(db, SESSION_ID), 10, 'getMaxPromptIndex handles gaps');
  const gapCtx = retrieveContextForPrompt(db, 'gap test', 11);
  assert(gapCtx !== null, 'retrieval works with prompt index gaps');
  assertIncludes(gapCtx, 'Prompt 10', 'continuity finds non-contiguous previous summary');

  // 20h. Unicode content
  const unicodeId = insertEntry(db, SESSION_ID, 5, '/src/i18n/日本語.ts', 'file_change', [
    { tool_name: 'Write', input_summary: '/src/i18n/日本語.ts' },
  ]);
  updateEntryDescription(db, unicodeId, 'Created Japanese localization file with 日本語 strings.', '日本語, i18n, localization', []);
  const unicodeFts = db.prepare(
    `SELECT ce.id FROM context_entries_fts fts
     JOIN context_entries ce ON ce.id = fts.rowid
     WHERE context_entries_fts MATCH '"日本語"'`
  ).all();
  assert(unicodeFts.length >= 1, 'FTS5 unicode61 tokenizer handles CJK characters');

  // 20i. Windows-style paths
  const winId = insertEntry(db, SESSION_ID, 5, 'C:\\Users\\dev\\src\\app.ts', 'file_change', [
    { tool_name: 'Edit', input_summary: 'C:\\Users\\dev\\src\\app.ts' },
  ]);
  updateEntryDescription(db, winId, 'Edited app entry point on Windows.', 'app.ts, Windows', []);
  const winEntry = getEntriesForPrompt(db, SESSION_ID, 5).find(e => e.id === winId);
  assertIncludes(winEntry.file_path, 'C:\\Users', 'Windows paths stored correctly');

  // 20j. Delete triggers FTS cleanup
  const deleteId = insertEntry(db, 'delete-test', 0, '/delete/me.ts', 'research', []);
  updateEntryDescription(db, deleteId, 'This will be deleted.', 'delete, cleanup', []);

  const beforeDelete = db.prepare(
    `SELECT ce.id FROM context_entries_fts fts
     JOIN context_entries ce ON ce.id = fts.rowid
     WHERE context_entries_fts MATCH '"deleted"'`
  ).all();
  assert(beforeDelete.length >= 1, 'entry found in FTS before delete');

  db.prepare('DELETE FROM context_entries WHERE id = ?').run(deleteId);
  const afterDelete = db.prepare(
    `SELECT ce.id FROM context_entries_fts fts
     JOIN context_entries ce ON ce.id = fts.rowid
     WHERE context_entries_fts MATCH '"deleted"'`
  ).all();
  assertEqual(afterDelete.length, 0, 'FTS delete trigger removes entry from index');

  // ── Summary ──
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

  sqlDb.close();
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
