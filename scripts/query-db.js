const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const os = require('os');
const path = require('path');

function main() {
  const sessionId = process.argv[2];
  if (!sessionId) { console.error('Usage: node query-db.js <sessionId>'); process.exit(1); }

  const dbPath = path.join(os.homedir(), '.damocles', 'context', 'distill', sessionId + '.db');
  if (!fs.existsSync(dbPath)) { console.error('DB not found: ' + dbPath); process.exit(1); }
  const db = new DatabaseSync(dbPath, { readOnly: true });

  console.log('=== ALL ENTRIES ===');
  const entries = db.prepare('SELECT id, prompt_index, file_path, entry_type, description, tags, tool_calls FROM context_entries ORDER BY id').all();
  for (const row of entries) {
    console.log('--- Entry ' + row.id + ' (prompt ' + row.prompt_index + ', type: ' + row.entry_type + ') ---');
    console.log('  file_path: ' + row.file_path);
    console.log('  description: ' + row.description);
    console.log('  tags: ' + row.tags);
    const tc = row.tool_calls;
    if (tc && tc !== '[]') {
      const parsed = JSON.parse(tc);
      parsed.forEach(function(t) {
        console.log('  tool: ' + t.tool_name);
        console.log('    input_summary: ' + t.input_summary);
      });
    }
    console.log();
  }

  console.log('=== FTS5 INDEX ===');
  const fts = db.prepare('SELECT rowid, * FROM context_entries_fts').all();
  if (fts.length) {
    for (const row of fts) {
      const vals = Object.values(row);
      console.log('FTS rowid: ' + row.rowid + ' | file: ' + String(vals[1] || '').substring(0, 50) + ' | desc: ' + String(vals[2] || '').substring(0, 100) + ' | tags: ' + vals[3]);
    }
  } else {
    console.log('(no FTS entries)');
  }

  db.close();
}
main();
