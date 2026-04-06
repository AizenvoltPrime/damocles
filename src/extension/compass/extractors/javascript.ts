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

const SUPERCLASS_IDENTIFIER_TYPES = new Set(['identifier', 'type_identifier']);

export function extractJavaScript(ctx: ExtractionContext, root: unknown): void {
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
		case 'import_statement':
			handleImport(ctx, node, fileNid);
			break;

		case 'class_declaration':
		case 'abstract_class_declaration':
			handleClass(ctx, node, fileNid);
			return;

		case 'interface_declaration':
			handleInterface(ctx, node, fileNid);
			return;

		case 'type_alias_declaration':
		case 'enum_declaration':
			handleTypeDeclaration(ctx, node, fileNid);
			return;

		case 'function_declaration':
			handleFunction(ctx, node, fileNid);
			return;

		case 'method_definition':
			if (parentClassNid) {
				handleMethod(ctx, node, parentClassNid);
				return;
			}
			break;

		case 'lexical_declaration':
		case 'variable_declaration':
			handleVariableDeclaration(ctx, node, fileNid, parentClassNid);
			return;
	}

	for (const child of node.children) {
		walk(ctx, child, fileNid, parentClassNid);
	}
}

function handleImport(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	for (const child of node.children) {
		if (child.type === 'string' || child.type === 'string_fragment') {
			const raw = nodeText(ctx.source, child);
			const moduleName = raw.replace(/^['"`]|['"`]$/g, '');
			if (moduleName) {
				const moduleNid = makeId(moduleName);
				addEdge(ctx, fileNid, moduleNid, 'imports', node.startPosition.row + 1);
			}
			return;
		}
	}

	const source = node.childForFieldName('source');
	if (source) {
		const raw = nodeText(ctx.source, source);
		const moduleName = raw.replace(/^['"`]|['"`]$/g, '');
		if (moduleName) {
			const moduleNid = makeId(moduleName);
			addEdge(ctx, fileNid, moduleNid, 'imports', node.startPosition.row + 1);
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

	const heritage = node.childForFieldName('superclass')
		?? findChild(node, 'class_heritage');
	if (heritage) {
		for (const baseName of collectSuperclassNames(ctx.source, heritage)) {
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
	}

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

	const body = node.childForFieldName('body');
	if (body) {
		ctx.functionBodies.push({ callerNid: funcNid, bodyNode: body });
	}
}

function handleMethod(ctx: ExtractionContext, node: AstNode, classNid: string): void {
	const nameNode = node.childForFieldName('name');
	if (!nameNode) return;

	const methodName = nodeText(ctx.source, nameNode);
	const methodNid = makeId(classNid, methodName);
	const line = node.startPosition.row + 1;

	addNode(ctx, methodNid, `.${methodName}()`, line, 'method');
	addEdge(ctx, classNid, methodNid, 'method', line);

	const body = node.childForFieldName('body');
	if (body) {
		ctx.functionBodies.push({ callerNid: methodNid, bodyNode: body });
	}
}

function handleVariableDeclaration(
	ctx: ExtractionContext,
	node: AstNode,
	fileNid: string,
	parentClassNid: string | null,
): void {
	for (const child of node.children) {
		if (child.type !== 'variable_declarator') continue;

		const nameNode = child.childForFieldName('name');
		const valueNode = child.childForFieldName('value');
		if (!nameNode || !valueNode) continue;

		if (valueNode.type !== 'arrow_function' && valueNode.type !== 'function_expression') continue;

		const funcName = nodeText(ctx.source, nameNode);
		const line = node.startPosition.row + 1;

		if (parentClassNid) {
			const methodNid = makeId(parentClassNid, funcName);
			addNode(ctx, methodNid, `.${funcName}()`, line, 'method');
			addEdge(ctx, parentClassNid, methodNid, 'method', line);

			const body = valueNode.childForFieldName('body');
			if (body) {
				ctx.functionBodies.push({ callerNid: methodNid, bodyNode: body });
			}
		} else {
			const funcNid = makeId(ctx.stem, funcName);
			addNode(ctx, funcNid, `${funcName}()`, line, 'function');
			addEdge(ctx, fileNid, funcNid, 'contains', line);

			const body = valueNode.childForFieldName('body');
			if (body) {
				ctx.functionBodies.push({ callerNid: funcNid, bodyNode: body });
			}
		}
	}

	for (const child of node.children) {
		if (child.type !== 'variable_declarator') {
			walk(ctx, child, fileNid, parentClassNid);
		}
	}
}

function handleInterface(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	const nameNode = node.childForFieldName('name');
	if (!nameNode) return;

	const name = nodeText(ctx.source, nameNode);
	const nid = makeId(ctx.stem, name);
	const line = node.startPosition.row + 1;

	addNode(ctx, nid, name, line, 'class');
	addEdge(ctx, fileNid, nid, 'contains', line);

	const extendsClause = findChild(node, 'extends_type_clause');
	if (extendsClause) {
		for (const child of extendsClause.children) {
			if (child.type === 'type_identifier' || child.type === 'identifier') {
				const baseName = nodeText(ctx.source, child);
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
				addEdge(ctx, nid, baseNid, 'inherits', line);
			}
		}
	}

	const body = node.childForFieldName('body');
	if (body) {
		for (const child of body.children) {
			if (child.type === 'method_signature' || child.type === 'property_signature') {
				const sigNameNode = child.childForFieldName('name');
				if (sigNameNode) {
					const sigName = nodeText(ctx.source, sigNameNode);
					const sigNid = makeId(nid, sigName);
					addNode(ctx, sigNid, `.${sigName}()`, child.startPosition.row + 1, 'method');
					addEdge(ctx, nid, sigNid, 'method', child.startPosition.row + 1);
				}
			}
		}
	}
}

function handleTypeDeclaration(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	const nameNode = node.childForFieldName('name');
	if (!nameNode) return;

	const name = nodeText(ctx.source, nameNode);
	const nid = makeId(ctx.stem, name);
	const line = node.startPosition.row + 1;

	addNode(ctx, nid, name, line, 'type');
	addEdge(ctx, fileNid, nid, 'contains', line);
}

function collectSuperclassNames(source: string, node: AstNode): string[] {
	const names: string[] = [];
	function scan(n: AstNode): void {
		if (SUPERCLASS_IDENTIFIER_TYPES.has(n.type)) {
			names.push(nodeText(source, n));
			return;
		}
		for (const child of n.children) {
			scan(child);
		}
	}
	scan(node);
	return names;
}

function findChild(node: AstNode, type: string): AstNode | null {
	for (const child of node.children) {
		if (child.type === type) return child;
	}
	return null;
}
