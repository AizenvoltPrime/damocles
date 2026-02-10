const initSqlJs = require('sql.js-fts5');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function main() {
  const sessionId = process.argv[2];
  if (!sessionId) { console.error('Usage: node query-db.js <sessionId>'); process.exit(1); }

  const wasmBinary = fs.readFileSync(path.join(require.resolve('sql.js-fts5'), '..', 'sql-wasm.wasm'));
  const SQL = await initSqlJs({ wasmBinary });
  const dbPath = path.join(os.homedir(), '.damocles', 'context', 'distill', sessionId + '.db');
  const data = fs.readFileSync(dbPath);
  const db = new SQL.Database(data);

  console.log('=== ALL ENTRIES ===');
  const entries = db.exec('SELECT id, prompt_index, file_path, entry_type, description, tags, tool_calls FROM context_entries ORDER BY id');
  if (entries.length) {
    entries[0].values.forEach(function(row) {
      console.log('--- Entry ' + row[0] + ' (prompt ' + row[1] + ', type: ' + row[3] + ') ---');
      console.log('  file_path: ' + row[2]);
      console.log('  description: ' + row[4]);
      console.log('  tags: ' + row[5]);
      const tc = row[6];
      if (tc && tc !== '[]') {
        const parsed = JSON.parse(tc);
        parsed.forEach(function(t) {
          console.log('  tool: ' + t.tool_name);
          console.log('    input_summary: ' + t.input_summary);
        });
      }
      console.log();
    });
  }

  console.log('=== FTS5 INDEX ===');
  const fts = db.exec('SELECT rowid, * FROM context_entries_fts');
  if (fts.length) {
    fts[0].values.forEach(function(row) {
      console.log('FTS rowid: ' + row[0] + ' | file: ' + (row[1] || '').substring(0, 50) + ' | desc: ' + (row[2] || '').substring(0, 100) + ' | tags: ' + row[3]);
    });
  } else {
    console.log('(no FTS entries)');
  }

  db.close();
}
main().catch(console.error);
