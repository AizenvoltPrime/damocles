import { log } from '../logger';
import { isKnownExternal } from './known-externals';
import { normalizePath } from './util';
import type { GraphStore } from './database';

const TEST_FIXTURE_PATH_RE = /\/(?:__tests__|tests?|spec|e2e)\/(?:[^/]+\/)*fixtures?\//i;
const FIXTURES_DIR_RE = /\/__fixtures__\//i;

function isTestFixtureFile(filePath: string): boolean {
	const normalized = normalizePath(filePath);
	return TEST_FIXTURE_PATH_RE.test(normalized) || FIXTURES_DIR_RE.test(normalized);
}

export interface ValidationResult {
	orphanedByKind: Record<string, { count: number; entities: string[]; truncated: boolean }>;
	expectedOrphanFiles: { count: number; entities: string[]; truncated: boolean };
	totalByKind: Record<string, number>;
	brokenEdges: { count: number; entities: string[]; truncated: boolean };
	knownExternalRefs: { count: number; entities: string[]; truncated: boolean };
	unresolvedInternalRefs: { count: number; entities: string[]; truncated: boolean };
	communityGaps: { count: number; entities: string[]; truncated: boolean };
	ftsRowCount: number;
	nodeCount: number;
	edgeCount: number;
	fileCount: number;
	communityCount: number;
	filePaths: string[];
}

export function runValidation(store: GraphStore): ValidationResult {
	const CAP = 100;

	const validation = store.withTransaction(() => runValidationInner(store, CAP));

	if (validation.ftsRowCount !== validation.nodeCount) {
		log(`[Compass] FTS5 drift detected (fts=${validation.ftsRowCount}, nodes=${validation.nodeCount}); rebuilding index`);
		store.rebuildFtsIndex();
		const refreshed = store.db.prepare('SELECT COUNT(*) as cnt FROM nodes_fts_docsize').get() as { cnt: number };
		validation.ftsRowCount = refreshed.cnt;
	}

	return validation;
}

function runValidationInner(store: GraphStore, CAP: number): ValidationResult {
	const totalByKind: Record<string, number> = {};
	for (const kind of ['Function', 'Class', 'Type', 'File']) {
		totalByKind[kind] = (store.db.prepare('SELECT COUNT(*) as cnt FROM nodes WHERE kind = ?').get(kind) as { cnt: number }).cnt;
	}

	const orphanedByKind: Record<string, { count: number; entities: string[]; truncated: boolean }> = {};
	for (const kind of ['Function', 'Class', 'Type', 'File']) {
		const countRow = store.db.prepare(`
			SELECT COUNT(*) as cnt FROM nodes n
			WHERE n.kind = ?
				AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.source_qualified = n.qualified_name)
				AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.target_qualified = n.qualified_name)
		`).get(kind) as { cnt: number };
		const entities = store.db.prepare(`
			SELECT n.qualified_name FROM nodes n
			WHERE n.kind = ?
				AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.source_qualified = n.qualified_name)
				AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.target_qualified = n.qualified_name)
			LIMIT ?
		`).all(kind, CAP) as { qualified_name: string }[];
		orphanedByKind[kind] = {
			count: countRow.cnt,
			entities: entities.map(r => r.qualified_name),
			truncated: countRow.cnt > CAP,
		};
	}

	const expectedOrphanRow = store.db.prepare(`
		SELECT COUNT(*) as cnt FROM nodes n
		WHERE n.kind = 'File'
			AND json_extract(n.extra, '$.no_callable_entities') = 1
			AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.source_qualified = n.qualified_name)
			AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.target_qualified = n.qualified_name)
	`).get() as { cnt: number };
	const expectedOrphanEntities = store.db.prepare(`
		SELECT n.qualified_name FROM nodes n
		WHERE n.kind = 'File'
			AND json_extract(n.extra, '$.no_callable_entities') = 1
			AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.source_qualified = n.qualified_name)
			AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.target_qualified = n.qualified_name)
		LIMIT ?
	`).all(CAP) as { qualified_name: string }[];
	const expectedOrphanFiles = {
		count: expectedOrphanRow.cnt,
		entities: expectedOrphanEntities.map(r => r.qualified_name),
		truncated: expectedOrphanRow.cnt > CAP,
	};

	const brokenCount = store.db.prepare(`
		SELECT COUNT(*) as cnt FROM edges e
		WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.qualified_name = e.source_qualified)
			OR (e.kind NOT IN ('IMPORTS_FROM', 'INHERITS', 'IMPLEMENTS', 'DEPENDS_ON')
				AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.qualified_name = e.target_qualified))
	`).get() as { cnt: number };
	const brokenEntities = store.db.prepare(`
		SELECT e.kind || ': ' || e.source_qualified || ' -> ' || e.target_qualified as label FROM edges e
		WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.qualified_name = e.source_qualified)
			OR (e.kind NOT IN ('IMPORTS_FROM', 'INHERITS', 'IMPLEMENTS', 'DEPENDS_ON')
				AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.qualified_name = e.target_qualified))
		LIMIT ?
	`).all(CAP) as { label: string }[];

	const UNRESOLVED_CAP = 5000;
	const allUnresolved = store.db.prepare(`
		SELECT e.kind || ': ' || e.target_qualified as label, e.target_qualified as target, e.file_path as filePath FROM edges e
		WHERE e.kind IN ('IMPORTS_FROM', 'INHERITS', 'IMPLEMENTS', 'DEPENDS_ON')
			AND EXISTS (SELECT 1 FROM nodes n WHERE n.qualified_name = e.source_qualified)
			AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.qualified_name = e.target_qualified)
		LIMIT ?
	`).all(UNRESOLVED_CAP) as { label: string; target: string; filePath: string }[];
	const knownExternalLabels: string[] = [];
	const unresolvedInternalLabels: string[] = [];
	for (const row of allUnresolved) {
		if (isTestFixtureFile(row.filePath)) continue;
		if (isKnownExternal(row.target)) {
			knownExternalLabels.push(row.label);
		} else {
			unresolvedInternalLabels.push(row.label);
		}
	}

	const communityGapCount = store.db.prepare(
		"SELECT COUNT(*) as cnt FROM nodes WHERE community_id IS NULL AND kind != 'File'"
	).get() as { cnt: number };
	const communityGapEntities = store.db.prepare(
		"SELECT qualified_name FROM nodes WHERE community_id IS NULL AND kind != 'File' LIMIT ?"
	).all(CAP) as { qualified_name: string }[];

	const ftsRow = store.db.prepare('SELECT COUNT(*) as cnt FROM nodes_fts_docsize').get() as { cnt: number };
	const nodeCount = store.getNodeCount();
	const edgeCount = store.getEdgeCount();
	const fileCount = (store.db.prepare("SELECT COUNT(*) as cnt FROM nodes WHERE kind = 'File'").get() as { cnt: number }).cnt;
	const communityCount = store.getCommunityCount();
	const filePaths = store.getAllFiles();

	return {
		orphanedByKind,
		expectedOrphanFiles,
		totalByKind,
		brokenEdges: {
			count: brokenCount.cnt,
			entities: brokenEntities.map(r => r.label),
			truncated: brokenCount.cnt > CAP,
		},
		knownExternalRefs: {
			count: knownExternalLabels.length,
			entities: knownExternalLabels.slice(0, CAP),
			truncated: knownExternalLabels.length > CAP,
		},
		unresolvedInternalRefs: {
			count: unresolvedInternalLabels.length,
			entities: unresolvedInternalLabels.slice(0, CAP),
			truncated: unresolvedInternalLabels.length > CAP,
		},
		communityGaps: {
			count: communityGapCount.cnt,
			entities: communityGapEntities.map(r => r.qualified_name),
			truncated: communityGapCount.cnt > CAP,
		},
		ftsRowCount: ftsRow.cnt,
		nodeCount,
		edgeCount,
		fileCount,
		communityCount,
		filePaths,
	};
}
