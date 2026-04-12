export interface TreeNode {
	type: string;
	text: string;
	startPosition: { row: number; column: number };
	endPosition: { row: number; column: number };
	startIndex: number;
	endIndex: number;
	children: TreeNode[];
	namedChildren: TreeNode[];
	childForFieldName(name: string): TreeNode | null;
	parent: TreeNode | null;
}

export function getName(node: TreeNode, language: string): string | null {
	const nameNode = node.childForFieldName('name');
	if (nameNode) return nameNode.text;

	if (language === 'go' && node.type === 'type_declaration') {
		const spec = node.namedChildren[0];
		if (spec) {
			const specName = spec.childForFieldName('name');
			return specName?.text ?? null;
		}
	}

	if (language === 'rust' && (node.type === 'impl_item' || node.type === 'trait_item')) {
		const typeNode = node.childForFieldName('type');
		return typeNode?.text ?? null;
	}

	if (node.type === 'struct_specifier' || node.type === 'class_specifier') {
		for (const child of node.children) {
			if (child.type === 'type_identifier' || child.type === 'field_identifier') {
				return child.text;
			}
		}
	}

	return null;
}

export function getGoReceiverType(node: TreeNode): string | null {
	const receiver = node.childForFieldName('receiver');
	if (!receiver) return null;

	for (const param of receiver.namedChildren) {
		const typeNode = param.childForFieldName('type');
		if (!typeNode) continue;
		if (typeNode.type === 'pointer_type') {
			for (const child of typeNode.namedChildren) {
				if (child.type === 'type_identifier') return child.text;
			}
		}
		if (typeNode.type === 'type_identifier') return typeNode.text;
	}
	return null;
}

export function getParams(node: TreeNode): string | null {
	const params = node.childForFieldName('parameters')
		?? node.childForFieldName('formal_parameters')
		?? node.childForFieldName('params');
	return params?.text ?? null;
}

export function getReturnType(node: TreeNode, language: string): string | null {
	const rt = node.childForFieldName('return_type')
		?? node.childForFieldName('result');
	if (rt) return rt.text;

	if (language === 'java' || language === 'csharp' || language === 'kotlin') {
		const typeNode = node.childForFieldName('type');
		return typeNode?.text ?? null;
	}

	return null;
}

const BASE_NAME_TYPES = new Set([
	'identifier', 'type_identifier', 'generic_type', 'scoped_type_identifier',
]);

function collectBaseNames(node: TreeNode, depth = 0): string[] {
	if (depth > 3) return [];
	const names: string[] = [];
	for (const child of node.namedChildren) {
		if (BASE_NAME_TYPES.has(child.type)) {
			names.push(child.childForFieldName('name')?.text ?? child.text);
		} else {
			names.push(...collectBaseNames(child, depth + 1));
		}
	}
	return names;
}

export function getBases(node: TreeNode, language: string): string[] {
	const bases: string[] = [];

	if (language === 'python') {
		const superclasses = node.childForFieldName('superclasses');
		if (superclasses) {
			for (const child of superclasses.namedChildren) {
				if (child.type === 'identifier' || child.type === 'attribute') {
					bases.push(child.text);
				}
			}
		}
		if (bases.length === 0) {
			for (const child of node.children) {
				if (child.type === 'argument_list') {
					for (const nameNode of child.namedChildren) {
						if (nameNode.type === 'identifier' || nameNode.type === 'attribute') {
							bases.push(nameNode.text);
						}
					}
				}
			}
		}
		return bases;
	}

	const HERITAGE_TYPES = new Set([
		'class_heritage', 'extends_clause', 'superclass', 'super_interfaces',
		'superinterfaces', 'extends_type_clause', 'implements_clause',
	]);

	for (const child of node.children) {
		if (HERITAGE_TYPES.has(child.type)) {
			bases.push(...collectBaseNames(child));
		}
	}

	if (language === 'rust' && node.type === 'impl_item') {
		const traitNode = node.childForFieldName('trait');
		if (traitNode) bases.push(traitNode.text);
	}

	return bases;
}

export function getModifiers(node: TreeNode): string | null {
	const modifiers: string[] = [];

	if (node.parent?.type === 'decorated_definition') {
		for (const child of node.parent.children) {
			if (child.type === 'decorator') {
				modifiers.push(child.text);
			}
		}
	}

	for (const child of node.children) {
		if (child.type === 'modifiers' || child.type === 'modifier') {
			modifiers.push(child.text);
		}
		if (child.type === 'visibility_modifier' || child.type === 'access_modifier') {
			modifiers.push(child.text);
		}
	}

	return modifiers.length > 0 ? modifiers.join(' ') : null;
}

export function getBody(node: TreeNode): TreeNode | null {
	return node.childForFieldName('body')
		?? node.childForFieldName('block')
		?? node.childForFieldName('consequence');
}

export function getImportTarget(node: TreeNode, language: string): string | string[] | null {
	if (language === 'python') {
		const moduleNode = node.childForFieldName('module_name');
		if (moduleNode) return moduleNode.text;
		for (const child of node.namedChildren) {
			if (child.type === 'dotted_name' || child.type === 'identifier') {
				return child.text;
			}
		}
		return null;
	}

	for (const child of node.children) {
		if (child.type === 'string' || child.type === 'string_literal'
			|| child.type === 'string_fragment') {
			return child.text.replace(/['"]/g, '');
		}
	}

	for (const child of node.namedChildren) {
		if (child.type === 'string' || child.type === 'string_literal') {
			return child.text.replace(/['"]/g, '');
		}
	}

	if (language === 'go') {
		for (const child of node.namedChildren) {
			if (child.type === 'import_spec_list') {
				const specs: string[] = [];
				for (const spec of child.namedChildren) {
					if (spec.type === 'import_spec') {
						const pathNode = spec.childForFieldName('path');
						if (pathNode) specs.push(pathNode.text.replace(/"/g, ''));
					}
				}
				if (specs.length === 0) return null;
				return specs.length === 1 ? specs[0]! : specs;
			}
			if (child.type === 'import_spec') {
				const pathNode = child.childForFieldName('path');
				return pathNode?.text.replace(/"/g, '') ?? null;
			}
		}
	}

	if (language === 'java' || language === 'kotlin' || language === 'scala') {
		const lastChild = node.namedChildren[node.namedChildren.length - 1];
		if (lastChild) return lastChild.text;
	}

	if (language === 'rust') {
		const argNode = node.childForFieldName('argument');
		return argNode?.text ?? null;
	}

	if (language === 'c' || language === 'cpp') {
		const pathNode = node.childForFieldName('path');
		return pathNode?.text.replace(/[<>"]/g, '') ?? null;
	}

	if (language === 'csharp') {
		const nameNode = node.childForFieldName('name');
		return nameNode?.text ?? null;
	}

	if (language === 'php') {
		for (const child of node.namedChildren) {
			if (child.type === 'namespace_use_clause') {
				return child.text;
			}
		}
	}

	if (language === 'ruby') {
		if (node.type === 'call') {
			const method = node.childForFieldName('method');
			if (method && (method.text === 'require' || method.text === 'require_relative')) {
				const args = node.childForFieldName('arguments');
				if (args) {
					const firstArg = args.namedChildren[0];
					if (firstArg) return firstArg.text.replace(/['"]/g, '');
				}
			}
		}
	}

	return null;
}

export function buildSignature(name: string, params: string | null, returnType: string | null): string | null {
	if (!params) return null;
	let sig = `${name}${params}`;
	if (returnType) sig += `: ${returnType}`;
	return sig;
}
