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

export function extractCpp(ctx: ExtractionContext, root: unknown): void {
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
		case 'preproc_include':
			handleInclude(ctx, node, fileNid);
			break;

		case 'class_specifier':
			handleClass(ctx, node, fileNid);
			return;

		case 'function_definition':
			handleFunction(ctx, node, fileNid, parentClassNid);
			return;
	}

	for (const child of node.children) {
		walk(ctx, child, fileNid, parentClassNid);
	}
}

function handleInclude(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	const pathNode = node.childForFieldName('path');
	if (!pathNode) return;

	const raw = nodeText(ctx.source, pathNode);
	const moduleName = raw.replace(/^["<]|[">]$/g, '').replace(/\.[^.]+$/, '');
	const moduleNid = makeId(moduleName);
	addEdge(ctx, fileNid, moduleNid, 'imports', node.startPosition.row + 1);
}

function handleClass(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	const nameNode = node.childForFieldName('name');
	if (!nameNode) return;

	const className = nodeText(ctx.source, nameNode);
	const classNid = makeId(ctx.stem, className);
	const line = node.startPosition.row + 1;

	addNode(ctx, classNid, className, line);
	addEdge(ctx, fileNid, classNid, 'contains', line);

	const body = node.childForFieldName('body');
	if (body) {
		for (const child of body.children) {
			if (child.type === 'function_definition' || child.type === 'method_definition') {
				handleMethod(ctx, child, classNid);
			} else if (child.type === 'access_specifier' || child.type === 'comment') {
				continue;
			} else {
				walk(ctx, child, fileNid, classNid);
			}
		}
	}
}

function handleMethod(ctx: ExtractionContext, node: AstNode, classNid: string): void {
	const declarator = node.childForFieldName('declarator');
	if (!declarator) return;

	const nameNode = unwrapDeclaratorName(declarator);
	if (!nameNode) return;

	const methodName = nodeText(ctx.source, nameNode);
	const methodNid = makeId(classNid, methodName);
	const line = node.startPosition.row + 1;

	addNode(ctx, methodNid, `.${methodName}()`, line);
	addEdge(ctx, classNid, methodNid, 'method', line);

	collectBody(ctx, node, methodNid);
}

function handleFunction(
	ctx: ExtractionContext,
	node: AstNode,
	fileNid: string,
	parentClassNid: string | null,
): void {
	if (parentClassNid) {
		handleMethod(ctx, node, parentClassNid);
		return;
	}

	const declarator = node.childForFieldName('declarator');
	if (!declarator) return;

	const nameNode = unwrapDeclaratorName(declarator);
	if (!nameNode) return;

	const funcName = nodeText(ctx.source, nameNode);
	const funcNid = makeId(ctx.stem, funcName);
	const line = node.startPosition.row + 1;

	addNode(ctx, funcNid, `${funcName}()`, line);
	addEdge(ctx, fileNid, funcNid, 'contains', line);

	collectBody(ctx, node, funcNid);
}

function unwrapDeclaratorName(node: AstNode): AstNode | null {
	if (node.type === 'identifier' || node.type === 'field_identifier') return node;

	const declarator = node.childForFieldName('declarator');
	if (declarator) return unwrapDeclaratorName(declarator);

	const nameNode = node.childForFieldName('name');
	if (nameNode) return nameNode;

	return null;
}

function collectBody(ctx: ExtractionContext, node: AstNode, callerNid: string): void {
	const body = node.childForFieldName('body');
	if (body) {
		ctx.functionBodies.push({ callerNid, bodyNode: body });
	}
}
