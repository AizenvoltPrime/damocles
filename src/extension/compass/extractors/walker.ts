import { addNode, addEdge } from '../extractor-base';
import { qualifyName } from '../schema';
import type { ExtractionContext, NodeKind } from '../types';
import { CLASS_TYPES, TYPE_TYPES, FUNCTION_TYPES, IMPORT_TYPES, JS_LANGUAGES, isTestFunction } from './lang-maps';
import type { TreeNode } from './ast-helpers';
import { getName, getParams, getReturnType, getBases, getModifiers, getBody, getImportTarget, buildSignature, getGoReceiverType } from './ast-helpers';

const MAX_AST_DEPTH = 180;

const _typeSetCache = new Map<string, { classTypes: Set<string>; typeTypes: Set<string>; funcTypes: Set<string>; importTypes: Set<string> }>();

function getTypeSets(language: string) {
	let cached = _typeSetCache.get(language);
	if (!cached) {
		cached = {
			classTypes: new Set(CLASS_TYPES[language] ?? []),
			typeTypes: new Set(TYPE_TYPES[language] ?? []),
			funcTypes: new Set(FUNCTION_TYPES[language] ?? []),
			importTypes: new Set(IMPORT_TYPES[language] ?? []),
		};
		_typeSetCache.set(language, cached);
	}
	return cached;
}

export function extractFromTree(
	node: TreeNode,
	ctx: ExtractionContext,
	language: string,
	enclosingClass?: string,
	depth = 0,
): void {
	if (depth > MAX_AST_DEPTH) return;

	const { classTypes, typeTypes, funcTypes, importTypes } = getTypeSets(language);

	for (const child of node.children) {
		const t = child.type;

		if (JS_LANGUAGES.has(language) && (t === 'lexical_declaration' || t === 'variable_declaration')) {
			if (handleJsVarFunction(child, ctx, language, enclosingClass, depth)) continue;
		}

		if (JS_LANGUAGES.has(language) && t === 'public_field_definition' && enclosingClass) {
			if (handleJsFieldFunction(child, ctx, language, enclosingClass, depth)) continue;
		}

		if (JS_LANGUAGES.has(language) && t === 'export_statement') {
			const source = child.childForFieldName('source');
			if (source) {
				const target = source.text.replace(/['"]/g, '');
				if (target) {
					addEdge(ctx, 'IMPORTS_FROM', ctx.fileQualified, target, child.startPosition.row + 1);
				}
			}
			extractFromTree(child, ctx, language, enclosingClass, depth + 1);
			continue;
		}

		if (classTypes.has(t)) {
			handleClass(child, ctx, language, 'Class', enclosingClass, depth);
			continue;
		}

		if (typeTypes.has(t)) {
			handleClass(child, ctx, language, 'Type', enclosingClass, depth);
			continue;
		}

		if (funcTypes.has(t)) {
			handleFunction(child, ctx, language, enclosingClass, depth);
			continue;
		}

		if (importTypes.has(t)) {
			if (language === 'ruby' && t === 'call') {
				if (isRubyRequire(child)) {
					handleImport(child, ctx, language);
					continue;
				}
			} else {
				handleImport(child, ctx, language);
				continue;
			}
		}

		if (language === 'python' && t === 'decorated_definition') {
			extractFromTree(child, ctx, language, enclosingClass, depth + 1);
			continue;
		}

		extractFromTree(child, ctx, language, enclosingClass, depth + 1);
	}
}

function isRubyRequire(node: TreeNode): boolean {
	const method = node.childForFieldName('method');
	return method !== null && (method.text === 'require' || method.text === 'require_relative');
}

function emitContainsEdge(ctx: ExtractionContext, qualified: string, enclosingClass: string | undefined, line: number): void {
	if (enclosingClass) {
		const parentQ = qualifyName(enclosingClass, ctx.filePath);
		addEdge(ctx, 'CONTAINS', parentQ, qualified, line);
	} else if (ctx.seenQualified.has(ctx.fileQualified)) {
		addEdge(ctx, 'CONTAINS', ctx.fileQualified, qualified, line);
	}
}

function handleClass(
	node: TreeNode,
	ctx: ExtractionContext,
	language: string,
	kind: NodeKind,
	enclosingClass: string | undefined,
	depth: number,
): void {
	const name = getName(node, language);
	if (!name) return;

	const lineStart = node.startPosition.row + 1;
	const lineEnd = node.endPosition.row + 1;
	const modifiers = getModifiers(node);

	const qualified = addNode(ctx, kind, name, lineStart, lineEnd, {
		language,
		...(enclosingClass ? { parentName: enclosingClass } : {}),
		...(modifiers ? { modifiers } : {}),
	});

	emitContainsEdge(ctx, qualified, enclosingClass, lineStart);

	const bases = getBases(node, language);
	for (const base of bases) {
		const edgeKind = kind === 'Type' ? 'IMPLEMENTS' : 'INHERITS';
		addEdge(ctx, edgeKind, qualified, base, lineStart);
	}

	const body = getBody(node);
	if (body) {
		extractFromTree(body, ctx, language, name, depth + 1);
	} else {
		extractFromTree(node, ctx, language, name, depth + 1);
	}
}

function handleFunction(
	node: TreeNode,
	ctx: ExtractionContext,
	language: string,
	enclosingClass: string | undefined,
	_depth: number,
): void {
	const name = getName(node, language);
	if (!name) return;

	let effectiveEnclosingClass = enclosingClass;
	if (language === 'go' && node.type === 'method_declaration') {
		const receiverType = getGoReceiverType(node);
		if (receiverType) effectiveEnclosingClass = receiverType;
	}

	const lineStart = node.startPosition.row + 1;
	const lineEnd = node.endPosition.row + 1;
	const params = getParams(node);
	const returnType = getReturnType(node, language);
	const modifiers = getModifiers(node);
	const isTest = isTestFunction(name, ctx.filePath);
	const kind: NodeKind = isTest ? 'Test' : 'Function';
	const signature = buildSignature(name, params, returnType);

	const qualified = addNode(ctx, kind, name, lineStart, lineEnd, {
		language,
		...(effectiveEnclosingClass ? { parentName: effectiveEnclosingClass } : {}),
		...(params ? { params } : {}),
		...(returnType ? { returnType } : {}),
		...(modifiers ? { modifiers } : {}),
		...(signature ? { signature } : {}),
		isTest,
	});

	emitContainsEdge(ctx, qualified, effectiveEnclosingClass, lineStart);

	const body = getBody(node);
	if (body) {
		ctx.functionBodies.push({ callerQualified: qualified, bodyNode: body, lineOffset: ctx.lineOffset });
	}
}

function handleImport(
	node: TreeNode,
	ctx: ExtractionContext,
	language: string,
): void {
	const target = getImportTarget(node, language);
	if (!target) return;

	const lineStart = node.startPosition.row + 1;
	if (Array.isArray(target)) {
		for (const t of target) {
			addEdge(ctx, 'IMPORTS_FROM', ctx.fileQualified, t, lineStart);
		}
	} else {
		addEdge(ctx, 'IMPORTS_FROM', ctx.fileQualified, target, lineStart);
	}
}

function handleJsVarFunction(
	node: TreeNode,
	ctx: ExtractionContext,
	language: string,
	enclosingClass: string | undefined,
	depth: number,
): boolean {
	let handled = false;

	for (const child of node.namedChildren) {
		if (child.type !== 'variable_declarator') continue;

		const nameNode = child.childForFieldName('name');
		const valueNode = child.childForFieldName('value');
		if (!nameNode || !valueNode) continue;

		if (valueNode.type !== 'arrow_function' && valueNode.type !== 'function_expression'
			&& valueNode.type !== 'function') continue;

		const name = nameNode.text;
		const lineStart = node.startPosition.row + 1;
		const lineEnd = node.endPosition.row + 1;
		const params = getParams(valueNode);
		const returnType = getReturnType(valueNode, language);
		const isTest = isTestFunction(name, ctx.filePath);
		const kind: NodeKind = isTest ? 'Test' : 'Function';
		const signature = buildSignature(name, params, returnType);

		const qualified = addNode(ctx, kind, name, lineStart, lineEnd, {
			language,
			...(enclosingClass ? { parentName: enclosingClass } : {}),
			...(params ? { params } : {}),
			...(returnType ? { returnType } : {}),
			...(signature ? { signature } : {}),
			isTest,
		});

		emitContainsEdge(ctx, qualified, enclosingClass, lineStart);

		const body = getBody(valueNode);
		if (body) {
			ctx.functionBodies.push({ callerQualified: qualified, bodyNode: body, lineOffset: ctx.lineOffset });
		}

		handled = true;
	}

	if (!handled) {
		extractFromTree(node, ctx, language, enclosingClass, depth + 1);
	}

	return handled;
}

function handleJsFieldFunction(
	node: TreeNode,
	ctx: ExtractionContext,
	language: string,
	enclosingClass: string,
	depth: number,
): boolean {
	const nameNode = node.childForFieldName('name') ?? node.childForFieldName('property');
	const valueNode = node.childForFieldName('value');
	if (!nameNode || !valueNode) return false;

	if (valueNode.type !== 'arrow_function' && valueNode.type !== 'function_expression') return false;

	const name = nameNode.text;
	const lineStart = node.startPosition.row + 1;
	const lineEnd = node.endPosition.row + 1;
	const params = getParams(valueNode);
	const returnType = getReturnType(valueNode, language);
	const signature = buildSignature(name, params, returnType);

	const qualified = addNode(ctx, 'Function', name, lineStart, lineEnd, {
		language,
		parentName: enclosingClass,
		...(params ? { params } : {}),
		...(returnType ? { returnType } : {}),
		...(signature ? { signature } : {}),
	});

	addEdge(ctx, 'CONTAINS', qualifyName(enclosingClass, ctx.filePath), qualified, lineStart);

	const body = getBody(valueNode);
	if (body) {
		ctx.functionBodies.push({ callerQualified: qualified, bodyNode: body, lineOffset: ctx.lineOffset });
	} else {
		extractFromTree(valueNode, ctx, language, enclosingClass, depth + 1);
	}

	return true;
}
