import type { GraphStore } from './database';
import type { StoredNode } from './types';
import { matchesEntryName, hasFrameworkDecorator } from './flows';
import { isTestFile } from './extractors/lang-maps';

const INCOMING_REFERENCE_KINDS = ['CALLS', 'TESTED_BY', 'IMPORTS_FROM', 'REFERENCES', 'INHERITS', 'IMPLEMENTS'];

const FRAMEWORK_BASE_CLASSES = new Set([
	'Component', 'PureComponent', 'Controller', 'AbstractController',
	'Model', 'Migration', 'TestCase', 'Exception', 'Module',
	'Injectable', 'Directive', 'Pipe', 'Command', 'Seeder',
	'Middleware', 'ServiceProvider', 'Activity', 'Fragment',
	'ViewModel', 'Service', 'Thread', 'Runnable', 'Application',
]);

const MOCK_NAME_RE = /\b(mock|stub|fake|dummy|spy)\b/i;
const DUNDER_RE = /^__.*__$/;

export interface DeadCodeOptions {
	kind?: 'Function' | 'Class';
	filePattern?: string;
}

export interface DeadCodeResult {
	name: string;
	qualified_name: string;
	kind: string;
	file_path: string;
	line: number;
	language: string | null;
}

interface ReferenceIndex {
	referencedQns: Set<string>;
	sourcesByTargetName: Map<string, Set<string>>;
}

export function findDeadCode(store: GraphStore, options: DeadCodeOptions = {}): DeadCodeResult[] {
	const kinds = options.kind ? [options.kind] : ['Function', 'Class'];
	const candidates = store.getNodesByKinds(kinds);
	const index = buildReferenceIndex(store);

	const results: DeadCodeResult[] = [];
	for (const node of candidates) {
		if (options.filePattern && !node.file_path.includes(options.filePattern)) continue;
		if (isExcluded(store, node)) continue;
		if (isReferenced(node, index)) continue;
		results.push({
			name: node.name,
			qualified_name: node.qualified_name,
			kind: node.kind,
			file_path: node.file_path,
			line: node.line_start,
			language: node.language,
		});
	}
	return results;
}

function buildReferenceIndex(store: GraphStore): ReferenceIndex {
	const referencedQns = new Set<string>();
	const sourcesByTargetName = new Map<string, Set<string>>();
	for (const edge of store.getEdgesByKinds(INCOMING_REFERENCE_KINDS)) {
		referencedQns.add(edge.target_qualified);
		const targetName = lastSegment(edge.target_qualified);
		let sources = sourcesByTargetName.get(targetName);
		if (!sources) {
			sources = new Set<string>();
			sourcesByTargetName.set(targetName, sources);
		}
		sources.add(edge.source_qualified);
	}
	return { referencedQns, sourcesByTargetName };
}

function isReferenced(node: StoredNode, index: ReferenceIndex): boolean {
	if (index.referencedQns.has(node.qualified_name)) return true;
	const sources = index.sourcesByTargetName.get(node.name);
	if (!sources) return false;
	for (const source of sources) {
		if (source !== node.qualified_name) return true;
	}
	return false;
}

function lastSegment(qualified: string): string {
	const idx = qualified.lastIndexOf('::');
	return idx >= 0 ? qualified.slice(idx + 2) : qualified;
}

function isExcluded(store: GraphStore, node: StoredNode): boolean {
	if (DUNDER_RE.test(node.name)) return true;
	if (node.name === 'constructor' && node.parent_name) return true;
	if (isTestFile(node.file_path) && MOCK_NAME_RE.test(node.name)) return true;
	if (matchesEntryName(node)) return true;
	if (hasFrameworkDecorator(node)) return true;
	if (node.kind === 'Class' && hasFrameworkBase(store, node)) return true;
	return false;
}

function hasFrameworkBase(store: GraphStore, node: StoredNode): boolean {
	for (const e of store.getEdgesBySource(node.qualified_name)) {
		if (e.kind !== 'INHERITS' && e.kind !== 'IMPLEMENTS') continue;
		if (FRAMEWORK_BASE_CLASSES.has(bareName(e.target_qualified))) return true;
	}
	return false;
}

function bareName(qualified: string): string {
	const parts = qualified.split(/::|[./\\]/);
	return parts[parts.length - 1] ?? qualified;
}
