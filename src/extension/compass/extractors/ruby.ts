import type { ExtractionContext } from '../extractor-base';
import { makeId, addNode, addEdge, nodeText } from '../extractor-base';

interface AstNode {
	type: string;
	children: AstNode[];
	childForFieldName(name: string): AstNode | null;
	startPosition: { row: number; column: number };
	startIndex: number;
	endIndex: number;
}

export function extractRuby(ctx: ExtractionContext, root: unknown): void {
	const fileNid = ctx.fileId;
	addNode(ctx, fileNid, ctx.stem, 1, 'file');

	walk(ctx, root as AstNode, fileNid, null);
}

function walk(
	ctx: ExtractionContext,
	node: AstNode,
	fileNid: string,
	parentClassNid: string | null,
): void {
	switch (node.type) {
		case 'call':
			handleRequire(ctx, node, fileNid);
			break;

		case 'module':
			handleModule(ctx, node, fileNid, parentClassNid);
			return;

		case 'class':
			handleClass(ctx, node, fileNid, parentClassNid);
			return;

		case 'method':
			handleMethod(ctx, node, fileNid, parentClassNid);
			return;

		case 'singleton_method':
			handleMethod(ctx, node, fileNid, parentClassNid);
			return;
	}

	for (const child of node.children) {
		walk(ctx, child, fileNid, parentClassNid);
	}
}

const REQUIRE_METHODS = new Set(['require', 'require_relative', 'load', 'autoload']);

function handleRequire(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	const methodNode = node.childForFieldName('method');
	if (!methodNode) return;

	const methodName = nodeText(ctx.source, methodNode);
	if (!REQUIRE_METHODS.has(methodName)) return;

	const args = node.childForFieldName('arguments');
	if (!args) return;

	for (const child of args.children) {
		if (child.type === 'string' || child.type === 'string_content') {
			const raw = nodeText(ctx.source, child).replace(/^['"]|['"]$/g, '');
			if (raw) {
				const moduleNid = makeId(raw);
				addEdge(ctx, fileNid, moduleNid, 'imports', node.startPosition.row + 1);
			}
			return;
		}
		for (const inner of child.children) {
			if (inner.type === 'string_content') {
				const raw = nodeText(ctx.source, inner);
				if (raw) {
					const moduleNid = makeId(raw);
					addEdge(ctx, fileNid, moduleNid, 'imports', node.startPosition.row + 1);
				}
				return;
			}
		}
	}
}

function handleModule(ctx: ExtractionContext, node: AstNode, fileNid: string, parentNid: string | null): void {
	const nameNode = node.childForFieldName('name');
	if (!nameNode) return;

	const moduleName = nodeText(ctx.source, nameNode);
	const moduleNid = makeId(ctx.stem, moduleName);
	const line = node.startPosition.row + 1;
	const containerNid = parentNid ?? fileNid;

	addNode(ctx, moduleNid, moduleName, line, 'type');
	addEdge(ctx, containerNid, moduleNid, 'contains', line);

	const body = node.childForFieldName('body');
	const bodyChildren = body ? body.children : node.children;

	for (const child of bodyChildren) {
		walk(ctx, child, fileNid, moduleNid);
	}
}

function handleClass(ctx: ExtractionContext, node: AstNode, fileNid: string, parentNid: string | null): void {
	const nameNode = node.childForFieldName('name');
	if (!nameNode) return;

	const className = nodeText(ctx.source, nameNode);
	const classNid = makeId(ctx.stem, className);
	const line = node.startPosition.row + 1;

	const containerNid = parentNid ?? fileNid;

	addNode(ctx, classNid, className, line, 'class');
	addEdge(ctx, containerNid, classNid, 'contains', line);

	const superclassNode = node.childForFieldName('superclass');
	if (superclassNode) {
		const baseName = nodeText(ctx.source, superclassNode);
		const baseNid = makeId(baseName);
		if (!ctx.seenIds.has(baseNid)) {
			ctx.seenIds.add(baseNid);
			ctx.nodes.push({
				id: baseNid,
				label: baseName,
				file_type: 'code',
				source_file: '',
				source_location: `L${line}`,
				kind: 'class',
			});
		}
		addEdge(ctx, classNid, baseNid, 'inherits', line);
	}

	const body = node.childForFieldName('body');
	const bodyChildren = body ? body.children : node.children;

	for (const child of bodyChildren) {
		walk(ctx, child, fileNid, classNid);
	}
}

function handleMethod(
	ctx: ExtractionContext,
	node: AstNode,
	fileNid: string,
	parentClassNid: string | null,
): void {
	const nameNode = node.childForFieldName('name');
	if (!nameNode) return;

	const methodName = nodeText(ctx.source, nameNode);
	const line = node.startPosition.row + 1;

	if (parentClassNid) {
		const methodNid = makeId(parentClassNid, methodName);
		addNode(ctx, methodNid, `.${methodName}()`, line, 'method');
		addEdge(ctx, parentClassNid, methodNid, 'method', line);
		collectBody(ctx, node, methodNid);
	} else {
		const funcNid = makeId(ctx.stem, methodName);
		addNode(ctx, funcNid, `${methodName}()`, line, 'function');
		addEdge(ctx, fileNid, funcNid, 'contains', line);
		collectBody(ctx, node, funcNid);
	}
}

function collectBody(ctx: ExtractionContext, node: AstNode, callerNid: string): void {
	const body = node.childForFieldName('body');
	if (body) {
		ctx.functionBodies.push({ callerNid, bodyNode: body });
		return;
	}

	ctx.functionBodies.push({ callerNid, bodyNode: node });
}
