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
	previousNamedSibling?: TreeNode | null;
}

export function getName(node: TreeNode, language: string): string | null {
	if (language === 'java' && node.type === 'method_declaration') {
		const javaMethodName = _javaMethodIdentifier(node);
		if (javaMethodName) return javaMethodName;
	}

	if (language === 'bash' && node.type === 'function_definition') {
		return _bashFunctionName(node);
	}

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

	if ((language === 'c' || language === 'cpp') && node.type === 'function_definition') {
		const declarator = node.childForFieldName('declarator');
		if (declarator) return _cppLeafName(declarator);
	}

	return null;
}

function _bashFunctionName(node: TreeNode): string | null {
	const nameNode = node.childForFieldName('name');
	if (nameNode) {
		if (nameNode.type === 'word') return nameNode.text;
		return nameNode.text;
	}
	for (const child of node.children) {
		if (child.type === 'word') return child.text;
	}
	return null;
}

function _javaMethodIdentifier(node: TreeNode): string | null {
	const nameField = node.childForFieldName('name');
	if (nameField && nameField.type === 'identifier') return nameField.text;

	let seenType = false;
	for (const child of node.children) {
		if (!seenType) {
			if (child.type === 'modifiers') continue;
			if (child.type === 'type_parameters') continue;
			if (child.type === 'identifier') {
				return child.text;
			}
			seenType = true;
			continue;
		}
		if (child.type === 'identifier') return child.text;
	}
	return null;
}

const CPP_DECLARATOR_WRAPPERS = new Set([
	'pointer_declarator',
	'reference_declarator',
	'parenthesized_declarator',
	'init_declarator',
]);

function _cppLeafName(node: TreeNode): string | null {
	if (node.type === 'identifier' || node.type === 'field_identifier') {
		return node.text;
	}

	if (node.type === 'destructor_name' || node.type === 'operator_name') {
		return node.text;
	}

	if (node.type === 'qualified_identifier') {
		const inner = node.childForFieldName('name');
		if (inner) return _cppLeafName(inner);
		return null;
	}

	if (node.type === 'function_declarator' || CPP_DECLARATOR_WRAPPERS.has(node.type)) {
		const inner = node.childForFieldName('declarator');
		if (inner) return _cppLeafName(inner);
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
	'name', 'qualified_name',
	'member_expression',
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

	if (language === 'java') {
		return collectJavaBases(node);
	}

	const HERITAGE_TYPES = new Set([
		'class_heritage', 'extends_clause', 'superclass', 'super_interfaces',
		'superinterfaces', 'extends_type_clause', 'implements_clause',
		'base_clause', 'class_interface_clause',
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

function collectJavaBases(node: TreeNode): string[] {
	const bases: string[] = [];

	const superclass = node.childForFieldName('superclass');
	if (superclass) {
		for (const child of superclass.namedChildren) {
			const name = javaTypeBareName(child);
			if (name) bases.push(name);
		}
	}

	const superInterfaces = node.childForFieldName('interfaces');
	if (superInterfaces) {
		for (const child of superInterfaces.namedChildren) {
			if (child.type === 'type_list') {
				for (const typeNode of child.namedChildren) {
					const name = javaTypeBareName(typeNode);
					if (name) bases.push(name);
				}
			} else {
				const name = javaTypeBareName(child);
				if (name) bases.push(name);
			}
		}
	}

	return bases;
}

function javaTypeBareName(node: TreeNode): string | null {
	if (node.type === 'type_identifier') return node.text;

	if (node.type === 'generic_type') {
		for (const child of node.namedChildren) {
			if (child.type === 'type_identifier') return child.text;
			if (child.type === 'scoped_type_identifier') {
				const last = child.namedChildren[child.namedChildren.length - 1];
				if (last && last.type === 'type_identifier') return last.text;
				return child.text;
			}
		}
		return null;
	}

	if (node.type === 'scoped_type_identifier') {
		const last = node.namedChildren[node.namedChildren.length - 1];
		if (last && last.type === 'type_identifier') return last.text;
		return node.text;
	}

	return null;
}

export function getRustAttributes(node: TreeNode): string[] {
	const attributes: string[] = [];
	let sibling = node.previousNamedSibling ?? null;
	while (sibling) {
		if (sibling.type === 'line_comment' || sibling.type === 'block_comment') {
			sibling = sibling.previousNamedSibling ?? null;
			continue;
		}
		if (sibling.type !== 'attribute_item') break;
		const inner = sibling.text.replace(/^#!?\[/, '').replace(/\]\s*$/, '').trim();
		const token = inner.split(/[\s(]/)[0]!.trim();
		if (token) attributes.push(token);
		sibling = sibling.previousNamedSibling ?? null;
	}
	return attributes;
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
		if (nameNode) return nameNode.text;
		for (const child of node.namedChildren) {
			if (child.type === 'qualified_name' || child.type === 'identifier') {
				return child.text;
			}
		}
		return null;
	}

	if (language === 'php') {
		for (const child of node.namedChildren) {
			if (child.type === 'namespace_use_clause') {
				for (const grand of child.namedChildren) {
					if (grand.type !== 'namespace_aliasing_clause') {
						return grand.text;
					}
				}
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
