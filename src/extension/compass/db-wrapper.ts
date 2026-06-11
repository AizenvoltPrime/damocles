export interface SqlJsStatic {
	Database: new (data?: ArrayLike<number>) => SqlJsDatabase;
}

export interface SqlJsDatabase {
	run(sql: string, params?: unknown[]): SqlJsDatabase;
	exec(sql: string): { columns: string[]; values: unknown[][] }[];
	prepare(sql: string): SqlJsStatement;
	getRowsModified(): number;
	export(): Uint8Array;
	close(): void;
}

interface SqlJsStatement {
	bind(params?: unknown[]): boolean;
	step(): boolean;
	getAsObject(): Record<string, unknown>;
	free(): boolean;
}

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

export function createWrapper(sqlDb: SqlJsDatabase): DbWrapper {
	let depth = 0;
	let dirty = false;

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

	return {
		prepare(sql: string): PreparedStatement {
			return {
				run(...params: unknown[]): RunResult {
					markDirtyUnlessNonPersistent(sql);
					sqlDb.run(sql, params);
					applyTransactionTransition(sql);
					return { changes: sqlDb.getRowsModified() };
				},
				get(...params: unknown[]): Record<string, unknown> | undefined {
					const stmt = sqlDb.prepare(sql);
					try {
						if (params.length) stmt.bind(params);
						if (stmt.step()) return stmt.getAsObject();
						return undefined;
					} finally {
						stmt.free();
					}
				},
				all(...params: unknown[]): Record<string, unknown>[] {
					const stmt = sqlDb.prepare(sql);
					try {
						if (params.length) stmt.bind(params);
						const results: Record<string, unknown>[] = [];
						while (stmt.step()) results.push(stmt.getAsObject());
						return results;
					} finally {
						stmt.free();
					}
				},
			};
		},
		exec(sql: string): void {
			markDirtyUnlessNonPersistent(sql);
			sqlDb.exec(sql);
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
		export(): Uint8Array {
			return sqlDb.export();
		},
		close(): void {
			sqlDb.close();
		},
	};
}
