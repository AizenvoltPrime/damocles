import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { createFakePlatform } from '../../../../../__mocks__/fake-platform';
import { createCompassHandlers } from '../compass-handlers';
import { installLogSink } from '../../../../logger';
import type { HandlerContext, HandlerDependencies } from '../../types';
import type { CompassRegistry } from '../../../../compass/compass-registry';
import type { FolderTarget } from '../../../../workspace-folders/folder-registry';

function folder(fsPath: string): FolderTarget {
	return { key: fsPath, fsPath, name: fsPath, label: fsPath, projectScope: true };
}

function fakeService(name: string) {
	return {
		isEnabled: true,
		ensureInitialized: vi.fn(async () => {}),
		triggerReindex: vi.fn(async () => {}),
		webviewSearch: vi.fn(async () => [{ node: { name: `${name}Symbol` } }]),
		webviewGraph: vi.fn(async () => ({ nodes: [name], edges: [], communities: [] })),
		webviewBlastRadius: vi.fn(async () => ({ changed_files: [name] })),
	};
}

const A = folder('/work/A');
const B = folder('/work/B');

let services: Map<string, ReturnType<typeof fakeService>>;
let posted: unknown[];
let handlers: ReturnType<typeof createCompassHandlers>;

function ctx(target: FolderTarget): HandlerContext {
	return { host: {}, folder: target, panelId: 'p' } as unknown as HandlerContext;
}

beforeEach(() => {
	services = new Map([[A.key, fakeService('A')], [B.key, fakeService('B')]]);
	posted = [];
	const registry = { get: (key: string) => services.get(key) } as unknown as CompassRegistry;
	handlers = createCompassHandlers({
		compassRegistry: registry,
		postMessage: (_host: unknown, message: unknown) => { posted.push(message); },
		platform: createFakePlatform(),
	} as unknown as HandlerDependencies);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('compass handlers per folder', () => {
	it('searches the requesting panel\'s folder only', async () => {
		await handlers['compassSearch']!({ type: 'compassSearch', query: 'x' } as never, ctx(B));

		expect(services.get(B.key)!.webviewSearch).toHaveBeenCalledTimes(1);
		expect(services.get(A.key)!.webviewSearch).not.toHaveBeenCalled();
		expect(posted).toEqual([{ type: 'compassSearchResults', results: [{ node: { name: 'BSymbol' } }] }]);
	});

	it('reads the graph of the requesting panel\'s folder', async () => {
		await handlers['compassRequestGraph']!({ type: 'compassRequestGraph' } as never, ctx(A));

		expect(services.get(A.key)!.webviewGraph).toHaveBeenCalledTimes(1);
		expect(services.get(B.key)!.webviewGraph).not.toHaveBeenCalled();
	});

	it('reindexes the requesting panel\'s folder only', async () => {
		await handlers['requestCompassReindex']!({ type: 'requestCompassReindex' } as never, ctx(B));

		expect(services.get(B.key)!.triggerReindex).toHaveBeenCalledTimes(1);
		expect(services.get(A.key)!.triggerReindex).not.toHaveBeenCalled();
	});

	it("answers a blast radius only for a file in the requesting panel's folder", async () => {
		const RA = folder(path.resolve('/work/A'));
		const RB = folder(path.resolve('/work/B'));
		services = new Map([[RA.key, fakeService('A')], [RB.key, fakeService('B')]]);

		await handlers['compassRequestBlastRadius']!({ type: 'compassRequestBlastRadius', filePath: path.join(RB.fsPath, 'src', 'x.ts') } as never, ctx(RA));
		expect(services.get(RA.key)!.webviewBlastRadius).not.toHaveBeenCalled();
		expect(posted).toEqual([]);

		await handlers['compassRequestBlastRadius']!({ type: 'compassRequestBlastRadius', filePath: path.join(RA.fsPath, 'src', 'x.ts') } as never, ctx(RA));
		expect(services.get(RA.key)!.webviewBlastRadius).toHaveBeenCalledTimes(1);
		expect(posted).toEqual([{ type: 'compassBlastRadiusData', data: { changed_files: ['A'] } }]);
	});

	it('does nothing for a folder with no Compass service', async () => {
		await handlers['compassSearch']!({ type: 'compassSearch', query: 'x' } as never, ctx(folder('/work/C')));

		expect(posted).toEqual([]);
	});
});

describe('compass handlers fire-and-forget and read-only results', () => {
	it('logs an editor that fails to open a navigated node instead of leaving the rejection unhandled', async () => {
		const root = path.resolve('/work/A');
		const platform = createFakePlatform({ folders: [{ fsPath: root, name: 'A' }] });
		vi.spyOn(platform.editor, 'openFile').mockRejectedValue(new Error('editor gone'));
		const logged: string[] = [];
		installLogSink({ appendLine: (line) => void logged.push(line), show: () => undefined, dispose: () => undefined });
		const navigate = createCompassHandlers({ platform, postMessage: () => undefined } as unknown as HandlerDependencies);

		await navigate['compassNavigateToNode']!({ type: 'compassNavigateToNode', filePath: path.join(root, 'a.ts'), line: 1 } as never, ctx(folder(root)));

		await vi.waitFor(() => expect(logged.join('\n')).toContain('editor gone'));
	});

	it('reports the stale files a read-only index kept instead of claiming they were removed', async () => {
		const empty = { count: 0, entities: [], truncated: false };
		const service = {
			isEnabled: true,
			ensureInitialized: vi.fn(async () => {}),
			webviewValidation: vi.fn(async () => ({
				validation: {
					orphanedByKind: {}, expectedOrphanFiles: empty, totalByKind: {}, brokenEdges: empty, knownExternalRefs: empty,
					unresolvedInternalRefs: empty, communityGaps: empty, ftsRowCount: 1, nodeCount: 1, edgeCount: 2, fileCount: 1, communityCount: 0, filePaths: [],
				},
				workspaceFileCount: 0,
				workspaceFiles: [],
				staleFilesRemoved: [],
				staleFilesKept: ['/work/A/gone.ts'],
			})),
		};
		const registry = { get: () => service } as unknown as CompassRegistry;
		const validate = createCompassHandlers({ compassRegistry: registry, postMessage: (_host: unknown, message: unknown) => { posted.push(message); }, platform: createFakePlatform() } as unknown as HandlerDependencies);

		await validate['compassRequestValidation']!({ type: 'compassRequestValidation' } as never, ctx(A));

		const issues = (posted[0] as { data: { issues: Array<{ category: string; entities: string[] }> } }).data.issues;
		expect(issues.map((i) => i.category)).not.toContain('Stale files auto-removed');
		expect(issues.find((i) => i.category === 'Stale files kept (read-only index)')?.entities).toEqual(['/work/A/gone.ts']);
	});
});
