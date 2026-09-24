import * as vscode from 'vscode';
import { log } from '../logger';
import { isCompassEnabled, type CompassService } from './index';
import { CompassTreeProvider, BlastRadiusTreeProvider, CompassStatusBar, registerBlastRadiusCommand } from './tree-provider';
import { BlastRadiusDecorations } from './editor-decorations';

export interface CompassViewsOptions {
	/** Creates the service for the views' folder when it has none yet, so Rebuild can start it. */
	acquireActive?: () => CompassService | null;
}

interface RegisteredViews {
	treeProvider: CompassTreeProvider;
	blastRadiusProvider: BlastRadiusTreeProvider;
	statusBar: CompassStatusBar;
	explorerView: vscode.TreeView<vscode.TreeItem>;
	blastRadiusView: vscode.TreeView<vscode.TreeItem>;
	disposables: vscode.Disposable[];
}

/**
 * The window's single set of Compass views, status bar and commands, pointed at one folder's service
 * at a time through `setActive`.
 */
export class CompassViews implements vscode.Disposable {
	private service: CompassService | null = null;
	private description: string | undefined;
	private views: RegisteredViews | null = null;
	private statusSubscription: vscode.Disposable | null = null;
	private readonly listeners: vscode.Disposable[] = [];
	private readonly options: CompassViewsOptions;
	private disposed = false;

	constructor(options: CompassViewsOptions = {}) {
		this.options = options;
		const trust = vscode.workspace.onDidGrantWorkspaceTrust?.(() => this.register());
		if (trust) this.listeners.push(trust);
		const config = vscode.workspace.onDidChangeConfiguration?.((e) => {
			if (e.affectsConfiguration('damocles.compass.enabled')) this.register();
		});
		if (config) this.listeners.push(config);
	}

	get active(): CompassService | null {
		return this.service;
	}

	/** Registers the views once Compass is enabled in a trusted window; a trust grant or enable retries. */
	register(): void {
		if (this.disposed || this.views || !isCompassEnabled()) return;
		const treeProvider = new CompassTreeProvider(null, '');
		const blastRadiusProvider = new BlastRadiusTreeProvider();
		const statusBar = new CompassStatusBar();
		const decorations = new BlastRadiusDecorations();
		const explorerView = vscode.window.createTreeView('damocles.compass.explorer', { treeDataProvider: treeProvider });
		const blastRadiusView = vscode.window.createTreeView('damocles.compass.blastRadius', { treeDataProvider: blastRadiusProvider });
		this.views = {
			treeProvider,
			blastRadiusProvider,
			statusBar,
			explorerView,
			blastRadiusView,
			disposables: [
				explorerView,
				blastRadiusView,
				treeProvider,
				blastRadiusProvider,
				statusBar,
				decorations,
				vscode.commands.registerCommand('damocles.compass.rebuild', () => this.rebuild()),
				vscode.commands.registerCommand('damocles.compass.search', () => this.search()),
				registerBlastRadiusCommand(() => this.service, blastRadiusProvider),
			],
		};
		this.render(true);
	}

	/** Points the views, status bar and commands at `service`; `description` names its folder. */
	setActive(service: CompassService | null, description?: string): void {
		if (this.disposed) return;
		if (service === this.service && description === this.description) return;
		const serviceChanged = service !== this.service;
		this.description = description;
		if (serviceChanged) {
			this.statusSubscription?.dispose();
			this.statusSubscription = null;
			this.service = service;
			if (service) {
				this.statusSubscription = service.onStatusChange(() => {
					this.views?.treeProvider.refresh();
					this.updateStatusBar();
				});
			}
			// Blast radius results describe the previous folder's graph.
			this.views?.blastRadiusProvider.clear();
		}
		this.render(serviceChanged);
	}

	dispose(): void {
		this.disposed = true;
		this.statusSubscription?.dispose();
		this.statusSubscription = null;
		for (const d of this.listeners.splice(0)) d.dispose();
		for (const d of this.views?.disposables ?? []) d.dispose();
		this.views = null;
		this.service = null;
	}

	private render(serviceChanged: boolean): void {
		const views = this.views;
		if (!views) return;
		if (serviceChanged) views.treeProvider.setService(this.service, this.service?.workspacePath ?? '');
		views.explorerView.description = this.description ?? '';
		views.blastRadiusView.description = this.description ?? '';
		this.updateStatusBar();
	}

	private updateStatusBar(): void {
		const views = this.views;
		if (!views) return;
		if (!this.service) {
			views.statusBar.hide();
			return;
		}
		views.statusBar.update(this.service.getStatus());
		views.statusBar.show();
	}

	private rebuild(): void {
		const service = this.service ?? this.options.acquireActive?.() ?? null;
		if (!service) return;
		service.triggerReindex().catch(err => {
			log('[CompassViews] Rebuild command failed: %O', err);
		});
	}

	private search(): void {
		const service = this.service;
		if (service?.getStatus().state !== 'ready') {
			vscode.window.showWarningMessage('Compass: Graph not built yet.');
			return;
		}
		const pick = vscode.window.createQuickPick();
		pick.placeholder = 'Search for functions, classes, files, types…';
		pick.matchOnDescription = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		pick.onDidChangeValue(value => {
			if (timer) clearTimeout(timer);
			if (!value) { pick.items = []; return; }
			timer = setTimeout(async () => {
				let results: Array<{ node: { name: string; kind: string; file_path: string; line_start: number }; score: number }>;
				try {
					results = await service.webviewSearch(value, undefined, 20) as typeof results;
				} catch (err) {
					log('[CompassViews] Search failed: %O', err);
					pick.items = [];
					return;
				}
				pick.items = results.map(r => ({
					label: `$(${r.node.kind === 'Function' ? 'symbol-method' : r.node.kind === 'Class' ? 'symbol-class' : r.node.kind === 'Type' ? 'symbol-interface' : r.node.kind === 'Test' ? 'beaker' : 'file'}) ${r.node.name}`,
					description: r.node.kind,
					detail: `${r.node.file_path}:${r.node.line_start}`,
					node: r.node,
				} as vscode.QuickPickItem & { node: typeof r.node }));
			}, 100);
		});
		pick.onDidAccept(() => {
			const selected = pick.selectedItems[0] as (vscode.QuickPickItem & { node?: { file_path: string; line_start: number } }) | undefined;
			pick.dispose();
			if (selected?.node) {
				const line = Math.max(0, selected.node.line_start - 1);
				vscode.window.showTextDocument(vscode.Uri.file(selected.node.file_path), {
					selection: new vscode.Range(line, 0, line, 0),
				});
			}
		});
		pick.onDidHide(() => { if (timer) clearTimeout(timer); pick.dispose(); });
		pick.show();
	}
}
