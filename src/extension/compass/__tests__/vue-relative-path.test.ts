import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractFile } from '../extractors';
import { setGrammarDir } from '../parser-manager';
import { GraphStore } from '../database';
import type { SqlJsStatic } from '../database';
import { getSqlEngine, createTestStore } from './sql-test-helper';

const GRAMMARS = path.join(process.cwd(), 'resources', 'grammars');

let engine: SqlJsStatic;

beforeAll(async () => {
	setGrammarDir(GRAMMARS);
	engine = await getSqlEngine();
});

function writeFile(p: string, content: string): void {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, content);
}

describe('Vue relative-path resolution (iemis-layout regression)', () => {
	let tmp: string;
	let store: GraphStore;
	afterEach(() => {
		store?.close();
		if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
	});

	it('resolves ../../Components/PasswordInput.vue from Pages/Admin/DataSources', async () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-vue-rel-'));

		const target = path.join(tmp, 'resources', 'ts', 'Pages', 'Components', 'PasswordInput.vue');
		const importer = path.join(tmp, 'resources', 'ts', 'Pages', 'Admin', 'DataSources', 'PostgreSQLForm.vue');
		writeFile(target, '<script setup lang="ts">\nconst x = 1;\n</script>\n');
		writeFile(importer, '<script setup lang="ts">\nimport PasswordInput from "../../Components/PasswordInput.vue";\nconst x = 2;\n</script>\n');

		store = createTestStore(engine);

		const targetX = await extractFile(target, tmp);
		const importerX = await extractFile(importer, tmp);
		store.storeFileNodesEdges(target, targetX.nodes, targetX.edges);
		store.storeFileNodesEdges(importer, importerX.nodes, importerX.edges);

		store.resolveExternalEdges(tmp);

		const importerFQ = `${importer.replace(/\\/g, '/')}::PostgreSQLForm.vue`;
		const targetFQ = `${target.replace(/\\/g, '/')}::PasswordInput.vue`;
		const imports = store.getEdgesBySource(importerFQ).filter(e => e.kind === 'IMPORTS_FROM');
		const match = imports.find(e => e.target_qualified === targetFQ);
		expect(match, `expected ../../Components/PasswordInput.vue to resolve to ${targetFQ}. Got targets: ${imports.map(i => i.target_qualified).join(', ')}`).toBeDefined();
	});

	it('resolves ../Components/PasswordInput.vue from Pages/User', async () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-vue-rel-'));

		const target = path.join(tmp, 'resources', 'ts', 'Pages', 'Components', 'PasswordInput.vue');
		const importer = path.join(tmp, 'resources', 'ts', 'Pages', 'User', 'PasswordForm.vue');
		writeFile(target, '<script setup lang="ts">\nconst x = 1;\n</script>\n');
		writeFile(importer, '<script setup lang="ts">\nimport PasswordInput from "../Components/PasswordInput.vue";\nconst x = 2;\n</script>\n');

		store = createTestStore(engine);

		const targetX = await extractFile(target, tmp);
		const importerX = await extractFile(importer, tmp);
		store.storeFileNodesEdges(target, targetX.nodes, targetX.edges);
		store.storeFileNodesEdges(importer, importerX.nodes, importerX.edges);

		store.resolveExternalEdges(tmp);

		const importerFQ = `${importer.replace(/\\/g, '/')}::PasswordForm.vue`;
		const targetFQ = `${target.replace(/\\/g, '/')}::PasswordInput.vue`;
		const imports = store.getEdgesBySource(importerFQ).filter(e => e.kind === 'IMPORTS_FROM');
		const match = imports.find(e => e.target_qualified === targetFQ);
		expect(match, `Got targets: ${imports.map(i => i.target_qualified).join(', ')}`).toBeDefined();
	});

	it('resolves ./PasswordForm.vue from sibling file', async () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-vue-rel-'));

		const target = path.join(tmp, 'resources', 'ts', 'Pages', 'User', 'PasswordForm.vue');
		const importer = path.join(tmp, 'resources', 'ts', 'Pages', 'User', 'Profile.vue');
		writeFile(target, '<script setup lang="ts">\nconst x = 1;\n</script>\n');
		writeFile(importer, '<script setup lang="ts">\nimport PasswordForm from "./PasswordForm.vue";\nconst x = 2;\n</script>\n');

		store = createTestStore(engine);

		const targetX = await extractFile(target, tmp);
		const importerX = await extractFile(importer, tmp);
		store.storeFileNodesEdges(target, targetX.nodes, targetX.edges);
		store.storeFileNodesEdges(importer, importerX.nodes, importerX.edges);

		store.resolveExternalEdges(tmp);

		const importerFQ = `${importer.replace(/\\/g, '/')}::Profile.vue`;
		const targetFQ = `${target.replace(/\\/g, '/')}::PasswordForm.vue`;
		const imports = store.getEdgesBySource(importerFQ).filter(e => e.kind === 'IMPORTS_FROM');
		const match = imports.find(e => e.target_qualified === targetFQ);
		expect(match, `Got targets: ${imports.map(i => i.target_qualified).join(', ')}`).toBeDefined();
	});
});
