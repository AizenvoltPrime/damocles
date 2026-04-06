import type { GraphNode, GraphEdge, ExtractionResult, Confidence, EntityKind } from './types';

export function makeId(...parts: string[]): string {
	const combined = parts.filter(Boolean).map(p => p.replace(/^[_.]+|[_.]+$/g, '')).join('_');
	const cleaned = combined.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
	return cleaned.toLowerCase();
}

export interface ExtractionContext {
	filePath: string;
	stem: string;
	fileId: string;
	source: string;
	nodes: GraphNode[];
	edges: GraphEdge[];
	seenIds: Set<string>;
	functionBodies: Array<{ callerNid: string; bodyNode: unknown }>;
}

function computeFileId(filePath: string, workspaceRoot?: string): string {
	const normalized = filePath.replace(/\\/g, '/');
	let relative = normalized;
	if (workspaceRoot) {
		const normalizedRoot = workspaceRoot.replace(/\\/g, '/');
		if (normalized.startsWith(normalizedRoot)) {
			relative = normalized.slice(normalizedRoot.length).replace(/^\//, '');
		}
	}
	return makeId(relative.replace(/\.[^.]+$/, ''));
}

export function createExtractionContext(filePath: string, source: string, workspaceRoot?: string): ExtractionContext {
	const parts = filePath.replace(/\\/g, '/').split('/');
	const filename = parts[parts.length - 1] ?? '';
	const stem = filename.replace(/\.[^.]+$/, '');

	return {
		filePath,
		stem,
		fileId: computeFileId(filePath, workspaceRoot),
		source,
		nodes: [],
		edges: [],
		seenIds: new Set(),
		functionBodies: [],
	};
}

export function addNode(ctx: ExtractionContext, nid: string, label: string, line: number, kind?: EntityKind): void {
	if (ctx.seenIds.has(nid)) return;
	ctx.seenIds.add(nid);
	ctx.nodes.push({
		id: nid,
		label,
		file_type: 'code',
		source_file: ctx.filePath,
		source_location: `L${line}`,
		...(kind ? { kind } : {}),
	});
}

export function addEdge(
	ctx: ExtractionContext,
	src: string,
	tgt: string,
	relation: string,
	line: number,
	confidence: Confidence = 'EXTRACTED',
	weight = 1.0,
): void {
	ctx.edges.push({
		source: src,
		target: tgt,
		relation,
		confidence,
		source_file: ctx.filePath,
		source_location: `L${line}`,
		weight,
	});
}

export function nodeText(source: string, node: { startIndex: number; endIndex: number }): string {
	return source.slice(node.startIndex, node.endIndex);
}

const CALL_NODE_TYPES = new Set([
	'call', 'call_expression',
	'method_invocation',
	'member_call_expression', 'scoped_call_expression',
	'macro_invocation',
	'object_creation_expression',
	'navigation_expression',
]);

export function walkCalls(
	ctx: ExtractionContext,
	node: { type: string; children: unknown[]; childForFieldName(name: string): unknown | null; startPosition: { row: number } },
	callerNid: string,
	labelToNid: Map<string, string>,
	seenCallPairs: Set<string>,
	source: string,
): void {
	if (node.type === 'function_definition' || node.type === 'function_declaration'
		|| node.type === 'method_definition' || node.type === 'function_item') {
		return;
	}

	if (node.type === 'class_declaration' || node.type === 'class_definition'
		|| node.type === 'class' || node.type === 'struct_item' || node.type === 'impl_item'
		|| node.type === 'interface_declaration' || node.type === 'abstract_class_declaration') {
		return;
	}

	if (CALL_NODE_TYPES.has(node.type)) {
		let calleeName: string | null = null;

		const nameNode = (node as any).childForFieldName?.('name') as { type: string; startIndex: number; endIndex: number } | null;
		const funcNode = (node as any).childForFieldName?.('function') as { type: string; startIndex: number; endIndex: number; childForFieldName(name: string): unknown | null } | null;

		if (nameNode && (nameNode.type === 'identifier' || nameNode.type === 'simple_identifier')) {
			calleeName = nodeText(source, nameNode);
		} else if (funcNode) {
			if (funcNode.type === 'identifier') {
				calleeName = nodeText(source, funcNode);
			} else if (funcNode.type === 'attribute' || funcNode.type === 'member_expression'
				|| funcNode.type === 'field_expression') {
				const attr = funcNode.childForFieldName?.('attribute')
					?? funcNode.childForFieldName?.('property')
					?? funcNode.childForFieldName?.('field');
				if (attr) calleeName = nodeText(source, attr as { startIndex: number; endIndex: number });
			}
		}

		if (calleeName) {
			const tgtNid = labelToNid.get(calleeName.toLowerCase());
			if (tgtNid && tgtNid !== callerNid) {
				const pair = `${callerNid}||${tgtNid}`;
				if (!seenCallPairs.has(pair)) {
					seenCallPairs.add(pair);
					addEdge(ctx, callerNid, tgtNid, 'calls', node.startPosition.row + 1, 'INFERRED', 0.8);
				}
			}
		}
	}

	const children = (node as any).children as Array<typeof node> | undefined;
	if (children) {
		for (const child of children) {
			walkCalls(ctx, child, callerNid, labelToNid, seenCallPairs, source);
		}
	}
}

export function buildLabelMap(nodes: GraphNode[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const n of nodes) {
		const normalised = n.label.replace(/[()]/g, '').replace(/^\./, '').toLowerCase();
		map.set(normalised, n.id);
	}
	return map;
}

export function cleanEdges(ctx: ExtractionContext): ExtractionResult {
	const validIds = ctx.seenIds;
	const cleanedEdges = ctx.edges.filter(edge => {
		const { source, target, relation } = edge;
		if (validIds.has(source) && (validIds.has(target) || relation === 'imports' || relation === 'imports_from')) {
			return true;
		}
		return false;
	});

	return { nodes: ctx.nodes, edges: cleanedEdges };
}

export function runCallGraphPass(ctx: ExtractionContext): void {
	const labelToNid = buildLabelMap(ctx.nodes);
	const seenCallPairs = new Set<string>();

	for (const { callerNid, bodyNode } of ctx.functionBodies) {
		walkCalls(
			ctx,
			bodyNode as Parameters<typeof walkCalls>[1],
			callerNid,
			labelToNid,
			seenCallPairs,
			ctx.source,
		);
	}
}
