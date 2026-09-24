import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { CompassViews } from '../compass-views';
import type { CompassService } from '../index';
import type { IndexStatus } from '../types';

const { __setTrusted, __trustEmitter } = vscode as unknown as {
	__setTrusted: (v: boolean) => void;
	__trustEmitter: { clear: () => void };
};

interface FakeService {
	workspacePath: string;
	status: IndexStatus;
	statusCbs: Array<(s: IndexStatus) => void>;
	triggerReindex: ReturnType<typeof vi.fn>;
	treeGetFiles: ReturnType<typeof vi.fn>;
	getStatus(): IndexStatus;
	onStatusChange(cb: (s: IndexStatus) => void): { dispose: () => void };
	fireStatus(state: IndexStatus['state']): void;
}

function readyStatus(nodeCount = 1): IndexStatus {
	return { state: 'ready', fileCount: 1, nodeCount, edgeCount: 0, communityCount: 0, flowCount: 0, lastIndexedAt: Date.now() };
}

function fakeService(workspacePath: string, nodeCount = 1): FakeService {
	const svc: FakeService = {
		workspacePath,
		status: readyStatus(nodeCount),
		statusCbs: [],
		triggerReindex: vi.fn(async () => {}),
		treeGetFiles: vi.fn(async () => [`${workspacePath}/src/main.ts`]),
		getStatus: () => svc.status,
		onStatusChange(cb) {
			svc.statusCbs.push(cb);
			return { dispose: () => { svc.statusCbs = svc.statusCbs.filter(c => c !== cb); } };
		},
		fireStatus(state) {
			svc.status = { ...svc.status, state };
			for (const cb of [...svc.statusCbs]) cb(svc.status);
		},
	};
	return svc;
}

const asService = (s: FakeService | null): CompassService | null => s as unknown as CompassService | null;

interface FakeTreeView { id: string; description: string | undefined; treeDataProvider: vscode.TreeDataProvider<vscode.TreeItem>; disposed: boolean }
interface FakeStatusItem { text: string; shown: boolean; disposed: boolean }

let treeViews: FakeTreeView[];
let statusItems: FakeStatusItem[];
let commands: Map<string, (...args: unknown[]) => unknown>;
let disposedCommands: string[];
let views: CompassViews | null;

function explorer(): FakeTreeView {
	const view = treeViews.find(v => v.id === 'damocles.compass.explorer');
	if (!view) throw new Error('explorer view not created');
	return view;
}

beforeEach(() => {
	treeViews = [];
	statusItems = [];
	commands = new Map();
	disposedCommands = [];
	views = null;
	__setTrusted(true);
	vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
		get: (key: string, defaultValue?: unknown) => (key === 'enabled' ? true : defaultValue),
		update: () => Promise.resolve(),
	} as never);
	vi.spyOn(vscode.window, 'createTreeView').mockImplementation(((id: string, options: { treeDataProvider: vscode.TreeDataProvider<vscode.TreeItem> }) => {
		const view: FakeTreeView = { id, description: undefined, treeDataProvider: options.treeDataProvider, disposed: false };
		treeViews.push(view);
		return Object.assign(view, { dispose: () => { view.disposed = true; } });
	}) as never);
	vi.spyOn(vscode.window, 'createStatusBarItem').mockImplementation((() => {
		const item: FakeStatusItem = { text: '', shown: false, disposed: false };
		statusItems.push(item);
		return Object.assign(item, {
			tooltip: '',
			command: '',
			show: () => { item.shown = true; },
			hide: () => { item.shown = false; },
			dispose: () => { item.disposed = true; },
		});
	}) as never);
	vi.spyOn(vscode.commands, 'registerCommand').mockImplementation(((id: string, handler: (...args: unknown[]) => unknown) => {
		commands.set(id, handler);
		return { dispose: () => { disposedCommands.push(id); } };
	}) as never);
});

afterEach(() => {
	views?.dispose();
	__trustEmitter.clear();
	vi.restoreAllMocks();
});

describe('CompassViews', () => {
	it('registers the explorer and blast radius tree views and the three commands', () => {
		views = new CompassViews();
		views.register();

		expect(treeViews.map(v => v.id)).toEqual(['damocles.compass.explorer', 'damocles.compass.blastRadius']);
		expect([...commands.keys()].sort()).toEqual(['damocles.compass.rebuild', 'damocles.compass.search', 'damocles.compass.showBlastRadius']);
	});

	it('names the active folder in both view descriptions', () => {
		views = new CompassViews();
		views.register();

		views.setActive(asService(fakeService('/work/B')), 'B');

		expect(explorer().description).toBe('B');
		expect(treeViews[1]!.description).toBe('B');
	});

	it('shows no description when none is given, as in a single-folder window', () => {
		views = new CompassViews();
		views.register();

		views.setActive(asService(fakeService('/work/A')), undefined);

		expect(explorer().description).toBeFalsy();
	});

	it('lists the active folder\'s files in the explorer and switches with setActive', async () => {
		const a = fakeService('/work/A');
		const b = fakeService('/work/B');
		views = new CompassViews();
		views.register();

		views.setActive(asService(a), 'A');
		const fromA = await explorer().treeDataProvider.getChildren!(undefined) as vscode.TreeItem[];
		views.setActive(asService(b), 'B');
		const fromB = await explorer().treeDataProvider.getChildren!(undefined) as vscode.TreeItem[];

		expect(fromA.map(i => i.tooltip)).toEqual(['/work/A/src/main.ts']);
		expect(fromB.map(i => i.tooltip)).toEqual(['/work/B/src/main.ts']);
		expect(a.treeGetFiles).toHaveBeenCalledTimes(1);
		expect(b.treeGetFiles).toHaveBeenCalledTimes(1);
	});

	it('rebuilds the active folder only', () => {
		const a = fakeService('/work/A');
		const b = fakeService('/work/B');
		views = new CompassViews();
		views.register();
		views.setActive(asService(a), 'A');
		views.setActive(asService(b), 'B');

		commands.get('damocles.compass.rebuild')!();

		expect(b.triggerReindex).toHaveBeenCalledTimes(1);
		expect(a.triggerReindex).not.toHaveBeenCalled();
	});

	it('asks for the active folder\'s service when Rebuild runs before one exists', () => {
		const created = fakeService('/work/A');
		const acquireActive = vi.fn(() => asService(created));
		views = new CompassViews({ acquireActive });
		views.register();

		commands.get('damocles.compass.rebuild')!();

		expect(acquireActive).toHaveBeenCalledTimes(1);
		expect(created.triggerReindex).toHaveBeenCalledTimes(1);
	});

	it('shows the active folder\'s status and ignores the previous folder\'s updates', () => {
		const a = fakeService('/work/A', 11);
		const b = fakeService('/work/B', 22);
		views = new CompassViews();
		views.register();
		const bar = statusItems[0]!;

		views.setActive(asService(a), 'A');
		expect(bar.text).toContain('11');
		views.setActive(asService(b), 'B');
		expect(bar.text).toContain('22');

		a.fireStatus('indexing');

		expect(bar.text).toContain('22');
		expect(a.statusCbs).toHaveLength(0);
		b.fireStatus('indexing');
		expect(bar.text).toContain('Indexing');
	});

	it('hides the status bar when the views have no folder service', () => {
		views = new CompassViews();
		views.register();
		views.setActive(asService(fakeService('/work/A')), 'A');
		expect(statusItems[0]!.shown).toBe(true);

		views.setActive(null, 'B');

		expect(statusItems[0]!.shown).toBe(false);
		expect(explorer().description).toBe('B');
	});

	it('applies the active folder set before registration once the views register', () => {
		__setTrusted(false);
		views = new CompassViews();
		views.register();
		views.setActive(asService(fakeService('/work/B')), 'B');
		expect(treeViews).toHaveLength(0);

		__setTrusted(true);
		views.register();

		expect(explorer().description).toBe('B');
	});

	it('empties the search list when a search fails, instead of leaving an unhandled rejection', async () => {
		const service = Object.assign(fakeService('/work/A'), {
			webviewSearch: vi.fn(async () => { throw new Error('CompassService disposed'); }),
		});
		let onValue: ((value: string) => void) | undefined;
		const pick = {
			items: [{ label: 'stale' }] as vscode.QuickPickItem[],
			onDidChangeValue: (cb: (value: string) => void) => { onValue = cb; return { dispose: () => {} }; },
			onDidAccept: () => ({ dispose: () => {} }),
			onDidHide: () => ({ dispose: () => {} }),
			show: () => {},
			dispose: () => {},
		};
		vi.spyOn(vscode.window, 'createQuickPick').mockReturnValue(pick as never);
		views = new CompassViews();
		views.register();
		views.setActive(asService(service), 'A');

		commands.get('damocles.compass.search')!();
		onValue!('main');

		await vi.waitFor(() => expect(pick.items).toEqual([]));
		expect(service.webviewSearch).toHaveBeenCalledWith('main', undefined, 20);
	});

	describe('Show Blast Radius', () => {
		const realEditor = vscode.window.activeTextEditor;
		const openEditor = (fsPath: string): void => {
			(vscode.window as { activeTextEditor: unknown }).activeTextEditor = { document: { uri: vscode.Uri.file(fsPath) } };
		};
		afterEach(() => {
			(vscode.window as { activeTextEditor: unknown }).activeTextEditor = realEditor;
		});
		const blastRadiusView = (): FakeTreeView => treeViews.find(v => v.id === 'damocles.compass.blastRadius')!;
		const node = { name: 'main', kind: 'Function', file_path: '/work/A/src/main.ts', line_start: 1 };

		it('tells the user when the open file is outside the folder the views show, and queries nothing', async () => {
			const service = Object.assign(fakeService('/work/A'), { webviewBlastRadius: vi.fn() });
			const warn = vi.spyOn(vscode.window, 'showWarningMessage');
			views = new CompassViews();
			views.register();
			views.setActive(asService(service), 'A');
			openEditor('/work/B/src/main.ts');

			await commands.get('damocles.compass.showBlastRadius')!();

			expect(service.webviewBlastRadius).not.toHaveBeenCalled();
			expect(String(warn.mock.calls[0]?.[0])).toContain('outside A');
		});

		it('drops a result that arrives after the views moved to another folder', async () => {
			let answer!: (value: unknown) => void;
			const a = Object.assign(fakeService('/work/A'), {
				webviewBlastRadius: vi.fn(() => new Promise((resolve) => { answer = resolve; })),
			});
			views = new CompassViews();
			views.register();
			views.setActive(asService(a), 'A');
			openEditor('/work/A/src/main.ts');

			const running = commands.get('damocles.compass.showBlastRadius')!() as Promise<void>;
			views.setActive(asService(fakeService('/work/B')), 'B');
			answer({ changed_nodes: [node], impacted_nodes: [node], impacted_files: [] });
			await running;

			expect(blastRadiusView().treeDataProvider.getChildren!(undefined)).toEqual([]);
		});
	});

	it('disposes its views, status bar and commands', () => {
		views = new CompassViews();
		views.register();

		views.dispose();
		views = null;

		expect(treeViews.every(v => v.disposed)).toBe(true);
		expect(statusItems[0]!.disposed).toBe(true);
		expect(disposedCommands.sort()).toEqual(['damocles.compass.rebuild', 'damocles.compass.search', 'damocles.compass.showBlastRadius']);
	});
});
