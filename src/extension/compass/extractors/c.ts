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

export function extractC(ctx: ExtractionContext, root: unknown): void {
	const fileNid = ctx.fileId;
	addNode(ctx, fileNid, ctx.stem, 1);

	walk(ctx, root as AstNode, fileNid);
}

function walk(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	switch (node.type) {
		case 'preproc_include':
			handleInclude(ctx, node, fileNid);
			break;

		case 'function_definition':
			handleFunction(ctx, node, fileNid);
			return;

		case 'struct_specifier':
			handleStruct(ctx, node, fileNid);
			return;

		case 'type_definition':
			handleTypedef(ctx, node, fileNid);
			return;
	}

	for (const child of node.children) {
		walk(ctx, child, fileNid);
	}
}

function handleStruct(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	const nameNode = node.childForFieldName('name');
	if (!nameNode) return;

	const structName = nodeText(ctx.source, nameNode);
	const structNid = makeId(ctx.stem, structName);
	const line = node.startPosition.row + 1;

	addNode(ctx, structNid, structName, line);
	addEdge(ctx, fileNid, structNid, 'contains', line);
}

function handleTypedef(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	const declarator = node.childForFieldName('declarator');
	if (!declarator) return;

	const nameNode = declarator.type === 'type_identifier' ? declarator : null;
	if (!nameNode) return;

	const typeName = nodeText(ctx.source, nameNode);
	const typeNid = makeId(ctx.stem, typeName);
	const line = node.startPosition.row + 1;

	addNode(ctx, typeNid, typeName, line);
	addEdge(ctx, fileNid, typeNid, 'contains', line);

	for (const child of node.children) {
		if (child.type === 'struct_specifier') {
			const innerName = child.childForFieldName('name');
			if (innerName) {
				const innerNid = makeId(ctx.stem, nodeText(ctx.source, innerName));
				if (innerNid !== typeNid) {
					addEdge(ctx, typeNid, innerNid, 'aliases', line);
				}
			}
		}
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

function handleFunction(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
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
	if (node.type === 'identifier') return node;

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
