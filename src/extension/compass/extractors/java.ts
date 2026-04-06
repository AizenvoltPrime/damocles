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

export function extractJava(ctx: ExtractionContext, root: unknown): void {
	const fileNid = ctx.fileId;
	addNode(ctx, fileNid, ctx.stem, 1);

	walk(ctx, root as AstNode, fileNid, null);
}

function walk(
	ctx: ExtractionContext,
	node: AstNode,
	fileNid: string,
	parentClassNid: string | null,
): void {
	switch (node.type) {
		case 'import_declaration':
			handleImport(ctx, node, fileNid);
			break;

		case 'class_declaration':
			handleClass(ctx, node, fileNid, parentClassNid);
			return;

		case 'interface_declaration':
			handleInterface(ctx, node, fileNid, parentClassNid);
			return;

		case 'method_declaration':
			if (parentClassNid) {
				handleMethod(ctx, node, parentClassNid);
				return;
			}
			break;

		case 'constructor_declaration':
			if (parentClassNid) {
				handleConstructor(ctx, node, parentClassNid);
				return;
			}
			break;
	}

	for (const child of node.children) {
		walk(ctx, child, fileNid, parentClassNid);
	}
}

function handleImport(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	const importPath = reconstructScopedIdentifier(ctx, node);
	if (!importPath) return;

	const moduleNid = makeId(importPath);
	addEdge(ctx, fileNid, moduleNid, 'imports', node.startPosition.row + 1);
}

function reconstructScopedIdentifier(ctx: ExtractionContext, node: AstNode): string | null {
	for (const child of node.children) {
		if (child.type === 'scoped_identifier') {
			return nodeText(ctx.source, child);
		}

		if (child.type === 'identifier') {
			return nodeText(ctx.source, child);
		}
	}

	return null;
}

function handleClass(
	ctx: ExtractionContext,
	node: AstNode,
	fileNid: string,
	parentClassNid: string | null,
): void {
	const nameNode = node.childForFieldName('name');
	if (!nameNode) return;

	const className = nodeText(ctx.source, nameNode);
	const classNid = makeId(ctx.stem, className);
	const line = node.startPosition.row + 1;

	addNode(ctx, classNid, className, line);

	const containerNid = parentClassNid ?? fileNid;
	addEdge(ctx, containerNid, classNid, 'contains', line);

	const superclass = node.childForFieldName('superclass');
	if (superclass) {
		const baseName = extractTypeName(ctx, superclass);
		if (baseName) {
			const baseNid = makeId(baseName);
			if (!ctx.seenIds.has(baseNid)) {
				addNode(ctx, baseNid, baseName, line);
				ctx.nodes[ctx.nodes.length - 1]!.source_file = '';
			}
			addEdge(ctx, classNid, baseNid, 'inherits', line);
		}
	}

	const interfaces = node.childForFieldName('interfaces');
	if (interfaces) {
		handleImplementsList(ctx, interfaces, classNid, line);
	}

	const body = node.childForFieldName('body');
	if (body) {
		for (const child of body.children) {
			walk(ctx, child, fileNid, classNid);
		}
	}
}

function handleInterface(
	ctx: ExtractionContext,
	node: AstNode,
	fileNid: string,
	parentClassNid: string | null,
): void {
	const nameNode = node.childForFieldName('name');
	if (!nameNode) return;

	const ifaceName = nodeText(ctx.source, nameNode);
	const ifaceNid = makeId(ctx.stem, ifaceName);
	const line = node.startPosition.row + 1;

	addNode(ctx, ifaceNid, ifaceName, line);

	const containerNid = parentClassNid ?? fileNid;
	addEdge(ctx, containerNid, ifaceNid, 'contains', line);

	const body = node.childForFieldName('body');
	if (body) {
		for (const child of body.children) {
			walk(ctx, child, fileNid, ifaceNid);
		}
	}
}

function handleImplementsList(
	ctx: ExtractionContext,
	node: AstNode,
	classNid: string,
	line: number,
): void {
	for (const child of node.children) {
		if (child.type === 'type_identifier' || child.type === 'generic_type') {
			const ifaceName = child.type === 'generic_type'
				? extractGenericBaseName(ctx, child)
				: nodeText(ctx.source, child);

			if (ifaceName) {
				const ifaceNid = makeId(ifaceName);
				addEdge(ctx, classNid, ifaceNid, 'implements', line);
			}
		}

		if (child.type === 'type_list') {
			handleImplementsList(ctx, child, classNid, line);
		}
	}
}

function handleMethod(ctx: ExtractionContext, node: AstNode, classNid: string): void {
	const nameNode = node.childForFieldName('name');
	if (!nameNode) return;

	const methodName = nodeText(ctx.source, nameNode);
	const methodNid = makeId(classNid, methodName);
	const line = node.startPosition.row + 1;

	addNode(ctx, methodNid, `.${methodName}()`, line);
	addEdge(ctx, classNid, methodNid, 'method', line);

	collectBody(ctx, node, methodNid);
}

function handleConstructor(ctx: ExtractionContext, node: AstNode, classNid: string): void {
	const nameNode = node.childForFieldName('name');
	if (!nameNode) return;

	const ctorName = nodeText(ctx.source, nameNode);
	const params = node.childForFieldName('parameters');
	const paramCount = params
		? params.children.filter(c => c.type === 'formal_parameter' || c.type === 'spread_parameter').length
		: 0;
	const ctorNid = makeId(classNid, `constructor_${paramCount}`);
	const line = node.startPosition.row + 1;

	addNode(ctx, ctorNid, `${ctorName}(${paramCount})`, line);
	addEdge(ctx, classNid, ctorNid, 'method', line);

	collectBody(ctx, node, ctorNid);
}

function extractTypeName(ctx: ExtractionContext, node: AstNode): string | null {
	if (node.type === 'type_identifier' || node.type === 'identifier') {
		return nodeText(ctx.source, node);
	}

	if (node.type === 'generic_type') {
		return extractGenericBaseName(ctx, node);
	}

	for (const child of node.children) {
		if (child.type === 'type_identifier' || child.type === 'identifier') {
			return nodeText(ctx.source, child);
		}
		if (child.type === 'generic_type') {
			return extractGenericBaseName(ctx, child);
		}
	}

	return null;
}

function extractGenericBaseName(ctx: ExtractionContext, node: AstNode): string | null {
	const nameNode = node.children[0];
	if (nameNode && (nameNode.type === 'type_identifier' || nameNode.type === 'identifier')) {
		return nodeText(ctx.source, nameNode);
	}
	return null;
}

function collectBody(ctx: ExtractionContext, node: AstNode, callerNid: string): void {
	const body = node.childForFieldName('body');
	if (body) {
		ctx.functionBodies.push({ callerNid, bodyNode: body });
	}
}
