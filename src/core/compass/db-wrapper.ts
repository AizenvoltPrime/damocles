import * as fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { log } from '../logger';

type NodeDatabaseSync = InstanceType<typeof DatabaseSync>;
type NodeStatementSync = ReturnType<NodeDatabaseSync['prepare']>;

type SqlParam = null | number | bigint | string | Buffer | Uint8Array;

interface RunResult {
	changes: number;
}

export interface PreparedStatement {
	run(...params: unknown[]): RunResult;
	get(...params: unknown[]): Record<string, unknown> | undefined;
	all(...params: unknown[]): Record<string, unknown>[];
}

export interface DbWrapper {
	prepare(sql: string): PreparedStatement;
	exec(sql: string): void;
	inTransaction(): boolean;
	isDirty(): boolean;
	clearDirty(): void;
	/** Fold the WAL into the main file. Returns true only when it fully folded (no busy reader). */
	checkpoint(): boolean;
	export(): Uint8Array;
	close(): void;
}

const TRANSACTION_KEYWORDS = 'BEGIN|COMMIT|END|ROLLBACK';
/** END is excluded from transition tracking: trigger DDL bodies terminate with `; END`, and no Compass SQL commits via END. */
const TRANSACTION_STATEMENT_RE = /(?:^|;)\s*(BEGIN|COMMIT|ROLLBACK)\b/gi;
const PURE_TRANSACTION_SQL_RE = new RegExp(
	`^[\\s;]*(?:(?:${TRANSACTION_KEYWORDS})(?:\\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE))?(?:\\s+TRANSACTION)?[\\s;]*)+$`,
	'i',
);

/** The temp schema never reaches export(), so statements scoped to it cannot dirty the persisted DB. */
const TEMP_SCHEMA_STATEMENT_RE = new RegExp(
	'^\\s*(?:CREATE\\s+TEMP(?:ORARY)?\\s+TABLE\\b'
	+ '|(?:INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO|DELETE\\s+FROM|UPDATE(?:\\s+OR\\s+\\w+)?|DROP\\s+TABLE(?:\\s+IF\\s+EXISTS)?)\\s+temp\\.)',
	'i',
);

type TransactionTransition = 'begin' | 'commit' | 'rollback';

function* iterTransactionTransitions(sql: string): Iterable<TransactionTransition> {
	for (const match of sql.matchAll(TRANSACTION_STATEMENT_RE)) {
		const keyword = match[1]!.toUpperCase();
		if (keyword === 'BEGIN') yield 'begin';
		else if (keyword === 'COMMIT') yield 'commit';
		else yield 'rollback';
	}
}

// Generated IN-list SQL varies by placeholder count, so an unbounded cache would accumulate a distinct
// StatementSync per list size over a long session. LRU-cap it; the ~dozens of fixed hot statements
// stay resident while one-off shapes are evicted. Map iteration is insertion order = LRU order.
const STMT_CACHE_LIMIT = 256;

export function createWrapper(db: NodeDatabaseSync, dbPath?: string): DbWrapper {
	let depth = 0;
	let dirty = false;
	const stmtCache = new Map<string, NodeStatementSync>();

	function getStatement(sql: string): NodeStatementSync {
		const cached = stmtCache.get(sql);
		if (cached) {
			stmtCache.delete(sql);
			stmtCache.set(sql, cached);
			return cached;
		}
		const stmt = db.prepare(sql);
		stmtCache.set(sql, stmt);
		if (stmtCache.size > STMT_CACHE_LIMIT) {
			const oldest = stmtCache.keys().next().value;
			if (oldest !== undefined) stmtCache.delete(oldest);
		}
		return stmt;
	}

	function applyTransactionTransition(sql: string): void {
		for (const kind of iterTransactionTransitions(sql)) {
			if (kind === 'begin') depth++;
			else if (depth > 0) depth--;
		}
	}

	function markDirtyUnlessNonPersistent(sql: string): void {
		if (PURE_TRANSACTION_SQL_RE.test(sql)) return;
		if (TEMP_SCHEMA_STATEMENT_RE.test(sql)) return;
		dirty = true;
	}

	// Returns true when the WAL fully folded into the main file. A concurrent reader can leave frames
	// unfolded (busy=1, checkpointed<log); export() reads the main file, so it needs to know.
	function checkpoint(): boolean {
		const r = getStatement('PRAGMA wal_checkpoint(TRUNCATE)').get() as
			{ busy?: number; log?: number; checkpointed?: number } | undefined;
		const folded = !!r && r.busy !== 1 && (r.log ?? 0) === (r.checkpointed ?? 0);
		if (!folded && r) {
			log(`[Compass] WAL checkpoint did not fully fold (busy=${r.busy}, log=${r.log}, checkpointed=${r.checkpointed})`);
		}
		return folded;
	}

	return {
		prepare(sql: string): PreparedStatement {
			return {
				run(...params: unknown[]): RunResult {
					markDirtyUnlessNonPersistent(sql);
					const r = getStatement(sql).run(...(params as SqlParam[]));
					applyTransactionTransition(sql);
					return { changes: Number(r.changes) };
				},
				get(...params: unknown[]): Record<string, unknown> | undefined {
					return getStatement(sql).get(...(params as SqlParam[])) as Record<string, unknown> | undefined;
				},
				all(...params: unknown[]): Record<string, unknown>[] {
					return getStatement(sql).all(...(params as SqlParam[])) as Record<string, unknown>[];
				},
			};
		},
		exec(sql: string): void {
			markDirtyUnlessNonPersistent(sql);
			db.exec(sql);
			applyTransactionTransition(sql);
		},
		inTransaction(): boolean {
			return depth > 0;
		},
		isDirty(): boolean {
			return dirty;
		},
		clearDirty(): void {
			dirty = false;
		},
		checkpoint,
		export(): Uint8Array {
			if (!dbPath) throw new Error('DbWrapper.export() requires a file-backed dbPath');
			// export() reads the MAIN file, so an unfolded WAL means stale bytes. checkpoint() already
			// logs the incomplete fold; the read still returns the last durable main-file state.
			checkpoint();
			return new Uint8Array(fs.readFileSync(dbPath));
		},
		close(): void {
			// WAL data is already durable; fold it back best-effort so a checkpoint fault never blocks close.
			try {
				checkpoint();
			} catch {
				/* best-effort */
			}
			db.close();
		},
	};
}
