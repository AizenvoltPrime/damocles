import { VALID_FILE_TYPES, VALID_CONFIDENCES, REQUIRED_NODE_FIELDS, REQUIRED_EDGE_FIELDS } from './types';

export function validateExtraction(data: unknown): string[] {
	if (typeof data !== 'object' || data === null || Array.isArray(data)) {
		return ['Extraction must be a JSON object'];
	}

	const obj = data as Record<string, unknown>;
	const errors: string[] = [];

	if (!('nodes' in obj)) {
		errors.push("Missing required key 'nodes'");
	} else if (!Array.isArray(obj['nodes'])) {
		errors.push("'nodes' must be a list");
	} else {
		for (let i = 0; i < obj['nodes'].length; i++) {
			const node = obj['nodes'][i] as Record<string, unknown>;
			if (typeof node !== 'object' || node === null || Array.isArray(node)) {
				errors.push(`Node ${i} must be an object`);
				continue;
			}
			for (const field of REQUIRED_NODE_FIELDS) {
				if (!(field in node)) {
					errors.push(`Node ${i} (id=${JSON.stringify(node['id'] ?? '?')}) missing required field '${field}'`);
				}
			}
			if ('file_type' in node && !VALID_FILE_TYPES.has(node['file_type'] as never)) {
				errors.push(
					`Node ${i} (id=${JSON.stringify(node['id'] ?? '?')}) has invalid file_type '${node['file_type']}' - must be one of ${JSON.stringify([...VALID_FILE_TYPES].sort())}`
				);
			}
		}
	}

	if (!('edges' in obj)) {
		errors.push("Missing required key 'edges'");
	} else if (!Array.isArray(obj['edges'])) {
		errors.push("'edges' must be a list");
	} else {
		const nodeIds = new Set<string>();
		if (Array.isArray(obj['nodes'])) {
			for (const node of obj['nodes']) {
				if (typeof node === 'object' && node !== null && 'id' in node) {
					nodeIds.add((node as Record<string, unknown>)['id'] as string);
				}
			}
		}

		for (let i = 0; i < obj['edges'].length; i++) {
			const edge = obj['edges'][i] as Record<string, unknown>;
			if (typeof edge !== 'object' || edge === null || Array.isArray(edge)) {
				errors.push(`Edge ${i} must be an object`);
				continue;
			}
			for (const field of REQUIRED_EDGE_FIELDS) {
				if (!(field in edge)) {
					errors.push(`Edge ${i} missing required field '${field}'`);
				}
			}
			if ('confidence' in edge && !VALID_CONFIDENCES.has(edge['confidence'] as never)) {
				errors.push(
					`Edge ${i} has invalid confidence '${edge['confidence']}' - must be one of ${JSON.stringify([...VALID_CONFIDENCES].sort())}`
				);
			}
			if ('source' in edge && nodeIds.size > 0 && !nodeIds.has(edge['source'] as string)) {
				errors.push(`Edge ${i} source '${edge['source']}' does not match any node id`);
			}
			if ('target' in edge && nodeIds.size > 0 && !nodeIds.has(edge['target'] as string)) {
				errors.push(`Edge ${i} target '${edge['target']}' does not match any node id`);
			}
		}
	}

	return errors;
}

export function assertValid(data: unknown): void {
	const errors = validateExtraction(data);
	if (errors.length > 0) {
		throw new Error(
			`Extraction JSON has ${errors.length} error(s):\n` +
			errors.map(e => `  • ${e}`).join('\n')
		);
	}
}
