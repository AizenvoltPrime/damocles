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

export function extractPhp(ctx: ExtractionContext, root: unknown): void {
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
		case 'namespace_use_declaration':
			handleUse(ctx, node, fileNid);
			break;

		case 'class_declaration':
		case 'interface_declaration':
		case 'trait_declaration':
			handleClass(ctx, node, fileNid);
			return;

		case 'function_definition':
			handleFunction(ctx, node, fileNid);
			return;

		case 'method_declaration':
			if (parentClassNid) {
				handleMethod(ctx, node, parentClassNid);
				return;
			}
			break;
	}

	for (const child of node.children) {
		walk(ctx, child, fileNid, parentClassNid);
	}
}

function handleUse(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	for (const child of node.children) {
		if (child.type === 'namespace_use_clause') {
			const nameNode = child.childForFieldName('name') ?? child.children.find(c => c.type === 'qualified_name' || c.type === 'name');
			if (nameNode) {
				const moduleName = nodeText(ctx.source, nameNode);
				const moduleNid = makeId(moduleName);
				addEdge(ctx, fileNid, moduleNid, 'imports', node.startPosition.row + 1);
			}
		}
	}
}

function handleClass(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	const nameNode = node.childForFieldName('name');
	if (!nameNode) return;

	const className = nodeText(ctx.source, nameNode);
	const classNid = makeId(ctx.stem, className);
	const line = node.startPosition.row + 1;

	addNode(ctx, classNid, className, line, 'class');
	addEdge(ctx, fileNid, classNid, 'contains', line);

	const body = node.childForFieldName('body');
	if (body) {
		for (const child of body.children) {
			walk(ctx, child, fileNid, classNid);
		}
	}
}

function handleFunction(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	const nameNode = node.childForFieldName('name');
	if (!nameNode) return;

	const funcName = nodeText(ctx.source, nameNode);
	const funcNid = makeId(ctx.stem, funcName);
	const line = node.startPosition.row + 1;

	addNode(ctx, funcNid, `${funcName}()`, line, 'function');
	addEdge(ctx, fileNid, funcNid, 'contains', line);

	collectBody(ctx, node, funcNid);
}

function handleMethod(ctx: ExtractionContext, node: AstNode, classNid: string): void {
	const nameNode = node.childForFieldName('name');
	if (!nameNode) return;

	const methodName = nodeText(ctx.source, nameNode);
	const methodNid = makeId(classNid, methodName);
	const line = node.startPosition.row + 1;

	addNode(ctx, methodNid, `.${methodName}()`, line, 'method');
	addEdge(ctx, classNid, methodNid, 'method', line);

	collectBody(ctx, node, methodNid);
}

function collectBody(ctx: ExtractionContext, node: AstNode, callerNid: string): void {
	const body = node.childForFieldName('body');
	if (body) {
		ctx.functionBodies.push({ callerNid, bodyNode: body });
	}
}
