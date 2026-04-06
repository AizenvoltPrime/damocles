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

export function extractRust(ctx: ExtractionContext, root: unknown): void {
	const fileNid = ctx.fileId;
	addNode(ctx, fileNid, ctx.stem, 1);

	walk(ctx, root as AstNode, fileNid);
}

function walk(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	switch (node.type) {
		case 'use_declaration':
			handleUseDeclaration(ctx, node, fileNid);
			break;

		case 'function_item':
			handleFunction(ctx, node, fileNid);
			return;

		case 'struct_item':
			handleStructItem(ctx, node, fileNid);
			return;

		case 'enum_item':
			handleEnumItem(ctx, node, fileNid);
			return;

		case 'trait_item':
			handleTraitItem(ctx, node, fileNid);
			return;

		case 'impl_item':
			handleImplItem(ctx, node, fileNid);
			return;
	}

	for (const child of node.children) {
		walk(ctx, child, fileNid);
	}
}

function handleUseDeclaration(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	const pathText = collectUsePath(ctx, node);
	if (!pathText) return;

	const moduleNid = makeId(pathText);
	addEdge(ctx, fileNid, moduleNid, 'imports', node.startPosition.row + 1);
}

function collectUsePath(ctx: ExtractionContext, node: AstNode): string | null {
	for (const child of node.children) {
		if (child.type === 'scoped_identifier' || child.type === 'scoped_use_list') {
			return gatherScopedPath(ctx, child);
		}

		if (child.type === 'identifier' || child.type === 'crate') {
			return nodeText(ctx.source, child);
		}

		if (child.type === 'use_wildcard') {
			const pathNode = child.childForFieldName('path');
			if (pathNode) return gatherScopedPath(ctx, pathNode);
		}
	}

	return null;
}

function gatherScopedPath(ctx: ExtractionContext, node: AstNode): string {
	const parts: string[] = [];

	function gather(n: AstNode): void {
		if (n.type === 'identifier' || n.type === 'crate') {
			parts.push(nodeText(ctx.source, n));
			return;
		}

		if (n.type === 'scoped_identifier') {
			const pathNode = n.childForFieldName('path');
			const nameNode = n.childForFieldName('name');
			if (pathNode) gather(pathNode);
			if (nameNode) parts.push(nodeText(ctx.source, nameNode));
			return;
		}

		for (const child of n.children) {
			if (child.type === 'scoped_identifier' || child.type === 'identifier' || child.type === 'crate') {
				gather(child);
			}
		}
	}

	gather(node);
	return parts.join('::');
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

function handleStructItem(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	const nameNode = node.childForFieldName('name');
	if (!nameNode) return;

	const structName = nodeText(ctx.source, nameNode);
	const structNid = makeId(ctx.stem, structName);
	const line = node.startPosition.row + 1;

	addNode(ctx, structNid, structName, line);
	addEdge(ctx, fileNid, structNid, 'contains', line);
}

function handleEnumItem(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	const nameNode = node.childForFieldName('name');
	if (!nameNode) return;

	const enumName = nodeText(ctx.source, nameNode);
	const enumNid = makeId(ctx.stem, enumName);
	const line = node.startPosition.row + 1;

	addNode(ctx, enumNid, enumName, line);
	addEdge(ctx, fileNid, enumNid, 'contains', line);
}

function handleTraitItem(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	const nameNode = node.childForFieldName('name');
	if (!nameNode) return;

	const traitName = nodeText(ctx.source, nameNode);
	const traitNid = makeId(ctx.stem, traitName);
	const line = node.startPosition.row + 1;

	addNode(ctx, traitNid, traitName, line);
	addEdge(ctx, fileNid, traitNid, 'contains', line);
}

function handleImplItem(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	const typeName = extractImplTypeName(ctx, node);
	if (!typeName) return;

	const typeNid = makeId(ctx.stem, typeName);
	const line = node.startPosition.row + 1;

	if (!ctx.seenIds.has(typeNid)) {
		addNode(ctx, typeNid, typeName, line);
		addEdge(ctx, fileNid, typeNid, 'contains', line);
	}

	const traitNode = node.childForFieldName('trait');
	if (traitNode) {
		const traitName = nodeText(ctx.source, traitNode);
		const traitNid = makeId(traitName);
		addEdge(ctx, typeNid, traitNid, 'implements', line);
	}

	const body = node.childForFieldName('body');
	if (!body) return;

	for (const child of body.children) {
		if (child.type === 'function_item') {
			handleImplMethod(ctx, child, typeNid);
		}
	}
}

function extractImplTypeName(ctx: ExtractionContext, node: AstNode): string | null {
	const typeNode = node.childForFieldName('type');
	if (typeNode) return nodeText(ctx.source, typeNode);

	for (const child of node.children) {
		if (child.type === 'type_identifier' || child.type === 'generic_type') {
			const nameChild = child.type === 'generic_type' ? child.childForFieldName('type') : child;
			if (nameChild) return nodeText(ctx.source, nameChild);
		}
	}

	return null;
}

function handleImplMethod(ctx: ExtractionContext, node: AstNode, typeNid: string): void {
	const nameNode = node.childForFieldName('name');
	if (!nameNode) return;

	const methodName = nodeText(ctx.source, nameNode);
	const methodNid = makeId(typeNid, methodName);
	const line = node.startPosition.row + 1;

	addNode(ctx, methodNid, `.${methodName}()`, line);
	addEdge(ctx, typeNid, methodNid, 'method', line);

	collectBody(ctx, node, methodNid);
}

function collectBody(ctx: ExtractionContext, node: AstNode, callerNid: string): void {
	const body = node.childForFieldName('body');
	if (body) {
		ctx.functionBodies.push({ callerNid, bodyNode: body });
	}
}
