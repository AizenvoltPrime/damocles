// Schema-skew tests assert "nothing was written" through this: it reads through the WAL, and a checkpoint that folds another app's frames leaves it unchanged.
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/** A hash of every table's rows plus `user_version`, read from a fresh read-only connection. */
export function sqliteContentFingerprint(dbPath: string): string {
  const raw = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
  try {
    const hash = createHash('sha256');
    hash.update(JSON.stringify(raw.prepare('PRAGMA user_version').get()));
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
    for (const { name } of tables) {
      hash.update(name).update(JSON.stringify(raw.prepare(`SELECT * FROM "${name}"`).all()));
    }
    return hash.digest('hex');
  } finally {
    raw.close();
  }
}
