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

export function extractGo(ctx: ExtractionContext, root: unknown): void {
	const fileNid = ctx.fileId;
	addNode(ctx, fileNid, ctx.stem, 1);

	walk(ctx, root as AstNode, fileNid);
}

function walk(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	switch (node.type) {
		case 'import_declaration':
			handleImportDeclaration(ctx, node, fileNid);
			break;

		case 'function_declaration':
			handleFunction(ctx, node, fileNid);
			return;

		case 'method_declaration':
			handleMethod(ctx, node, fileNid);
			return;

		case 'type_declaration':
			handleTypeDeclaration(ctx, node, fileNid);
			return;
	}

	for (const child of node.children) {
		walk(ctx, child, fileNid);
	}
}

function handleImportDeclaration(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	const specList = findChild(node, 'import_spec_list');

	if (specList) {
		for (const child of specList.children) {
			if (child.type === 'import_spec') {
				extractImportPath(ctx, child, fileNid);
			}
		}
		return;
	}

	for (const child of node.children) {
		if (child.type === 'import_spec') {
			extractImportPath(ctx, child, fileNid);
		}
	}
}

function extractImportPath(ctx: ExtractionContext, spec: AstNode, fileNid: string): void {
	const pathNode = spec.childForFieldName('path');
	const target = pathNode ?? findChild(spec, 'interpreted_string_literal');
	if (!target) return;

	const raw = nodeText(ctx.source, target);
	const modulePath = raw.replace(/^"|"$/g, '');
	if (!modulePath) return;

	const moduleNid = makeId(modulePath);
	addEdge(ctx, fileNid, moduleNid, 'imports', spec.startPosition.row + 1);
}

function handleFunction(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	const nameNode = node.childForFieldName('name');
	if (!nameNode) return;

	const funcName = nodeText(ctx.source, nameNode);
	const funcNid = makeId(ctx.stem, funcName);
	const line = node.startPosition.row + 1;

	addNode(ctx, funcNid, `${funcName}()`, line);
	addEdge(ctx, fileNid, funcNid, 'contains', line);

	collectBody(ctx, node, funcNid);
}

function handleMethod(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	const nameNode = node.childForFieldName('name');
	if (!nameNode) return;

	const receiverType = extractReceiverType(ctx, node);
	const methodName = nodeText(ctx.source, nameNode);
	const line = node.startPosition.row + 1;

	if (receiverType) {
		const typeNid = makeId(ctx.stem, receiverType);
		if (!ctx.seenIds.has(typeNid)) {
			addNode(ctx, typeNid, receiverType, line);
			addEdge(ctx, fileNid, typeNid, 'contains', line);
		}

		const methodNid = makeId(typeNid, methodName);
		addNode(ctx, methodNid, `.${methodName}()`, line);
		addEdge(ctx, typeNid, methodNid, 'method', line);
		collectBody(ctx, node, methodNid);
	} else {
		const funcNid = makeId(ctx.stem, methodName);
		addNode(ctx, funcNid, `${methodName}()`, line);
		addEdge(ctx, fileNid, funcNid, 'contains', line);
		collectBody(ctx, node, funcNid);
	}
}

function extractReceiverType(ctx: ExtractionContext, node: AstNode): string | null {
	const receiver = node.childForFieldName('receiver');
	if (!receiver) return null;

	const paramList = receiver.type === 'parameter_list' ? receiver : null;
	const params = paramList ? paramList.children : [receiver];

	for (const param of params) {
		if (param.type !== 'parameter_declaration') continue;

		const typeNode = param.childForFieldName('type');
		if (!typeNode) continue;

		if (typeNode.type === 'pointer_type') {
			const inner = findChild(typeNode, 'type_identifier');
			if (inner) return nodeText(ctx.source, inner);
		}

		if (typeNode.type === 'type_identifier') {
			return nodeText(ctx.source, typeNode);
		}
	}

	return null;
}

function handleTypeDeclaration(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	for (const child of node.children) {
		if (child.type === 'type_spec') {
			handleTypeSpec(ctx, child, fileNid);
		}
	}
}

function handleTypeSpec(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	const nameNode = node.childForFieldName('name');
	if (!nameNode) return;

	const typeName = nodeText(ctx.source, nameNode);
	const typeNid = makeId(ctx.stem, typeName);
	const line = node.startPosition.row + 1;

	addNode(ctx, typeNid, typeName, line);
	addEdge(ctx, fileNid, typeNid, 'contains', line);
}

function collectBody(ctx: ExtractionContext, node: AstNode, callerNid: string): void {
	const body = node.childForFieldName('body');
	if (body) {
		ctx.functionBodies.push({ callerNid, bodyNode: body });
	}
}

function findChild(node: AstNode, type: string): AstNode | null {
	for (const child of node.children) {
		if (child.type === type) return child;
	}
	return null;
}
