import type { NodeInfo, EdgeInfo, NodeKind, EdgeKind, ExtractionContext } from './types';
import { qualifyName } from './schema';

export function createExtractionContext(filePath: string, source: string, workspaceRoot: string): ExtractionContext {
	const parts = filePath.replace(/\\/g, '/').split('/');
	const filename = parts[parts.length - 1] ?? '';
	const stem = filename.replace(/\.[^.]+$/, '');

	return {
		filePath,
		stem,
		fileQualified: qualifyName(filename, filePath),
		workspaceRoot,
		source,
		lineOffset: 0,
		nodes: [],
		edges: [],
		seenQualified: new Set(),
		functionBodies: [],
	};
}

export function addNode(
	ctx: ExtractionContext,
	kind: NodeKind,
	name: string,
	lineStart: number,
	lineEnd: number,
	options?: {
		language?: string;
		parentName?: string;
		params?: string;
		returnType?: string;
		modifiers?: string;
		signature?: string;
		isTest?: boolean;
		extra?: Record<string, unknown>;
	},
): string {
	const qualified = qualifyName(name, ctx.filePath, options?.parentName);
	if (ctx.seenQualified.has(qualified)) return qualified;
	ctx.seenQualified.add(qualified);

	const adjustedStart = lineStart + ctx.lineOffset;
	const adjustedEnd = lineEnd + ctx.lineOffset;

	const node: NodeInfo = {
		kind,
		name,
		file_path: ctx.filePath,
		line_start: adjustedStart,
		line_end: adjustedEnd,
	};
	if (options?.language !== undefined) node.language = options.language;
	if (options?.parentName !== undefined) node.parent_name = options.parentName;
	if (options?.params !== undefined) node.params = options.params;
	if (options?.returnType !== undefined) node.return_type = options.returnType;
	if (options?.modifiers !== undefined) node.modifiers = options.modifiers;
	if (options?.signature !== undefined) node.signature = options.signature;
	if (options?.isTest !== undefined) node.is_test = options.isTest;
	if (options?.extra !== undefined) node.extra = options.extra;
	ctx.nodes.push(node);

	return qualified;
}

export function addEdge(
	ctx: ExtractionContext,
	kind: EdgeKind,
	source: string,
	target: string,
	line: number,
	extra?: Record<string, unknown>,
): void {
	const edge: EdgeInfo = {
		kind,
		source,
		target,
		file_path: ctx.filePath,
		line: line + ctx.lineOffset,
	};
	if (extra !== undefined) edge.extra = extra;
	ctx.edges.push(edge);
}

export function nodeText(source: string, node: { startIndex: number; endIndex: number }): string {
	return source.slice(node.startIndex, node.endIndex);
}

const CALL_BOUNDARY_TYPES = new Set([
	'function_definition', 'function_declaration', 'method_definition', 'function_item',
	'method_declaration', 'constructor_declaration', 'singleton_method',
	'function_expression', 'arrow_function',
	'class_declaration', 'class_definition', 'class', 'struct_item', 'impl_item',
	'interface_declaration', 'abstract_class_declaration', 'enum_declaration',
	'type_declaration', 'trait_item', 'module', 'object_declaration',
]);

const CALL_NODE_TYPES = new Set([
	'call', 'call_expression',
	'method_invocation',
	'member_call_expression', 'scoped_call_expression',
	'macro_invocation',
	'object_creation_expression',
	'navigation_expression',
]);

const REFERENCE_SKIP_NAMES = new Set([
	'true', 'false', 'null', 'undefined', 'this', 'self',
	'NaN', 'Infinity', 'arguments', 'super', 'console', 'window', 'document',
	'process', 'module', 'exports', 'require', 'global',
]);

export function walkReferences(
	ctx: ExtractionContext,
	node: { type: string; children: unknown[]; childForFieldName(name: string): unknown | null; startPosition: { row: number } },
	callerQualified: string,
	nameToQualified: Map<string, string>,
	seenRefPairs: Set<string>,
	source: string,
): void {
	if (CALL_BOUNDARY_TYPES.has(node.type)) return;

	const children = (node as any).children as Array<typeof node> | undefined;

	if (node.type === 'pair') {
		if (children && children.length > 0) {
			let valueNode: typeof node | null = null;
			for (let i = children.length - 1; i >= 0; i--) {
				const child = children[i]!;
				if (child.type !== ':' && child.type !== ',') { valueNode = child; break; }
			}
			if (valueNode && valueNode.type === 'identifier') {
				const name = nodeText(source, valueNode as unknown as { startIndex: number; endIndex: number });
				emitReferenceIfKnown(ctx, name, callerQualified, nameToQualified, seenRefPairs, node.startPosition.row + 1);
			}
		}
	}

	if (node.type === 'shorthand_property_identifier' || node.type === 'shorthand_property_identifier_pattern') {
		const name = nodeText(source, node as unknown as { startIndex: number; endIndex: number });
		emitReferenceIfKnown(ctx, name, callerQualified, nameToQualified, seenRefPairs, node.startPosition.row + 1);
	}

	if (node.type === 'array' || node.type === 'tuple') {
		if (children) {
			for (const child of children) {
				if (child.type === 'identifier') {
					const name = nodeText(source, child as unknown as { startIndex: number; endIndex: number });
					emitReferenceIfKnown(ctx, name, callerQualified, nameToQualified, seenRefPairs, child.startPosition.row + 1);
				}
			}
		}
	}

	if (node.type === 'arguments') {
		if (children) {
			for (const child of children) {
				if (child.type === 'identifier') {
					const name = nodeText(source, child as unknown as { startIndex: number; endIndex: number });
					emitReferenceIfKnown(ctx, name, callerQualified, nameToQualified, seenRefPairs, child.startPosition.row + 1);
				}
			}
		}
	}

	if (children) {
		for (const child of children) {
			walkReferences(ctx, child, callerQualified, nameToQualified, seenRefPairs, source);
		}
	}
}

function emitReferenceIfKnown(
	ctx: ExtractionContext,
	name: string,
	callerQualified: string,
	nameToQualified: Map<string, string>,
	seenRefPairs: Set<string>,
	line: number,
): void {
	if (name.length <= 1) return;
	if (/^[A-Z_][A-Z0-9_]*$/.test(name)) return;
	if (REFERENCE_SKIP_NAMES.has(name)) return;

	const tgtQualified = nameToQualified.get(name.toLowerCase());
	if (!tgtQualified || tgtQualified === callerQualified) return;

	const pair = `${callerQualified}||${tgtQualified}`;
	if (seenRefPairs.has(pair)) return;
	seenRefPairs.add(pair);
	addEdge(ctx, 'REFERENCES', callerQualified, tgtQualified, line);
}

export function walkCalls(
	ctx: ExtractionContext,
	node: { type: string; children: unknown[]; childForFieldName(name: string): unknown | null; startPosition: { row: number } },
	callerQualified: string,
	nameToQualified: Map<string, string>,
	seenCallPairs: Set<string>,
	source: string,
): void {
	if (CALL_BOUNDARY_TYPES.has(node.type)) {
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
			const tgtQualified = nameToQualified.get(calleeName.toLowerCase());
			if (tgtQualified && tgtQualified !== callerQualified) {
				const pair = `${callerQualified}||${tgtQualified}`;
				if (!seenCallPairs.has(pair)) {
					seenCallPairs.add(pair);
					addEdge(ctx, 'CALLS', callerQualified, tgtQualified, node.startPosition.row + 1);
				}
			}
		}
	}

	if (node.type === 'jsx_opening_element' || node.type === 'jsx_self_closing_element') {
		const nameNode = (node as any).childForFieldName?.('name') as { type: string; startIndex: number; endIndex: number } | null;
		if (nameNode) {
			const tagName = nodeText(source, nameNode);
			if (tagName && /^[A-Z]/.test(tagName)) {
				const baseName = tagName.includes('.') ? tagName.split('.')[0]! : tagName;
				const tgtQualified = nameToQualified.get(baseName.toLowerCase());
				if (tgtQualified && tgtQualified !== callerQualified) {
					const pair = `${callerQualified}||${tgtQualified}`;
					if (!seenCallPairs.has(pair)) {
						seenCallPairs.add(pair);
						addEdge(ctx, 'CALLS', callerQualified, tgtQualified, node.startPosition.row + 1);
					}
				}
			}
		}
	}

	const children = (node as any).children as Array<typeof node> | undefined;
	if (children) {
		for (const child of children) {
			walkCalls(ctx, child, callerQualified, nameToQualified, seenCallPairs, source);
		}
	}
}

export function buildNameMap(nodes: NodeInfo[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const n of nodes) {
		const normalised = n.name.replace(/[()]/g, '').replace(/^\./, '').toLowerCase();
		const qualified = qualifyName(n.name, n.file_path, n.parent_name);
		map.set(normalised, qualified);
	}
	return map;
}

export interface ExtractionResult {
	nodes: NodeInfo[];
	edges: EdgeInfo[];
}

const EXTERNAL_TARGET_EDGE_KINDS: Set<string> = new Set([
	'IMPORTS_FROM', 'INHERITS', 'IMPLEMENTS', 'DEPENDS_ON',
]);

export function cleanEdges(ctx: ExtractionContext): ExtractionResult {
	const validSources = ctx.seenQualified;
	const cleanedEdges = ctx.edges.filter(edge => {
		if (!validSources.has(edge.source)) return false;
		if (EXTERNAL_TARGET_EDGE_KINDS.has(edge.kind)) return true;
		return validSources.has(edge.target);
	});

	return { nodes: ctx.nodes, edges: cleanedEdges };
}

export function runCallGraphPass(ctx: ExtractionContext): void {
	const nameToQualified = buildNameMap(ctx.nodes);
	const seenCallPairs = new Set<string>();
	const seenRefPairs = new Set<string>();

	for (const { callerQualified, bodyNode, lineOffset } of ctx.functionBodies) {
		const savedOffset = ctx.lineOffset;
		ctx.lineOffset = lineOffset;
		walkCalls(
			ctx,
			bodyNode as Parameters<typeof walkCalls>[1],
			callerQualified,
			nameToQualified,
			seenCallPairs,
			ctx.source,
		);
		walkReferences(
			ctx,
			bodyNode as Parameters<typeof walkReferences>[1],
			callerQualified,
			nameToQualified,
			seenRefPairs,
			ctx.source,
		);
		ctx.lineOffset = savedOffset;
	}
}
