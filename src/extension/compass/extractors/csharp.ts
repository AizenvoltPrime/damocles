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

export function extractCSharp(ctx: ExtractionContext, root: unknown): void {
	const fileNid = ctx.fileId;
	addNode(ctx, fileNid, ctx.stem, 1);

	walk(ctx, root as AstNode, fileNid, null, null);
}

function walk(
	ctx: ExtractionContext,
	node: AstNode,
	fileNid: string,
	parentClassNid: string | null,
	namespace: string | null,
): void {
	switch (node.type) {
		case 'using_directive':
			handleUsing(ctx, node, fileNid);
			break;

		case 'namespace_declaration':
			handleNamespace(ctx, node, fileNid, parentClassNid);
			return;

		case 'class_declaration':
			handleClass(ctx, node, fileNid, namespace);
			return;

		case 'interface_declaration':
			handleInterface(ctx, node, fileNid, namespace);
			return;

		case 'method_declaration':
			handleMethod(ctx, node, fileNid, parentClassNid);
			return;

	}

	for (const child of node.children) {
		walk(ctx, child, fileNid, parentClassNid, namespace);
	}
}

function handleUsing(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	const nameNode = node.childForFieldName('name');
	if (nameNode) {
		const moduleName = nodeText(ctx.source, nameNode);
		const moduleNid = makeId(moduleName);
		addEdge(ctx, fileNid, moduleNid, 'imports', node.startPosition.row + 1);
		return;
	}

	for (const child of node.children) {
		if (child.type === 'qualified_name' || child.type === 'identifier') {
			const moduleName = nodeText(ctx.source, child);
			const moduleNid = makeId(moduleName);
			addEdge(ctx, fileNid, moduleNid, 'imports', node.startPosition.row + 1);
			break;
		}
	}
}

function handleNamespace(
	ctx: ExtractionContext,
	node: AstNode,
	fileNid: string,
	parentClassNid: string | null,
): void {
	const nameNode = node.childForFieldName('name');
	const nsName = nameNode ? nodeText(ctx.source, nameNode) : null;

	const body = node.childForFieldName('body');
	const target = body ?? node;

	for (const child of target.children) {
		walk(ctx, child, fileNid, parentClassNid, nsName);
	}
}

function handleClass(
	ctx: ExtractionContext,
	node: AstNode,
	fileNid: string,
	namespace: string | null,
): void {
	const nameNode = node.childForFieldName('name');
	if (!nameNode) return;

	const className = nodeText(ctx.source, nameNode);
	const classNid = namespace
		? makeId(ctx.stem, namespace, className)
		: makeId(ctx.stem, className);
	const line = node.startPosition.row + 1;

	addNode(ctx, classNid, className, line);
	addEdge(ctx, fileNid, classNid, 'contains', line);

	handleBaseList(ctx, node, classNid, line);

	const body = node.childForFieldName('body');
	if (body) {
		for (const child of body.children) {
			walk(ctx, child, fileNid, classNid, namespace);
		}
	}
}

function handleBaseList(
	ctx: ExtractionContext,
	node: AstNode,
	classNid: string,
	line: number,
): void {
	const baseList = node.childForFieldName('bases');

	const target = baseList ?? findChildByType(node, 'base_list');
	if (!target) return;

	for (const child of target.children) {
		if (child.type === 'identifier' || child.type === 'qualified_name' || child.type === 'generic_name') {
			const baseName = extractTypeName(ctx, child);
			const baseNid = makeId(baseName);
			if (!ctx.seenIds.has(baseNid)) {
				ctx.seenIds.add(baseNid);
				ctx.nodes.push({
					id: baseNid,
					label: baseName,
					file_type: 'code',
					source_file: '',
					source_location: `L${line}`,
				});
			}
			addEdge(ctx, classNid, baseNid, 'inherits', line);
		}
	}
}

function handleInterface(
	ctx: ExtractionContext,
	node: AstNode,
	fileNid: string,
	namespace: string | null,
): void {
	const nameNode = node.childForFieldName('name');
	if (!nameNode) return;

	const ifaceName = nodeText(ctx.source, nameNode);
	const ifaceNid = namespace
		? makeId(ctx.stem, namespace, ifaceName)
		: makeId(ctx.stem, ifaceName);
	const line = node.startPosition.row + 1;

	addNode(ctx, ifaceNid, ifaceName, line);
	addEdge(ctx, fileNid, ifaceNid, 'contains', line);

	handleBaseList(ctx, node, ifaceNid, line);

	const body = node.childForFieldName('body');
	if (body) {
		for (const child of body.children) {
			walk(ctx, child, fileNid, ifaceNid, namespace);
		}
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
		addNode(ctx, methodNid, `.${methodName}()`, line);
		addEdge(ctx, parentClassNid, methodNid, 'method', line);
		collectBody(ctx, node, methodNid);
	} else {
		const funcNid = makeId(ctx.stem, methodName);
		addNode(ctx, funcNid, `${methodName}()`, line);
		addEdge(ctx, fileNid, funcNid, 'contains', line);
		collectBody(ctx, node, funcNid);
	}
}

function collectBody(ctx: ExtractionContext, node: AstNode, callerNid: string): void {
	const body = node.childForFieldName('body');
	if (body) {
		ctx.functionBodies.push({ callerNid, bodyNode: body });
	}
}

function findChildByType(node: AstNode, type: string): AstNode | null {
	for (const child of node.children) {
		if (child.type === type) return child;
	}
	return null;
}

function extractTypeName(ctx: ExtractionContext, node: AstNode): string {
	if (node.type === 'generic_name') {
		const nameNode = node.childForFieldName('name');
		if (nameNode) return nodeText(ctx.source, nameNode);
	}
	return nodeText(ctx.source, node);
}
